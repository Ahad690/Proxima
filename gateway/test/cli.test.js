'use strict';

const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync, spawn } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'proxima-gw.js');

/**
 * CLI tests.
 *
 * The CLI is the only way a human touches the gateway, so it gets tested like one:
 * real argv, real sockets, real exit codes. A CLI that returns 0 on failure is worse
 * than no CLI, because a script trusts the exit code.
 */

function tmpState() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxima-cli-'));
    return { dir, fact: path.join(dir, 'port.json') };
}

/** Run the CLI with a captured environment. Returns { code, out, err }. */
function runCli(args, env = {}) {
    const res = require('child_process').spawnSync(process.execPath, [CLI, ...args], {
        encoding: 'utf8',
        env: {
            ...process.env,
            PROXIMA_GATEWAY_STATE_DIR: path.join(os.tmpdir(), 'proxima-cli-state'),
            ...env,
        },
        timeout: 20000,
    });
    return { code: res.status, out: res.stdout || '', err: res.stderr || '' };
}

// ---- argument parsing --------------------------------------------------------

test('parseArgs separates positionals from flags', () => {
    const { parseArgs } = require('../bin/proxima-gw.js');
    const a = parseArgs(['login', 'claude', '--cookies', 'c.json', '--headed']);
    assert.deepEqual(a._, ['login', 'claude']);
    assert.equal(a.flags.cookies, 'c.json');
    assert.equal(a.flags.headed, true, 'a trailing flag with no value is boolean true');
});

test('parseArgs does not swallow a following positional as a flag value', () => {
    const { parseArgs } = require('../bin/proxima-gw.js');
    const a = parseArgs(['--headless', 'logout', 'qwen']);
    assert.equal(a.flags.headless, true);
    assert.deepEqual(a._, ['logout', 'qwen']);
});

test('usage lists every command', () => {
    const { usage } = require('../bin/proxima-gw.js');
    for (const c of ['check', 'status', 'login', 'logout']) {
        assert.ok(usage().includes(c), `usage must mention ${c}`);
    }
});

// ---- port discovery ----------------------------------------------------------

test('resolvePort prefers AGENT_HUB_PORT over the recorded fact', () => {
    const { dir, fact } = tmpState();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fact, JSON.stringify({ port: 19999, pid: process.pid }));
    const saved = process.env.AGENT_HUB_PORT;
    process.env.AGENT_HUB_PORT = '19500';
    try {
        const { resolvePort } = require('../bin/proxima-gw.js');
        const r = resolvePort();
        assert.equal(r.port, 19500, 'env must win, matching the automation client precedence');
        assert.equal(r.via, 'env');
    } finally {
        if (saved === undefined) delete process.env.AGENT_HUB_PORT;
        else process.env.AGENT_HUB_PORT = saved;
    }
});

test('the CLI exit code is non-zero when the gateway is not running', () => {
    const { fact } = tmpState();
    const r = runCli(['check'], { AGENT_HUB_PORT: '19998', PROXIMA_GATEWAY_PORT_FACT: fact });
    assert.equal(r.code, 1, 'a script must be able to trust this exit code');
    assert.match(r.out, /NOT RUNNING/);
    // The message has to tell the operator what to do, not just that it failed.
    assert.match(r.out, /node src\\index\.js|node src\/index\.js/);
});

test('an unknown command is a usage error, not a stack trace', () => {
    const r = runCli(['nope']);
    assert.equal(r.code, 2);
    assert.match(r.err, /Unknown command/);
    assert.ok(!/at Object\.|at Module\./.test(r.err), 'must not dump a stack trace at the user');
});

test('an unknown provider is rejected before any connection', () => {
    const r = runCli(['login', 'notaprovider', '--cookies', 'x.json']);
    assert.equal(r.code, 2);
    assert.match(r.err, /Unknown provider/);
    assert.match(r.err, /perplexity/, 'must list the valid providers');
});

test('a missing cookie file is reported clearly', () => {
    const r = runCli(['login', 'claude', '--cookies', 'C:\\definitely\\not\\here.json']);
    assert.equal(r.code, 2);
    assert.match(r.err, /No such file/);
});

test('login with no method is a usage error listing both options', () => {
    const r = runCli(['login', 'claude']);
    assert.equal(r.code, 2);
    assert.match(r.err, /--cookies/);
    assert.match(r.err, /--headed/);
});

