/**
 * Proxima — ChatGPT attachment upload
 *
 * Captured from chatgpt.com (HAR, 2026-09-25). Attaching a file is four steps, and
 * only the middle one can leave the page:
 *
 *   1. POST /backend-api/files                  -> { upload_url, file_id }
 *   2. PUT  <upload_url>                        -> 201, the raw bytes, Azure Blob
 *   3. POST /backend-api/files/process_upload_stream
 *   4. GET  /backend-api/files/{file_id}/simple -> library_file_id and friends
 *
 * Then the send references it: content_type 'multimodal_text', parts[0] an
 * image_asset_pointer whose asset_pointer is `sediment://<file_id>`, and
 * metadata.attachments carrying the descriptor. See buildParts/buildAttachment below.
 *
 * NOT captured as required: the app also fires POST /backend-api/files/upload_reservations
 * first. Its reservation_id (file_0000000011bc…) is NOT the id the turn ends up using
 * (file_00000000eedc…), and the send carries a metadata key literally named
 * `file_upload_slot_prefetch_attribution`. So that call is a speculative slot prefetch,
 * not part of the critical path, and is deliberately not replicated.
 *
 * Step 2 lives here rather than in the page for the same reason as qwen-upload.cjs: the
 * only way to hand bytes to page JavaScript is a base64 string literal through
 * executeJavaScript, which costs 1.33x inflation plus a same-size JS string. Node
 * streams the file off disk instead. The upload URL is a pre-signed Azure Blob URL on
 * oaiusercontent.com — a different origin from chatgpt.com, carrying its own signature
 * and needing no cookies — so unlike the image DOWNLOAD path (which Cloudflare only
 * accepts from inside the page) this genuinely can be done from outside.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL } = require('url');

// Enough to cover what gets attached in practice. Anything unlisted still uploads:
// the server is told application/octet-stream and makes its own call, which is better
// than refusing a file over a missing table entry.
const MIME = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', tif: 'image/tiff',
    tiff: 'image/tiff', heic: 'image/heic', avif: 'image/avif',
    pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown',
    csv: 'text/csv', json: 'application/json', xml: 'text/xml', yaml: 'text/yaml',
    yml: 'text/yaml', html: 'text/html', css: 'text/css', js: 'text/javascript',
    ts: 'text/typescript', py: 'text/x-python', java: 'text/x-java',
    c: 'text/x-c', cpp: 'text/x-c++', cs: 'text/x-csharp', go: 'text/x-go',
    rs: 'text/x-rust', rb: 'text/x-ruby', php: 'text/x-php', sh: 'text/x-sh',
    sql: 'application/x-sql', log: 'text/plain',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
};

const IMAGE_MIME = /^image\//;

function extOf(p) {
    const e = path.extname(String(p)).replace('.', '').toLowerCase();
    return e;
}

/** mime + whether this counts as an image, which decides the message shape. */
function classify(filePath) {
    const ext = extOf(filePath);
    const mime = MIME[ext] || 'application/octet-stream';
    return { ext, mime, isImage: IMAGE_MIME.test(mime) && mime !== 'image/svg+xml' };
}

/**
 * Throws unless the file exists and has bytes. No size ceiling is enforced: none was
 * measured, and inventing one would reject files the server would have taken. The
 * server's own limit is the authority, and it reports it.
 */
function validate(filePath) {
    if (!fs.existsSync(filePath)) throw new Error('ChatGPT: file not found: ' + filePath);
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error('ChatGPT: not a file: ' + filePath);
    if (stat.size === 0) throw new Error('ChatGPT: file is empty: ' + filePath);
    return stat;
}

/**
 * Pixel dimensions, read from the file's own header.
 *
 * The capture shows the client computing width/height locally and sending them in BOTH
 * the asset pointer and metadata.attachments — /files/{id}/simple does not return them.
 * Only the containers below are understood; anything else returns null, and the caller
 * omits the fields rather than sending a guess. A wrong size is worse than an absent
 * one: it is what the model uses to reason about the image.
 */
