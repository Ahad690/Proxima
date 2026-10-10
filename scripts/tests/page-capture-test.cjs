/**
 * The shared capture sanitizer (tools/orchestrate/lib/page-capture.cjs), tested against
 * the credential shapes each provider actually produces. capture.cjs and chatgpt-audio.cjs
 * both label their output "sanitized"; this is what makes that true.
 *
 * History that put these cases here: an earlier ChatGPT-only capture scrubbed headers and
 * request URLs but not response BODIES, and shipped an Azure SAS upload URL with sig=
 * intact. Its first fix then swallowed the backslash of a JSON-escaped \" and corrupted
 * the file. Both are pinned below, plus the shapes of the other providers.
 */
const cap = require('../../tools/orchestrate/lib/page-capture.cjs');

let fails = 0;
const ok = (c, l) => { console.log((c ? '  PASS  ' : '  FAIL  ') + l); if (!c) fails++; };
const clean = (s, origin) => cap.capCleanText(s, 0, origin || 'https://chatgpt.com');
const leaks = (s) => cap.scan(s);

const SAS = 'https://sdmntprindiasocentral.oaiusercontent.com/files/00000000-bbb0/raw?se=2026-10-10T13%3A51%3A00Z&sp=cw&sv=2024-08-04&sr=b&skoid=abc&sig=Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA%3D%3D';
const OSS = 'https://qwen-webui-prod.oss-accelerate.aliyuncs.com/u/f.mp3?OSSAccessKeyId=STS.NUabcd1234&Expires=1790000000&Signature=abc%2Fdef%3D&security-token=CAIS1234567890';

// --- ChatGPT: Azure SAS in a response body, raw and JSON-in-JSON -------------------------
let out = clean(JSON.stringify({ status: 'success', upload_url: SAS, file_id: 'file_x' }));
ok(!/sig=Zm9v/.test(out) && leaks(out).length === 0, 'Azure SAS sig= removed from a response body');
out = clean(JSON.stringify(JSON.stringify({ upload_url: SAS })));
let parses = true; try { JSON.parse(out); } catch (e) { parses = false; }
ok(parses && !/sig=Zm9v/.test(out), 'JSON nested in a JSON string: SAS removed AND still valid JSON');

// --- Qwen: Alibaba OSS signed URL ---------------------------------------------------------
out = clean('{"url":"' + OSS + '"}', 'https://chat.qwen.ai');
ok(!/Signature=abc|OSSAccessKeyId=STS|security-token=CAIS/.test(out), 'Alibaba OSS signature, key id and STS token removed');

// --- Gemini: XSRF token in a form-encoded body ---------------------------------------------
out = clean('f.req=%5B%5B%22x%22%5D%5D&at=AJvLN6M3xYzQ9kExampleXsrfToken123%3A1790000000000&', 'https://gemini.google.com');
ok(/at=<removed>/.test(out) && /f\.req=/.test(out), 'Gemini at= XSRF token removed, f.req payload kept');
out = clean('/_/BardChatUi/data/batchexecute?rpcids=x&f.sid=-123456789012345&bl=boq_x', 'https://gemini.google.com');
ok(/f\.sid=<removed>/.test(out) && /rpcids=x/.test(out), 'Gemini f.sid session id removed, rpcids kept');

// --- generic shapes -----------------------------------------------------------------------
out = clean('{"x":"eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVlLWhlcmU"}');
ok(out === '{"x":"<jwt>"}', 'JWT masked');
out = clean('{"conduit_token":"abcdef0123456789xyz","accessToken":"zzzzzzzzzzzzzzzzzz"}');
ok(/"conduit_token":"<redacted>"/.test(out) && /"accessToken":"<redacted>"/.test(out), 'secret-named JSON fields redacted');
out = clean('{"user":{"email":"someone.real@example.com"}}');
ok(/<email>/.test(out) && !/example\.com/.test(out), 'email address masked');
out = clean('{"full_name":"Real Person","display_name":"Real","statsigContext":{"deviceId":"0b2f8c1e-aaaa-bbbb-cccc-111122223333","region":"Somewhere, Earth"}}');
ok(!/Real Person|"Real"|0b2f8c1e|Somewhere/.test(out) && (out.match(/<pii>/g) || []).length === 4,
    'personal fields (full_name, display_name, deviceId, region) masked');
out = clean('{"data":[{"id":"qwen3.8-max","name":"Qwen3.8-Max","owned_by":"qwen"}]}', 'https://chat.qwen.ai');
ok(/"name":"Qwen3\.8-Max"/.test(out), 'plain "name" is kept, so model names survive');
out = clean('{"blob":"' + 'A'.repeat(80) + '"}');
ok(/<long-opaque>/.test(out), 'long opaque strings masked');

// --- what must NOT be destroyed -----------------------------------------------------------
out = clean('{"u":"https://chatgpt.com/backend-api/files/download/file_x?conversation_id=abc"}');
ok(/conversation_id=abc/.test(out), 'an own-origin URL keeps its ordinary query parameters');
out = clean('{"format":"mp3","state":"done","first":"x"}');
ok(out === '{"format":"mp3","state":"done","first":"x"}', 'words containing "at"/"st"/"se" are not mangled');
ok(cap.capCleanUrl('https://claude.ai/api/organizations/abc/chat_conversations?limit=5', 'https://claude.ai')
    === '/api/organizations/abc/chat_conversations?limit=5', 'own-origin request URL becomes a clean path');
ok(cap.capCleanUrl(SAS, 'https://chatgpt.com').indexOf('?<signed params removed>') !== -1,
    'other-origin request URL loses its query');

// --- headers -----------------------------------------------------------------------------
const h = cap.capCleanHeaders({
    Authorization: 'Bearer abc', Cookie: 'a=b', 'bx-ua': 'x', 'x-xsrf-token': 'y',
    'openai-sentinel-proof-token': 'z', 'x-conduit-token': 'q', 'content-type': 'application/json'
}, 'https://chatgpt.com');
ok(['Authorization', 'Cookie', 'bx-ua', 'x-xsrf-token', 'openai-sentinel-proof-token', 'x-conduit-token']
    .every((k) => h[k] === '<redacted>'), 'auth, cookie, Qwen bx-*, XSRF, sentinel and conduit headers redacted');
ok(h['content-type'] === 'application/json', 'ordinary headers kept');

// --- the scanner is the last gate: it must SEE a leak --------------------------------------
ok(leaks(SAS).some((x) => x.check === 'signed-URL parameter'), 'scanner catches a raw SAS sig=');
ok(leaks('at=AJvLN6M3xYzQ9kExampleXsrf').some((x) => x.check === 'session/XSRF parameter'), 'scanner catches a raw at= token');
ok(leaks('mail me at someone.real@example.com').some((x) => x.check === 'email address'), 'scanner catches an email');
ok(leaks(clean(JSON.stringify({ upload_url: SAS, user: 'a@b.co' }))).length === 0, 'scanner is quiet on sanitized output');

console.log(fails ? '\n' + fails + ' FAILURE(S)' : '\nall page-capture sanitizer assertions passed');
process.exit(fails ? 1 : 0);
