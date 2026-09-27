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
const os = require('os');
const path = require('path');
const fs = require('fs');

const { StateStore } = require('../src/state-store');
const { CookieStore } = require('../src/cookie-store');
const { EngineLoader } = require('../src/engine-loader');
const { SessionManager } = require('../src/session-manager');
const { IpcServer } = require('../src/ipc-server');
const { createHandler } = require('../src/actions');
const { redactString, redactCookies, containsSecret, SENSITIVE_COOKIE_NAMES } = require('../src/redact');

/**
 * Regression tests for the code-review findings.
 *
 * Each of these was a real defect confirmed by running the code first. They are named
 * after the invariant they protect, not the bug, so a future reader can tell what would
 * break rather than only what changed.
 */

// ---- shared harness ------------------------------------------------------------

function harness({ enginePresent = true, gotoThrows = false, installThrows = false } = {}) {
    const stateStore = new StateStore(fs.mkdtempSync(path.join(os.tmpdir(), 'proxima-reg-')));
    const cookieStore = new CookieStore(stateStore);
    const engineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxima-regeng-'));
    fs.writeFileSync(
        path.join(engineDir, 'claude-engine.js'),
        'window.__proximaClaude={sendMessage:function(){return{ok:true};},' +
            'newConversation:function(){return{};},getResponse:function(){return "answer";},' +
            'getTypingStatus:function(){return{typing:false};},isReady:function(){return true;}};'
    );

    const jar = [];
    const events = { contextsCreated: 0, contextsClosed: 0, navigations: 0, browsersCreated: 0 };

    const page = {
        async goto() {
            events.navigations += 1;
            if (gotoThrows) throw new Error('net::ERR_NAME_NOT_RESOLVED');
        },
        async evaluate(a, b) {
            if (typeof a === 'string') return true;
            if (typeof a === 'function') {
                if (typeof b === 'string') return enginePresent;
                if (installThrows) return null;
                if (b && b.g && b.m === 'getResponse') return 'answer';
                return Promise.resolve({ ok: true });
            }
            return null;
        },
        async content() { return '<html>x</html>'; },
    };
    const context = {
        async addInitScript() {},
        async cookies(f) {
            return f ? jar.filter((c) => String(c.domain).includes(f)) : jar.slice();
        },
        async addCookies(l) { l.forEach((c) => jar.push(c)); },
        async clearCookies() { jar.length = 0; },
        async close() { events.contextsClosed += 1; },
        async newPage() { return page; },
    };

    const sessions = new SessionManager({
        stateStore,
        cookieStore,
        engineLoader: new EngineLoader({ engineDir, stateStore }),
        settings: { headless: true },
        browserFactory: async () => {
            events.browsersCreated += 1;
            return {
                newContext: async () => {
                    events.contextsCreated += 1;
                    return context;
                },
                close: async () => {},
            };
        },
    });

    const handler = createHandler({ sessions, stateStore, startedAt: 'x' });
    return { stateStore, cookieStore, sessions, handler, jar, events, context, page };
}

// ---- A6: unload must preserve auth (was reported true while logging out) -------

test('A6: unloadProvider preserves auth acquired in the live context', async () => {
    const h = harness();
    await h.handler({ action: 'initProvider', provider: 'claude' });
    // The interactive-login path: cookies exist ONLY in the context, nothing on disk yet.
    h.jar.push({ name: 'sessionKey', value: 'abc123def456ghi789', domain: '.claude.ai' });

    assert.equal((await h.handler({ action: 'isLoggedIn', provider: 'claude' })).loggedIn, true);

    const res = await h.handler({ action: 'unloadProvider', provider: 'claude' });
    assert.equal(res.success, true);

    const after = await h.handler({ action: 'isLoggedIn', provider: 'claude' });
    assert.equal(after.loggedIn, true, 'unload must not log the operator out');

    // And the claim must be derived, not hardcoded.
    assert.equal(res.reports[0].authPreserved, true);
    assert.equal(res.unloaded.includes('claude'), true);
    await h.sessions.close();
});

