#!/usr/bin/env node
/**
 * Proxima QA — ask Qwen 3.8 to review a screen recording and return a verdict.
 *
 * Talks to a running Proxima over its IPC socket (the same channel the MCP server
 * uses), so the video is uploaded to Qwen as a real multimodal attachment via
 * getstsToken -> Alibaba OSS -> messages[0].files. See electron/providers/
 * qwen-upload.cjs for that protocol.
 *
 * The point of this script over just asking Qwen in prose: it returns an EXIT CODE
 * and a parsed verdict, so a calling agent (or CI job) can branch on the result
 * instead of re-reading paragraphs. Qwen is instructed to end with a fenced JSON
 * block; a missing or unparseable block is reported as INCONCLUSIVE rather than
 * being silently treated as a pass, because "the reviewer did not answer" and
 * "the app works" must never collapse into the same outcome.
 *
 * usage:
 *   node qwen-review.cjs --video run.mp4 [--image last.jpg] [--checklist checks.txt | --check "..."]
 *                        [--context "what the app is"] [--model qwen3.8-max]
 *                        [--json out.json] [--port 19222] [--timeout-ms 1800000]
 *                        [--keep-context]   (default: each review gets a fresh chat)
 *
 * exit: 0 = PASS, 2 = FAIL, 3 = INCONCLUSIVE, 1 = error (upload/transport/etc)
 */
const fs = require('fs');
const net = require('net');
const path = require('path');

const VIDEO_EXT = ['.mp4', '.mov', '.mkv', '.avi', '.wmv', '.flv'];

function parseArgs(argv) {
    const a = {
        video: null, images: [], checks: [], context: null, model: null, json: null,
        port: null, timeoutMs: 1800000, raw: false, keepContext: false
    };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i], v = argv[i + 1];
        if (k === '--video') { a.video = v; i++; }
        else if (k === '--image') { a.images.push(v); i++; }
        else if (k === '--check') { a.checks.push(v); i++; }
        else if (k === '--checklist') {
            const lines = fs.readFileSync(v, 'utf8').split(/\r?\n/)
                .map((s) => s.replace(/^\s*[-*]\s*/, '').trim())
                .filter((s) => s && !s.startsWith('#'));
            a.checks.push(...lines); i++;
        }
        else if (k === '--context') { a.context = v; i++; }
        else if (k === '--model') { a.model = v; i++; }
        else if (k === '--json') { a.json = v; i++; }
        else if (k === '--port') { a.port = Number(v); i++; }
        else if (k === '--timeout-ms') { a.timeoutMs = Number(v); i++; }
        else if (k === '--raw') { a.raw = true; }
        else if (k === '--keep-context') { a.keepContext = true; }
    }
    return a;
}

/** Proxima writes its live IPC port into settings.json; fall back to the default. */
function resolvePort(explicit) {
    if (explicit) return explicit;
    if (process.env.PROXIMA_IPC_PORT) return Number(process.env.PROXIMA_IPC_PORT);
    const candidates = [
        path.join(process.env.APPDATA || '', 'Proxima', 'settings.json'),
        path.join(process.env.HOME || '', '.config', 'Proxima', 'settings.json')
    ];
    for (const c of candidates) {
        try {
            if (c && fs.existsSync(c)) {
                const p = JSON.parse(fs.readFileSync(c, 'utf8')).ipcPort;
                if (p) return Number(p);
            }
        } catch (e) { /* fall through to default */ }
    }
    return 19222;
}

