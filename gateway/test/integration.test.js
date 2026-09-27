'use strict';

const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { StateStore } = require('../src/state-store');
const { CookieStore } = require('../src/cookie-store');
const { EngineLoader } = require('../src/engine-loader');
const { SessionManager } = require('../src/session-manager');
const { IpcServer } = require('../src/ipc-server');
const { createHandler, REJECTED_ACTIONS } = require('../src/actions');
const { PROVIDERS } = require('../src/providers');

/**
 * Integration: a real TCP client against a real server, with a stubbed browser.
 *
 * The stub satisfies the narrow surface SessionManager uses, so the whole IPC path -
 * framing, dispatch, validation, error typing - is exercised without Chromium.
 */

// ---- test doubles -------------------------------------------------------------

function stubContext({ cookies = [], persistent = true } = {}) {
    let store = cookies.slice();
    const initScripts = [];
    return {
        _store: () => store,
        _initScripts: initScripts,
        async addInitScript(arg) {
            initScripts.push(arg);
        },
        async cookies(filter) {
            if (!filter) return store.slice();
            return store.filter((c) => String(c.domain).includes(filter));
        },
        async addCookies(list) {
            for (const c of list) {
                const i = store.findIndex((x) => x.name === c.name && x.domain === c.domain);
                if (i >= 0) store[i] = c;
                else store.push(c);
            }
        },
        async clearCookies() {
            store = [];
        },
        async close() {
            this._closed = true;
        },
        newPage: async () => stubPage(),
    };
}

function stubPage({ enginePresent = true, response = 'hello from engine' } = {}) {
    const state = { response, typing: false, sent: [], closed: false, responses: null };
    // When `responses` is a queue, each getResponse() shifts the next value. That makes
    // retry behaviour deterministic instead of racing a timer.
    const nextResponse = () =>
        Array.isArray(state.responses) && state.responses.length
            ? state.responses.shift()
            : state.response;
    const engine = {
        sendMessage: (p) => {
            state.sent.push(p);
            return { ok: true };
        },
        newConversation: () => ({ cleared: true }),
        getResponse: () => nextResponse(),
        getTypingStatus: () => ({ typing: state.typing }),
        isReady: () => true,
    };
    return {
        _state: state,
        async goto() {},
        // Three distinct call shapes are used by the gateway, all via Playwright's
        // evaluate(pageFunction, arg) signature:
        //   evaluate(sourceString)         - engine script injection
        //   evaluate(fn, globalName)       - engine presence probe
        //   evaluate(fn, { g, m, a })      - engine method call
        async evaluate(arg, maybeArg) {
            if (typeof arg === 'string') return true; // injection
            if (typeof arg === 'function') {
                if (typeof maybeArg === 'string') return enginePresent; // probe
                if (maybeArg && typeof maybeArg === 'object' && maybeArg.g) {
                    const { g, m, a } = maybeArg;
                    if (!engine[m]) {
                        return { __error: `engine method ${g}.${m} is not a function` };
                    }
                    return Promise.resolve(engine[m](...(a || [])));
                }
                return null;
            }
            return null;
        },
        async content() {
            return '<html>stub</html>';
        },
    };
}

function stubBrowserFactory() {
    return async () => ({
        newContext: async () => stubContext(),
        close: async () => {},
    });
}

/**
 * Write a minimal engine file per provider into a temp dir.
 *
 * The shipped perplexity engine is the real clean-room reference; these stubs exist so
 * every provider path can be exercised without five real provider protocols. They prove
 * the gateway treats all providers uniformly, which is the property under test.
 */
function stubEngineDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxima-gw-eng-'));
    for (const spec of Object.values(PROVIDERS)) {
        fs.writeFileSync(
            path.join(dir, `${spec.name}-engine.js`),
            `/* stub */\nwindow.${spec.engineGlobal} = { sendMessage: function(){return {ok:true};}, newConversation: function(){return {cleared:true};}, getResponse: function(){return '';}, getTypingStatus: function(){return {typing:false};}, isReady: function(){return true;} };\n`,
            'utf8'
        );
    }
    return dir;
}

function makeGateway(stateDir) {
    const stateStore = new StateStore(stateDir);
    const cookieStore = new CookieStore(stateStore);
    const engineLoader = new EngineLoader({
        engineDir: stubEngineDir(),
        stateStore,
    });
    const sessions = new SessionManager({
        stateStore,
        cookieStore,
        engineLoader,
        settings: { headless: true },
        browserFactory: stubBrowserFactory(),
    });
    const handler = createHandler({
        sessions,
        stateStore,
        startedAt: '2026-01-01T00:00:00.000Z',
        getFileReferenceEnabled: () => true,
    });
    const ipc = new IpcServer({ handler, stateStore, port: 0 });
    return { stateStore, cookieStore, engineLoader, sessions, ipc, handler };
}