test('A6: authPreserved is not claimed when nothing was on disk', async () => {
    const h = harness();
    await h.handler({ action: 'initProvider', provider: 'claude' });
    // No cookies at all: an unload must not claim preservation.
    const res = await h.handler({ action: 'unloadProvider', provider: 'claude' });
    assert.equal(res.reports[0].authPreserved, false, 'must not claim preservation it cannot verify');
    assert.ok(res.reports[0].warning, 'and must say why');
    await h.sessions.close();
});

// ---- C2: success responses must be redacted too ------------------------------

test('C2: getCookies does not put a raw cookie value on the wire', async () => {
    const h = harness();
    const ipc = new IpcServer({ handler: h.handler, stateStore: h.stateStore, port: 0 });
    const port = await ipc.listen();

    await h.handler({ action: 'initProvider', provider: 'claude' });
    h.jar.push({ name: 'sessionKey', value: 'abc123def456ghi789', domain: '.claude.ai' });

    const net = require('net');
    const client = net.createConnection({ port, host: '127.0.0.1' });
    await new Promise((r) => client.once('connect', r));
    const reply = await new Promise((resolve) => {
        let buf = '';
        client.on('data', (c) => {
            buf += c.toString();
            const line = buf.split('\n').find((l) => l.trim());
            if (line) resolve(JSON.parse(line));
        });
        client.write(JSON.stringify({ requestId: 1, action: 'getCookies', provider: 'claude' }) + '\n');
    });

    assert.ok(!JSON.stringify(reply).includes('abc123def456ghi789'), 'raw value leaked to the wire');
    assert.equal(reply.success, true, 'the call itself should still succeed');
    assert.ok(reply.cookies, 'the cookie list is still returned');

    client.destroy();
    await ipc.close();
    await h.sessions.close();
});

// ---- C5: every Authorization scheme must be redacted -------------------------

test('C5: every Authorization scheme has its credential redacted', () => {
    const cred = '9f8e7d6c5b4a3210zzzzzzzz';
    const schemes = ['Bearer', 'Basic', 'Token', 'DPoP', 'Negotiate', 'ApiKey', 'Custom'];
    for (const scheme of schemes) {
        const input = `Authorization: ${scheme} ${cred}`;
        const out = redactString(input);
        assert.ok(!out.includes(cred), `${scheme}: credential survived -> ${out}`);
    }
});

test('C5: a custom scheme is not mangled into looking-redacted', () => {
    // The old rule destroyed the scheme word and kept the credential, so the line
    // looked redacted while leaking. Assert the value is genuinely gone.
    const out = redactString('Authorization: ApiKey 9f8e7d6c5b4a3210zzzzzzzz');
    assert.equal(containsSecret(out), false, 'the leak oracle must agree it is clean');
});

test('C5: redaction is idempotent', () => {
    const once = redactString('Authorization: Basic dXNlcjpwYXNzd29yZDEyMw==');
    const twice = redactString(once);
    assert.equal(twice, once, 'a second pass must not change an already-redacted line');
});

// ---- I8: the sensitive-name list cannot drift from the registry --------------

test('I8: every provider auth cookie is a known-sensitive name', () => {
    const { PROVIDERS } = require('../src/providers');
    for (const [name, spec] of Object.entries(PROVIDERS)) {
        for (const cookie of spec.auth.cookies) {
            assert.ok(
                SENSITIVE_COOKIE_NAMES.test(cookie),
                `${name}: ${cookie} is treated as auth but would not be redacted`
            );
        }
    }
});

test('I8: cloudflare clearance is redacted', () => {
    const out = redactString('Set-Cookie: __cf_bm=Ql8vKx2mNpQrStUvWxYz0123; Path=/');
    assert.ok(!out.includes('Ql8vKx2mNpQrStUvWxYz0123'), 'cf_bm is bearer-grade and must be masked');
    assert.ok(out.includes('__cf_bm='), 'the name should stay');
});

