#!/usr/bin/env node
/**
 * Send an audio file to ChatGPT and get its answer — by having the REAL web app send it.
 *
 *   node chatgpt-audio.cjs --file clip.mp3 --message "Transcribe this." [--capture out.har]
 *
 * WHY THE APP AND NOT THE ENGINE. Measured 2026-10-10, same mp3, same question,
 * gpt-6-thinking:
 *   real app, driven through its own composer        -> heard it  (WORD=pineapple NUMBER=47)
 *   Proxima engine, app's exact upload bodies          -> CANNOT_HEAR
 *   Proxima engine, use_case 'multimodal'              -> CANNOT_HEAR
 * The server stored all three user turns IDENTICALLY (multimodal_text, text then
 * audio_asset_pointer). So it is not the upload and not the message: it is how the turn
 * is invoked. The app posts to /backend-api/f/conversation behind a prepare/conduit_token
 * and two-step sentinel handshake; the engine still uses the older /backend-api/conversation,
 * where the model can see the file but not hear it. Until the engine speaks /f/, driving
 * the app is the path that works — and it needs no Proxima restart.
 *
 * WHAT IT TOUCHES. The ChatGPT tab inside Proxima: it opens a new chat there, attaches the
 * file through the app's general-purpose file input, types the message, sends, and reads
 * the reply back through the API. It does not touch any other provider. Do not run it
 * while something else is driving ChatGPT: there is one tab.
 *
 * Output: the reply on stdout; progress on stderr. Exit 0 = a reply was read back,
 * 2 = the UI or the app refused (message says which step and what was seen),
 * 1 = transport/argument error, 3 = --capture refused to write (output looked unsanitized).
 *
 * Recording uses the same in-page recorder and sanitizer as capture.cjs
 * (lib/page-capture.cjs) — one copy, so the two cannot drift apart.
 */
const net = require('net');
const fs = require('fs');
const path = require('path');
const { resolvePortSync } = require('../../scripts/lib/proxima-port.cjs');
const cap = require('./lib/page-capture.cjs');

const MIME = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac',
    ogg: 'audio/ogg', oga: 'audio/ogg', flac: 'audio/flac', webm: 'audio/webm', opus: 'audio/ogg' };

function parseArgs(argv) {
    const a = { file: null, message: null, capture: null, timeoutMs: 420000 };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i], v = argv[i + 1];
        if (k === '--file') { a.file = path.resolve(v); i++; }
        else if (k === '--message') { a.message = v; i++; }
        else if (k === '--message-file') { a.message = fs.readFileSync(v, 'utf8'); i++; }
        else if (k === '--capture') { a.capture = path.resolve(v); i++; }
        else if (k === '--timeout-ms') { a.timeoutMs = Number(v); i++; }
        else if (k === '-h' || k === '--help') { a.help = true; }
    }
    return a;
}

function ipc(port, req, ms) {
    return new Promise((res, rej) => {
        const s = net.createConnection(port, '127.0.0.1');
        let b = '';
        const t = setTimeout(() => { s.destroy(); rej(new Error('Proxima did not answer within ' + ms + 'ms')); }, ms);
        s.on('connect', () => s.write(JSON.stringify(Object.assign({ requestId: String(Date.now()) }, req)) + '\n'));
        s.on('data', (d) => {
            b += d.toString();
            const i = b.indexOf('\n');
            if (i === -1) return;
            clearTimeout(t); s.end();
            try { res(JSON.parse(b.slice(0, i))); } catch (e) { rej(e); }
        });
        s.on('error', (e) => { clearTimeout(t); rej(e); });
    });
}

