/**
 * The ChatGPT attachment shapes, pinned against the capture they came from.
 *
 * Two things here are easy to get wrong in ways nothing reports:
 *
 *  - Dimensions. /files/{id}/simple does NOT return them, so they are read from the
 *    file's own header and sent in both the asset pointer and the descriptor. A wrong
 *    width is worse than an absent one: it is what the model reasons about the image
 *    with, and no layer validates it.
 *  - Part order. The captured turn puts the pointers FIRST and the text LAST. Reversing
 *    them still sends, still answers, and quietly changes what the model sees.
 *
 * Headers are built byte by byte rather than read off disk, so the test does not depend
 * on any file happening to exist.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const up = require('../../electron/providers/chatgpt-upload.cjs');

let fails = 0;
const ok = (c, l) => { console.log((c ? '  PASS  ' : '  FAIL  ') + l); if (!c) fails++; };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-upload-'));
const write = (name, buf) => { const p = path.join(tmp, name); fs.writeFileSync(p, buf); return p; };

// ── classify ──
ok(up.classify('x/diagram.png').isImage === true, 'png classifies as an image');
ok(up.classify('x/diagram.png').mime === 'image/png', 'png gets the right mime');
ok(up.classify('x/report.pdf').isImage === false, 'pdf is not an image');
ok(up.classify('x/notes.md').mime === 'text/markdown', 'md gets a text mime');
// SVG is image/* but is not a raster asset; treating it as one would send a pointer
// with no dimensions and no pixels behind it.
ok(up.classify('x/logo.svg').isImage === false, 'svg is NOT treated as a raster image');
ok(up.classify('x/thing.unknownext').mime === 'application/octet-stream',
    'an unknown extension still uploads, as octet-stream');

// ── PNG: IHDR at a fixed offset ──
const png = Buffer.alloc(33);
Buffer.from('89504e470d0a1a0a', 'hex').copy(png, 0);
png.write('IHDR', 12, 'ascii');
png.writeUInt32BE(1920, 16);
png.writeUInt32BE(1080, 20);
const pngPath = write('a.png', png);
const pngDim = up.imageSize(pngPath, 'image/png');
ok(pngDim && pngDim.width === 1920 && pngDim.height === 1080, 'PNG dimensions read from IHDR');

// ── GIF: little-endian, right after the signature ──
const gif = Buffer.alloc(16);
gif.write('GIF89a', 0, 'ascii');
gif.writeUInt16LE(800, 6);
gif.writeUInt16LE(600, 8);
const gifDim = up.imageSize(write('a.gif', gif), 'image/gif');
ok(gifDim && gifDim.width === 800 && gifDim.height === 600, 'GIF dimensions read');

// ── JPEG: must WALK the marker chain, not assume a fixed offset ──
// A JFIF APP0 segment sits before the SOF0 here precisely so a naive reader fails.
const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8]),                          // SOI
    Buffer.from([0xff, 0xe0, 0x00, 0x10]),              // APP0, length 16
    Buffer.from('JFIF\0', 'ascii'), Buffer.alloc(9),    // APP0 payload
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08]),        // SOF0, length 17, precision 8
    (() => { const b = Buffer.alloc(4); b.writeUInt16BE(768, 0); b.writeUInt16BE(1024, 2); return b; })(),
    Buffer.alloc(8)
]);
const jpgDim = up.imageSize(write('a.jpg', jpeg), 'image/jpeg');
ok(jpgDim && jpgDim.width === 1024 && jpgDim.height === 768,
    'JPEG dimensions found by walking past APP0 to SOF0');

// ── An unreadable header must not throw, and must not guess ──
ok(up.imageSize(write('junk.png', Buffer.from('not a png at all')), 'image/png') === null,
    'a corrupt header returns null rather than a guess');

// ── validate ──
let threw = false;
try { up.validate(path.join(tmp, 'does-not-exist.png')); } catch (e) { threw = true; }
ok(threw, 'a missing file is rejected before any byte goes out');
threw = false;
try { up.validate(write('empty.png', Buffer.alloc(0))); } catch (e) { threw = true; }
ok(threw, 'an empty file is rejected');

// ── message shapes ──
const imgUp = { fileId: 'file_abc', size: 1813462, name: 'd.png', mime: 'image/png',
    isImage: true, width: 1920, height: 1080, libraryFileId: 'libfile_x' };
const docUp = { fileId: 'file_doc', size: 4096, name: 'r.pdf', mime: 'application/pdf',
    isImage: false, width: null, height: null, libraryFileId: null };

const c = up.buildParts('describe this', [imgUp]);
ok(c.content_type === 'multimodal_text', 'an image turn is multimodal_text');
ok(c.parts[0].content_type === 'image_asset_pointer', 'the pointer comes FIRST');
ok(c.parts[0].asset_pointer === 'sediment://file_abc', 'the pointer carries the sediment:// scheme');
ok(c.parts[c.parts.length - 1] === 'describe this', 'the text comes LAST');
ok(c.parts[0].width === 1920 && c.parts[0].height === 1080, 'dimensions ride on the pointer');

const d = up.buildParts('summarise', [docUp]);
ok(d.content_type === 'text', 'a document-only turn stays plain text');
ok(d.parts.length === 1 && d.parts[0] === 'summarise', 'and carries just the message');

const att = up.buildAttachment(imgUp);
ok(att.id === 'file_abc' && att.source === 'local', 'descriptor id and source');
ok(att.library_file_id === 'libfile_x', 'library_file_id is carried when known');
const attDoc = up.buildAttachment(docUp);
ok(!('width' in attDoc) && !('height' in attDoc),
    'dimensions are OMITTED rather than sent as null when unknown');
ok(!('library_file_id' in attDoc), 'library_file_id is omitted when absent');

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
console.log(fails ? '\n' + fails + ' FAILURE(S)' : '\nall chatgpt upload assertions passed');
process.exit(fails ? 1 : 0);
