#!/usr/bin/env node
/**
 * Proxima QA — CDP screencast recorder
 *
 * Records a Chrome tab to mp4 by attaching to an existing browser's debug port.
 * Deliberately NOT tied to any one automation library: it only needs
 * --remote-debugging-port, which chrome-devtools MCP, Playwright MCP and Puppeteer
 * all expose. The agent drives the app with whatever tooling it already has and this
 * records the same tab, rather than the recorder owning the browser.
 *
 * Why CDP screencast rather than a desktop grab (ffmpeg gdigrab):
 *   - captures ONLY the tab, so no stray windows, notification toasts or wallpaper
 *     end up in a video an LLM is about to reason over;
 *   - works headless and on CI, where there is no desktop to grab;
 *   - frames carry CDP timestamps, so real timing survives (see below).
 *
 * TIMING, which is the whole trick here: screencast emits a frame when something
 * CHANGES, not on a clock. Encoding those at a fixed fps would squeeze a 4-second
 * spinner into two frames of playback and destroy exactly what a QA reviewer needs
 * to see. So each frame's true duration is derived from its neighbour's timestamp
 * and fed to ffmpeg's concat demuxer, making the mp4 run at wall-clock speed.
 *
 * usage:
 *   node record-cdp.cjs --out run.mp4 [--port 9222] [--url-filter localhost]
 *                       [--new-tab URL] [--target ws://...] [--allow-any-tab]
 *                       [--network net.json] [--network-bodies] [--network-headers-raw]
 *                       [--dom final.html] [--console log.json]
 *                       [--quality 70] [--max-width 1280] [--max-seconds 300]
 *                       [--stop-file .stop] [--keep-frames] [--navigate URL]
 *
 * Stops on: --max-seconds, the appearance of --stop-file, or SIGINT/SIGTERM.
 * Prints a one-line JSON summary to stdout on exit; progress goes to stderr.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cdpTarget = require('./cdp-target.cjs');
const instances = require('./chrome-instances.cjs');
const { spawnSync } = require('child_process');
const WebSocket = require('ws');

// ─── Network capture ─────────────────────────────
// Passive by default: the events below cost nothing but bookkeeping, and the recorder's
// job is the video. Bodies are opt-in because fetching one is a CDP round-trip per
// request, and doing that mid-recording competes with screencast frame acks.
//
// HEADERS ARE REDACTED BY DEFAULT, and that is not paranoia — request headers carry
// Cookie and Authorization, response headers carry Set-Cookie, and the whole point of
// this file is to produce an artifact you hand to someone else (a reviewer, a bug
// report, another agent). A capture that quietly contains a session token is a much
// worse thing to have produced than no capture. --network-headers-raw opts out.
const REDACT = ['cookie', 'set-cookie', 'authorization', 'proxy-authorization',
                'x-api-key', 'x-auth-token', 'api-key', 'auth-token'];

function redactHeaders(h, raw) {
    const out = {};
    for (const k of Object.keys(h || {})) {
        out[k] = (!raw && REDACT.indexOf(k.toLowerCase()) !== -1)
            ? '<redacted ' + String(h[k]).length + ' chars>'
            : h[k];
    }
    return out;
}

// Only text-ish bodies are worth keeping. An image or a font is megabytes of base64 that
// tells a reviewer nothing.
const BODY_MIME = /^(application\/(json|javascript|xml|x-www-form-urlencoded)|text\/)/i;
const BODY_MAX = 256 * 1024;

function newNetState() {
    return { byId: new Map(), order: [], pendingBodies: [] };
}

function netOnEvent(net, m, args, send) {
    if (!net) return;
    const p = m.params || {};
    if (m.method === 'Network.requestWillBeSent') {
        const rec = {
            id: p.requestId,
            method: p.request.method,
            url: p.request.url,
            resourceType: p.type || null,
            requestHeaders: redactHeaders(p.request.headers, args.networkHeadersRaw),
            // postData is where a form or a JSON payload lives. Same redaction logic does
            // not apply — it is the caller's own app — but it is capped.
            postData: typeof p.request.postData === 'string'
                ? p.request.postData.slice(0, 8192) : null,
            startedAt: p.wallTime || null,
            status: null, mimeType: null, responseHeaders: null,
            body: null, bodySize: null, failed: null
        };
        net.byId.set(p.requestId, rec);
        net.order.push(p.requestId);
        return;
    }
    if (m.method === 'Network.responseReceived') {
        const rec = net.byId.get(p.requestId);
        if (!rec) return;
        rec.status = p.response.status;
        rec.mimeType = p.response.mimeType;
        rec.responseHeaders = redactHeaders(p.response.headers, args.networkHeadersRaw);
        rec.fromCache = !!p.response.fromDiskCache;
        return;
    }
    if (m.method === 'Network.loadingFailed') {
        const rec = net.byId.get(p.requestId);
        if (!rec) return;
        // A failed request is often the whole story of a bad run, so it is recorded as a
        // fact rather than dropped for having no response.
        rec.failed = p.errorText || 'failed';
        rec.canceled = !!p.canceled;
        return;
    }
    if (m.method === 'Network.loadingFinished') {
        const rec = net.byId.get(p.requestId);
        if (!rec) return;
        rec.bodySize = p.encodedDataLength || null;
        if (args.networkBodies && rec.mimeType && BODY_MIME.test(rec.mimeType)) {
            // Queued, not awaited: blocking here would stall the message loop that also
            // acks screencast frames.
            net.pendingBodies.push(p.requestId);
            send('Network.getResponseBody', { requestId: p.requestId })
                .then((r) => {
                    if (r && typeof r.body === 'string') {
                        rec.body = r.body.length > BODY_MAX
                            ? r.body.slice(0, BODY_MAX) + '\n<truncated at ' + BODY_MAX + ' chars>'
                            : r.body;
                        rec.bodyBase64 = !!r.base64Encoded;
                    }
                })
                .catch(() => { rec.body = null; rec.bodyNote = 'body no longer retained'; })
                .then(() => {
                    const i = net.pendingBodies.indexOf(p.requestId);
                    if (i !== -1) net.pendingBodies.splice(i, 1);
                });
        }
    }
}

function writeNetwork(net, args, targetUrl) {
    if (!net || !args.network) return null;
    const requests = net.order.map((id) => net.byId.get(id)).filter(Boolean);
    const payload = {
        // Deliberately NOT called a HAR. It does not carry HAR's timings or cookie
        // structures, and labelling a partial thing with a standard's name invites a
        // tool to consume it and fail confusingly.
        format: 'proxima-network-capture/1',
        capturedAt: new Date().toISOString(),
        target: targetUrl || null,
        headersRedacted: !args.networkHeadersRaw,
        bodiesCaptured: !!args.networkBodies,
        counts: {
            total: requests.length,
            failed: requests.filter((r) => r.failed).length,
            byStatus: requests.reduce((acc, r) => {
                const k = r.failed ? 'failed' : String(r.status || 'pending');
                acc[k] = (acc[k] || 0) + 1;
                return acc;
            }, {})
        },
        requests: requests
    };
    fs.writeFileSync(args.network, JSON.stringify(payload, null, 2));
    return payload.counts;
}

function parseArgs(argv) {
    const a = {
        port: 9222, out: 'run.mp4', quality: 70, maxWidth: 1280, maxHeight: 800,
        maxSeconds: 300, urlFilter: null, stopFile: null, keepFrames: false, target: null,
        host: '127.0.0.1', tailMax: 4, lastFrame: null, navigate: null,
        newTab: null, allowAnyTab: false, instance: null,
        network: null, networkBodies: false, networkHeadersRaw: false,
        dom: null, consoleOut: null
    };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i], v = argv[i + 1];
        if (k === '--port') { a.port = Number(v); i++; }
        else if (k === '--out') { a.out = v; i++; }
        else if (k === '--quality') { a.quality = Number(v); i++; }
        else if (k === '--max-width') { a.maxWidth = Number(v); i++; }
        else if (k === '--max-height') { a.maxHeight = Number(v); i++; }
        else if (k === '--max-seconds') { a.maxSeconds = Number(v); i++; }
        else if (k === '--url-filter') { a.urlFilter = v; i++; }
        else if (k === '--stop-file') { a.stopFile = v; i++; }
        else if (k === '--target') { a.target = v; i++; }
        else if (k === '--host') { a.host = v; i++; }
        else if (k === '--tail-max') { a.tailMax = Number(v); i++; }
        else if (k === '--last-frame') { a.lastFrame = v; i++; }
        else if (k === '--navigate') { a.navigate = v; i++; }
        else if (k === '--instance') { a.instance = v; i++; }
        else if (k === '--network') { a.network = v; i++; }
        else if (k === '--network-bodies') { a.networkBodies = true; }
        else if (k === '--network-headers-raw') { a.networkHeadersRaw = true; }
        else if (k === '--dom') { a.dom = v; i++; }
        else if (k === '--console') { a.consoleOut = v; i++; }
        else if (k === '--new-tab') { a.newTab = v; i++; }
        else if (k === '--allow-any-tab') { a.allowAnyTab = true; }
        else if (k === '--keep-frames') { a.keepFrames = true; }
    }
    return a;
}

function getJSON(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let b = '';
            res.on('data', (d) => { b += d; });
            res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
        }).on('error', reject);
    });
}

// Target selection lives in cdp-target.cjs and is shared with the drivers, because
// all three used to fall back to the first tab and that is exactly the failure mode
// that puts someone else's app in your recording. There is no fallback now.
// --instance looks the port up in the shared registry instead of making the caller
// remember it. Worth having beyond convenience: this file defaults to 9222 while
// start-browser defaults to 9333, so a caller who passed neither used to attach to a
// port nobody had started.
function applyInstance(args) {
    if (!args.instance) return args;
    const e = instances.readEntry(args.instance);
    if (!e) {
        throw new Error('no browser instance named "' + args.instance + '". Start one: node start-browser.cjs --instance ' + args.instance + ' --url <app>');
    }
    args.port = e.port;
    console.error('[rec] instance ' + e.name + ' -> port ' + e.port);
    return args;
}

async function pickTarget(args) {
    applyInstance(args);
    const picked = await cdpTarget.resolveTarget({
        port: args.port, host: args.host, target: args.target,
        newTab: args.newTab, urlFilter: args.urlFilter, allowAnyTab: args.allowAnyTab
    });
    console.error('[rec] target: ' + picked.how + (picked.url ? ' — ' + picked.url : ''));
    return picked.ws;
}

(async () => {
    const args = parseArgs(process.argv);
    const wsUrl = await pickTarget(args);
    const frameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-rec-'));
    const frames = [];      // { file, ts } — ts is the CDP frame timestamp, in seconds
    let id = 0;
    const pending = new Map();
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });

    const send = (method, params) => new Promise((resolve) => {
        const msgId = ++id;
        pending.set(msgId, resolve);
        ws.send(JSON.stringify({ id: msgId, method: method, params: params || {} }));
    });

    let stopped = false;
    let stopWall = null;
    let netCounts = null;
    let domInfo = null;
    let consoleInfo = null;
    const nlLiteral = String.fromCharCode(10);
    const stop = async (reason) => {
        if (stopped) return;
        stopped = true;
        // Captured BEFORE the round-trip below so the tail duration reflects how long
        // the final state was actually on screen, not how slow stopScreencast was.
        stopWall = Date.now() / 1000;
        try { await send('Page.stopScreencast'); } catch (e) { /* socket may already be gone */ }
        // Outstanding getResponseBody calls have to land BEFORE the socket closes, or
        // the last few requests in the run silently lose their bodies — which would
        // look like the app never made them.
        if (net && net.pendingBodies.length) {
            const deadline = Date.now() + 5000;
            while (net.pendingBodies.length && Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 100));
            }
            if (net.pendingBodies.length) {
                console.error('[rec] ' + net.pendingBodies.length +
                    ' response body/bodies did not arrive before shutdown');
            }
        }
        // DOM SNAPSHOT, taken here because the socket is still open and the page is in
        // exactly the state the last video frame shows. The end state is what decides
        // pass/fail, and a screenshot shows THAT it failed while the DOM shows WHY —
        // the error text, the empty list, the element that never rendered.
        if (args.dom) {
            try {
                const r = await send('Runtime.evaluate', {
                    expression: 'JSON.stringify({url:location.href,title:document.title,' +
                        'html:document.documentElement.outerHTML})',
                    returnByValue: true
                });
                const raw = r && r.result && r.result.value;
                const o = raw ? JSON.parse(raw) : null;
                if (o) {
                    const CAP = 2 * 1024 * 1024;
                    const html = o.html.length > CAP
                        ? o.html.slice(0, CAP) + nlLiteral + '<!-- truncated at ' + CAP + ' chars -->'
                        : o.html;
                    fs.writeFileSync(args.dom,
                        '<!-- captured ' + new Date().toISOString() + nlLiteral +
                        '     url:   ' + o.url + nlLiteral +
                        '     title: ' + o.title + ' -->' + nlLiteral + html);
                    domInfo = { file: path.resolve(args.dom), chars: o.html.length,
                                url: o.url, title: o.title };
                    console.error('[rec] dom: ' + o.html.length + ' chars -> ' + args.dom);
                }
            } catch (e) {
                console.error('[rec] dom capture failed: ' + e.message);
            }
        }
        if (consoleLog) {
            const errors = consoleLog.filter((c) => c.level === 'error' || c.kind === 'exception');
            fs.writeFileSync(args.consoleOut, JSON.stringify({
                capturedAt: new Date().toISOString(),
                counts: { total: consoleLog.length, errors: errors.length },
                entries: consoleLog
            }, null, 2));
            consoleInfo = { file: path.resolve(args.consoleOut), total: consoleLog.length,
                            errors: errors.length };
            console.error('[rec] console: ' + consoleLog.length + ' entr(ies), ' +
                errors.length + ' error(s) -> ' + args.consoleOut);
        }
        netCounts = writeNetwork(net, args, args.navigate);
        if (netCounts) {
            console.error('[rec] network: ' + netCounts.total + ' request(s), ' +
                netCounts.failed + ' failed -> ' + args.network);
        }
        try { ws.close(); } catch (e) { }
        finish(reason);
    };

    function finish(reason) {
        if (!frames.length) {
            console.log(JSON.stringify({ ok: false, error: 'no frames captured', reason: reason }));
            process.exit(1);
        }
        // True per-frame durations from CDP timestamps.
        const durations = [];
        for (let i = 0; i < frames.length - 1; i++) {
            durations.push(Math.max(0.02, frames[i + 1].ts - frames[i].ts));
        }
        // THE FINAL FRAME IS THE IMPORTANT ONE and it has no successor to measure
        // against. Giving it the median (the obvious choice, and what this did first)
        // is actively harmful: screencast only emits on CHANGE, so a run that ends on a
        // static error banner produces exactly one frame for it, and the median turns
        // 9 seconds of visible failure into ~0.05s of video. A reviewer sampling frames
        // then never sees it and reports a PASS. Measured: a "Network Error" banner
        // visible for 9s survived as 0.2s of a 12.4s clip, and Qwen missed it.
        // So: use the real wall-clock dwell, floored at 1s so it is always sampleable
        // and capped at --tail-max so an idle recorder does not pad on a dull still.
        const lastTs = frames[frames.length - 1].ts;
        const realTail = (stopWall || (Date.now() / 1000)) - lastTs;
        durations.push(Math.min(Math.max(realTail, 1.0), Math.max(1.0, args.tailMax)));

        const listFile = path.join(frameDir, 'frames.txt');
        let txt = '';
        for (let i = 0; i < frames.length; i++) {
            const p = frames[i].file.split('\\').join('/');
            txt += "file '" + p + "'\nduration " + durations[i].toFixed(3) + "\n";
        }
        // concat demuxer convention: repeat the final file so its duration is honoured.
        txt += "file '" + frames[frames.length - 1].file.split('\\').join('/') + "'\n";
        fs.writeFileSync(listFile, txt);

        const wall = frames[frames.length - 1].ts - frames[0].ts;
        const outAbs = path.resolve(args.out);
        // H.264 needs even dimensions. fps=25 resamples the variable-rate concat output
        // to a constant rate, which players and Qwen both handle predictably.
        const ff = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0',
            '-i', listFile, '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=25',
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '26',
            outAbs], { encoding: 'utf8' });
        if (ff.status !== 0) {
            console.log(JSON.stringify({
                ok: false, error: 'ffmpeg failed',
                stderr: (ff.stderr || '').slice(0, 500), frameDir: frameDir
            }));
            process.exit(1);
        }
        // The end state is what most QA checks hinge on, and video frame sampling can
        // still skim past a brief one. Emitting it as a still lets the reviewer be given
        // a full-resolution look at it alongside the video.
        let lastFrameOut = null;
        if (args.lastFrame) {
            try {
                lastFrameOut = path.resolve(args.lastFrame);
                fs.copyFileSync(frames[frames.length - 1].file, lastFrameOut);
            } catch (e) { lastFrameOut = null; }
        }
        if (!args.keepFrames) { try { fs.rmSync(frameDir, { recursive: true, force: true }); } catch (e) { } }
        const size = fs.statSync(outAbs).size;
        // Report the ENCODED duration, not the frame span. The concat demuxer needs the
        // final file repeated for its duration to be honoured, and it charges for both
        // entries, so the mp4 runs a little longer than the capture window. Publishing
        // the frame span as "seconds" made the tool contradict ffprobe on its own output.
        let encoded = null;
        try {
            const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
                '-of', 'default=nw=1:nk=1', outAbs], { encoding: 'utf8' });
            if (probe.status === 0) encoded = Number(String(probe.stdout).trim());
        } catch (e) { /* ffprobe is optional; the mp4 is already written */ }
        console.log(JSON.stringify({
            ok: true, out: outAbs, frames: frames.length,
            seconds: encoded !== null && !Number.isNaN(encoded) ? Number(encoded.toFixed(2)) : Number(wall.toFixed(2)),
            capturedSeconds: Number(wall.toFixed(2)),
            tailSeconds: Number(durations[durations.length - 1].toFixed(2)),
            lastFrame: lastFrameOut, bytes: size,
            mb: Number((size / 1048576).toFixed(2)), reason: reason,
            // Surfaced on the summary line, not just in the file, so a caller can branch
            // on "were there failed requests" without opening and parsing the capture.
            // A run whose video looks fine but logged six failed XHRs is worth knowing
            // about before a reviewer ever sees it.
            network: netCounts ? {
                file: path.resolve(args.network),
                total: netCounts.total, failed: netCounts.failed, byStatus: netCounts.byStatus
            } : undefined,
            dom: domInfo || undefined,
            console: consoleInfo || undefined
        }));
        process.exit(0);
    }

    // Only allocated when asked for, so an ordinary recording carries no bookkeeping.
    const net = args.network ? newNetState() : null;
    // Console output is the other half of "what happened in this page". A run that
    // looks fine on video and threw six uncaught TypeErrors is a failing run, and
    // nothing in the frames says so.
    const consoleLog = args.consoleOut ? [] : null;

    ws.on('message', (raw) => {
        let m;
        try { m = JSON.parse(raw.toString()); } catch (e) { return; }
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
        // Before the frame branch, and cheap: these are bookkeeping only. Frame acks
        // stay the priority — a stalled ack throttles the whole screencast.
        if (net && m.method && m.method.indexOf('Network.') === 0) {
            netOnEvent(net, m, args, send);
            return;
        }
        if (consoleLog && m.method === 'Runtime.consoleAPICalled') {
            consoleLog.push({
                kind: 'console', level: m.params.type,
                text: (m.params.args || []).map((a) =>
                    a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' ').slice(0, 4000),
                ts: m.params.timestamp
            });
            return;
        }
        if (consoleLog && m.method === 'Runtime.exceptionThrown') {
            const d = (m.params.exceptionDetails || {});
            consoleLog.push({
                kind: 'exception', level: 'error',
                text: (d.exception && (d.exception.description || d.exception.value)) || d.text || 'exception',
                url: d.url || null, line: d.lineNumber, ts: m.params.timestamp
            });
            return;
        }
        if (m.method === 'Page.screencastFrame') {
            const n = String(frames.length + 1).padStart(6, '0');
            const file = path.join(frameDir, 'f' + n + '.jpg');
            fs.writeFileSync(file, Buffer.from(m.params.data, 'base64'));
            frames.push({ file: file, ts: m.params.metadata.timestamp });
            // Chrome throttles the stream until each frame is acked.
            send('Page.screencastFrameAck', { sessionId: m.params.sessionId });
        }
    });

    ws.on('open', async () => {
        await send('Page.enable');
        if (consoleLog) {
            // Runtime.enable is what turns on consoleAPICalled and exceptionThrown.
            await send('Runtime.enable');
            console.error('[rec] console capture -> ' + args.consoleOut);
        }
        if (net) {
            // Buffer caps keep a long run from holding every response body in the
            // browser's memory; bodies we actually want are pulled on loadingFinished.
            await send('Network.enable', {
                maxTotalBufferSize: 32 * 1024 * 1024,
                maxResourceBufferSize: 8 * 1024 * 1024
            });
            console.error('[rec] network capture -> ' + args.network +
                (args.networkBodies ? ' (with bodies)' : ' (metadata only)') +
                (args.networkHeadersRaw ? ' RAW HEADERS' : ''));
        }
        await send('Page.startScreencast', {
            format: 'jpeg', quality: args.quality,
            maxWidth: args.maxWidth, maxHeight: args.maxHeight, everyNthFrame: 1
        });
        console.error('[rec] recording -> ' + args.out + ' (max ' + args.maxSeconds + 's)');
        // Navigate AFTER the screencast is live, so frame one is the page loading rather
        // than whatever the tab happened to be showing. Attaching to an already-loaded
        // tab and reloading separately leaves several seconds of the PREVIOUS run at the
        // head of the video — and a reviewer with no way to know that reads the stale
        // end screen as the app's initial state. That produced a false FAIL once already.
        if (args.navigate) {
            await send('Page.navigate', { url: args.navigate });
            console.error('[rec] navigated to ' + args.navigate + ' with the recorder already running');
        }
        if (args.stopFile) {
            const iv = setInterval(() => {
                if (fs.existsSync(args.stopFile)) { clearInterval(iv); stop('stop-file'); }
            }, 250);
        }
        setTimeout(() => stop('max-seconds'), args.maxSeconds * 1000);
    });

    ws.on('error', (e) => {
        console.log(JSON.stringify({ ok: false, error: 'cdp socket: ' + e.message }));
        process.exit(1);
    });
    process.on('SIGINT', () => stop('sigint'));
    process.on('SIGTERM', () => stop('sigterm'));
})().catch((e) => {
    console.log(JSON.stringify({ ok: false, error: e.message }));
    process.exit(1);
});