// ---- a minimal client that speaks the documented protocol ---------------------

class Client {
    constructor(port) {
        this.port = port;
        this.buffer = '';
        this.pending = new Map();
        this.nextId = 1;
    }

    connect() {
        return new Promise((resolve, reject) => {
            this.socket = net.createConnection({ port: this.port, host: '127.0.0.1' }, resolve);
            this.socket.once('error', reject);
            this.socket.on('data', (chunk) => {
                this.buffer += chunk.toString('utf8');
                const lines = this.buffer.split('\n');
                this.buffer = lines.pop() || '';
                for (const line of lines) {
                    if (!line.trim()) continue;
                    const msg = JSON.parse(line);
                    const resolveFn = this.pending.get(msg.requestId);
                    if (resolveFn) {
                        this.pending.delete(msg.requestId);
                        resolveFn(msg);
                    }
                }
            });
        });
    }

    send(action, provider, data = {}, { raw = null, timeoutMs = 10000, id = null } = {}) {
        const requestId = id !== null ? id : this.nextId++;
        return new Promise((resolve) => {
            // A client must never hang forever on a request the server cannot correlate.
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                resolve({
                    requestId,
                    success: false,
                    error: `Client timeout after ${timeoutMs}ms waiting for requestId ${requestId}`,
                    errorKind: 'client-timeout',
                });
            }, timeoutMs);
            if (timer.unref) timer.unref();

            this.pending.set(requestId, (msg) => {
                clearTimeout(timer);
                resolve(msg);
            });
            const frame = raw !== null ? raw : JSON.stringify({ requestId, action, provider, data });
            this.socket.write(frame + '\n');
        });
    }

    close() {
        this.socket.destroy();
    }
}

async function withGateway(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxima-gw-int-'));
    const g = makeGateway(dir);
    const port = await g.ipc.listen();
    const client = new Client(port);
    await client.connect();
    try {
        await fn(client, g);
    } finally {
        client.close();
        await g.shutdown?.();
        await g.ipc.close();
        await g.sessions.close();
    }
}

// ---- tests --------------------------------------------------------------------

test('end-to-end: health and status over a real socket', async () => {
    await withGateway(async (client, g) => {
        const pong = await client.send('ping');
        assert.equal(pong.success, true);
        assert.equal(pong.message, 'pong');
        assert.equal(pong.requestId, 1, 'requestId must be echoed');

        const status = await client.send('getStatus');
        assert.equal(status.success, true);
        assert.equal(status.pid, process.pid);
        assert.ok(Array.isArray(status.providers));
        assert.ok(status.knownProviders.includes('qwen'));
        assert.equal(status.port, g.ipc.boundPort, 'status must report the real bound port');
    });
});

test('a real client from the existing automation layer can attach unchanged', async () => {
    // This mirrors scripts/lib/proxima-client.cjs: newline-delimited JSON, requestId
    // correlation, and reading the port from a fact file.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxima-gw-compat-'));
    const g = makeGateway(dir);
    const port = await g.ipc.listen();

    const fact = JSON.parse(fs.readFileSync(g.stateStore.portFactPath, 'utf8'));
    assert.equal(fact.port, port, 'the fact file must let a client discover the port');

    const socket = net.createConnection({ port: fact.port, host: '127.0.0.1' });
    await new Promise((r) => socket.once('connect', r));

    const reply = await new Promise((resolve) => {
        let buf = '';
        socket.on('data', (c) => {
            buf += c.toString();
            const line = buf.split('\n').find((l) => l.trim());
            if (line) resolve(JSON.parse(line));
        });
        socket.write(
            JSON.stringify({ requestId: 1, action: 'sendMessage', provider: 'perplexity', data: { message: 'hi' } }) + '\n'
        );
    });

    assert.equal(reply.requestId, 1);
    assert.equal(reply.success, true, reply.error);
    socket.destroy();
    await g.ipc.close();
    await g.sessions.close();
});

test('unknown action and unknown provider are rejected, not crashed on', async () => {
    await withGateway(async (client) => {
        const bad = await client.send('noSuchAction');
        assert.equal(bad.success, false);
        assert.match(bad.error, /Unknown action/);

        const badProvider = await client.send('isLoggedIn', 'notaprovider');
        assert.equal(badProvider.success, false);
        assert.match(badProvider.error, /Unknown provider/);
    });
});

test('a provider-scoped action without a provider is refused', async () => {
    await withGateway(async (client) => {
        const res = await client.send('sendMessage', null, { message: 'x' });
        assert.equal(res.success, false);
        assert.match(res.error, /requires a provider/);
    });
});