function imageSize(filePath, mime) {
    let fd;
    try {
        fd = fs.openSync(filePath, 'r');
        const buf = Buffer.alloc(32768);
        const read = fs.readSync(fd, buf, 0, buf.length, 0);
        const b = buf.slice(0, read);

        if (mime === 'image/png' && b.length > 24 && b.toString('hex', 0, 8) === '89504e470d0a1a0a') {
            return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
        }
        if (mime === 'image/gif' && b.length > 10 && b.toString('ascii', 0, 3) === 'GIF') {
            return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
        }
        if (mime === 'image/bmp' && b.length > 26 && b.toString('ascii', 0, 2) === 'BM') {
            return { width: b.readInt32LE(18), height: Math.abs(b.readInt32LE(22)) };
        }
        if (mime === 'image/webp' && b.length > 30 && b.toString('ascii', 0, 4) === 'RIFF') {
            const fmt = b.toString('ascii', 12, 16);
            if (fmt === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
            if (fmt === 'VP8L') {
                const bits = b.readUInt32LE(21);
                return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
            }
            if (fmt === 'VP8X') return { width: (b.readUIntLE(24, 3) + 1), height: (b.readUIntLE(27, 3) + 1) };
        }
        if (mime === 'image/jpeg' && b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
            // Walk the marker chain to a Start-Of-Frame, which is the only place the
            // dimensions live. SOF0..SOF15 except the four that are not frame headers.
            let i = 2;
            while (i + 9 < b.length) {
                if (b[i] !== 0xff) { i++; continue; }
                const marker = b[i + 1];
                if (marker >= 0xc0 && marker <= 0xcf &&
                    marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                    return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
                }
                const len = b.readUInt16BE(i + 2);
                if (len <= 0) break;
                i += 2 + len;
            }
        }
    } catch (e) {
        // Unreadable header is not a reason to fail the upload.
    } finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) { } }
    }
    return null;
}

/**
 * Step 2: stream the bytes to the pre-signed Azure Blob URL.
 *
 * x-ms-blob-type is mandatory — without it Azure answers 400 and the message names the
 * header, which is the one good error in this flow. A single PUT, matching the capture:
 * no ?comp=block / blockid / comp=blocklist anywhere, so block-list multipart is not
 * replicated. The captured file was 2.5MB; larger uploads are untested rather than
 * ruled out, and a large file failing where a small one works is the first thing to
 * suspect.
 */
function putToBlob(uploadUrl, filePath, size, contentType) {
    return new Promise((resolve, reject) => {
        const u = new URL(uploadUrl);
        const req = https.request({
            method: 'PUT',
            hostname: u.hostname,
            path: u.pathname + u.search,
            headers: {
                'Content-Type': contentType,
                'Content-Length': size,
                'x-ms-blob-type': 'BlockBlob',
                'x-ms-version': '2020-04-08'
            }
        }, (res) => {
            let body = '';
            res.on('data', (d) => { if (body.length < 2000) body += d.toString(); });
            res.on('end', () => {
                if (res.statusCode === 201 || res.statusCode === 200) return resolve(true);
                reject(new Error('ChatGPT blob PUT failed (' + res.statusCode + '): ' +
                    body.slice(0, 300)));
            });
        });
        req.on('error', reject);
        const stream = fs.createReadStream(filePath);
        stream.on('error', reject);
        stream.pipe(req);
    });
}

/**
 * The parts array for a turn that carries attachments.
 *
 * Captured shape, for an image: content_type 'multimodal_text', parts[0] an
 * image_asset_pointer, parts[1] the user's text — in that order, text LAST. The
 * asset_pointer carries the `sediment://` scheme, which is the same scheme the image
 * EXTRACTION path has to strip back off when reading generated images out of a reply.
 *
 * Non-image files were not captured. They are sent as plain text parts with the
 * descriptor in metadata.attachments only, which is the shape the extraction side
 * already expects to see for documents.
 */
function buildParts(message, uploads) {
    const images = uploads.filter((u) => u.isImage);
    if (!images.length) return { content_type: 'text', parts: [message] };
    const parts = images.map((u) => {
        const p = {
            content_type: 'image_asset_pointer',
            asset_pointer: 'sediment://' + u.fileId,
            size_bytes: u.size
        };
        if (u.width && u.height) { p.width = u.width; p.height = u.height; }
        return p;
    });
    parts.push(message);
    return { content_type: 'multimodal_text', parts: parts };
}

/** One entry of message.metadata.attachments. */
function buildAttachment(u) {
    const a = {
        id: u.fileId,
        size: u.size,
        name: u.name,
        mime_type: u.mime,
        source: 'local'
    };
    if (u.width && u.height) { a.width = u.width; a.height = u.height; }
    if (u.libraryFileId) a.library_file_id = u.libraryFileId;
    a.is_big_paste = false;
    return a;
}

module.exports = {
    classify,
    validate,
    imageSize,
    putToBlob,
    buildParts,
    buildAttachment,
    MIME
};