async function page(port, script, ms) {
    const r = await ipc(port, { action: 'executeScript', provider: 'chatgpt', data: { script } }, ms);
    if (r && r.success === false) throw new Error(r.error || 'executeScript failed');
    return r.result !== undefined ? r.result : r.data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The in-page driver. It assumes the shared recorder is already installed, and reads its
// log to know when the app's own upload has started and finished.
function driverScript(b64, name, mime, message) {
    return `(async function () {
  var B64 = ${JSON.stringify(b64)}, NAME = ${JSON.stringify(name)}, MIME = ${JSON.stringify(mime)};
  var MSG = ${JSON.stringify(message)};
  var C = window.__proximaCapture;
  if (!C) return JSON.stringify({ step: 'start', error: 'recorder not installed' });
  var origFetch = C.origFetch;
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var seen = function (re, status) {
    return C.log.some(function (e) { return re.test(e.url) && (status === undefined || e.status === status); });
  };

  var out = { step: 'start' };
  try {
    var bin = atob(B64), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    var file = new File([bytes], NAME, { type: MIME });

    // The app has several hidden file inputs; the image ones declare accept="image/*".
    // The general one declares no accept at all, and is the one "Add files" uses.
    //
    // Seconds after a reload the composer is VISIBLE before the app has wired up its file
    // input, and a change event dispatched then is silently ignored: measured, a run
    // straight after a reload sat for 90s with no upload ever starting. So confirm the
    // upload actually STARTED (POST /backend-api/files) and re-attach if it did not.
    out.step = 'attach';
    var started = false;
    for (var attempt = 1; attempt <= 3 && !started; attempt++) {
      var general = Array.prototype.slice.call(document.querySelectorAll('input[type=file]'))
        .filter(function (el) { return !el.getAttribute('accept'); })[0];
      if (!general) { await sleep(2000); continue; }
      var dt = new DataTransfer(); dt.items.add(file);
      general.files = dt.files;
      general.dispatchEvent(new Event('input', { bubbles: true }));
      general.dispatchEvent(new Event('change', { bubbles: true }));
      var ta = Date.now();
      while (Date.now() - ta < 15000) {
        await sleep(500);
        if (C.log.some(function (e) { return e.method === 'POST' && /\\/backend-api\\/files$/.test(e.url); })) { started = true; break; }
      }
      out.attachAttempts = attempt;
    }
    if (!started) throw new Error('the app never started an upload after 3 attach attempts (file input not wired up, or UI changed)');

    out.step = 'upload';
    var t0 = Date.now(), uploaded = false;
    while (Date.now() - t0 < 90000) {
      await sleep(1000);
      if (seen(/process_upload_stream/, 200)) { uploaded = true; break; }
      if (/isn.t supported|not supported|unsupported file|can.t upload|cannot upload|too large/i.test(document.body.innerText)) {
        throw new Error('the app rejected the file: ' + document.body.innerText.slice(0, 200));
      }
    }
    if (!uploaded) throw new Error('the app did not finish uploading within 90s');

    out.step = 'type';
    var pm = document.querySelector('.ProseMirror[contenteditable=true]');
    if (!pm) throw new Error('composer not found (UI changed?)');
    pm.focus();
    document.execCommand('insertText', false, MSG);

    out.step = 'send';
    var btn = null, t1 = Date.now();
    while (Date.now() - t1 < 30000) {
      btn = document.querySelector('[data-testid="send-button"]') ||
            Array.prototype.slice.call(document.querySelectorAll('button')).filter(function (b) {
              return /send/i.test(b.getAttribute('aria-label') || '');
            })[0];
      if (btn && !btn.disabled) break;
      await sleep(500);
    }
    if (!btn || btn.disabled) throw new Error('send button never became enabled');
    btn.click();

    out.step = 'await reply';
    var conv = null, t2 = Date.now();
    while (Date.now() - t2 < 60000 && !conv) {
      await sleep(1000);
      conv = (location.pathname.match(/\\/c\\/([0-9a-f-]{36})/) || [])[1] || null;
    }
    if (!conv) throw new Error('no conversation id appeared after sending');
    out.conversationId = conv;

    // Read the answer back from the API rather than the DOM. Poll: the assistant message
    // is persisted only after the stream finishes, and an early read finds nothing.
    // origFetch, so the read-back is not itself recorded.
    var sess = await origFetch('/api/auth/session', { credentials: 'include' }).then(function (r) { return r.json(); });
    var h = { 'Authorization': 'Bearer ' + sess.accessToken };
    if (sess.account && sess.account.id) h['ChatGPT-Account-Id'] = sess.account.id;
    var t3 = Date.now();
    while (Date.now() - t3 < 300000) {
      await sleep(3000);
      var j = await origFetch('/backend-api/conversation/' + conv, { credentials: 'include', headers: h })
        .then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
      if (!j) continue;
      var msgs = Array.isArray(j.messages) ? j.messages
               : Object.keys(j.mapping || {}).map(function (k) { return j.mapping[k].message; });
      msgs = msgs.filter(Boolean);
      var finals = msgs.filter(function (m) {
        return m.author && m.author.role === 'assistant' && m.channel === 'final' &&
               m.content && m.content.content_type === 'text' &&
               (m.content.parts || []).join('').trim();
      });
      if (finals.length) {
        var last = finals[finals.length - 1];
        out.reply = (last.content.parts || []).join('');
        out.model = last.metadata && last.metadata.model_slug || null;
        var user = msgs.filter(function (m) { return m.author && m.author.role === 'user'; })[0] || {};
        out.audioPointer = JSON.stringify(user.content || {}).indexOf('audio_asset_pointer') !== -1;
        break;
      }
    }
    if (!out.reply) throw new Error('no reply was stored within 5 minutes');
    out.step = 'done';
  } catch (e) {
    out.error = String(e && e.message || e);
  }
  return JSON.stringify(out);
})()`;
}

/** Same gate as capture.cjs: second-pass scrub, parse guard, scan, then write or refuse. */
function writeCapture(entries, origin, out) {
    let text = cap.scrub(JSON.stringify(cap.toHar(entries, { origin, startedAt: Date.now() }), null, 2), origin);
    JSON.parse(text);
    const hits = cap.scan(text);
    if (hits.length) {
        console.error('[chatgpt-audio] REFUSED to write the capture — it still looks unsanitized:');
        hits.forEach((x) => console.error('    ' + x.check + ' x' + x.count));
        return false;
    }
    fs.writeFileSync(out, text);
    console.error('[chatgpt-audio] sanitized capture (' + entries.length + ' requests, scan clean): ' + out);
    return true;
}

(async () => {
    const args = parseArgs(process.argv);
    if (args.help || !args.file || !args.message) {
        console.error('usage: node chatgpt-audio.cjs --file <audio> --message "<question>" [--capture out.har]');
        process.exit(args.help ? 0 : 1);
    }
    if (!fs.existsSync(args.file)) { console.error('file not found: ' + args.file); process.exit(1); }
    const ext = path.extname(args.file).slice(1).toLowerCase();
    const mime = MIME[ext];
    if (!mime) { console.error('not an audio type this tool knows: .' + ext); process.exit(1); }

    const port = resolvePortSync();
    const b64 = fs.readFileSync(args.file).toString('base64');

    // A fresh chat, so the turn cannot land in a thread somebody else is using. Done as
    // its own call: a navigation reloads the page and would kill a running driver.
    console.error('[chatgpt-audio] opening a new chat in Proxima\'s ChatGPT tab');
    await page(port, "(function(){ location.assign('/'); return 'ok'; })()", 30000).catch(() => {});
    let ready = false;
    for (let i = 0; i < 30 && !ready; i++) {
        await sleep(1000);
        ready = await page(port, "(function(){ return !!document.querySelector('.ProseMirror[contenteditable=true]') && location.pathname === '/'; })()", 10000)
            .then((v) => v === true || v === 'true').catch(() => false);
    }
    if (!ready) { console.error('[chatgpt-audio] the ChatGPT tab never showed a composer'); process.exit(2); }
    // Visible is not wired up. Give the app a moment to finish booting before driving it.
    await sleep(4000);

    await page(port, cap.pageScript('capInstall(location.origin, 8000)'), 15000);

    console.error('[chatgpt-audio] attaching ' + path.basename(args.file) + ' (' + mime + ') and sending');
    const t0 = Date.now();
    let o;
    try {
        o = JSON.parse(await page(port, driverScript(b64, path.basename(args.file), mime, args.message), args.timeoutMs));
    } finally {
        // Collect whatever the recorder saw, then always take it back out of the page.
        var drained = await page(port, cap.pageDrainScript(true, 5000), 30000).then((v) => JSON.parse(v)).catch(() => null);
        await page(port, cap.pageScript('capUninstall()'), 15000).catch(() => {});
    }
    const entries = (drained && drained.entries) || [];
    const secs = ((Date.now() - t0) / 1000).toFixed(1);

    let captureOk = true;
    if (args.capture && entries.length) captureOk = writeCapture(entries, drained.origin, args.capture);

    if (o.error) {
        console.error('[chatgpt-audio] FAILED at step "' + o.step + '": ' + o.error);
        // What the app did get as far as, so a failure is diagnosable without a rerun.
        entries.forEach((e) => console.error('    seen: ' + e.method + ' ' + (e.status || '...') + ' ' + String(e.url).slice(0, 90)));
        process.exit(2);
    }
    console.error('[chatgpt-audio] ' + secs + 's | model ' + o.model + ' | thread ' + o.conversationId +
        ' | audio pointer stored: ' + o.audioPointer);
    process.stdout.write(o.reply + '\n\n_conversation_id: ' + o.conversationId + '_\n');
    process.exit(captureOk ? 0 : 3);
})().catch((e) => { console.error('[chatgpt-audio] ' + e.message); process.exit(1); });
