#!/usr/bin/env node
/**
 * Record what a site's web app actually sends, from inside any Proxima provider tab, and
 * write it as a sanitized HAR. The replacement for "open DevTools, reproduce, export HAR".
 *
 *   node capture.cjs --provider <name> --seconds 90            record for 90s, then write
 *   node capture.cjs --provider <name> --stop-file <path>      record until <path> exists
 *   node capture.cjs --provider <name> --start                 install and return
 *   node capture.cjs --provider <name> --stop                  collect what --start saw
 *   node capture.cjs --provider <name> --status                is a recorder running here?
 *
 *   --out <file>     default ./proxima-capture-<provider>-<timestamp>.har
 *   --max-body <n>   characters kept per request/response body (default 8000)
 *   --init           load the provider's tab first if Proxima has not (costs memory)
 *
 * <name> is any provider Proxima has a tab for: chatgpt, claude, qwen, gemini, perplexity.
 * Nothing in here is specific to one of them — the page's own origin decides what is
 * first-party, and the recorder wraps fetch and XMLHttpRequest the same way everywhere.
 *
 * Use --seconds or --stop-file for anything that might navigate. A full page load wipes a
 * recorder that lives in the page, so those modes drain it to this process every 2s and
 * reinstall it after a reload; a reload costs at most the requests in flight across it,
 * and the output says when one happened. --start/--stop has no process in between and
 * cannot survive a reload — fine for single-page flows, wrong for anything else.
 *
 * What triggers the traffic is up to you: click through the flow in Proxima's window, or
 * run another tool against that tab while this records. Proxima's own engines run in the
 * page's world, so their requests are captured too.
 *
 * Every write is scrubbed a second time in Node and then SCANNED. If the scan still finds
 * something that looks like a credential or an email address, nothing is written and the
 * exit code is 3. That gate exists because "sanitized" has been wrong before.
 *
 * Exit: 0 written · 1 argument/transport error · 2 nothing captured or provider not loaded ·
 *       3 refused to write: output still looked unsanitized after both passes.
 */
const net = require('net');
const fs = require('fs');
const path = require('path');
const { resolvePortSync } = require('../../scripts/lib/proxima-port.cjs');
const cap = require('./lib/page-capture.cjs');

function parseArgs(argv) {
    const a = { provider: null, mode: null, seconds: null, stopFile: null, out: null, maxBody: 8000, init: false };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i], v = argv[i + 1];
        if (k === '--provider') { a.provider = String(v || '').toLowerCase(); i++; }
        else if (k === '--seconds') { a.mode = 'timed'; a.seconds = Number(v); i++; }
        else if (k === '--stop-file') { a.mode = 'timed'; a.stopFile = path.resolve(v); i++; }
        else if (k === '--start') a.mode = 'start';
        else if (k === '--stop') a.mode = 'stop';
        else if (k === '--status') a.mode = 'status';
        else if (k === '--out') { a.out = path.resolve(v); i++; }
        else if (k === '--max-body') { a.maxBody = Number(v); i++; }
        else if (k === '--init') a.init = true;
        else if (k === '-h' || k === '--help') a.help = true;
    }
    return a;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (m) => console.error('[capture] ' + m);

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

async function inPage(port, provider, script, ms) {
    const r = await ipc(port, { action: 'executeScript', provider, data: { script } }, ms || 30000);
    if (r && r.success === false) throw new Error(r.error || 'executeScript failed');
    const v = r.result !== undefined ? r.result : r.data;
    return typeof v === 'string' ? JSON.parse(v) : v;
}

/**
 * Fail fast on a provider Proxima has not loaded. Measured: an executeScript against an
 * unloaded tab does not error, it hangs until the caller's timeout.
 */
async function ensureLoaded(port, provider, init) {
    const st = await ipc(port, { action: 'getStatus' }, 15000);
    const loaded = (st && st.providers) || [];
    if (loaded.indexOf(provider) !== -1) return true;
    if (!init) {
        say(provider + ' is not loaded in Proxima (loaded: ' + (loaded.join(', ') || 'none') + ').');
        say('Pass --init to load it (it costs memory), or open it in Proxima first.');
        return false;
    }
    say('loading ' + provider + ' in Proxima...');
    await ipc(port, { action: 'initProvider', provider }, 30000);
    for (let i = 0; i < 40; i++) {
        await sleep(1000);
        const ok = await inPage(port, provider, 'JSON.stringify(document.readyState === "complete" && !!location.origin)', 5000)
            .catch(() => false);
        if (ok === true) return true;
    }
    say(provider + ' tab never finished loading');
    return false;
}

function defaultOut(provider) {
    const ts = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    return path.resolve('proxima-capture-' + provider + '-' + ts + '.har');
}