test('GUI actions are refused with the reason on record (P1)', async () => {
    await withGateway(async (client) => {
        for (const action of Object.keys(REJECTED_ACTIONS)) {
            const res = await client.send(action, 'chatgpt');
            assert.equal(res.success, false, `${action} must be refused`);
            assert.match(res.error, /not available/);
        }
    });
});

test('malformed JSON does not kill the connection (F5)', async () => {
    await withGateway(async (client) => {
        // The id is salvaged textually, so the caller can still correlate and see why.
        const bad = await client.send(
            null,
            null,
            {},
            { raw: '{"requestId": 77, oops', id: 77 }
        );
        assert.equal(bad.success, false);
        assert.equal(bad.requestId, 77, 'requestId must be salvaged so the caller is not left pending');
        assert.match(bad.error, /Malformed JSON/);
        assert.equal(bad.errorKind, 'protocol');

        // The same socket must still work afterwards.
        const pong = await client.send('ping');
        assert.equal(pong.success, true);
    });
});

test('a client is never left pending when a response cannot be correlated', async () => {
    await withGateway(async (client) => {
        const res = await client.send(null, null, {}, { raw: 'total garbage no id here', timeoutMs: 2000 });
        assert.equal(res.success, false, 'must fail rather than hang');
        assert.ok(
            res.errorKind === 'protocol' || res.errorKind === 'client-timeout',
            `expected protocol or timeout, got ${res.errorKind}`
        );
    });
});

test('a frame with no action is refused without dropping the socket', async () => {
    await withGateway(async (client) => {
        const res = await client.send(
            null,
            null,
            {},
            { raw: JSON.stringify({ requestId: 909 }), id: 909 }
        );
        assert.equal(res.success, false);
        assert.match(res.error, /missing an "action"/);
        const pong = await client.send('ping');
        assert.equal(pong.success, true);
    });
});

test('sendMessage stamps the timestamp exactly once (A2)', async () => {
    await withGateway(async (client, g) => {
        await client.send('sendMessage', 'perplexity', { message: 'hello' });
        const session = g.sessions._session('perplexity');
        const sent = session.page._state.sent[0];
        const stamps = sent.message.match(/Current time:/g) || [];
        assert.equal(stamps.length, 1, `expected one stamp, got ${stamps.length}`);
    });
});

test('timestamp:false opts out of stamping (A2)', async () => {
    await withGateway(async (client, g) => {
        await client.send('sendMessage', 'perplexity', { message: 'hello', timestamp: false });
        const sent = g.sessions._session('perplexity').page._state.sent[0];
        assert.equal(sent.message, 'hello', 'no stamp may be appended');
    });
});

test('claude turns are tagged, other providers are not', async () => {
    await withGateway(async (client, g) => {
        await client.send('sendMessage', 'claude', { message: 'for claude' });
        await client.send('sendMessage', 'perplexity', { message: 'for pplx' });

        const claude = g.sessions._session('claude').page._state.sent[0].message;
        const pplx = g.sessions._session('perplexity').page._state.sent[0].message;
        assert.ok(claude.startsWith('[PROXIMA]'), 'claude turns must be tagged');
        assert.ok(!pplx.startsWith('[PROXIMA]'), 'the tag must not leak to other providers');
    });
});

test('sendMessage requires a message', async () => {
    await withGateway(async (client) => {
        const res = await client.send('sendMessage', 'chatgpt', {});
        assert.equal(res.success, false);
        assert.match(res.error, /requires data.message/);
    });
});

test('getResponseWithTyping returns a real answer on the first attempt', async () => {
    await withGateway(async (client) => {
        const res = await client.send('getResponseWithTyping', 'perplexity');
        assert.equal(res.success, true);
        assert.equal(res.response, 'hello from engine');
        assert.equal(res.attempts, 1);
    });
});

test('placeholder responses are retried, not returned (A8)', async () => {
    await withGateway(async (client, g) => {
        await client.send('initProvider', 'perplexity');
        const page = g.sessions._session('perplexity').page;
        // Deterministic: two placeholders, then a real answer. No timers.
        page._state.responses = ['no response captured', '', 'real answer'];

        const res = await client.send('getResponseWithTyping', 'perplexity', {
            maxAttempts: 5,
            retryDelayMs: 5,
        });
        assert.equal(res.success, true);
        assert.equal(res.response, 'real answer');
        assert.equal(res.attempts, 3, `expected exactly 3 attempts, got ${res.attempts}`);
    });
});

test('a placeholder is never surfaced to the caller as an answer', async () => {
    await withGateway(async (client, g) => {
        await client.send('initProvider', 'perplexity');
        const page = g.sessions._session('perplexity').page;
        page._state.responses = ['', '   ', 'no response received'];

        const res = await client.send('getResponseWithTyping', 'perplexity', {
            maxAttempts: 3,
            retryDelayMs: 5,
        });
        assert.equal(res.success, false, 'a run of placeholders must not report success');
        assert.equal(res.attempts, 3);
    });
});

