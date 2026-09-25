#!/usr/bin/env node
/**
 * Proxima — orchestration preflight
 *
 * Run this BEFORE leaving an unattended run going. It checks every dependency the
 * orchestration and QA pipelines actually touch, and fails loudly on anything that
 * would otherwise surface hours later as a confusing wrong answer.
 *
 * It exists because of a specific, repeated failure in this project's history: a
 * feature that had been changed on disk but not reloaded into the running Electron
 * process behaves EXACTLY like a broken feature. The STALE CODE check below compares
 * the running process's start time against the mtime of the files it loads, which is
 * the only way to tell those apart from the outside.
 *
 * usage:
 *   node preflight.cjs [--browser-port 9333] [--port 19222] [--json]
 *
 * exit 0 = everything reachable, 1 = at least one FAIL. WARNs never fail the run.
 */
const fs = require('fs');
// Shared with the MCP server and the QA reviewer, because this check used to
// hardcode 19222 while main-v2 falls back to 19223 when 19222 is taken — and then
// reported "not reachable, start Proxima" about an app that was running fine.
const proximaPort = require('../../scripts/lib/proxima-port.cjs');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '../..');
const MCP_SERVER = path.join(REPO, 'src/mcp-server-v3.js');

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const browserPort = (() => {
    const i = args.indexOf('--browser-port');
    return i === -1 ? 9333 : Number(args[i + 1]);
})();
// Must be read the same way. `args` is an ARRAY, so an earlier version of this read
// `args.port` — always undefined, which would have silently ignored the flag documented
// in the usage line above.
const explicitPort = (() => {
    const i = args.indexOf('--port');
    return i === -1 ? null : Number(args[i + 1]);
})();

const os = require('os');

/**
 * Free memory, checked BEFORE anything that needs a socket.
 *
 * On the recorded incident this machine had ~734 MB free with 16.5 of 19 GB of
 * commit charge used, and the visible symptom was `getaddrinfo() thread failed
 * to start` — which reads as a dead service. Below this floor, socket and thread
 * creation start failing, so every check after it produces a misleading answer.
 */
const MIN_FREE_MB = 1024;

function memoryCheck() {
    const freeMb = Math.round(os.freemem() / (1024 * 1024));
    const totalMb = Math.round(os.totalmem() / (1024 * 1024));
    if (!Number.isFinite(freeMb) || totalMb === 0) {
        return { status: 'UNKNOWN', detail: 'could not read memory' };
    }
    if (freeMb < MIN_FREE_MB) {
        return {
            status: 'FAIL',
            detail: freeMb + ' MB free of ' + totalMb + ' MB — under the ' + MIN_FREE_MB +
                ' MB floor. Sockets and threads start failing here and it looks exactly ' +
                'like a dead service. Close something before trusting any check below.'
        };
    }
    return { status: 'PASS', detail: freeMb + ' MB free of ' + totalMb + ' MB' };
}

const results = [];
const record = (name, status, detail) => {
    results.push({ name, status, detail });
    if (!asJson) {
        const mark = status === 'PASS' ? 'ok  '
            : status === 'WARN' ? 'warn'
                : status === 'UNKNOWN' ? '????' : 'FAIL';
        console.log('  [' + mark + '] ' + name + (detail ? ' — ' + detail : ''));
    }
};

// Set by discovery in main(); every ipc() call below uses it.
let IPC_PORT = proximaPort.DEFAULT_PORT;
let IPC_VIA = 'default';

function ipc(req, timeoutMs) {
    return new Promise((resolve, reject) => {
        const sock = net.createConnection(IPC_PORT, '127.0.0.1');
        let buf = '';
        const t = setTimeout(() => { sock.destroy(); reject(new Error('timeout')); }, timeoutMs || 20000);
        sock.on('connect', () => sock.write(JSON.stringify(
            Object.assign({ requestId: String(Date.now()) }, req)) + '\n'));
        sock.on('data', (d) => {
            buf += d.toString();
            const i = buf.indexOf('\n');
            if (i === -1) return;
            clearTimeout(t); sock.end();
            try { resolve(JSON.parse(buf.slice(0, i))); } catch (e) { reject(e); }
        });
        sock.on('error', (e) => { clearTimeout(t); reject(e); });
    });
}
const evalIn = async (provider, script, ms) => {
    const r = await ipc({ action: 'executeScript', provider, data: { script } }, ms || 30000);
    if (!r.success) throw new Error(r.error || 'executeScript failed');
    return r.result;
};

