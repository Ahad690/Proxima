'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { StateStore, DEFAULT_PORT } = require('../src/state-store');
const { evaluateAuth, normalizeImportedCookies, isPlaceholderResponse, CookieStore } = require('../src/cookie-store');
const { FrameDecoder, IpcServer } = require('../src/ipc-server');
const { allowlistOptions, stampTimestamp, OPTION_ALLOWLIST } = require('../src/session-manager');
const { PROVIDERS } = require('../src/providers');
const { EngineLoader, EngineError } = require('../src/engine-loader');

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'proxima-gw-'));
}

// ---------------------------------------------------------------- state store

test('port fact beats stale preference (F3)', () => {
    const dir = tmpDir();
    const s = new StateStore(dir);

    s.saveSettings({ ipcPort: DEFAULT_PORT });
    assert.equal(s.resolvePort().source, 'preference');

    s.recordPortFact(DEFAULT_PORT + 1);
    const resolved = s.resolvePort();
    assert.equal(resolved.port, DEFAULT_PORT + 1);
    assert.equal(resolved.source, 'fact', 'a live fact must outrank the preference');

    s.clearPortFact();
    // Recording a fact also syncs the preference, so once the fact is gone the last
    // known-good port survives as a preference rather than reverting to the default.
    const after = s.resolvePort();
    assert.equal(after.source, 'preference');
    assert.equal(after.port, DEFAULT_PORT + 1);
});

test('a fact naming a dead pid is ignored', () => {
    const dir = tmpDir();
    const s = new StateStore(dir);
    s.saveSettings({ ipcPort: DEFAULT_PORT });
    // pid 2^22 is above the typical max and will not exist.
    fs.writeFileSync(s.portFactPath, JSON.stringify({ port: 59999, pid: 4194303 }));
    const resolved = s.resolvePort();
    assert.equal(resolved.source, 'preference');
    assert.equal(resolved.port, DEFAULT_PORT);
});

test('corrupt settings do not throw', () => {
    const dir = tmpDir();
    const s = new StateStore(dir);
    fs.writeFileSync(s.settingsPath, '{ not json');
    assert.deepEqual(s.loadSettings(), {});
});

// ---------------------------------------------------------------- auth detection

test('auth detection is name-matched, not counted', () => {
    // Google sets many non-auth cookies; a count would read this as logged in.
    const googleNoise = Array.from({ length: 30 }, (_, i) => ({
        name: `consent_${i}`,
        domain: '.google.com',
        value: 'x',
    }));
    const gemini = PROVIDERS.gemini.auth;
    assert.equal(evaluateAuth(googleNoise, gemini).loggedIn, false);
    assert.equal(googleNoise.length, 30, 'sanity: plenty of cookies, none of them auth');

    const real = [...googleNoise, { name: '__Secure-1PSID', domain: '.google.com', value: 'y' }];
    const verdict = evaluateAuth(real, gemini);
    assert.equal(verdict.loggedIn, true);
    assert.deepEqual(verdict.matched, ['__Secure-1PSID']);
});

test('auth detection is domain-scoped', () => {
    const chatgpt = PROVIDERS.chatgpt.auth;
    // Right cookie name, wrong domain -> must not count.
    const wrong = [{ name: '__cf_bm', domain: '.example.com', value: 'z' }];
    assert.equal(evaluateAuth(wrong, chatgpt).loggedIn, false);

    const right = [{ name: '__cf_bm', domain: '.openai.com', value: 'z' }];
    assert.equal(evaluateAuth(right, chatgpt).loggedIn, true);
});

test('auth detection handles prefix families', () => {
    const perplexity = PROVIDERS.perplexity.auth;
    const suffixed = [{ name: 'pplx_session_abc123', domain: '.perplexity.ai', value: 'v' }];
    assert.equal(evaluateAuth(suffixed, perplexity).loggedIn, true);
});

