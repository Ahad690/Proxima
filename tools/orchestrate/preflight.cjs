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
 *   node preflight.cjs [--browser-port 9333] [--json]
 *
 * exit 0 = everything reachable, 1 = at least one FAIL. WARNs never fail the run.
 */
const fs = require('fs');
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

const results = [];
const record = (name, status, detail) => {
    results.push({ name, status, detail });
    if (!asJson) {
        const mark = status === 'PASS' ? 'ok  ' : status === 'WARN' ? 'warn' : 'FAIL';
        console.log('  [' + mark + '] ' + name + (detail ? ' — ' + detail : ''));
    }
};

function ipc(req, timeoutMs) {
    return new Promise((resolve, reject) => {
        const sock = net.createConnection(19222, '127.0.0.1');
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

    // ── 1. Proxima itself ────────────────────────────
    let status = null;
    try {
        status = await ipc({ action: 'getStatus' }, 15000);
        record('Proxima IPC (127.0.0.1:19222)', 'PASS',
            'providers: ' + (status.providers || []).join(', '));
    } catch (e) {
        record('Proxima IPC (127.0.0.1:19222)', 'FAIL',
            'not reachable (' + e.message + '). Start Proxima before anything else.');
        return finish();
    }

    // ── 2. Stale code — the check that exists because of experience ──
    // Anything the MAIN PROCESS loads only takes effect on restart. Engine files are
    // re-read per injection but cached by provider-api, so they need one too.
    if (!status.startedAt) {
        record('running code is current', 'WARN',
            'this Proxima predates the startedAt field — restart once to enable the check');
    } else {
        const started = Date.parse(status.startedAt);
        const watched = ['electron/main-v2.cjs', 'electron/provider-api.cjs',
            'electron/browser-manager.cjs', 'electron/providers/qwen-engine.js',
            'electron/providers/claude-engine.js', 'electron/providers/qwen-upload.cjs',
            'electron/providers/claude-upload.cjs'];
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
    } catch (e) { record('Qwen engine', 'FAIL', e.message); }

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
        if (asJson) {
            console.log(JSON.stringify({ ok: fails.length === 0, fails: fails.length, warns: warns.length, results }, null, 2));
        } else {
            console.log('\n' + (fails.length === 0
                ? 'READY — ' + results.length + ' checks, ' + warns.length + ' warning(s).'
                : 'NOT READY — ' + fails.length + ' failure(s). Fix these before leaving it unattended:')
            );
            fails.forEach((f) => console.log('   • ' + f.name + ': ' + f.detail));
            console.log('');
        }
        process.exit(fails.length ? 1 : 0);
    }
})().catch((e) => {
    console.error('preflight crashed: ' + e.message);
    process.exit(1);
});