/** MCP handshake + tools/list. Read-only: lists the surface, calls nothing. */
function mcpToolNames(timeoutMs) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [MCP_SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
        let out = '', settled = false;
        const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); child.kill(); fn(v); };
        const timer = setTimeout(() => done(reject, new Error('MCP timeout')), timeoutMs || 30000);
        const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
        child.stdout.on('data', (d) => {
            out += d.toString();
            let i;
            while ((i = out.indexOf('\n')) !== -1) {
                const line = out.slice(0, i).trim(); out = out.slice(i + 1);
                if (!line) continue;
                let m; try { m = JSON.parse(line); } catch (e) { continue; }
                if (m.id === 1 && m.result) {
                    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
                    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
                } else if (m.id === 2) {
                    const tools = ((m.result && m.result.tools) || []).map((t) => t.name);
                    done(resolve, tools);
                }
            }
        });
        child.on('error', (e) => done(reject, e));
        child.on('exit', (c) => done(reject, new Error('MCP server exited ' + c)));
        send({
            jsonrpc: '2.0', id: 1, method: 'initialize',
            params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'preflight', version: '1' } }
        });
    });
}

// Every .js/.cjs the main process loads or injects. Derived rather than typed out:
// see the note at the call site for what the hand-maintained version missed.
function listSources(dirs) {
    const out = [];
    for (const d of dirs) {
        let entries = [];
        try {
            entries = fs.readdirSync(path.join(REPO, d), { withFileTypes: true });
        } catch (e) { continue; }
        for (const e of entries) {
            if (e.isFile() && /\.(js|cjs)$/.test(e.name)) out.push(d + '/' + e.name);
        }
    }
    return out;
}

function newestMtime(files) {
    let newest = 0, which = null;
    for (const f of files) {
        try {
            const m = fs.statSync(path.join(REPO, f)).mtimeMs;
            if (m > newest) { newest = m; which = f; }
        } catch (e) { /* absent file is not a staleness signal */ }
    }
    return { ms: newest, file: which };
}