test('auth detection tolerates garbage input', () => {
    assert.equal(evaluateAuth(null, PROVIDERS.claude.auth).loggedIn, false);
    assert.equal(evaluateAuth([null, undefined], PROVIDERS.claude.auth).loggedIn, false);
    assert.equal(evaluateAuth([], PROVIDERS.claude.auth).loggedIn, false);
});

// ---------------------------------------------------------------- cookie import

test('imported cookies get a refreshed expiry so restart != logout', () => {
    const out = normalizeImportedCookies([
        { name: 'sessionKey', domain: '.claude.ai', value: 'abc' },
    ]);
    assert.equal(out.length, 1);
    const oneYearFromNow = Date.now() / 1000 + 364 * 24 * 3600;
    assert.ok(
        out[0].expires > oneYearFromNow,
        `expected a refreshed long expiry, got ${out[0].expires}`
    );
    assert.equal(out[0].path, '/');
    assert.equal(out[0].secure, true);
});

test('an existing future expiry is preserved', () => {
    const far = Math.floor(Date.now() / 1000) + 99999;
    const out = normalizeImportedCookies([
        { name: 'a', domain: '.x.com', value: '1', expires: far },
    ]);
    assert.equal(out[0].expires, far);
});

test('bad cookie payloads fail loudly', () => {
    assert.throws(() => normalizeImportedCookies('not json'), /not valid JSON/);
    assert.throws(() => normalizeImportedCookies({ a: 1 }), /should be an array/);
    assert.deepEqual(normalizeImportedCookies([{ noName: true }]), [], 'junk entries are dropped');
});

test('sameSite variants normalize', () => {
    const out = normalizeImportedCookies([
        { name: 'a', domain: '.x.com', value: '1', sameSite: 'no_restriction' },
        { name: 'b', domain: '.x.com', value: '1', sameSite: 'Strict' },
    ]);
    assert.equal(out[0].sameSite, 'None');
    assert.equal(out[1].sameSite, 'Strict');
});

// ---------------------------------------------------------------- placeholders

test('placeholder responses are recognised (A8)', () => {
    assert.equal(isPlaceholderResponse(''), true);
    assert.equal(isPlaceholderResponse('   '), true);
    assert.equal(isPlaceholderResponse('No Response Captured'), true, 'case insensitive');
    assert.equal(isPlaceholderResponse('no response received'), true);
    assert.equal(isPlaceholderResponse(null), true);
    assert.equal(isPlaceholderResponse(undefined), true);
    assert.equal(isPlaceholderResponse('a real answer'), false);
});

// ---------------------------------------------------------------- allowlist (A1)

test('option allowlist drops unlisted keys silently (A1)', () => {
    const out = allowlistOptions({
        modelPreference: 'pplx-pro',
        thinking: true,
        // not on the allowlist - must be dropped, not forwarded
        deepSearch: false,
        someVendorKnob: 'x',
    });
    assert.equal(out.modelPreference, 'pplx-pro');
    assert.equal(out.thinking, true);
    assert.ok(!('deepSearch' in out), 'deepSearch must not reach the engine');
    assert.ok(!('someVendorKnob' in out));
});

test('allowlist preserves explicitly-false values', () => {
    const out = allowlistOptions({ thinking: false, autoSearch: false });
    assert.equal(out.thinking, false);
    assert.equal(out.autoSearch, false);
});

test('allowlist has no duplicates', () => {
    assert.equal(new Set(OPTION_ALLOWLIST).size, OPTION_ALLOWLIST.length);
});

// ---------------------------------------------------------------- timestamp (A2)

test('timestamp stamping appends an ISO time', () => {
    const out = stampTimestamp('hello');
    assert.match(out, /^hello\n\nCurrent time: \d{4}-\d{2}-\d{2}T/);
});

test('timestamp stamping leaves non-strings alone', () => {
    assert.equal(stampTimestamp(null), null);
    assert.equal(stampTimestamp(42), 42);
});

// ---------------------------------------------------------------- framing

test('frame decoder splits on newlines and retains the partial tail', () => {
    const d = new FrameDecoder();
    assert.deepEqual(d.push('{"a":1}\n{"b":'), ['{"a":1}']);
    assert.equal(d.buffer, '{"b":');
    assert.deepEqual(d.push('2}\n'), ['{"b":2}']);
    assert.equal(d.buffer, '');
});

