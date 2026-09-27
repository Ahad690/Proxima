'use strict';

const test = require('node:test');
const assert = require('node:assert');
// The gateway writes its port fact to the legacy Electron userData dir so the
// existing automation client can find it. Tests must never write there: it is the
// real user profile, and several test files start servers concurrently, so they
// would both pollute it and race each other over the same fact file.
process.env.PROXIMA_GATEWAY_PORT_FACT = require('path').join(
    require('os').tmpdir(),
    `proxima-test-portfact-${process.pid}.json`
);
const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { StateStore } = require('../src/state-store');
const { CookieStore } = require('../src/cookie-store');
const { EngineLoader, EngineError } = require('../src/engine-loader');
const { SessionManager } = require('../src/session-manager');
const { IpcServer } = require('../src/ipc-server');
const { createHandler, processMemoryReport, NEEDS_PROVIDER, resolveProbe } = require('../src/actions');

/**
 * Contract tests for the action surface and the error paths.
 *
 * These exist because the coverage report showed the interesting failures were the
 * untested ones: an action nobody calls, an error nobody classifies, a fallback nobody
 * exercises. Two real bugs have already come out of this style of test, so the gaps
 * were worth closing deliberately rather than chasing a percentage.
 */

// ---- harness ------------------------------------------------------------------

function stubEngineDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxima-gw-eng2-'));
    const names = ['chatgpt', 'perplexity', 'claude', 'gemini', 'qwen'];
    for (const name of names) {
        const globals = {
            chatgpt: '__proximaChatGPT',
            perplexity: '__proximaPerplexity',
            claude: '__proximaClaude',
            gemini: '__proximaGemini',
            qwen: '__proximaQwen',
        };
        fs.writeFileSync(
            path.join(dir, `${name}-engine.js`),
            `/* stub */\nwindow.${globals[name]} = { sendMessage: function(){return {ok:true};}, newConversation: function(){return {cleared:true};}, getResponse: function(){return 'engine answer';}, getTypingStatus: function(){return {typing:true};}, isReady: function(){return true;}, marker: 'installed' };\n`,
            'utf8'
        );
    }
    return dir;
}

function makePage({ enginePresent = true, contentThrows = false, evaluateThrows = false } = {}) {
    const state = { sent: [], typing: false, response: 'engine answer', navigations: [] };
    const engine = {
        sendMessage: (p) => {
            state.sent.push(p);
            return { ok: true };
        },
        newConversation: () => ({ cleared: true }),
        getResponse: () => state.response,
        getTypingStatus: () => ({ typing: state.typing }),
        isReady: () => true,
    };
    return {
        _state: state,
        async goto(url) {
            state.navigations.push(url);
        },
        async evaluate(arg, maybeArg) {
            if (evaluateThrows) throw new Error('evaluate exploded');
            if (typeof arg === 'string') return true;
            if (typeof arg === 'function') {
                if (typeof maybeArg === 'string') return enginePresent;
                if (maybeArg && typeof maybeArg === 'object' && maybeArg.g) {
                    if (!engine[maybeArg.m]) {
                        return { __error: `engine method ${maybeArg.m} is not a function` };
                    }
                    return Promise.resolve(engine[maybeArg.m](...(maybeArg.a || [])));
                }
            }
            return null;
        },
        async content() {
            if (contentThrows) throw new Error('no content');
            return '<html>real</html>';
        },
    };
}

function makeGateway({ fileReference = true, pageOpts = {} } = {}) {
    const stateStore = new StateStore(fs.mkdtempSync(path.join(os.tmpdir(), 'proxima-gw-c-')));
    const cookieStore = new CookieStore(stateStore);
    const engineLoader = new EngineLoader({ engineDir: stubEngineDir(), stateStore });

    const page = makePage(pageOpts);
    const context = {
        _page: page,
        _store: [],
        async addInitScript() {},
        async cookies(filter) {
            if (!filter) return this._store.slice();
            return this._store.filter((c) => String(c.domain).includes(filter));
        },
        async addCookies(list) {
            for (const c of list) this._store.push(c);
        },
        async clearCookies() {
            this._store = [];
        },
        async close() {},
        async newPage() {
            return page;
        },
    };

    const sessions = new SessionManager({
        stateStore,
        cookieStore,
        engineLoader,
        settings: { headless: true },
        browserFactory: async () => ({
            newContext: async () => context,
            close: async () => {},
        }),
    });

    const handler = createHandler({
        sessions,
        stateStore,
        startedAt: '2026-01-01T00:00:00.000Z',
        getFileReferenceEnabled: () => fileReference,
    });

    return { stateStore, cookieStore, engineLoader, sessions, handler, page, context };
}