function ipc(port, req, timeoutMs) {
    return new Promise((resolve, reject) => {
        const sock = net.createConnection(port, '127.0.0.1');
        let buf = '';
        const t = setTimeout(() => {
            sock.destroy();
            reject(new Error('Proxima IPC timed out after ' + timeoutMs + 'ms'));
        }, timeoutMs);
        sock.on('connect', () => sock.write(JSON.stringify(
            Object.assign({ requestId: String(Date.now()) }, req)) + '\n'));
        sock.on('data', (d) => {
            buf += d.toString();
            const i = buf.indexOf('\n');
            if (i === -1) return;
            clearTimeout(t);
            sock.end();
            try { resolve(JSON.parse(buf.slice(0, i))); } catch (e) { reject(e); }
        });
        sock.on('error', (e) => {
            clearTimeout(t);
            reject(new Error(e.code === 'ECONNREFUSED'
                ? 'Proxima is not running (nothing listening on 127.0.0.1:' + port + ')'
                : e.message));
        });
    });
}

function buildPrompt(args) {
    const checks = args.checks.length ? args.checks : [
        'The app loads and renders its main UI without a blank screen.',
        'No visible error message, stack trace or broken layout appears.',
        'The interactions shown appear to complete successfully.'
    ];
    const lines = [];
    lines.push('You are a QA reviewer. The attached video is a screen recording of an ' +
        'automated test run against a web application. Watch it and judge whether the ' +
        'application behaved correctly.');
    if (args.images.length) {
        lines.push('Also attached ' + (args.images.length === 1 ? 'is a still image' :
            'are ' + args.images.length + ' still images') + ' captured at the END of the ' +
            'run, at full resolution. Treat ' + (args.images.length === 1 ? 'it' : 'them') +
            ' as the authoritative view of the final state — the video is compressed and ' +
            'may not show brief messages clearly.');
    }
    if (args.context) lines.push('\nContext about the app under test:\n' + args.context);
    lines.push('\nCheck each of these specifically:');
    checks.forEach((c, i) => lines.push((i + 1) + '. ' + c));
    lines.push('');
    lines.push('Rules:');
    lines.push('- Judge ONLY what is visible in the video. Do not assume behaviour you ' +
        'cannot see.');
    lines.push('- Quote on-screen text verbatim as evidence for each finding.');
    lines.push('- If the video does not show enough to judge a check, mark that check ' +
        '"unknown" rather than guessing.');
    // Frame sampling skims past short-lived states, and the state a test ends in is
    // usually the one that decides pass/fail. An error banner that was on screen for a
    // fraction of the clip has been missed this way, so ask about the end explicitly.
    lines.push('- Look CAREFULLY at the FINAL state of the run and describe it before ' +
        'you decide. Error banners, toasts and validation messages often appear only at ' +
        'the very end and are easy to skim past.');
    lines.push('- Any red/warning-coloured banner, or text such as "Network Error", ' +
        '"failed", "something went wrong" or "Unauthorized", is a FAIL even if the rest ' +
        'of the run looked healthy.');
    lines.push('');
    lines.push('Write a short prose summary first. Then end your reply with ONLY this, ' +
        'in a fenced json code block:');
    lines.push('```json');
    lines.push('{');
    lines.push('  "verdict": "PASS" | "FAIL",');
    lines.push('  "confidence": "high" | "medium" | "low",');
    lines.push('  "checks": [');
    lines.push('    {"check": "<the check text>", "result": "pass" | "fail" | "unknown", ' +
        '"evidence": "<verbatim on-screen text or a description of what you saw>"}');
    lines.push('  ],');
    lines.push('  "issues": ["<any problem you actually observed>"],');
    lines.push('  "timeline": ["<mm:ss - what happens>"]');
    lines.push('}');
    lines.push('```');
    return lines.join('\n');
}

/** Last fenced json block wins — the prose summary may mention json in passing. */
function extractVerdict(text) {
    const blocks = [];
    const re = /```(?:json)?\s*([\s\S]*?)```/g;
    let m;
    while ((m = re.exec(text)) !== null) blocks.push(m[1].trim());
    for (let i = blocks.length - 1; i >= 0; i--) {
        try {
            const o = JSON.parse(blocks[i]);
            if (o && o.verdict) return o;
        } catch (e) { /* try the next-oldest block */ }
    }
    // Fall back to a bare "VERDICT: PASS" line if the model ignored the schema.
    const bare = text.match(/VERDICT\s*[:=]\s*(PASS|FAIL)/i);
    if (bare) return { verdict: bare[1].toUpperCase(), confidence: 'low', _recoveredFrom: 'bare line' };
    return null;
}