test('help exits zero and prints usage', () => {
    const r = runCli(['help']);
    assert.equal(r.code, 0);
    assert.match(r.out, /USAGE/);
});

// ---- table formatting --------------------------------------------------------

test('table pads columns so it is readable in a terminal', () => {
    const { table } = require('../bin/proxima-gw.js');
    const out = table(
        [
            ['chatgpt', 'loaded', 'yes'],
            ['perplexity', '-', 'NO'],
        ],
        ['PROVIDER', 'STATE', 'LOGGED IN']
    );
    const lines = out.split('\n');
    assert.ok(lines[0].includes('PROVIDER'));
    assert.ok(lines[2].includes('chatgpt'));
    // The separator must be as wide as the header.
    assert.ok(lines[1].includes('----------'));
});

test('table handles an empty result set', () => {
    const { table } = require('../bin/proxima-gw.js');
    assert.match(table([], ['A', 'B']), /none/);
});

test('table output has no ANSI escape codes', () => {
    // Colour would corrupt redirected output and any downstream parsing.
    const { table } = require('../bin/proxima-gw.js');
    const out = table([['a', 'b']], ['A', 'B']);
    // eslint-disable-next-line no-control-regex
    assert.ok(!/\[/.test(out), 'must be plain text');
});

// ---- end to end against a stub gateway --------------------------------------

/** A minimal stand-in that answers the actions the CLI issues. */
async function startStub(handlers) {
    const server = net.createServer((socket) => {
        let buf = '';
        socket.on('data', (chunk) => {
            buf += chunk.toString();
            const lines = buf.split('\n');
            buf = lines.pop() || '';
            for (const line of lines) {
                if (!line.trim()) continue;
                let req;
                try {
                    req = JSON.parse(line);
                } catch {
                    continue;
                }
                const res = (handlers[req.action] || (() => ({ success: false, error: 'no stub' })))(req);
                socket.write(JSON.stringify({ ...res, requestId: req.requestId }) + '\n');
            }
        });
        socket.on('error', () => {});
    });
    const port = await new Promise((resolve) =>
        server.listen(0, '127.0.0.1', () => resolve(server.address().port))
    );
    return { server, port, close: () => new Promise((r) => server.close(r)) };
}

test('status prints a row per provider and exits zero', async () => {
    const stub = await startStub({
        ping: () => ({ success: true, message: 'pong' }),
        getStatus: () => ({
            success: true,
            providers: ['claude'],
            knownProviders: ['chatgpt', 'perplexity', 'claude', 'gemini', 'qwen'],
            pid: 1234,
            port: 19222,
            startedAt: '2026-01-01T00:00:00.000Z',
        }),
        isLoggedIn: (req) => ({ success: true, provider: req.provider, loggedIn: req.provider === 'claude' }),
    });
    try {
        const r = runCli(['status'], { AGENT_HUB_PORT: String(stub.port) });
        assert.equal(r.code, 0, r.err);
        assert.match(r.out, /PROVIDER/);
        assert.match(r.out, /claude\s+loaded\s+yes/);
        assert.match(r.out, /qwen\s+-\s+NO/);
    } finally {
        await stub.close();
    }
});

test('status reports an unreachable gateway without a stack trace', () => {
    const r = runCli(['status'], { AGENT_HUB_PORT: '19997' });
    assert.equal(r.code, 1);
    assert.match(r.err, /not reachable/i);
    assert.ok(!/at Object\./.test(r.err));
});

test('login --cookies reports success and verifies auth', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'proxima-cookies-'));
    const file = path.join(tmp, 'claude.json');
    fs.writeFileSync(file, JSON.stringify([{ name: 'sessionKey', value: 'abc', domain: '.claude.ai' }]));

    const stub = await startStub({
        setCookies: (req) => ({
            success: true,
            provider: req.provider,
            set: 1,
            failed: 0,
            loggedIn: true,
            message: 'Applied 1 cookies. Session authenticated.',
        }),
    });
    try {
        const r = runCli(['login', 'claude', '--cookies', file], { AGENT_HUB_PORT: String(stub.port) });
        assert.equal(r.code, 0, r.err);
        assert.match(r.out, /claude: .*authenticated/);
    } finally {
        await stub.close();
    }
});

