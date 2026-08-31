/**
 * Proxima — Claude attachment upload (main process)
 *
 * Uploading to claude.ai is decoupled from sending. The file goes up when it is
 * attached, and the completion request merely references what is already on the
 * server:
 *
 *   POST /api/organizations/{org}/conversations/{conv}/wiggle/upload-file
 *   multipart/form-data, exactly ONE part, field name must be "file"
 *   cookies are the only auth — no anthropic-* headers are required
 *
 * Note /conversations/, not /chat_conversations/ — the same inconsistency the wiggle
 * download routes have.
 *
 * The response's `file_kind` is decided by SERVER-SIDE CONTENT SNIFFING, not by the
 * MIME type we declare, and it determines which of two completely different slots the
 * file occupies in the completion body:
 *
 *   file_kind "image" / "document"  ->  files: ["<file_uuid>"]
 *   file_kind "blob"                ->  attachments: [{ file_name, file_type,
 *                                        file_size, extracted_content, origin, kind }]
 *
 * So a PNG and a PDF are referenced by id, while a plain-text file is carried inline as
 * extracted text. Routing on our own guess of the type would put files in the wrong
 * slot; we route on what the server says it sniffed.
 *
 * Why this runs in Node rather than in the page: the upload is a multipart body, and
 * pushing file bytes through executeJavaScript means base64 (1.33x) plus a same-size JS
 * string. The size ceiling here is only known to be above 30MB, so streaming off disk
 * is the safe default. Electron's net.request carries the BrowserView's cookies when
 * given its session, which is what makes a main-process upload possible at all.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Text-ish extensions we are willing to read off disk as `extracted_content` when the
// server sniffs a file as "blob". A blob that is NOT one of these is left in `files`
// by uuid instead — sending binary as "extracted text" would be worse than useless.
const TEXT_EXT = ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonc', 'yaml', 'yml',
                  'xml', 'html', 'htm', 'css', 'js', 'cjs', 'mjs', 'jsx', 'ts', 'tsx',
                  'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs',
                  'sh', 'bash', 'ps1', 'sql', 'ini', 'toml', 'env', 'log', 'diff', 'patch'];

const MIME = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon',
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json',
    html: 'text/html', xml: 'text/xml', yaml: 'text/yaml', yml: 'text/yaml'
};

function extOf(p) { return path.extname(p).replace(/^\./, '').toLowerCase(); }
function mimeOf(p) { return MIME[extOf(p)] || 'application/octet-stream'; }

function validate(filePath) {
    if (!fs.existsSync(filePath)) throw new Error('Claude: file not found: ' + filePath);
    const st = fs.statSync(filePath);
    if (!st.isFile()) throw new Error('Claude: not a file: ' + filePath);
    if (st.size === 0) throw new Error('Claude: file is empty: ' + filePath);
    return st;
}

/**
 * Upload one file. `netRequest` is Electron's net.request and `ses` the BrowserView's
 * session, so the claude.ai cookies ride along.
 * Resolves with the parsed upload response.
 */
function uploadOne(netRequest, ses, orgId, convId, filePath) {
    const st = validate(filePath);
    const name = path.basename(filePath);
    const boundary = '----ProximaFormBoundary' + crypto.randomBytes(12).toString('hex');
    const head = Buffer.from(
        '--' + boundary + '\r\n' +
        'Content-Disposition: form-data; name="file"; filename="' + name.replace(/"/g, '') + '"\r\n' +
        'Content-Type: ' + mimeOf(filePath) + '\r\n\r\n', 'utf8');
    const tail = Buffer.from('\r\n--' + boundary + '--\r\n', 'utf8');

    return new Promise((resolve, reject) => {
        const req = netRequest({
            method: 'POST',
            url: 'https://claude.ai/api/organizations/' + orgId + '/conversations/' +
                 convId + '/wiggle/upload-file',
            session: ses,
            useSessionCookies: true      // without this the request is anonymous and 401s
        });
        req.setHeader('Content-Type', 'multipart/form-data; boundary=' + boundary);
        // Content-Length, Origin and Referer are all set here in the first version and
        // that is what made every request fail with net::ERR_INVALID_ARGUMENT before it
        // left the process. Chromium treats them as forbidden request headers: the
        // network stack owns them, and setHeader rejects the whole request rather than
        // ignoring the field. Content-Length is computed from what we write, and Origin
        // and Referer are derived from the session, so none of the three were ours to
        // set in the first place.

        req.on('response', (res) => {
            let body = '';
            res.on('data', (c) => { body += c.toString(); });
            res.on('end', () => {
                if (res.statusCode !== 200 && res.statusCode !== 201) {
                    return reject(new Error('Claude upload failed (' + res.statusCode + ') for ' +
                        name + ': ' + body.slice(0, 300)));
                }
                let j;
                try { j = JSON.parse(body); } catch (e) {
                    return reject(new Error('Claude upload: non-JSON response for ' + name +
                        ': ' + body.slice(0, 200)));
                }
                if (!j || (!j.file_uuid && !j.uuid)) {
                    return reject(new Error('Claude upload: no file id for ' + name +
                        ': ' + body.slice(0, 200)));
                }
                resolve({
                    name: name,
                    localPath: filePath,
                    uuid: j.file_uuid || j.uuid,
                    fileKind: j.file_kind || null,
                    sanitizedName: j.sanitized_name || name,
                    sandboxPath: j.path || null,
                    bytes: typeof j.size_bytes === 'number' ? j.size_bytes : st.size,
                    mime: mimeOf(filePath)
                });
            });
        });
        req.on('error', reject);

        req.write(head);
        const stream = fs.createReadStream(filePath);
        stream.on('data', (chunk) => req.write(chunk));
        stream.on('error', (e) => { try { req.abort(); } catch (x) { } reject(e); });
        stream.on('end', () => { req.write(tail); req.end(); });
    });
}

/**
 * Turn upload results into the two completion-body slots.
 * Returns { files: [uuid...], attachments: [entry...], summary: [...] }.
 */
function toCompletionSlots(uploads) {
    const files = [];
    const attachments = [];
    const summary = [];
    for (const u of uploads) {
        const isText = u.fileKind === 'blob' && TEXT_EXT.indexOf(extOf(u.localPath)) !== -1;
        if (isText) {
            // The app carries text files inline as extracted_content rather than by id.
            // Whether the server would re-derive this from `path` if omitted is unknown,
            // so we mirror the app and send it.
            let text = '';
            try { text = fs.readFileSync(u.localPath, 'utf8'); } catch (e) { text = ''; }
            attachments.push({
                file_name: u.sanitizedName,
                file_type: u.mime,
                file_size: u.bytes,
                extracted_content: text,
                origin: 'user_upload',
                kind: 'file'
            });
            summary.push({ name: u.name, slot: 'attachments', fileKind: u.fileKind, bytes: u.bytes });
        } else {
            // image / document, and any blob we will not treat as text.
            files.push(u.uuid);
            summary.push({ name: u.name, slot: 'files', fileKind: u.fileKind, uuid: u.uuid, bytes: u.bytes });
        }
    }
    return { files: files, attachments: attachments, summary: summary };
}

module.exports = { uploadOne, toCompletionSlots, validate, mimeOf, TEXT_EXT };
