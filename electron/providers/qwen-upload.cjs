/**
 * Proxima — Qwen attachment upload (main process)
 *
 * Qwen does not accept file bytes on its chat endpoint. Attaching anything is a
 * three-step dance, and only step 1 can happen inside the page:
 *
 *   1. POST /api/v2/files/getstsToken   -> short-lived Alibaba STS credentials
 *      + the object key the file must land on. This path is in the frontend's
 *      baxia-signed list (main.js `Hu`), so it has to be issued from the page's
 *      main world like chats/new — see qwen-engine.js header note #2.
 *   2. PUT the bytes straight to Alibaba OSS, signed with those credentials.
 *   3. Send the chat message with a descriptor in `messages[0].files`.
 *
 * Steps 2 and 3 live here rather than in the engine on purpose. The web app does
 * its upload in-page with the bundled ali-oss SDK, but doing that in Proxima would
 * mean pushing the file through executeJavaScript as a base64 string literal —
 * 1.33x inflation plus a same-size JS string, for a format whose own limit is
 * 500MB. Node streams the file off disk instead, so a 500MB video costs a socket
 * and not 1.3GB of renderer heap.
 *
 * A single PUT, matching the app: a capture of its own image and video uploads shows
 * one PutObject with the whole body and no ?uploads/uploadId/partNumber anywhere.
 * PutObject covers 5GB, so the bundled SDK's switch to multipartUpload above 2MB is
 * not replicated — that buys the web app progress events and resumability, neither of
 * which this path uses. (The captured files were both under 325KB, so multipart is
 * untested rather than ruled out. If a large video ever fails where a small one
 * works, that is the first thing to suspect.)
 *
 * Signing is OSS V1 (HMAC-SHA1); the app uses V4 (OSS4-HMAC-SHA256). The divergence
 * is deliberate and, unlike the Qwen API, carries no anomaly risk — this is a plain
 * object store with no bot scoring, so only correctness matters. V1 is verified
 * working against this bucket (200 + etag, object read back byte-identical), and it
 * signs without touching the payload, so a 500MB video streams once instead of being
 * read twice to compute a SHA-256. If Alibaba ever retires V1 on this bucket the fix
 * is V4 with `x-oss-content-sha256: UNSIGNED-PAYLOAD`, which keeps the single pass.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

// ─── Type classification ─────────────────────────────
// Extension lists lifted verbatim from the frontend bundle (main.js: zt/$t/Gt/Vt/Bt).
// Qwen keys everything off these, not off the MIME type we guess below.
const EXT_IMAGE = ['gif', 'webp', 'jpg', 'jpeg', 'png', 'bmp', 'icns', 'jp2', 'sgi', 'tif',
                   'tiff', 'dib', 'ico', 'jfif', 'j2c', 'j2k', 'jpc', 'jpf', 'jpx', 'apng',
                   'bw', 'rgb', 'rgba'];
const EXT_VIDEO = ['mp4', 'avi', 'wmv', 'flv', 'mkv', 'mov'];
const EXT_AUDIO = ['amr', 'wav', 'aac', 'mp3', 'm4a'];
const EXT_DOC   = ['pdf', 'doc', 'docx', 'csv', 'xlsx', 'xls', 'md'];
const EXT_TEXT  = ['txt'];

// The bundle's own limits (main.js `Jt`). The server can override them per-account
// via config.features.limits, so these are the floor we validate against locally to
// fail fast with a useful message instead of after a 500MB upload.
// `max_size` is MB; `max_duration` seconds (not enforced here — needs a demux).
const LIMITS = {
    vision:   { max_count: 5,        max_size: 20,  exts: EXT_IMAGE },
    video:    { max_count: 1,        max_size: 500, exts: EXT_VIDEO, max_duration: 600 },
    audio:    { max_count: 1,        max_size: 100, exts: EXT_AUDIO, max_duration: 180 },
    document: { max_count: 5,        max_size: 20,  exts: EXT_DOC },
    default:  { max_count: Infinity, max_size: 20,  exts: EXT_TEXT }
};

// file_class (Xt) -> type/showType (Zt). The frontend keeps both and so does the
// wire format, with different vocabularies for the same idea: 'vision' becomes
// 'image', 'document'/'default' both become 'file'.
const SHOW_TYPE = { vision: 'image', video: 'video', audio: 'audio', document: 'file', default: 'file' };
// filetype in the getstsToken body — derived in the app from the MIME prefix.
const STS_TYPE  = { vision: 'image', video: 'video', audio: 'audio', document: 'file', default: 'file' };

const MIME = {
    // images
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', dib: 'image/bmp',
    tif: 'image/tiff', tiff: 'image/tiff', ico: 'image/x-icon', icns: 'image/x-icns',
    apng: 'image/apng', jp2: 'image/jp2', j2k: 'image/jp2', j2c: 'image/jp2',
    jpc: 'image/jp2', jpf: 'image/jpx', jpx: 'image/jpx',
    sgi: 'image/sgi', bw: 'image/sgi', rgb: 'image/sgi', rgba: 'image/sgi',
    // video — mirrors the bundle's `dh` fixup map, which exists because browsers
    // hand back an empty File.type for several of these.
    mp4: 'video/mp4', avi: 'video/avi', wmv: 'video/x-ms-wmv', flv: 'video/x-flv',
    mkv: 'video/x-matroska', mov: 'video/quicktime',
    // audio
    mp3: 'audio/mpeg', wav: 'audio/wav', aac: 'audio/aac', m4a: 'audio/mp4', amr: 'audio/amr',
    // documents
    pdf: 'application/pdf', doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    csv: 'text/csv', md: 'text/markdown', txt: 'text/plain'
};

function extOf(filePath) {
    return path.extname(filePath).replace(/^\./, '').toLowerCase();
}

/**
 * Which of Qwen's five upload classes this file belongs to.
 * Anything not in a known list is rejected rather than guessed at: an unsupported
 * extension uploads fine to OSS and then produces "The selected model or feature
 * does not support the file type you uploaded" at send time, which is a much worse
 * place to find out.
 */
