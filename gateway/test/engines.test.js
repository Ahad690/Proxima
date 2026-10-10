'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const { PROVIDERS, PROVIDER_NAMES } = require('../src/providers');
const { EngineLoader } = require('../src/engine-loader');
const { render } = require('../scripts/make-engine-scaffold.cjs');

/**
 * Engine scaffold tests.
 *
 * Two properties matter, and they pull in opposite directions:
 *
 *   1. Each scaffold satisfies the engine contract, so the gateway loads and probes it
 *      without special-casing.
 *   2. Each scaffold REFUSES to issue a request while unverified, so nobody mistakes a
 *      blank endpoint for a working one.
 *
 * The second is the more important. A scaffold that quietly returned an empty answer
 * would look functional while doing nothing.
 */

const ENGINE_DIR = path.join(__dirname, '..', 'engines');

/** Evaluate an engine in a fake page context, exactly as the browser would. */
function evaluateInPage(source, { cookies = 'a=1' } = {}) {
    const fetchCalls = [];
    const sandbox = {
        window: {},
        document: { cookie: cookies },
        console: { log() {}, warn() {}, error() {} },
        fetch: async (url, init) => {
            fetchCalls.push({ url, init });
            return {
                ok: true,
                status: 200,
                json: async () => ({ text: 'server answer', conversationId: 'c1' }),
            };
        },
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox, { timeout: 2000 });
    return { api: sandbox.window, fetchCalls, sandbox };
}

test('every provider has an engine file on disk', () => {
    for (const name of PROVIDER_NAMES) {
        const file = path.join(ENGINE_DIR, `${name}-engine.js`);
        assert.ok(fs.existsSync(file), `${name}: missing ${file}`);
    }
});

test('every engine defines its documented global', () => {
    for (const [name, spec] of Object.entries(PROVIDERS)) {
        const src = fs.readFileSync(path.join(ENGINE_DIR, `${name}-engine.js`), 'utf8');
        assert.ok(
            src.includes(spec.engineGlobal),
            `${name}: must assign window.${spec.engineGlobal}`
        );
    }
});

test('every engine implements the required contract methods', () => {
    const required = ['sendMessage', 'newConversation', 'getResponse', 'getTypingStatus', 'isReady'];
    for (const name of PROVIDER_NAMES) {
        const src = fs.readFileSync(path.join(ENGINE_DIR, `${name}-engine.js`), 'utf8');
        for (const m of required) {
            assert.match(src, new RegExp(`${m}\\s*:`), `${name}: missing ${m}`);
        }
    }
});

test('every engine loads and probes without special-casing', () => {
    for (const name of PROVIDER_NAMES) {
        const src = fs.readFileSync(path.join(ENGINE_DIR, `${name}-engine.js`), 'utf8');
        const { api } = evaluateInPage(src);
        const global = PROVIDERS[name].engineGlobal;
        assert.ok(api[global], `${name}: global not installed`);
        for (const m of ['sendMessage', 'newConversation', 'getResponse']) {
            assert.equal(typeof api[global][m], 'function', `${name}.${m} must be callable`);
        }
    }
});

test('every unverified engine refuses to issue a request', async () => {
    for (const name of PROVIDER_NAMES) {
        const src = fs.readFileSync(path.join(ENGINE_DIR, `${name}-engine.js`), 'utf8');
        const { api, fetchCalls } = evaluateInPage(src);
        const global = PROVIDERS[name].engineGlobal;

        let threw = null;
        try {
            await api[global].sendMessage({ message: 'hello' });
        } catch (e) {
            threw = e;
        }
        assert.ok(threw, `${name}: an unverified engine must not silently succeed`);
        assert.match(
            threw.message,
            new RegExp('scaffold', 'i'),
            `${name}: the refusal must say it is a scaffold, so the cause is obvious`
        );
        assert.equal(fetchCalls.length, 0, `${name}: no network call may be attempted`);
    }
});

test('a refusal is non-retryable, so it cannot spin', async () => {
    for (const name of PROVIDER_NAMES) {
        const src = fs.readFileSync(path.join(ENGINE_DIR, `${name}-engine.js`), 'utf8');
        const { api } = evaluateInPage(src);
        const global = PROVIDERS[name].engineGlobal;
        let threw = null;
        try {
            await api[global].sendMessage({ message: 'x' });
        } catch (e) {
            threw = e;
        }
        assert.equal(threw.retryable, false, `${name}: a config error must not be retried`);
    }
});

test('an engine reports itself not-ready while unverified', () => {
    for (const name of PROVIDER_NAMES) {
        const src = fs.readFileSync(path.join(ENGINE_DIR, `${name}-engine.js`), 'utf8');
        const { api } = evaluateInPage(src);
        assert.equal(
            api[PROVIDERS[name].engineGlobal].isReady(),
            false,
            `${name}: isReady must be false until endpoints are filled in`
        );
    }
});