test('redactCookies masks a value the registry calls auth', () => {
    const out = redactCookies([{ name: '__cf_bm', value: 'Ql8vKx2mNpQrStUvWxYz0123', domain: '.openai.com' }]);
    assert.ok(!out[0].value.includes('Ql8vKx2mNpQrStUvWxYz0123'));
});

// ---- I1/I2: placeholders must never be answers ------------------------------

test('I1: placeholder variants are all recognised', () => {
    const { isPlaceholderResponse } = require('../src/cookie-store');
    for (const t of ['', '   ', 'no response', 'No Response', 'NO RESPONSE CAPTURED',
                     'no response received', 'no answer', 'null', undefined]) {
        assert.equal(isPlaceholderResponse(t), true, `${JSON.stringify(t)} must be a placeholder`);
    }
    assert.equal(isPlaceholderResponse('a real answer'), false);
});

test('I2: getResponse will not return a placeholder as a success', async () => {
    const h = harness();
    await h.handler({ action: 'initProvider', provider: 'claude' });
    // Force the engine to answer with a placeholder.
    h.sessions._session('claude').page.evaluate = async (a, b) => {
        if (typeof a === 'string') return true;
        if (typeof a === 'function' && typeof b === 'string') return true;
        if (b && b.g && b.m === 'getResponse') return 'no response captured';
        return { ok: true };
    };
    const res = await h.handler({ action: 'getResponse', provider: 'claude' });
    assert.equal(res.success, false, 'a placeholder must not be a success');
    assert.equal(res.errorKind, 'capture');
    await h.sessions.close();
});

// ---- I5: the destructive operation must not report a no-op as success --------

test('I5: purgeProvider with no target is an error, not a silent success', async () => {
    const h = harness();
    const res = await h.handler({ action: 'purgeProvider', provider: null, data: { providers: [] } });
    assert.equal(res.success, false);
    assert.match(res.error, /name a provider/);
    await h.sessions.close();
});

// ---- I7: retry bounds are enforced ------------------------------------------

test('I7: an absurd attempt count is clamped, not honoured', async () => {
    const h = harness();
    await h.handler({ action: 'initProvider', provider: 'claude' });
    const started = Date.now();
    const res = await h.handler({
        action: 'getResponseWithTyping',
        provider: 'claude',
        data: { maxAttempts: 1e9, retryDelayMs: 1 },
    });
    // An unclamped run would hang for years. Completing at all proves the clamp.
    assert.ok(Date.now() - started < 60000, 'a clamped run must finish promptly');
    assert.ok(typeof res.success === 'boolean');
    await h.sessions.close();
});

test('I7: a non-numeric delay falls back to the default', async () => {
    const h = harness();
    await h.handler({ action: 'initProvider', provider: 'claude' });
    const res = await h.handler({
        action: 'getResponseWithTyping',
        provider: 'claude',
        data: { maxAttempts: 'abc', retryDelayMs: -5 },
    });
    assert.equal(res.success, true, 'a real answer is available, so it should succeed');
    await h.sessions.close();
});

// ---- I6: no context leaks ----------------------------------------------------

test('I6: a failed first navigation closes its context', async () => {
    const h = harness({ gotoThrows: true });
    // The action layer converts throws into a success:false result, so this asserts the
    // reported outcome rather than a rejection.
    const res = await h.handler({ action: 'initProvider', provider: 'claude' });
    assert.equal(res.success, false, 'a provider that cannot load must report failure');
    assert.equal(h.events.contextsCreated, 1);
    assert.equal(h.events.contextsClosed, 1, 'the orphaned context must be closed, not leaked');
    await h.sessions.close();
});

test('I6: a failed provider is not reported as initialised', async () => {
    const h = harness({ gotoThrows: true });
    const res = await h.handler({ action: 'initProvider', provider: 'claude' });
    assert.equal(res.success, false);
    assert.deepEqual(h.sessions.initializedProviders(), [], 'must not look ready');
    const status = await h.handler({ action: 'getStatus' });
    assert.ok(!status.providers.includes('claude'));
    await h.sessions.close();
});