test('login reports failure when cookies are applied but do not authenticate', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'proxima-cookies-'));
    const file = path.join(tmp, 'claude.json');
    fs.writeFileSync(file, JSON.stringify([{ name: 'theme', value: 'dark', domain: '.claude.ai' }]));

    const stub = await startStub({
        setCookies: () => ({
            success: true,
            provider: 'claude',
            set: 1,
            failed: 0,
            loggedIn: false,
            message: 'Applied 1 cookies. No recognised auth cookie found.',
        }),
    });
    try {
        const r = runCli(['login', 'claude', '--cookies', file], { AGENT_HUB_PORT: String(stub.port) });
        assert.equal(r.code, 1, 'a non-authenticating login must not report success');
        assert.match(r.out, /No recognised auth cookie/);
        assert.match(r.out, /--headed/, 'must suggest the alternative');
    } finally {
        await stub.close();
    }
});

test('logout confirms destruction on disk', async () => {
    const stub = await startStub({
        purgeProvider: () => ({ success: true, purged: [{ provider: 'qwen', purged: true }] }),
    });
    try {
        const r = runCli(['logout', 'qwen'], { AGENT_HUB_PORT: String(stub.port) });
        assert.equal(r.code, 0, r.err);
        assert.match(r.out, /auth destroyed on disk/);
    } finally {
        await stub.close();
    }
});

test('logout propagates a server-side refusal', async () => {
    const stub = await startStub({
        purgeProvider: () => ({ success: false, error: 'name a provider, or pass data.providers' }),
    });
    try {
        const r = runCli(['logout', 'qwen'], { AGENT_HUB_PORT: String(stub.port) });
        assert.equal(r.code, 1, 'a refused destructive action must not exit zero');
        assert.match(r.err, /name a provider/);
    } finally {
        await stub.close();
    }
});

test('login --headed sets the override and explains the restart', async () => {
    const stub = await startStub({
        setSetting: (req) => ({ success: true, settings: req.data }),
        initProvider: () => ({ success: true, provider: 'chatgpt' }),
    });
    try {
        const r = runCli(['login', 'chatgpt', '--headed'], { AGENT_HUB_PORT: String(stub.port) });
        assert.equal(r.code, 0, r.err);
        assert.match(r.out, /visible window/);
        assert.match(r.out, /restart-requiring/);
    } finally {
        await stub.close();
    }
});

// ---- interop: the port fact must land where the legacy client looks ----------

test('the gateway writes its port fact where the legacy client reads it', () => {
    const { StateStore, legacyUserDataDir } = require('../src/state-store');
    // Mirrors the path resolution in scripts/lib/proxima-port.cjs. If these ever
    // diverge, the existing automation client silently stops finding the gateway.
    const clientPath = (() => {
        if (process.platform === 'win32' && process.env.APPDATA) {
            return path.join(process.env.APPDATA, 'proxima', 'ipc-port.json');
        }
        if (process.platform === 'darwin' && process.env.HOME) {
            return path.join(process.env.HOME, 'Library', 'Application Support', 'proxima', 'ipc-port.json');
        }
        return path.join(process.env.HOME || '.', '.config', 'proxima', 'ipc-port.json');
    })();

    const store = new StateStore(fs.mkdtempSync(path.join(os.tmpdir(), 'proxima-facts-')));
    assert.equal(
        store.portFactPath,
        clientPath,
        'gateway and client must agree on the fact file, or the client cannot connect'
    );
    assert.ok(legacyUserDataDir().length > 0);
});

test('a port collision fails loudly instead of relocating', async () => {
    const { StateStore } = require('../src/state-store');
    const { IpcServer } = require('../src/ipc-server');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxima-collide-'));
    const store = new StateStore(dir);

    const first = new IpcServer({ handler: async () => ({ success: true }), stateStore: store, port: 0 });
    const taken = await first._tryListen(0);
    const port = first.server.address().port;

    const second = new IpcServer({ handler: async () => ({ success: true }), stateStore: store, port });
    // Relocation is opt-in, so the default must refuse.
    await assert.rejects(() => second.listen(), /already in use/);

    // And it must not have written a fact naming the wrong process.
    const fact = store.readPortFact();
    assert.ok(!fact || fact.port !== port, 'must not leave a fact pointing at the other process');

    // Opting in works, and warns.
    const moved = await second.listen({ allowRelocate: true });
    assert.equal(moved, port + 1);

    await second.close();
    await first.close();
    void taken;
});