function clientFor(port) {
    const c = {
        buffer: '',
        pending: new Map(),
        nextId: 1,
        socket: null,
    };
    c.connect = () =>
        new Promise((resolve, reject) => {
            c.socket = net.createConnection({ port, host: '127.0.0.1' }, resolve);
            c.socket.once('error', reject);
            c.socket.on('data', (chunk) => {
                c.buffer += chunk.toString('utf8');
                const lines = c.buffer.split('\n');
                c.buffer = lines.pop() || '';
                for (const line of lines) {
                    if (!line.trim()) continue;
                    const msg = JSON.parse(line);
                    const fn = c.pending.get(msg.requestId);
                    if (fn) {
                        c.pending.delete(msg.requestId);
                        fn(msg);
                    }
                }
            });
        });
    c.send = (action, provider, data = {}) => {
        const requestId = c.nextId++;
        return new Promise((resolve) => {
            c.pending.set(requestId, resolve);
            c.socket.write(JSON.stringify({ requestId, action, provider, data }) + '\n');
        });
    };
    return c;
}

async function overSocket(fn) {
    const g = makeGateway();
    const ipc = new IpcServer({ handler: g.handler, stateStore: g.stateStore, port: 0 });
    const port = await ipc.listen();
    const client = clientFor(port);
    await client.connect();
    try {
        await fn(client, g);
    } finally {
        client.socket.destroy();
        await ipc.close();
        await g.sessions.close();
    }
}

// ---- action surface: every action reachable and correct -----------------------

test('every non-GUI action has a test that reaches it', async () => {
    await overSocket(async (c) => {
        const cases = [
            ['ping', null, {}],
            ['getStatus', null, {}],
            ['memory', null, {}],
            ['initProvider', 'perplexity', {}],
            ['isLoggedIn', 'perplexity', {}],
            ['sendMessage', 'perplexity', { message: 'hi' }],
            ['getResponse', 'perplexity', {}],
            ['getTypingStatus', 'perplexity', {}],
            ['getResponseWithTyping', 'perplexity', {}],
            ['newConversation', 'perplexity', {}],
            ['waitForSendButton', 'perplexity', {}],
            ['executeScript', 'perplexity', { script: '1+1' }],
            ['navigate', 'perplexity', { url: 'https://example.com' }],
            ['debugDOM', 'perplexity', {}],
            ['getSettings', null, {}],
            ['setSetting', null, { key: 'fileReference', value: true }],
            ['getCookies', 'perplexity', {}],
            ['setCookies', 'claude', { cookies: [{ name: 'sessionKey', domain: '.claude.ai', value: 'v' }] }],
            ['unloadProvider', 'perplexity', {}],
            ['purgeProvider', 'perplexity', {}],
            ['setHeadlessMode', null, { headless: true }],
        ];
        for (const [action, provider, data] of cases) {
            const res = await c.send(action, provider, data);
            assert.equal(res.success, true, `${action} failed: ${res.error}`);
        }
    });
});

test('getTypingStatus surfaces the engine indicator', async () => {
    await overSocket(async (c, g) => {
        await c.send('initProvider', 'perplexity');
        g.page._state.typing = true;
        const res = await c.send('getTypingStatus', 'perplexity');
        assert.equal(res.success, true, res.error);
        assert.equal(res.typing, true, 'the engine indicator must be passed through');
    });
});

test('waitForSendButton reports readiness from the engine', async () => {
    await overSocket(async (c) => {
        const res = await c.send('waitForSendButton', 'perplexity');
        assert.equal(res.success, true);
        assert.equal(res.ready, true);
    });
});

test('waitForSendButton with an engine that never registers is a typed failure', async () => {
    // Loading the provider requires the engine, so an absent engine must surface as a
    // classified engine error rather than a false "not ready".
    const g = makeGateway({ pageOpts: { enginePresent: false } });
    const res = await g.handler({ action: 'waitForSendButton', provider: 'perplexity' });
    assert.equal(res.success, false);
    assert.equal(res.errorKind, 'engine');
    await g.sessions.close();
});

test('executeScript returns the evaluated result', async () => {
    await overSocket(async (c) => {
        const res = await c.send('executeScript', 'perplexity', { script: 'document.title' });
        assert.equal(res.success, true, res.error);
        assert.equal(res.result, true, 'the result of the page evaluation is passed through');
    });
});