(async () => {
    if (!asJson) console.log('\nProxima orchestration preflight\n');

    // ── 0. The machine, before anything that needs a socket ──────────
    // First on purpose. A starved box fails every check below it for reasons that
    // have nothing to do with what those checks are about, and the last time that
    // happened the conclusion was "restart Proxima" about an app that was fine.
    {
        const m = memoryCheck();
        record('free memory', m.status, m.detail);
    }

    // ── 1. Proxima itself ────────────────────────────
    // Find the port before judging reachability. Probing proves it with a real ping,
    // so something else on 19223 is not mistaken for Proxima.
    let found = null;
    try {
        found = await proximaPort.discover(explicitPort, 2500);
        IPC_PORT = found.port;
        IPC_VIA = found.via;
    } catch (e) {
        // TWO different failures, and conflating them cost hours once already: a host
        // whose loopback stack is dead looks identical to an app that is not running,
        // unless the socket error code is carried this far. describeFailure() has already
        // written the right message for whichever it is — do NOT append "Start Proxima"
        // to it, because for a host fault that is the one action guaranteed not to help.
        if (e.hostNetworkFault) {
            record('HOST networking', 'FAIL', e.message);
        } else if (e.undetermined) {
            // Neither "the app is down" nor "the machine is broken" is supported by
            // the evidence. An unattended run that reads this as either one acts on
            // a guess, so it gets its own status and its own exit code.
            record('Proxima IPC', 'UNKNOWN', e.message);
        } else {
            record('Proxima IPC', 'FAIL', e.message);
        }
        return finish();
    }
    let status = null;
    try {
        status = await ipc({ action: 'getStatus' }, 15000);
        record('Proxima IPC (127.0.0.1:' + IPC_PORT + ')', 'PASS',
            'via ' + IPC_VIA + ' · providers: ' + (status.providers || []).join(', '));
    } catch (e) {
        record('Proxima IPC (127.0.0.1:' + IPC_PORT + ')', 'FAIL',
            'answered a ping then failed getStatus (' + e.message + ')');
        return finish();
    }
    // A port reached any way other than the app's own record means something is out of
    // step, and the next tool along may resolve it differently. Worth saying.
    if (IPC_VIA === 'fallback' || IPC_VIA === 'settings.json') {
        record('IPC port discovery', 'WARN',
            'found on ' + IPC_PORT + ' via ' + IPC_VIA + ', not the app\'s own ipc-port.json — ' +
            'a Proxima older than that change, or a stale settings value. Other tools may disagree.');
    }

    // ── 2. Stale code — the check that exists because of experience ──
    // Anything the MAIN PROCESS loads only takes effect on restart. Engine files are
    // re-read per injection but cached by provider-api, so they need one too.
    if (!status.startedAt) {
        record('running code is current', 'WARN',
            'this Proxima predates the startedAt field — restart once to enable the check');
    } else {
        const started = Date.parse(status.startedAt);
        // Derived, not hand-listed. The typed-out version had drifted: it named
        // seven files and omitted chatgpt-engine.js, gemini-engine.js,
        // perplexity-engine.js, rest-api.cjs, ws-server.cjs and preload.cjs. Editing
        // any of those and skipping the restart earned a confident "running code is
        // current" — this check asserting currency it never verified, which is worse
        // than not checking at all. Caught when a chatgpt-engine.js change passed.
        const watched = listSources(['electron', 'electron/providers']);
        const newest = newestMtime(watched);
        if (newest.ms > started) {
            const mins = Math.round((newest.ms - started) / 60000);
            record('running code is current', 'FAIL',
                newest.file + ' changed ' + mins + ' min AFTER Proxima started — RESTART PROXIMA. ' +
                'Until you do, that change is not running and will look like a broken feature.');
        } else {
            record('running code is current', 'PASS',
                'started ' + status.startedAt + ', newer than every source file');
        }
    }

    // ── 3. Providers reachable and logged in ─────────
    for (const p of ['claude', 'qwen']) {
        if ((status.providers || []).indexOf(p) === -1) {
            try { await ipc({ action: 'initProvider', provider: p }, 20000); } catch (e) { /* reported below */ }
        }
    }

    try {
        const org = await evalIn('claude',
            'window.__proximaClaude && window.__proximaClaude.getOrgId ? window.__proximaClaude.getOrgId() : null', 30000);
        if (org) record('Claude session', 'PASS', 'org ' + String(org).slice(0, 8) + '…');
        else record('Claude session', 'FAIL', 'no organization returned — log in to claude.ai in the Proxima tab');
    } catch (e) {
        record('Claude session', 'FAIL', e.message);
    }

    try {
        const raw = await evalIn('claude',
            'JSON.stringify({ keys: window.__proximaClaude ? Object.keys(window.__proximaClaude) : [] })', 20000);
        const keys = JSON.parse(raw).keys;
        const need = ['send', 'setConversation', 'listArtifacts', 'downloadArtifact', 'ensureConversation'];
        const missing = need.filter((k) => keys.indexOf(k) === -1);
        if (missing.length) {
            record('Claude engine build', 'FAIL',
                'missing ' + missing.join(', ') + ' — the injected engine is older than the source. Restart Proxima.');
        } else record('Claude engine build', 'PASS', keys.length + ' exports');
    } catch (e) { record('Claude engine build', 'FAIL', e.message); }

    // Qwen needs its anti-bot SDK ready, and must not be sitting behind a CAPTCHA.
    try {
        const raw = await evalIn('qwen', `JSON.stringify({
            engine: !!window.__proximaQwen,
            sessions: (window.__proximaQwen && window.__proximaQwen.sessions) ? true : false,
            bx: !!window.baxiaInitialized,
            tok: (function(){ try { return !!window.__baxia__.getFYModule.getUidToken(); } catch(e){ return false; } })(),
            punish: Array.from(document.querySelectorAll('iframe'))
                     .filter(function(f){ return (f.src||'').indexOf('punish') !== -1; }).length
        })`, 30000);
        const q = JSON.parse(raw);
        if (!q.engine) record('Qwen engine', 'FAIL', 'not injected — open the Qwen tab');
        else if (!q.sessions) record('Qwen engine', 'FAIL',
            'no sessions() export — injected engine predates per-caller state. Restart Proxima.');
        else record('Qwen engine', 'PASS', 'sessions supported');

        if (q.punish) {
            record('Qwen WAF', 'FAIL',
                q.punish + ' CAPTCHA frame(s) present. Open the Qwen tab and solve the slider, ' +
                'or reload it. Sends will hang for minutes until you do.');
        } else if (!q.bx || !q.tok) {
            record('Qwen signing', 'FAIL',
                'baxia not ready (bx=' + q.bx + ' token=' + q.tok + '). Reload the Qwen tab and ' +
                'let it finish booting; unsigned requests draw a CAPTCHA.');
        } else {
            record('Qwen signing + WAF', 'PASS', 'signed, no challenge pending');
        }
    } catch (e) {
        // One probe feeds three checks, so a throw here used to record only 'Qwen
        // engine' and leave WAF and signing absent from the report entirely — not
        // FAIL, not WARN, simply missing. In a tool whose entire job is to answer
        // "is everything reachable before I go AFK", a check that silently does not
        // run is worse than one that fails: the summary line still says READY.
        // Every check the probe covers is now recorded explicitly. Found in code
        // review of 9d0b3ade.
        record('Qwen engine', 'FAIL', e.message);
        record('Qwen signing + WAF', 'FAIL',
            'not checked — the Qwen probe failed before it could report (' + e.message + ')');
    }

    // ── 4. MCP surface ───────────────────────────────
    try {
        const tools = await mcpToolNames(40000);
        const need = ['ask_claude', 'ask_qwen', 'claude_conversation', 'claude_artifacts'];
        const missing = need.filter((t) => tools.indexOf(t) === -1);
        if (missing.length) record('MCP tools', 'FAIL', 'missing ' + missing.join(', '));
        else record('MCP tools', 'PASS', tools.length + ' tools, all orchestration tools present');
    } catch (e) {
        record('MCP tools', 'FAIL', 'MCP server did not answer (' + e.message + ')');
    }

    // ── 5. QA video pipeline dependencies ────────────
    for (const bin of ['ffmpeg', 'ffprobe']) {
        const r = spawnSync(bin, ['-version'], { encoding: 'utf8' });
        if (r.status === 0) record(bin, 'PASS', (r.stdout || '').split('\n')[0].slice(0, 48));
        else record(bin, 'WARN', 'not on PATH — the QA video pipeline will not work');
    }

    try {
        require.resolve('ws');
        record('ws module (recorder)', 'PASS', 'resolvable');
    } catch (e) {
        record('ws module (recorder)', 'WARN', 'not resolvable — record-cdp.cjs cannot run');
    }

    try {
        const list = await new Promise((res, rej) => {
            const req = require('http').get('http://127.0.0.1:' + browserPort + '/json/list', (r) => {
                let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
            });
            req.on('error', rej); req.setTimeout(3000, () => { req.destroy(); rej(new Error('timeout')); });
        });
        record('Chrome debug port ' + browserPort, 'PASS', list.length + ' target(s)');
    } catch (e) {
        record('Chrome debug port ' + browserPort, 'WARN',
            'nothing listening — start it with tools/qa-video-review/start-browser.cjs when you need the QA pipeline');
    }

    // ── 6. Artifact output directory ─────────────────
    const artDir = path.join(process.env.APPDATA || process.env.HOME || '.', 'proxima', 'claude-artifacts');
    try {
        fs.mkdirSync(artDir, { recursive: true });
        const probe = path.join(artDir, '.preflight');
        fs.writeFileSync(probe, 'x'); fs.unlinkSync(probe);
        record('artifact directory writable', 'PASS', artDir);
    } catch (e) {
        record('artifact directory writable', 'FAIL', artDir + ' — ' + e.message);
    }

    finish();

    function finish() {
        const fails = results.filter((r) => r.status === 'FAIL');
        const warns = results.filter((r) => r.status === 'WARN');
        const unknowns = results.filter((r) => r.status === 'UNKNOWN');
        if (asJson) {
            console.log(JSON.stringify({
                ok: fails.length === 0 && unknowns.length === 0,
                fails: fails.length, warns: warns.length, unknowns: unknowns.length, results
            }, null, 2));
        } else {
            console.log('\n' + (fails.length === 0 && unknowns.length === 0
                ? 'READY — ' + results.length + ' checks, ' + warns.length + ' warning(s).'
                : fails.length
                    ? 'NOT READY — ' + fails.length + ' failure(s). Fix these before leaving it unattended:'
                    : 'UNDETERMINED — ' + unknowns.length + ' check(s) could not be decided. ' +
                      'Treating as not ready; do not act on a guess:')
            );
            fails.concat(unknowns).forEach((f) => console.log('   • ' + f.name + ': ' + f.detail));
            console.log('');
        }
        // 2 is not 1 and neither is 0: an unattended loop that reads "I could not
        // tell" as "fine" walks into work it cannot do.
        process.exit(fails.length ? 1 : unknowns.length ? 2 : 0);
    }
})().catch((e) => {
    console.error('preflight crashed: ' + e.message);
    process.exit(1);
});