function classify(filePath) {
    const ext = extOf(filePath);
    let fileClass = null;
    if (EXT_IMAGE.includes(ext)) fileClass = 'vision';
    else if (EXT_VIDEO.includes(ext)) fileClass = 'video';
    else if (EXT_AUDIO.includes(ext)) fileClass = 'audio';
    else if (EXT_DOC.includes(ext)) fileClass = 'document';
    else if (EXT_TEXT.includes(ext)) fileClass = 'default';
    if (!fileClass) {
        const all = [].concat(EXT_IMAGE, EXT_VIDEO, EXT_AUDIO, EXT_DOC, EXT_TEXT);
        throw new Error(`Qwen: unsupported attachment type ".${ext}". Supported: ${all.join(', ')}`);
    }
    return {
        fileClass,
        showType: SHOW_TYPE[fileClass],
        stsType: STS_TYPE[fileClass],
        mime: MIME[ext] || 'application/octet-stream',
        ext
    };
}

/** Throws unless the file exists and fits the class's size ceiling. */
function validate(filePath, kind) {
    if (!fs.existsSync(filePath)) throw new Error(`Qwen: file not found: ${filePath}`);
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error(`Qwen: not a file: ${filePath}`);
    if (stat.size === 0) throw new Error(`Qwen: file is empty: ${filePath}`);
    const lim = LIMITS[kind.fileClass];
    const mb = stat.size / 1024 / 1024;
    if (mb > lim.max_size) {
        throw new Error(`Qwen: ${kind.fileClass} attachment is ${mb.toFixed(1)}MB; ` +
            `the limit for this type is ${lim.max_size}MB`);
    }
    return stat;
}

/** Rejects a batch that breaks the per-turn count limits (5 images, 1 video, 1 audio…). */
function validateBatch(kinds) {
    const counts = {};
    for (const k of kinds) counts[k.fileClass] = (counts[k.fileClass] || 0) + 1;
    for (const cls in counts) {
        const lim = LIMITS[cls].max_count;
        if (counts[cls] > lim) {
            throw new Error(`Qwen: ${counts[cls]} ${cls} attachments in one turn; ` +
                `the limit is ${lim}`);
        }
    }
}

// ─── OSS V1 request signing ──────────────────────────
// StringToSign = VERB\nContent-MD5\nContent-Type\nDate\nCanonicalizedOSSHeaders + CanonicalizedResource
// CanonicalizedOSSHeaders: every x-oss-* header, lowercased, sorted, "k:v\n".
// CanonicalizedResource:   /{bucket}/{key} — the RAW key, not the percent-encoded one.
function signV1(method, bucket, key, contentType, dateStr, ossHeaders, secret) {
    const lower = {};
    for (const k of Object.keys(ossHeaders)) lower[k.toLowerCase()] = ossHeaders[k];
    const canonHeaders = Object.keys(lower).sort().map((k) => `${k}:${lower[k]}\n`).join('');
    const stringToSign = `${method}\n\n${contentType}\n${dateStr}\n${canonHeaders}/${bucket}/${key}`;
    const sig = crypto.createHmac('sha1', secret).update(stringToSign, 'utf8').digest('base64');
    return { sig, stringToSign };
}

/**
 * Streams the file to OSS with a single signed PUT.
 * Resolves with { etag, requestId }.
 */
