#!/usr/bin/env node
/**
 * Proxima QA — start the Chrome that both chrome-devtools MCP and record-cdp.cjs attach to.
 *
 * Exists because the ordering is a footgun. chrome-devtools MCP is registered here as
 *   npx chrome-devtools-mcp@latest --browserUrl=http://127.0.0.1:9333
 * and --browserUrl means the MCP ATTACHES rather than launching its own browser. So
 * Chrome has to be listening on 9333 before the MCP server starts, or every tool it
 * offers fails with a connection error that looks like a broken MCP install.
 *
 * Also pins --remote-debugging-address=127.0.0.1. Without it, if anything already
 * holds 127.0.0.1:9333 Chrome silently binds [::1]:9333 instead and logs a
 * bind() error nobody reads — after which the MCP and the recorder can end up looking
 * at two different browsers.
 *
 * usage:
 *   node start-browser.cjs [--port 9333] [--url http://localhost:5173]
 *                          [--headed] [--profile <dir>] [--size 1280,800]
 *
 * Exits 0 once the debug port answers, printing the port and the first page target.
 * Leaves Chrome running in the background. Use --kill to stop whatever holds the port.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

function parseArgs(argv) {
    const a = {
        port: 9333, url: 'about:blank', headed: false, kill: false,
        profile: path.join(os.tmpdir(), 'qa-chrome-profile'), size: '1280,800'
    };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i], v = argv[i + 1];
        if (k === '--port') { a.port = Number(v); i++; }
        else if (k === '--url') { a.url = v; i++; }
        else if (k === '--profile') { a.profile = v; i++; }
        else if (k === '--size') { a.size = v; i++; }
        else if (k === '--headed') { a.headed = true; }
        else if (k === '--kill') { a.kill = true; }
    }
    return a;
}

function findChrome() {
    if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
    const candidates = process.platform === 'win32' ? [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    ] : process.platform === 'darwin' ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    ] : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
    for (const c of candidates) { if (c && fs.existsSync(c)) return c; }
    return null;
}

function probe(port) {
    return new Promise((resolve) => {
        // Try both loopback families — see the header note.
        const hosts = ['127.0.0.1', '[::1]'];
        let done = 0, found = null;
        hosts.forEach((h) => {
            const req = http.get('http://' + h + ':' + port + '/json/list', (res) => {
                let b = '';
                res.on('data', (d) => { b += d; });
                res.on('end', () => {
                    try {
                        const list = JSON.parse(b);
                        if (!found) found = { host: h, pages: list.filter((t) => t.type === 'page') };
                    } catch (e) { /* not ready */ }
                    if (++done === hosts.length) resolve(found);
                });
            });
            req.on('error', () => { if (++done === hosts.length) resolve(found); });
            req.setTimeout(1500, () => { req.destroy(); });
        });
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const args = parseArgs(process.argv);

    if (args.kill) {
        if (process.platform !== 'win32') {
            console.log(JSON.stringify({ ok: false, error: '--kill is implemented for Windows only' }));
            process.exit(1);
        }
        const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8' }).stdout || '';
        const pids = new Set();
        out.split(/\r?\n/).forEach((l) => {
            if (l.indexOf(':' + args.port) !== -1 && l.indexOf('LISTENING') !== -1) {
                const p = l.trim().split(/\s+/).pop();
                if (p && p !== '0') pids.add(p);
            }
        });
        pids.forEach((p) => spawnSync('taskkill', ['/PID', p, '/F'], { encoding: 'utf8' }));
        console.log(JSON.stringify({ ok: true, killed: Array.from(pids), port: args.port }));
        process.exit(0);
    }

    const existing = await probe(args.port);
    if (existing) {
        console.log(JSON.stringify({
            ok: true, reused: true, port: args.port, host: existing.host,
            pages: existing.pages.map((p) => p.url).slice(0, 5),
            note: 'a browser was already listening; not launching another'
        }));
        process.exit(0);
    }

    const chrome = findChrome();
    if (!chrome) {
        console.log(JSON.stringify({ ok: false, error: 'no Chrome/Edge binary found; set CHROME_PATH' }));
        process.exit(1);
    }
    fs.mkdirSync(args.profile, { recursive: true });

    const flags = [
        '--remote-debugging-port=' + args.port,
        '--remote-debugging-address=127.0.0.1',
        '--user-data-dir=' + args.profile,
        '--window-size=' + args.size,
        '--hide-scrollbars',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        // Keeps the recording clean: no "Chrome is being controlled" infobar, no
        // first-run bubbles, no background network chatter in the trace.
        '--disable-features=Translate,MediaRouter',
        '--disable-background-networking'
    ];
    if (!args.headed) flags.push('--headless=new');
    flags.push(args.url);

    const child = spawn(chrome, flags, { detached: true, stdio: 'ignore' });
    child.unref();

    for (let i = 0; i < 40; i++) {
        await sleep(500);
        const p = await probe(args.port);
        if (p) {
            console.log(JSON.stringify({
                ok: true, launched: true, port: args.port, host: p.host,
                headed: args.headed, profile: args.profile,
                pages: p.pages.map((x) => x.url).slice(0, 5)
            }));
            process.exit(0);
        }
    }
    console.log(JSON.stringify({ ok: false, error: 'Chrome did not open the debug port within 20s', port: args.port }));
    process.exit(1);
})();