/** Second-pass scrub, parse guard, leak scan, then — and only then — write. */
function writeHar(entries, meta, out) {
    const har = cap.toHar(entries, meta);
    let text = cap.scrub(JSON.stringify(har, null, 2), meta.origin);
    JSON.parse(text);   // a scrub that broke the JSON must not be written
    const hits = cap.scan(text);
    if (hits.length) {
        say('REFUSED TO WRITE: the output still looks like it contains secrets after both passes:');
        hits.forEach((h) => say('  ' + h.check + ' x' + h.count + '  (e.g. ' + h.sample + ')'));
        say('Nothing was written. Tighten capCleanText in lib/page-capture.cjs for this shape.');
        return 3;
    }
    fs.writeFileSync(out, text);
    const counts = {};
    entries.forEach((e) => {
        const k = e.method + ' ' + String(e.url).split('?')[0].replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, '{uuid}').slice(0, 70);
        counts[k] = (counts[k] || 0) + 1;
    });
    say('wrote ' + entries.length + ' request(s) from ' + meta.origin + ' -> ' + out);
    say('scan: clean on all ' + Object.keys(cap.LEAK_CHECKS).length + ' checks');
    Object.keys(counts).sort((x, y) => counts[y] - counts[x]).slice(0, 15)
        .forEach((k) => console.error('    ' + String(counts[k]).padStart(3) + '  ' + k));
    return 0;
}

(async () => {
    const a = parseArgs(process.argv);
    if (a.help || !a.provider || !a.mode) {
        console.error('usage: node capture.cjs --provider <name> (--seconds N | --stop-file F | --start | --stop | --status) [--out file.har]');
        process.exit(a.help ? 0 : 1);
    }
    if (a.mode === 'timed' && !(a.seconds > 0) && !a.stopFile) { console.error('--seconds needs a positive number'); process.exit(1); }
    const port = resolvePortSync();
    if (!(await ensureLoaded(port, a.provider, a.init))) process.exit(2);
    const out = a.out || defaultOut(a.provider);
    const install = cap.pageScript('capInstall(location.origin, ' + Number(a.maxBody) + ')');

    if (a.mode === 'status') {
        const s = await inPage(port, a.provider,
            'JSON.stringify(window.__proximaCapture ? { running: true, origin: window.__proximaCapture.origin, ' +
            'held: window.__proximaCapture.log.length, sinceSec: Math.round((Date.now() - window.__proximaCapture.startedAt) / 1000) } : { running: false })');
        console.log(JSON.stringify(s));
        process.exit(0);
    }

    if (a.mode === 'start') {
        const r = await inPage(port, a.provider, install);
        say((r.state === 'already' ? 'already recording' : 'recording') + ' in ' + r.origin +
            '. Note: a page reload ends it; use --seconds or --stop-file for flows that navigate.');
        process.exit(0);
    }

    if (a.mode === 'stop') {
        const d = await inPage(port, a.provider, cap.pageDrainScript(true, 5000), 30000);
        if (d.missing) {
            say('no recorder in the ' + a.provider + ' tab: never started, or the page reloaded since --start.');
            process.exit(2);
        }
        await inPage(port, a.provider, cap.pageScript('capUninstall()')).catch(() => {});
        if (!d.entries.length) { say('the recorder ran but saw no requests'); process.exit(2); }
        process.exit(writeHar(d.entries, { origin: d.origin, startedAt: d.startedAt }, out));
    }

    // timed: install, drain every 2s, survive reloads, stop on time or on the stop file.
    let meta = null;
    const all = [];
    const reloads = [];
    const deadline = a.seconds ? Date.now() + a.seconds * 1000 : Infinity;
    const r0 = await inPage(port, a.provider, install);
    meta = { origin: r0.origin, startedAt: Date.now() };
    say('recording in ' + r0.origin + (a.seconds ? ' for ' + a.seconds + 's' : ' until ' + a.stopFile + ' exists') +
        ' — trigger the flow in Proxima\'s ' + a.provider + ' tab now');
    let lastTick = 0;
    while (Date.now() < deadline && !(a.stopFile && fs.existsSync(a.stopFile))) {
        await sleep(2000);
        let d;
        try { d = await inPage(port, a.provider, cap.pageDrainScript(false, 0), 15000); }
        catch (e) { say('drain failed (' + e.message + '), retrying'); continue; }
        if (d.missing) {
            // The page reloaded: the recorder went with it. Put it back.
            reloads.push(new Date().toISOString());
            say('page reloaded — recorder reinstalled; requests in flight across the reload were missed');
            await inPage(port, a.provider, install).catch(() => {});
            continue;
        }
        all.push.apply(all, d.entries);
        if (Date.now() - lastTick > 10000) { say(all.length + ' request(s) so far'); lastTick = Date.now(); }
    }
    const d = await inPage(port, a.provider, cap.pageDrainScript(true, 5000), 30000).catch(() => ({ entries: [] }));
    if (d && d.entries) all.push.apply(all, d.entries);
    await inPage(port, a.provider, cap.pageScript('capUninstall()')).catch(() => {});
    if (a.stopFile && fs.existsSync(a.stopFile)) { try { fs.unlinkSync(a.stopFile); } catch (e) { /* not ours to keep */ } }
    if (!all.length) { say('no requests seen'); process.exit(2); }
    all.sort((x, y) => x.t - y.t);
    if (reloads.length) meta.note = 'Page reloaded ' + reloads.length + ' time(s) during capture: ' + reloads.join(', ') + '.';
    process.exit(writeHar(all, meta, out));
})().catch((e) => { say(e.message); process.exit(1); });
