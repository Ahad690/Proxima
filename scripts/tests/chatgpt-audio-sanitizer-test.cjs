/**
 * chatgpt-audio.cjs ships a sanitizer that runs INSIDE the page, and its --capture output is
 * labelled sanitized. The first version scrubbed headers and request URLs but not response
 * BODIES, and the upload_url in a /backend-api/files response is an Azure SAS whose sig= is
 * the credential: a capture shipped with one intact. A second attempt then swallowed the
 * backslash of a JSON-escaped \" and corrupted the file. Both are pinned here, against the
 * sanitizer exactly as the tool generates it (template-literal escapes resolved).
 */
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '../../tools/orchestrate/chatgpt-audio.cjs'), 'utf8');
const start = src.indexOf('  function cleanText(s, max) {');
const end = src.indexOf('  function cleanHeaders(h) {');
const generated = eval('`' + src.slice(start, end).replace(/`/g, '\`') + '`');
const cleanText = new Function(generated + '; return cleanText;')();

const sas = 'https://sdmntprindiasocentral.oaiusercontent.com/files/00000000-bbb0/raw?se=2026-10-10T13%3A51%3A00Z&sp=cw&sv=2024-08-04&sr=b&skoid=abc&sig=Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA%3D%3D';
const cases = [
    ['raw JSON body', JSON.stringify({ status: 'success', upload_url: sas, file_id: 'file_x' })],
    ['JSON nested in a JSON string', JSON.stringify(JSON.stringify({ upload_url: sas }))],
    ['a chatgpt.com URL keeps its query', '{"u":"https://chatgpt.com/backend-api/files/download/file_x?conversation_id=abc"}'],
    ['JWT', '{"x":"eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVlLWhlcmU"}'],
    ['token-named field', '{"conduit_token":"abcdef0123456789xyz"}']
];
let fail = 0;
for (const [label, input] of cases) {
    const out = cleanText(input, 100000);
    const leaked = /sig=(?!<removed>)[^&"\<\s]{4,}/.test(out) || /eyJ[A-Za-z0-9_-]{8,}\./.test(out) ||
        /"conduit_token":"(?!<redacted>)/.test(out);
    const keptChatgpt = label.indexOf('chatgpt.com') === -1 || out.indexOf('conversation_id=abc') !== -1;
    let parses = true;
    if (label.indexOf('JSON') !== -1) { try { JSON.parse(out); } catch (e) { parses = false; } }
    const ok = !leaked && keptChatgpt && parses;
    if (!ok) fail++;
    console.log((ok ? 'PASS  ' : 'FAIL  ') + label.padEnd(36) + (leaked ? ' LEAKED' : '') +
        (!parses ? ' BROKE-JSON' : '') + (!keptChatgpt ? ' OVER-REDACTED' : '') + '  -> ' + out.slice(0, 90));
}
console.log(fail ? '\n' + fail + ' FAILURE(S)' : '\nall sanitizer assertions passed');
process.exit(fail ? 1 : 0);
