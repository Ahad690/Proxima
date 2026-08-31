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
 *                       [--quality 70] [--max-width 1280] [--max-seconds 300]
 *                       [--stop-file .stop] [--keep-frames]
 *
 * Stops on: --max-seconds, the appearance of --stop-file, or SIGINT/SIGTERM.
 * Prints a one-line JSON summary to stdout on exit; progress goes to stderr.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const WebSocket = require('ws');

function parseArgs(argv) {
    const a = {
        port: 9222, out: 'run.mp4', quality: 70, maxWidth: 1280, maxHeight: 800,
        maxSeconds: 300, urlFilter: null, stopFile: null, keepFrames: false, target: null,
        host: '127.0.0.1', tailMax: 4, lastFrame: null
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

async function pickTarget(args) {
    if (args.target) return args.target;
    // Chrome binds the debug port to ONE loopback family, and which one is not
    // predictable: if something already holds 127.0.0.1:PORT it will silently fall
    // back to [::1]:PORT and log a bind error you never see. Probing 127.0.0.1 alone
    // then finds a DIFFERENT browser, or nothing. Observed in practice, hence both.
    const hosts = args.host === '127.0.0.1' ? ['127.0.0.1', '[::1]'] : [args.host];
    let list = null, lastErr = null;
    for (const h of hosts) {
        try { list = await getJSON('http://' + h + ':' + args.port + '/json/list'); break; }
        catch (e) { lastErr = e; }
    }
    if (!list) {
        throw new Error('cannot reach Chrome debug port ' + args.port + ' on ' + hosts.join(' or ') +
            ' (' + (lastErr && lastErr.message) + '). Start the browser with --remote-debugging-port=' +
            args.port);
    }
    let pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (args.urlFilter) {
        const f = pages.filter((t) => (t.url || '').indexOf(args.urlFilter) !== -1);
        // Fall back rather than fail: a tab can be mid-navigation when we attach.
        if (f.length) pages = f;
        else console.error('[rec] no tab matching "' + args.urlFilter + '"; using the first page');
    }
    if (!pages.length) throw new Error('no page targets on the debug port');
    return pages[0].webSocketDebuggerUrl;
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
    const stop = async (reason) => {
        if (stopped) return;
        stopped = true;
        // Captured BEFORE the round-trip below so the tail duration reflects how long
        // the final state was actually on screen, not how slow stopScreencast was.
        stopWall = Date.now() / 1000;
        try { await send('Page.stopScreencast'); } catch (e) { /* socket may already be gone */ }
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
            mb: Number((size / 1048576).toFixed(2)), reason: reason
        }));
        process.exit(0);
    }

    ws.on('message', (raw) => {
        let m;
        try { m = JSON.parse(raw.toString()); } catch (e) { return; }
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
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
        await send('Page.startScreencast', {
            format: 'jpeg', quality: args.quality,
            maxWidth: args.maxWidth, maxHeight: args.maxHeight, everyNthFrame: 1
        });
        console.error('[rec] recording -> ' + args.out + ' (max ' + args.maxSeconds + 's)');
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