test('executeScript requires a string script', async () => {
    await overSocket(async (c) => {
        const res = await c.send('executeScript', 'perplexity', { script: 42 });
        assert.equal(res.success, false);
        assert.match(res.error, /requires data.script/);
    });
});

test('navigate moves the page and re-injects', async () => {
    await overSocket(async (c, g) => {
        const res = await c.send('navigate', 'perplexity', { url: 'https://example.com/x' });
        assert.equal(res.success, true);
        assert.equal(res.url, 'https://example.com/x');
        assert.ok(g.page._state.navigations.includes('https://example.com/x'));
    });
});

test('navigate requires a url', async () => {
    await overSocket(async (c) => {
        const res = await c.send('navigate', 'perplexity', {});
        assert.equal(res.success, false);
        assert.match(res.error, /requires data.url/);
    });
});

test('debugDOM returns page length, and full only on request', async () => {
    await overSocket(async (c) => {
        const brief = await c.send('debugDOM', 'perplexity');
        assert.equal(brief.success, true);
        assert.equal(brief.length, '<html>real</html>'.length);
        assert.equal(brief.html, undefined, 'html must be omitted unless asked for');

        const full = await c.send('debugDOM', 'perplexity', { full: true });
        assert.equal(full.html, '<html>real</html>');
    });
});

test('debugDOM reports failure when the page cannot be read', async () => {
    const g = makeGateway({ pageOpts: { contentThrows: true } });
    const res = await g.handler({ action: 'debugDOM', provider: 'perplexity' });
    assert.equal(res.success, false, 'must not claim success when content is unavailable');
});

test('getCookies returns only the provider domain', async () => {
    await overSocket(async (c) => {
        await c.send('setCookies', 'claude', {
            cookies: [
                { name: 'sessionKey', domain: '.claude.ai', value: 'v' },
                { name: 'unrelated', domain: '.example.com', value: 'x' },
            ],
        });
        const res = await c.send('getCookies', 'claude');
        assert.equal(res.success, true);
        assert.equal(res.count, 1);
        assert.equal(res.cookies[0].name, 'sessionKey');
    });
});

test('getCookies works from disk with no browser loaded', async () => {
    const g = makeGateway();
    await g.sessions.setCookies('claude', [
        { name: 'sessionKey', domain: '.claude.ai', value: 'v' },
    ]);
    const res = await g.handler({ action: 'getCookies', provider: 'claude' });
    assert.equal(res.success, true);
    assert.equal(res.count, 1);
    await g.sessions.close();
});

test('settings round trip, and setSetting validates its key', async () => {
    await overSocket(async (c) => {
        await c.send('setSetting', null, { key: 'headlessByProvider', value: { qwen: false } });
        const got = await c.send('getSettings');
        assert.deepEqual(got.settings.headlessByProvider, { qwen: false });

        const bad = await c.send('setSetting', null, { value: 1 });
        assert.equal(bad.success, false);
        assert.match(bad.error, /requires data.key/);
    });
});

test('per-provider headless override is read from settings', async () => {
    // Settings are captured at construction, so they must be supplied up front.
    const stateStore = new StateStore(fs.mkdtempSync(path.join(os.tmpdir(), 'proxima-gw-h-')));
    const sessions = new SessionManager({
        stateStore,
        cookieStore: new CookieStore(stateStore),
        engineLoader: new EngineLoader({ engineDir: stubEngineDir(), stateStore }),
        settings: { headless: true, headlessByProvider: { qwen: false } },
        browserFactory: async () => ({ newContext: async () => ({}), close: async () => {} }),
    });
    assert.equal(sessions._headlessFor('qwen'), false, 'override wins');
    assert.equal(sessions._headlessFor('perplexity'), true, 'others fall back to global');
    assert.equal(sessions._headlessFor('gemini'), true);
    await sessions.close();
});

test('purgeProvider is reachable through the action surface', async () => {
    await overSocket(async (c) => {
        await c.send('setCookies', 'perplexity', {
            cookies: [{ name: 'pplx_s', domain: '.perplexity.ai', value: 'v' }],
        });
        const res = await c.send('purgeProvider', 'perplexity');
        assert.equal(res.success, true);
        assert.equal(res.purged.length, 1);
        const after = await c.send('isLoggedIn', 'perplexity');
        assert.equal(after.loggedIn, false);
    });
});