test('getResponse is empty before a turn, never a fabricated answer', () => {
    for (const name of PROVIDER_NAMES) {
        const src = fs.readFileSync(path.join(ENGINE_DIR, `${name}-engine.js`), 'utf8');
        const { api } = evaluateInPage(src);
        assert.equal(
            api[PROVIDERS[name].engineGlobal].getResponse(),
            '',
            `${name}: an empty response lets the gateway retry; a guess would be a lie`
        );
    }
});

test('newConversation clears state and is safe to call repeatedly', () => {
    for (const name of PROVIDER_NAMES) {
        const src = fs.readFileSync(path.join(ENGINE_DIR, `${name}-engine.js`), 'utf8');
        const { api } = evaluateInPage(src);
        const engine = api[PROVIDERS[name].engineGlobal];
        const first = engine.newConversation();
        const second = engine.newConversation();
        assert.deepEqual(first, { cleared: true });
        assert.deepEqual(second, { cleared: true }, `${name}: must be idempotent`);
    }
});

test('sendMessage rejects an empty message before touching the network', async () => {
    for (const name of PROVIDER_NAMES) {
        const src = fs.readFileSync(path.join(ENGINE_DIR, `${name}-engine.js`), 'utf8');
        const { api, fetchCalls } = evaluateInPage(src);
        const engine = api[PROVIDERS[name].engineGlobal];
        await assert.rejects(() => engine.sendMessage({ message: '   ' }), /non-empty/);
        assert.equal(fetchCalls.length, 0);
    }
});

test('no engine logs from inside the page, where redaction is unavailable', () => {
    for (const name of PROVIDER_NAMES) {
        const src = fs.readFileSync(path.join(ENGINE_DIR, `${name}-engine.js`), 'utf8');
        assert.ok(
            !/console\.(log|warn|error|debug)\s*\(/.test(src),
            `${name}: an engine runs in the page with no redactor, so it must not log`
        );
    }
});

test('the generator is idempotent and will not overwrite real work', () => {
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'proxima-scaffold-'));
    for (const name of ['chatgpt', 'claude']) {
        fs.writeFileSync(path.join(dir, `${name}-engine.js`), 'HAND WRITTEN', 'utf8');
    }
    // render() is pure, so re-rendering must be byte-identical.
    assert.equal(render('chatgpt', { global: 'g', origin: 'o', extra: [] }), render('chatgpt', { global: 'g', origin: 'o', extra: [] }));
    // And the on-disk originals must be untouched by a second generator run.
    const before = fs.readFileSync(path.join(ENGINE_DIR, 'chatgpt-engine.js'), 'utf8');
    require('node:child_process').execFileSync(
        process.execPath,
        [path.join(__dirname, '..', 'scripts', 'make-engine-scaffold.cjs')],
        { encoding: 'utf8' }
    );
    assert.equal(fs.readFileSync(path.join(ENGINE_DIR, 'chatgpt-engine.js'), 'utf8'), before);
});

test('a verified engine can complete a turn', async () => {
    // Flip the flags in a copy to prove the happy path works once endpoints exist.
    for (const name of PROVIDER_NAMES) {
        const raw = fs.readFileSync(path.join(ENGINE_DIR, `${name}-engine.js`), 'utf8');
        const verified = raw
            .replace('var verified = false;', 'var verified = true;')
            .replace(/send:\s*null,/, "send: '/api/send',");
        const { api, fetchCalls } = evaluateInPage(verified);
        const engine = api[PROVIDERS[name].engineGlobal];

        assert.equal(engine.isReady(), true, `${name}: must be ready once verified`);
        const result = await engine.sendMessage({ message: 'hello' });
        assert.equal(fetchCalls.length, 1, `${name}: exactly one request`);
        assert.equal(fetchCalls[0].init.credentials, 'include', 'auth rides on the session');
        assert.equal(result.conversationId, 'c1', `${name}: conversation id must be captured`);
        assert.equal(engine.getResponse(), 'server answer', `${name}: answer must be stored`);
    }
});

test('a verified engine classifies a failure without echoing the body', async () => {
    const raw = fs.readFileSync(path.join(ENGINE_DIR, 'claude-engine.js'), 'utf8');
    const verified = raw
        .replace('var verified = false;', 'var verified = true;')
        .replace(/send:\s*null,/, "send: '/api/send',");

    const sandbox = {
        window: {},
        document: { cookie: 'sessionKey=abc123' },
        console: { log() {}, warn() {}, error() {} },
        fetch: async () => ({
            ok: false,
            status: 403,
            json: async () => ({}),
            // A provider CAN echo the credential back. The engine must not forward it.
            text: async () => JSON.stringify({ echoed: 'sessionKey=abc123def456' }),
        }),
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(verified, sandbox, { timeout: 2000 });

    const engine = sandbox.window.__proximaClaude;
    let threw = null;
    try {
        await engine.sendMessage({ message: 'x' });
    } catch (e) {
        threw = e;
    }
    assert.ok(threw, 'a 403 must raise');
    assert.equal(threw.kind, 'waf', '403 is a WAF challenge, not a plain auth failure');
    assert.equal(threw.retryable, true);
    assert.ok(!threw.message.includes('abc123def456'), 'the echoed credential must not appear');
});