function putToOss(sts, filePath, size, contentType) {
    const bucket = sts.bucket;
    const key = sts.filePath;
    // Virtual-hosted style. `endpoint` came back as oss-accelerate.aliyuncs.com —
    // Alibaba's transfer-acceleration host, which V1 signing still covers.
    const host = `${bucket}.${sts.endpoint}`;
    const dateStr = new Date().toUTCString();
    const ossHeaders = { 'x-oss-security-token': sts.stsToken };
    const { sig } = signV1('PUT', bucket, key, contentType, dateStr, ossHeaders, sts.accessKeySecret);

    // Encode per segment: the key is "{userId}/{uuid}_{filename}" and the filename
    // half can hold spaces and non-ASCII. encodeURIComponent would eat the slashes.
    const encodedKey = key.split('/').map(encodeURIComponent).join('/');

    return new Promise((resolve, reject) => {
        const req = https.request({
            method: 'PUT',
            host,
            path: '/' + encodedKey,
            headers: {
                'Host': host,
                'Date': dateStr,
                'Content-Type': contentType,
                'Content-Length': size,
                'x-oss-security-token': sts.stsToken,
                'Authorization': `OSS ${sts.accessKeyId}:${sig}`
            }
        }, (res) => {
            let body = '';
            res.on('data', (d) => { body += d.toString(); });
            res.on('end', () => {
                if (res.statusCode === 200) {
                    resolve({ etag: res.headers.etag, requestId: res.headers['x-oss-request-id'] });
                } else {
                    // OSS answers with an XML <Error><Code>…; surface the code, it is
                    // the difference between "clock skew" and "expired token".
                    const code = (body.match(/<Code>([^<]+)<\/Code>/) || [])[1] || res.statusCode;
                    const msg = (body.match(/<Message>([^<]+)<\/Message>/) || [])[1] || body.slice(0, 300);
                    reject(new Error(`Qwen OSS upload failed (${code}): ${msg}`));
                }
            });
        });
        req.on('error', reject);
        const stream = fs.createReadStream(filePath);
        stream.on('error', (e) => { req.destroy(); reject(e); });
        stream.pipe(req);
    });
}

/**
 * The `messages[0].files[]` element — 17 keys, matched field for field against a
 * capture of the real app attaching a PNG and an MP4.
 *
 * Four details here are counter-intuitive enough to be worth stating, because each
 * was a guess before the capture and three of the guesses were wrong:
 *
 *  - `progress` is 0, not 100. The app ships the upload-progress counter in its
 *    initial state and never updates it before sending.
 *  - `greenNet` is 'greening' for video and 'success' for stills. 'greening' means
 *    content moderation was still in flight and the app sent anyway, so it is not a
 *    gate: there is nothing to poll and nothing to wait for.
 *  - `url` is the FULL presigned OSS URL (~1.1KB of query string), not the bare
 *    object URL. The server gets both that and `id`; which one it reads is unknown,
 *    so send both exactly as the app does.
 *  - `file_class` is the discriminator ('vision' for stills, 'video' for motion),
 *    and it does NOT match `type`/`showType` ('image'/'video'). Two vocabularies.
 *
 * `itemId` and `uploadTaskId` are client-generated UUIDs the server never refers to
 * again; they are sent because the app sends them.
 */
function buildDescriptor(sts, filePath, size, kind, mtimeMs) {
    const name = path.basename(filePath);
    const now = Date.now();
    // file_path is "{userId}/{uuid}_{name}", which is where the app gets user_id from.
    const userId = String(sts.filePath || '').split('/')[0] || '';
    const desc = {
        type: kind.showType,
        file: {
            created_at: now,
            update_at: now,
            lastModified: Math.round(mtimeMs || now),   // File.lastModified in the app
            data: {},
            hash: null,
            filename: name,
            name,
            id: sts.fileId,
            user_id: userId,
            meta: { name, size, content_type: kind.mime },
            size,
            type: kind.mime,
            webkitRelativePath: ''
        },
        id: sts.fileId,
        url: sts.fileCDNUrl,
        name,
        collection_name: '',
        progress: 0,
        status: 'uploaded',
        greenNet: kind.fileClass === 'video' ? 'greening' : 'success',
        size,
        error: '',
        itemId: crypto.randomUUID(),
        file_type: kind.mime,
        showType: kind.showType,
        file_class: kind.fileClass,
        uploadTaskId: crypto.randomUUID()
    };
    // 'default' (plain .txt) is the one class the app always sends full-context for.
    if (kind.fileClass === 'default') desc.context = 'full';
    return desc;
}

module.exports = {
    classify,
    validate,
    validateBatch,
    putToOss,
    buildDescriptor,
    LIMITS,
    EXT_IMAGE,
    EXT_VIDEO,
    EXT_AUDIO
};