(async () => {
    const args = parseArgs(process.argv);
    if (!args.video) { console.error('--video is required'); process.exit(1); }
    const video = path.resolve(args.video);
    if (!fs.existsSync(video)) { console.error('video not found: ' + video); process.exit(1); }
    const ext = path.extname(video).toLowerCase();
    if (VIDEO_EXT.indexOf(ext) === -1) {
        console.error('Qwen does not accept "' + ext + '" video. Supported: ' + VIDEO_EXT.join(', ') +
            '. Transcode first, e.g.  ffmpeg -i in' + ext + ' -c:v libx264 -pix_fmt yuv420p out.mp4');
        process.exit(1);
    }
    const mb = fs.statSync(video).size / 1048576;
    if (mb > 500) {
        console.error('video is ' + mb.toFixed(1) + 'MB; Qwen\'s video limit is 500MB');
        process.exit(1);
    }

    const port = resolvePort(args.port);
    const prompt = buildPrompt(args);
    const missingImg = args.images.filter((i) => !fs.existsSync(i));
    if (missingImg.length) { console.error('image not found: ' + missingImg.join(', ')); process.exit(1); }
    // Qwen allows 1 video AND up to 5 images in a single turn; they are separate
    // per-class caps, not one shared budget (see electron/providers/qwen-upload.cjs).
    if (args.images.length > 5) { console.error('at most 5 images per turn'); process.exit(1); }
    const data = {
        message: prompt,
        attachments: [video].concat(args.images.map((i) => path.resolve(i))),
        chatType: 't2t',
        // Fresh conversation by DEFAULT, which is the opposite of Qwen's normal
        // behaviour (it keeps context for 2h). A verdict has to stand on this video
        // alone: chained onto a previous review, the model carries over "the app
        // worked a moment ago" and starts reasoning about the wrong run. Opt back in
        // with --keep-context when you deliberately want a follow-up question.
        newChat: !args.keepContext
    };
    if (args.model) data.model = args.model;

    console.error('[review] ' + path.basename(video) + ' (' + mb.toFixed(2) + 'MB)' +
        (args.images.length ? ' + ' + args.images.length + ' still(s)' : '') +
        ' -> Qwen via Proxima :' + port);
    const t0 = Date.now();
    const res = await ipc(port, { action: 'sendMessage', provider: 'qwen', data: data }, args.timeoutMs);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);

    if (!res.success) {
        console.error('[review] FAILED after ' + secs + 's: ' + res.error);
        process.exit(1);
    }
    const text = (res.result && res.result.response) || '';
    if (args.raw || !text) console.log(text || '(empty response)');

    const verdict = extractVerdict(text);
    const out = {
        video: video, seconds: Number(secs),
        attachments: res.attachments || null,
        verdict: verdict ? verdict.verdict : 'INCONCLUSIVE',
        parsed: verdict, response: text
    };
    if (args.json) fs.writeFileSync(args.json, JSON.stringify(out, null, 2));

    if (!verdict) {
        console.error('[review] INCONCLUSIVE — no parseable verdict block in the reply (' + secs + 's)');
        if (!args.raw) console.log(text);
        process.exit(3);
    }
    console.error('[review] ' + verdict.verdict + ' (confidence ' + (verdict.confidence || 'n/a') +
        ') in ' + secs + 's');
    if (!args.raw) {
        console.log(text);
    }
    process.exit(verdict.verdict === 'PASS' ? 0 : 2);
})().catch((e) => {
    console.error('[review] error: ' + e.message);
    process.exit(1);
});