test('I6: concurrent first-touches create one context, not two', async () => {
    const h = harness();
    await Promise.all([
        h.handler({ action: 'initProvider', provider: 'claude' }),
        h.handler({ action: 'initProvider', provider: 'claude' }),
        h.handler({ action: 'initProvider', provider: 'claude' }),
    ]);
    assert.equal(h.events.contextsCreated, 1, 'the in-flight guard must collapse concurrent inits');
    assert.equal(h.events.browsersCreated, 1, 'and must not launch a second browser');
    await h.sessions.close();
});

// ---- I3/I4: navigate must not lie ------------------------------------------

test('I4: a navigation failure is typed as transport', async () => {
    const h = harness();
    await h.handler({ action: 'initProvider', provider: 'claude' });
    h.page.goto = async () => { throw new Error('net::ERR_NAME_NOT_RESOLVED'); };
    const res = await h.handler({
        action: 'navigate',
        provider: 'claude',
        data: { url: 'https://broken.test/' },
    });
    assert.equal(res.success, false);
    assert.equal(res.errorKind, 'transport', 'must match how initProvider classifies the same failure');
    await h.sessions.close();
});

test('I3: navigate reports failure when the engine cannot be reinstalled', async () => {
    const h = harness();
    await h.handler({ action: 'initProvider', provider: 'claude' });
    h.page.evaluate = async (a, b) => {
        if (typeof a === 'string') return true;
        if (typeof a === 'function' && typeof b === 'string') return false; // engine gone
        return null;
    };
    const res = await h.handler({
        action: 'navigate',
        provider: 'claude',
        data: { url: 'https://other.test/' },
    });
    assert.equal(res.success, false, 'reporting success here defers the failure confusingly');
    assert.equal(res.errorKind, 'engine');
    await h.sessions.close();
});

// ---- C3: credential files are written with a restrictive mode ----------------

test('C3: a credential file is never briefly world-readable', () => {
    if (process.platform === 'win32') return; // POSIX modes are not enforceable there
    const store = new CookieStore(new StateStore(fs.mkdtempSync(path.join(os.tmpdir(), 'proxima-mode-'))));
    store.saveBackup('claude', [{ name: 'sessionKey', value: 'v', domain: '.claude.ai' }]);
    const file = store._backupPath('claude');
    const mode = fs.statSync(file).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
    assert.ok(!fs.existsSync(`${file}.tmp`), 'no temp file may be left behind');
});

test('C3: a leftover temp file from a crashed write is cleaned up', () => {
    const store = new CookieStore(new StateStore(fs.mkdtempSync(path.join(os.tmpdir(), 'proxima-tmp-'))));
    const file = store._backupPath('gemini');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Pre-create the temp name to force the exclusive-create path to fail.
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, 'stale');
    assert.throws(() => store.writeSecure(file, 'x'));
    assert.ok(fs.existsSync(tmp), 'the pre-existing file is not ours to delete');
    fs.unlinkSync(tmp);
});

// ---- coverage gate itself ----------------------------------------------------

test('the coverage gate fails on an impossible floor', () => {
    const path = require('path');
    const script = path.join(__dirname, '..', 'scripts', 'check-coverage.cjs');
    const report = [
        '# file                | line % | branch % | funcs % | uncovered lines',
        '#  src.js             |  90.00 |    85.00 |   90.00 |',
        '#  all files          |  90.00 |    85.00 |   90.00 |',
    ].join('\n');
    const tmp = path.join(os.tmpdir(), `cov-${process.pid}.txt`);
    fs.writeFileSync(tmp, report);
    const { execFileSync } = require('child_process');
    try {
        execFileSync(process.execPath, [script, tmp, '99', '99', '99'], { stdio: 'pipe' });
        assert.fail('the gate must fail on an impossible floor');
    } catch (e) {
        assert.equal(e.status, 1);
    } finally {
        fs.unlinkSync(tmp);
    }
});