test('frame decoder handles multiple frames in one chunk', () => {
    const d = new FrameDecoder();
    assert.deepEqual(d.push('{"a":1}\n{"b":2}\n{"c":3}\n'), ['{"a":1}', '{"b":2}', '{"c":3}']);
});

test('frame decoder ignores blank lines', () => {
    const d = new FrameDecoder();
    assert.deepEqual(d.push('\n\n{"a":1}\n\n'), ['', '', '{"a":1}', '']);
});

test('frame decoder drops an oversized buffer rather than growing without bound', () => {
    const d = new FrameDecoder(64);
    const lines = d.push('x'.repeat(200));
    assert.deepEqual(lines, []);
    assert.equal(d.dropped, 1);
});

test('frame decoder handles a frame split across many chunks', () => {
    const d = new FrameDecoder();
    const payload = JSON.stringify({ requestId: 1, action: 'ping' });
    let out = [];
    for (const ch of payload) out = out.concat(d.push(ch + (ch === payload[payload.length - 1] ? '\n' : '')));
    assert.equal(out.length, 1);
    assert.equal(JSON.parse(out[0]).action, 'ping');
});

// ---------------------------------------------------------------- server policy

test('server refuses a non-loopback bind (P7)', () => {
    const s = new StateStore(tmpDir());
    assert.throws(
        () => new IpcServer({ handler: async () => ({}), stateStore: s, host: '0.0.0.0' }),
        /loopback-only/
    );
});

test('port collision retries +1 then reports both ports (F2)', async () => {
    const s = new StateStore(tmpDir());
    const squatter = new IpcServer({ handler: async () => ({ success: true }), stateStore: s, port: 0 });
    const taken = await squatter._tryListen(0);
    const takenPort = squatter.server.address().port;

    const second = new IpcServer({ handler: async () => ({ success: true }), stateStore: s, port: takenPort });
    const bound = await second.listen();
    assert.equal(bound, takenPort + 1, 'must land on the next port');

    await second.close();
    await squatter.close();
});

// ---------------------------------------------------------------- engines

test('engine loader reports a missing engine as a typed failure (F6)', () => {
    const loader = new EngineLoader({ engineDir: tmpDir() });
    assert.throws(
        () => loader.load('chatgpt'),
        (e) => e instanceof EngineError && e.kind === 'engine' && e.reason === 'engine-missing'
    );
});

test('the shipped reference engine exposes the documented contract', () => {
    const loader = new EngineLoader();
    const src = loader.load('perplexity');
    const spec = PROVIDERS.perplexity;
    assert.ok(src.includes(spec.engineGlobal), 'must define the documented global');
    for (const m of ['sendMessage', 'newConversation', 'getResponse']) {
        assert.match(src, new RegExp(`${m}\\s*:`), `engine must expose ${m}`);
    }
});

test('every provider has a coherent registry entry', () => {
    for (const [name, p] of Object.entries(PROVIDERS)) {
        assert.equal(p.name, name);
        assert.ok(p.url.startsWith('https://'), `${name} must use https`);
        assert.ok(p.engineGlobal.startsWith('__proxima'), `${name} global must be namespaced`);
        assert.ok(Array.isArray(p.auth.cookies) && p.auth.cookies.length, `${name} needs auth cookies`);
        assert.ok(p.auth.domain, `${name} needs an auth domain`);
    }
});

test('qwen is the only provider without a DOM fallback (A4)', () => {
    const withFallback = Object.entries(PROVIDERS)
        .filter(([, p]) => p.supportsDomFallback)
        .map(([n]) => n);
    assert.ok(!withFallback.includes('qwen'), 'qwen must not claim a DOM fallback');
    assert.equal(PROVIDERS.qwen.supportsDomFallback, false);
});

test('gemini is login + message only (Q4)', () => {
    assert.equal(PROVIDERS.gemini.supportsUploads, false);
});