test('capture gives up with a diagnostic rather than looping forever (Q5)', async () => {
    await withGateway(async (client, g) => {
        await client.send('initProvider', 'perplexity');
        g.sessions._session('perplexity').page._state.response = '';
        const res = await client.send('getResponseWithTyping', 'perplexity', {
            maxAttempts: 3,
            retryDelayMs: 5,
        });
        assert.equal(res.success, false);
        assert.match(res.error, /failed after 3 attempts/);
    });
});

test('a missing engine is an engine failure, not a transport failure (F6)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxima-gw-f6-'));
    const stateStore = new StateStore(dir);
    const cookieStore = new CookieStore(stateStore);
    // An engine dir with no engine installed.
    const engineLoader = new EngineLoader({ engineDir: dir, stateStore });
    const sessions = new SessionManager({
        stateStore,
        cookieStore,
        engineLoader,
        settings: { headless: true },
        browserFactory: stubBrowserFactory(),
    });
    const handler = createHandler({ sessions, stateStore, startedAt: 'x' });

    const res = await handler({ action: 'initProvider', provider: 'chatgpt' });
    assert.equal(res.success, false);
    assert.equal(res.errorKind, 'engine', 'must be typed as an engine failure');
    assert.match(res.error, /No engine installed/);
});

test('isLoggedIn answers from disk without launching a browser', async () => {
    await withGateway(async (client, g) => {
        const res = await client.send('isLoggedIn', 'claude');
        assert.equal(res.success, true);
        assert.equal(res.loggedIn, false, 'a fresh profile has no auth');
        assert.deepEqual(g.sessions.initializedProviders(), [], 'must not have launched anything');
    });
});

test('cookie injection authenticates without interactive login', async () => {
    await withGateway(async (client, g) => {
        const res = await client.send('setCookies', 'claude', {
            cookies: [{ name: 'sessionKey', domain: '.claude.ai', value: 'abc123' }],
        });
        assert.equal(res.success, true);
        assert.equal(res.set, 1);
        assert.equal(res.loggedIn, true, 'injected auth cookie must be recognised');

        const check = await client.send('isLoggedIn', 'claude');
        assert.equal(check.loggedIn, true);

        // And it must survive a restart via the profile on disk.
        assert.ok(fs.existsSync(g.sessions._session('claude').profileFile));
    });
});

test('unloadProvider preserves auth (A6) and reports honestly', async () => {
    await withGateway(async (client) => {
        await client.send('setCookies', 'perplexity', {
            cookies: [{ name: 'pplx_session', domain: '.perplexity.ai', value: 'v' }],
        });
        const res = await client.send('unloadProvider', 'perplexity');
        assert.equal(res.success, true);
        assert.deepEqual(res.unloaded, ['perplexity']);

        const after = await client.send('isLoggedIn', 'perplexity');
        assert.equal(after.loggedIn, true, 'auth must survive an unload');
    });
});

test('unloadProvider with no target is an error, not a silent success', async () => {
    await withGateway(async (client) => {
        const res = await client.send('unloadProvider', null, { providers: [] });
        assert.equal(res.success, false);
        assert.match(res.error, /name a provider/);
    });
});

test('purgeProvider destroys auth, unlike unloadProvider', async () => {
    await withGateway(async (client) => {
        await client.send('setCookies', 'perplexity', {
            cookies: [{ name: 'pplx_session', domain: '.perplexity.ai', value: 'v' }],
        });
        const res = await client.send('purgeProvider', 'perplexity');
        assert.equal(res.success, true);

        const after = await client.send('isLoggedIn', 'perplexity');
        assert.equal(after.loggedIn, false, 'purge must remove auth');
    });
});

test('setHeadlessMode persists and reports that a restart is required (Q3)', async () => {
    await withGateway(async (client, g) => {
        const res = await client.send('setHeadlessMode', null, { headless: false });
        assert.equal(res.success, true);
        assert.equal(res.headless, false);
        assert.equal(res.requiresRestart, true);
        assert.equal(g.stateStore.loadSettings().headless, false, 'must persist');
    });
});

test('a corrupt cookie payload is a clean error, not a crash', async () => {
    await withGateway(async (client) => {
        const res = await client.send('setCookies', 'claude', { cookies: 'not json at all' });
        assert.equal(res.success, false);
        assert.match(res.error, /not valid JSON/);
    });
});

test('concurrent requests on one socket stay correlated', async () => {
    await withGateway(async (client) => {
        const results = await Promise.all([
            client.send('ping'),
            client.send('getStatus'),
            client.send('ping'),
            client.send('getSettings'),
        ]);
        assert.deepEqual(results.map((r) => r.requestId), [1, 2, 3, 4]);
        assert.ok(results.every((r) => r.success));
    });
});
