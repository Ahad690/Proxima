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
 * SHARING A LAPTOP WITH ANOTHER AGENT — use a named instance:
 *   node start-browser.cjs --instance myproj --url http://localhost:4173
 *   node start-browser.cjs --list
 *   node start-browser.cjs --instance myproj --kill
 *
 * A named instance gets its OWN port and its OWN profile directory. The profile is
 * what actually separates browsers: Chrome treats --user-data-dir as a browser's
 * identity, so launching with a profile that is already in use hands the command line
 * to the running browser and exits rather than starting a second one. Same profile =
 * same browser, whatever port you asked for.
 *
 * Without --instance you get the old shared browser on 9333, which is fine alone and a
 * collision when it is not: measured on this machine, 9333 held eight page targets
 * belonging to a different project.
 *
 * Exits 0 once the debug port answers, printing the port and the first page target.
 * Leaves Chrome running in the background.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const instances = require('./chrome-instances.cjs');

function parseArgs(argv) {
    const a = {
        port: null, url: 'about:blank', headed: false, kill: false,
        profile: null, size: '1280,800', instance: null, list: false
    };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i], v = argv[i + 1];
        if (k === '--port') { a.port = Number(v); i++; }
        else if (k === '--url') { a.url = v; i++; }
        else if (k === '--profile') { a.profile = v; i++; }
        else if (k === '--size') { a.size = v; i++; }
        else if (k === '--headed') { a.headed = true; }
        else if (k === '--instance') { a.instance = v; i++; }
        else if (k === '--list') { a.list = true; }
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

    if (args.list) {
        const rows = instances.listEntries().map((e) => Object.assign({}, e, {
            alive: instances.pidAlive(e.pid)
        }));
        console.log(JSON.stringify({ ok: true, instances: rows }, null, 2));
        process.exit(0);
    }

    // A named instance owns a port and a profile. Reusing the name reattaches to the
    // same browser, which is what a returning agent wants; a dead entry is replaced.
    if (args.instance) {
        const existing = instances.readEntry(args.instance);
        if (existing && !args.kill) {
            if (instances.pidAlive(existing.pid) && await probe(existing.port)) {
                console.log(JSON.stringify({
                    ok: true, reused: true, instance: instances.safeName(args.instance),
                    port: existing.port, profile: existing.profile, pid: existing.pid,
                    note: 'your own instance was already running'
                }));
                process.exit(0);
            }
            // Registry said it was there and it is not. Say so rather than silently
            // reusing a port some other program may now hold.
            console.error('[browser] instance ' + instances.safeName(args.instance) +
                ' was registered on port ' + existing.port + ' but is not running; relaunching');
            instances.removeEntry(args.instance);
        }
        if (args.port === null) args.port = await instances.allocatePort();
        if (args.profile === null) args.profile = instances.profileFor(args.instance);
    }
    if (args.port === null) args.port = 9333;
    if (args.profile === null) args.profile = path.join(os.tmpdir(), 'qa-chrome-profile');

    if (args.kill) {
        // Killing BY PORT takes down whatever holds it, which on a shared laptop is
        // very likely another agent's browser and everything they had open. So a named
        // instance kills only its own recorded pid, and the portwide version has to be
        // asked for explicitly.
        if (args.instance) {
            const r = instances.killInstance(args.instance);
            console.log(JSON.stringify(r));
            process.exit(r.ok ? 0 : 1);
        }
        if (process.argv.indexOf('--force') === -1) {
            console.log(JSON.stringify({
                ok: false,
                error: 'refusing to kill whatever holds port ' + args.port +
                    ' — on a shared machine that is probably another agent\'s browser.',
                hint: 'use --instance <name> --kill to stop only your own, or add --force ' +
                    'if you really mean the whole port.'
            }));
            process.exit(1);
        }
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
            pageCount: existing.pages.length,
            note: 'a browser was already listening; not launching another',
            // The old message stopped at 'reused'. Whose browser it is matters more
            // than the fact of reuse, and the tab list is the evidence.
            warning: existing.pages.length > 1
                ? 'this browser has ' + existing.pages.length + ' tabs and may belong to ' +
                  'another agent. Use --instance <name> for your own browser, and pass ' +
                  '--new-tab to the recorder/drivers rather than a bare --url-filter.'
                : undefined
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
            let registered = null;
            if (args.instance) {
                registered = instances.writeEntry({
                    name: instances.safeName(args.instance), port: args.port,
                    profile: args.profile, pid: child.pid, url: args.url,
                    headed: args.headed, startedAt: new Date().toISOString()
                });
            }
            console.log(JSON.stringify({
                ok: true, launched: true, port: args.port, host: p.host,
                headed: args.headed, profile: args.profile,
                instance: registered ? registered.name : undefined,
                pid: child.pid,
                pages: p.pages.map((x) => x.url).slice(0, 5)
            }));
            process.exit(0);
        }
    }
    console.log(JSON.stringify({ ok: false, error: 'Chrome did not open the debug port within 20s', port: args.port }));
    process.exit(1);
})();