test('multi-provider unload and purge accept a list', async () => {
    await overSocket(async (c) => {
        await c.send('initProvider', 'perplexity');
        await c.send('initProvider', 'chatgpt');
        const res = await c.send('unloadProvider', null, { providers: ['perplexity', 'chatgpt'] });
        assert.equal(res.success, true);
        assert.deepEqual(res.unloaded.sort(), ['chatgpt', 'perplexity']);

        const purge = await c.send('purgeProvider', null, { providers: ['perplexity'] });
        assert.equal(purge.success, true);
        assert.equal(purge.purged.length, 1);
    });
});

test('unloading a provider that was never loaded is reported, not faked', async () => {
    await overSocket(async (c) => {
        const res = await c.send('unloadProvider', 'qwen');
        assert.equal(res.success, true);
        assert.deepEqual(res.unloaded, [], 'a no-op unload must not claim success');
        assert.equal(res.reports[0].reason, 'not-loaded');
    });
});

// ---- attachment gating (A3) ---------------------------------------------------

test('attachments are refused when file reference is disabled (A3)', async () => {
    const g = makeGateway({ fileReference: false });
    const res = await g.handler({
        action: 'sendMessage',
        provider: 'claude',
        data: { message: 'see attached', attachments: ['/tmp/a.png'] },
    });
    assert.equal(res.success, false);
    assert.match(res.error, /File reference is disabled/);
    await g.sessions.close();
});

test('an empty attachments array is not treated as an attachment', () => {
    // hasAttachments must distinguish "no files" from "files".
    const g = makeGateway();
    const none = g.handler({ action: 'sendMessage', provider: 'claude', data: { message: 'x' } });
    return none.then(async (res) => {
        assert.equal(res.success, true, 'no attachments array must proceed');
        await g.sessions.close();
    });
});

test('a single filePath counts as an attachment', async () => {
    const g = makeGateway({ fileReference: false });
    const res = await g.handler({
        action: 'sendMessage',
        provider: 'claude',
        data: { message: 'x', filePath: '/tmp/a.png' },
    });
    assert.equal(res.success, false, 'a bare filePath must trip the gate');
    await g.sessions.close();
});

// ---- engine error classification (F6) ----------------------------------------

test('a missing engine is classified, not silently undefined', async () => {
    const loader = new EngineLoader({ engineDir: fs.mkdtempSync(path.join(os.tmpdir(), 'empty-')) });
    let caught = null;
    try {
        loader.load('perplexity');
    } catch (e) {
        caught = e;
    }
    assert.ok(caught, 'a missing engine must throw');
    assert.ok(caught instanceof EngineError);
    assert.equal(caught.kind, 'engine');
    assert.equal(caught.reason, 'engine-missing');
    assert.equal(caught.provider, 'perplexity');
});

test('an engine method that does not exist is a typed error, not a result', async () => {
    // Regression guard: the in-page sentinel used to be returned to the caller as if it
    // were a legitimate value, which would have made a missing method look like a
    // successful call returning nonsense.
    const loader = new EngineLoader({ engineDir: stubEngineDir() });
    const page = makePage();
    let caught = null;
    try {
        await loader.call(page, 'perplexity', 'noSuchMethod');
    } catch (e) {
        caught = e;
    }
    assert.ok(caught, 'must raise rather than return the sentinel');
    assert.equal(caught.kind, 'engine');
    assert.equal(caught.reason, 'engine-method-missing');
    assert.equal(caught.method, 'noSuchMethod');
});

test('a present engine method still returns its value', async () => {
    const loader = new EngineLoader({ engineDir: stubEngineDir() });
    const page = makePage();
    assert.equal(await loader.call(page, 'perplexity', 'getResponse'), 'engine answer');
});

test('calling a method on an absent engine raises engine-absent', async () => {
    const loader = new EngineLoader({ engineDir: stubEngineDir() });
    const page = makePage({ enginePresent: false });
    let caught = null;
    try {
        await loader.call(page, 'perplexity', 'getResponse');
    } catch (e) {
        caught = e;
    }
    assert.ok(caught);
    assert.equal(caught.reason, 'engine-absent');
});

test('probe returns false when evaluate throws', async () => {
    const loader = new EngineLoader({ engineDir: stubEngineDir() });
    const page = makePage({ evaluateThrows: true });
    assert.equal(await loader.probe(page, 'perplexity'), false);
});

test('install fails loudly when the engine does not register its global', async () => {
    const loader = new EngineLoader({ engineDir: stubEngineDir() });
    const page = makePage({ enginePresent: false });
    const context = { async addInitScript() {} };
    await assert.rejects(
        () => loader.install(context, page, 'perplexity'),
        (e) => e instanceof EngineError && e.reason === 'engine-absent'
    );
});

