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
 *                        [--conversation-id <uuid>]  pin every review to one thread
 *                        [--no-thinking]    (default: thinking ON — Qwen reasons only
 *                                            when asked; see the note on the payload)
 *                        [--allow-no-thinking]  accept a verdict reached unreasoned
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
        port: null, timeoutMs: 1800000, raw: false, keepContext: false, conversationId: null,
        thinking: true, allowNoThinking: false
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
        else if (k === '--conversation-id') { a.conversationId = v; i++; }
        else if (k === '--no-thinking') { a.thinking = false; }
        else if (k === '--thinking') { a.thinking = true; }
        else if (k === '--allow-no-thinking') { a.allowNoThinking = true; }
    }
    return a;
}

// Port resolution is shared with preflight and the MCP server. This file used to
// carry its own copy (env + settings.json + 19222), which is how three tools ended
// up disagreeing about where Proxima was — and settings.json is stale after the app
// falls back to 19223.
const proximaPort = require('../../scripts/lib/proxima-port.cjs');

/** Prove the port with a ping rather than assume it. Explicit --port still wins. */
async function resolvePort(explicit) {
    try {
        const found = await proximaPort.discover(explicit, 2500);
        return found.port;
    } catch (e) {
        // Fall through to the best guess so the caller gets the real connection
        // error, which is more informative than a discovery failure.
        return proximaPort.resolvePortSync(explicit);
    }
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

    const port = await resolvePort(args.port);
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
        // Its own session: video reviews must not inherit, or be inherited by, the
        // automation loop's review thread.
        session: 'qa-review',
        conversationId: args.conversationId || undefined,
        // Fresh conversation by DEFAULT, which is the opposite of Qwen's normal
        // behaviour (it keeps context for 2h). A verdict has to stand on this video
        // alone: chained onto a previous review, the model carries over "the app
        // worked a moment ago" and starts reasoning about the wrong run. Opt back in
        // with --keep-context when you deliberately want a follow-up question.
        // A pinned thread overrides the fresh-conversation default: an orchestrator can
        // then send every run to ONE reviewer chat, which is worth the contamination
        // risk when the reviews are meant to be compared against each other. Reviews
        // that must stand alone should keep the default.
        newChat: !args.keepContext && !args.conversationId,
        // THINKING. Not optional for a reviewer, and not the default in the protocol:
        // the engine does `!!o.thinking`, so a payload that omits this key runs
        // qwen3.8-max with thinking_enabled:false. This script omitted it, which means
        // every video verdict it produced was reached with no reasoning pass at all —
        // the same silent default that had been running the code-review and repair
        // loops before they were fixed. Nothing errors, nothing logs; the verdict just
        // arrives shallower than it looks. Watching a multi-minute recording and
        // reconciling it against a checklist is precisely the work reasoning is for,
        // so it is ON here and has to be switched off explicitly.
        thinking: args.thinking
    };
    if (args.model) data.model = args.model;

    console.error('[review] ' + path.basename(video) + ' (' + mb.toFixed(2) + 'MB)' +
        (args.images.length ? ' + ' + args.images.length + ' still(s)' : '') +
        ' -> Qwen via Proxima :' + port +
        ' [' + (args.model || 'qwen3.8-max') + (args.thinking ? ', thinking' : ', NO thinking') + ']');
    const t0 = Date.now();
    const res = await ipc(port, { action: 'sendMessage', provider: 'qwen', data: data }, args.timeoutMs);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);

    if (!res.success) {
        console.error('[review] FAILED after ' + secs + 's: ' + res.error);
        process.exit(1);
    }
    // Did it actually reason? main-v2 returns the engine's phase tally with the answer,
    // and 'thinking_summary' is present there if and only if reasoning frames arrived.
    // Three distinct states, kept distinct on purpose:
    //   verified  — asked for thinking and the stream proves it happened.
    //   unverifiable — the running Proxima predates the meta field. Warn; do not fail,
    //     or this script breaks against a build that is merely older, not broken.
    //   contradicted — thinking was requested and the stream shows it did NOT happen.
    //     That is a reviewer defect, and a verdict reached without the reasoning pass
    //     it was configured for is not a verdict this script will report as PASS. It
    //     becomes INCONCLUSIVE, which is what exit 3 already means: the reviewer did
    //     not properly answer. --allow-no-thinking downgrades it back to a warning.
    const canVerify = res.meta && res.meta.phases;
    const didThink = !!res.thinkingUsed;
    let thinkingStatus = 'not requested';
    if (args.thinking) {
        thinkingStatus = !canVerify ? 'unverifiable' : (didThink ? 'verified' : 'contradicted');
    }
    if (thinkingStatus === 'unverifiable') {
        console.error('[review] WARNING: cannot confirm the reviewer reasoned — this ' +
            'Proxima build does not report Qwen phase metadata. Restart Proxima to enable it.');
    } else if (thinkingStatus === 'contradicted') {
        console.error('[review] WARNING: thinking was requested but the response carried NO ' +
            'thinking_summary phase — phases seen: ' + Object.keys(res.meta.phases).join(', ') +
            '. The verdict was reached WITHOUT a reasoning pass.');
    } else if (thinkingStatus === 'verified') {
        console.error('[review] reasoning confirmed (' + res.meta.phases.thinking_summary +
            ' thinking frames' + (res.meta.usage && res.meta.usage.output_tokens
                ? ', ' + res.meta.usage.output_tokens + ' output tokens' : '') + ')');
    }

    const text = (res.result && res.result.response) || '';
    if (args.raw || !text) console.log(text || '(empty response)');

    const verdict = extractVerdict(text);
    const out = {
        video: video, seconds: Number(secs),
        attachments: res.attachments || null,
        model: (res.meta && res.meta.model) || args.model || 'qwen3.8-max',
        thinkingRequested: args.thinking,
        thinkingStatus: thinkingStatus,
        phases: (res.meta && res.meta.phases) || null,
        reasoning: (res.meta && res.meta.thinking) || null,
        usage: (res.meta && res.meta.usage) || null,
        verdict: verdict ? verdict.verdict : 'INCONCLUSIVE',
        parsed: verdict, response: text
    };
    if (args.json) fs.writeFileSync(args.json, JSON.stringify(out, null, 2));

    if (!verdict) {
        console.error('[review] INCONCLUSIVE — no parseable verdict block in the reply (' + secs + 's)');
        if (!args.raw) console.log(text);
        process.exit(3);
    }
    if (thinkingStatus === 'contradicted' && !args.allowNoThinking) {
        console.error('[review] INCONCLUSIVE — the reviewer returned ' + verdict.verdict +
            ' but reached it with thinking disabled server-side, despite being asked for it. ' +
            'Not reporting that as a verdict. Re-run, or pass --allow-no-thinking to accept it.');
        out.verdict = 'INCONCLUSIVE';
        out.suppressedVerdict = verdict.verdict;
        if (args.json) fs.writeFileSync(args.json, JSON.stringify(out, null, 2));
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