test('hasEngine reports which providers are installed', () => {
    const loader = new EngineLoader({ engineDir: stubEngineDir() });
    assert.equal(loader.hasEngine('perplexity'), true);
    const empty = new EngineLoader({ engineDir: fs.mkdtempSync(path.join(os.tmpdir(), 'empty2-')) });
    assert.equal(empty.hasEngine('perplexity'), false);
});

// ---- session manager internals ----------------------------------------------

test('flushAll writes a profile file for every loaded session', async () => {
    const g = makeGateway();
    await g.sessions.initProvider('perplexity');
    // Auth cookies must exist: flushing deliberately skips writing an empty auth store,
    // so a file appearing with nothing in it would be noise on disk.
    g.context._store.push({
        name: 'pplx_session',
        value: 'persisted',
        domain: '.perplexity.ai',
    });
    await g.sessions.flushAll();
    const file = g.sessions._session('perplexity').profileFile;
    assert.ok(fs.existsSync(file), 'the profile file must be written');
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(stored.provider, 'perplexity');
    assert.ok(
        stored.cookies.some((c) => c.name === 'pplx_session'),
        'and must contain the auth cookie'
    );
    await g.sessions.close();
});

test('flushAll does not write an empty auth store', async () => {
    const g = makeGateway();
    await g.sessions.initProvider('perplexity');
    await g.sessions.flushAll();
    const file = g.sessions._session('perplexity').profileFile;
    assert.equal(
        fs.existsSync(file),
        false,
        'a profile with no auth cookies is not worth persisting'
    );
    await g.sessions.close();
});

test('the profile file is scoped to the provider auth domain', async () => {
    const g = makeGateway();
    await g.sessions.initProvider('perplexity');
    g.context._store.push(
        { name: 'pplx_session', value: 'keep', domain: '.perplexity.ai' },
        { name: 'tracking', value: 'drop', domain: '.someothertracker.test' }
    );
    await g.sessions.flushAll();
    const stored = JSON.parse(
        fs.readFileSync(g.sessions._session('perplexity').profileFile, 'utf8')
    );
    const names = stored.cookies.map((c) => c.name);
    assert.ok(names.includes('pplx_session'));
    assert.ok(
        !names.includes('tracking'),
        'unrelated domains must not accumulate in the auth store'
    );
    await g.sessions.close();
});

test('close is idempotent and safe with nothing loaded', async () => {
    const g = makeGateway();
    await g.sessions.close();
    await g.sessions.close();
});

test('initializedProviders lists only open sessions', async () => {
    const g = makeGateway();
    assert.deepEqual(g.sessions.initializedProviders(), []);
    await g.sessions.initProvider('perplexity');
    assert.deepEqual(g.sessions.initializedProviders(), ['perplexity']);
    await g.sessions.unloadProvider('perplexity');
    assert.deepEqual(g.sessions.initializedProviders(), []);
    await g.sessions.close();
});

test('a provider session knows whether it is open and active', async () => {
    const g = makeGateway();
    const s = g.sessions._session('perplexity');
    assert.equal(s.isOpen, false);
    assert.equal(s.isActive, false);
    await g.sessions.initProvider('perplexity');
    assert.equal(g.sessions._session('perplexity').isOpen, true);
    assert.equal(g.sessions._session('perplexity').isActive, false, 'loaded is not active');
    await g.sessions.sendMessage('perplexity', { message: 'hi' });
    assert.equal(g.sessions._session('perplexity').isActive, true, 'a turn makes it active');
    await g.sessions.close();
});

test('sending with newChat clears conversation state first', async () => {
    const g = makeGateway();
    await g.sessions.initProvider('perplexity');
    await g.sessions.sendMessage('perplexity', { message: 'one', newChat: true });
    const session = g.sessions._session('perplexity');
    assert.equal(session.isActive, true);
    await g.sessions.close();
});

// ---- process helpers ----------------------------------------------------------

test('memory report exposes the fields an operator needs', () => {
    const m = processMemoryReport();
    for (const key of ['rssMB', 'heapUsedMB', 'heapTotalMB', 'externalMB']) {
        assert.equal(typeof m[key], 'number', `${key} must be numeric`);
        assert.ok(m[key] >= 0);
    }
});

test('the provider-requiring action set is explicit', () => {
    assert.ok(NEEDS_PROVIDER.has('sendMessage'));
    assert.ok(!NEEDS_PROVIDER.has('ping'), 'ping must not require a provider');
    assert.ok(!NEEDS_PROVIDER.has('getSettings'));
});
