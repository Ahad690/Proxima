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
const { EngineLoader } = require('../src/engine-loader');
const { SessionManager } = require('../src/session-manager');
const { IpcServer } = require('../src/ipc-server');
const { createHandler } = require('../src/actions');
const { toSafeError, log } = require('../src/logger');
const { containsSecret, redactString } = require('../src/redact');

/**
 * Boundary redaction tests.
 *
 * The unit tests prove the redaction functions work. These prove they are actually
 * WIRED IN - a secret is pushed through each real boundary and asserted absent from
 * what comes out. A redaction module nobody calls is worth nothing.
 */

// A realistic composite of everything a provider or driver might echo back.
const LEAK = [
    'sessionKey=abc123def456ghi789jkl012mno345',
    'Authorization: Bearer sk-proj-abc123DEF456ghi789JKL',
    'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r',
    'SID=1a2b3c4d5e6f7g8h9i0j',
    'https://chatgpt.test/backend-api?token=9f8e7d6c5b4a3210zz',
].join(' | ');

const LEAK_FRAGMENTS = [
    'abc123def456ghi789jkl012mno345',
    'sk-proj-abc123DEF456ghi789',
    'eyJ0eXAiOiJKV1Qi',
    '1a2b3c4d5e6f7g8h9i0j',
    '9f8e7d6c5b4a3210zz',
];

function assertNoLeak(text, label) {
    for (const frag of LEAK_FRAGMENTS) {
        assert.ok(!String(text).includes(frag), `${label}: leaked ${frag}`);
    }
    assert.equal(containsSecret(text), false, `${label}: containsSecret still reports a leak`);
}

function makeGateway() {
    const stateStore = new StateStore(fs.mkdtempSync(path.join(os.tmpdir(), 'proxima-gw-leak-')));
    const cookieStore = new CookieStore(stateStore);
    const engineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxima-gw-leakeng-'));
    fs.writeFileSync(
        path.join(engineDir, 'perplexity-engine.js'),
        'window.__proximaPerplexity={sendMessage:function(){return{ok:true};},newConversation:function(){return{};},getResponse:function(){return "";},isReady:function(){return true;}};',
        'utf8'
    );
    const engineLoader = new EngineLoader({ engineDir, stateStore });
    const sessions = new SessionManager({
        stateStore,
        cookieStore,
        engineLoader,
        settings: { headless: true },
        browserFactory: async () => ({ newContext: async () => ({}), close: async () => {} }),
    });
    const handler = createHandler({ sessions, stateStore, startedAt: 'x' });
    return { stateStore, sessions, handler };
}

function clientFor(port) {
    const c = { buffer: '', pending: new Map(), nextId: 1, socket: null };
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

// ---- boundary: action dispatch ------------------------------------------------

test('a secret thrown inside an action never reaches the wire', async () => {
    const g = makeGateway();
    // Force a real throw from deep in the session layer.
    g.sessions.sendMessage = async () => {
        const e = new Error(`upstream said: ${LEAK}`);
        e.kind = 'transport';
        e.provider = 'perplexity';
        throw e;
    };
    const res = await g.handler({ action: 'sendMessage', provider: 'perplexity', data: { message: 'x' } });
    assert.equal(res.success, false);
    assertNoLeak(res.error, 'action dispatch');
    assert.equal(res.errorKind, 'transport', 'the classification must survive redaction');
    assert.equal(res.provider, 'perplexity');
    await g.sessions.close();
});

test('a secret in an error stack never reaches the wire', async () => {
    const g = makeGateway();
    g.sessions.getResponse = async () => {
        const e = new Error(`capture failed: ${LEAK}`);
        e.stack = `Error: capture failed: ${LEAK}\n    at fetch (${LEAK})`;
        throw e;
    };
    const res = await g.handler({ action: 'getResponse', provider: 'perplexity' });
    assertNoLeak(JSON.stringify(res), 'error stack');
    await g.sessions.close();
});

// ---- boundary: IPC framing ----------------------------------------------------

test('a secret thrown while framing a response never reaches the socket', async () => {
    const stateStore = new StateStore(fs.mkdtempSync(path.join(os.tmpdir(), 'proxima-gw-fr-')));
    const ipc = new IpcServer({
        // Throw from the handler itself, past the action layer, into the framing layer.
        handler: async () => {
            throw new Error(`framing blew up: ${LEAK}`);
        },
        stateStore,
        port: 0,
    });
    const port = await ipc.listen();
    const client = clientFor(port);
    await client.connect();
    try {
        const res = await client.send('ping');
        assert.equal(res.success, false);
        assertNoLeak(JSON.stringify(res), 'ipc framing');
    } finally {
        client.socket.destroy();
        await ipc.close();
    }
});

test('a secret inside a malformed frame is not echoed back', async () => {
    const stateStore = new StateStore(fs.mkdtempSync(path.join(os.tmpdir(), 'proxima-gw-mal-')));
    const ipc = new IpcServer({ handler: async () => ({ success: true }), stateStore, port: 0 });
    const port = await ipc.listen();
    const client = clientFor(port);
    await client.connect();

    const response = await new Promise((resolve) => {
        client.pending.set(7, resolve);
        client.socket.write('{"requestId":7, "cookie": "' + LEAK + '"\n');
    });
    try {
        assert.equal(response.success, false);
        assertNoLeak(JSON.stringify(response), 'malformed frame');
    } finally {
        client.socket.destroy();
        await ipc.close();
    }
});

// ---- boundary: toSafeError ----------------------------------------------------

test('toSafeError normalises both strings and Errors without leaking', () => {
    const fromString = toSafeError(LEAK);
    assert.equal(fromString.success, false);
    assertNoLeak(fromString.error, 'toSafeError string');

    const fromError = toSafeError(new Error(LEAK), { provider: 'qwen' });
    assertNoLeak(fromError.error, 'toSafeError Error');
    assert.equal(fromError.provider, 'qwen', 'extra fields must survive');
    assert.equal(fromError.success, false, 'success:false must always be present');
});

test('toSafeError preserves the fields an operator needs', () => {
    const e = new Error('Request timed out after 900000ms for /api/chat');
    e.code = 'ETIMEDOUT';
    e.kind = 'transport';
    const out = toSafeError(e);
    assert.match(out.error, /timed out/, 'the reason must survive');
    assert.ok(out.error.includes('/api/chat'), 'the path is diagnostic and must survive');
    assert.equal(out.code, 'ETIMEDOUT');
    assert.equal(out.errorKind, 'transport');
});

// ---- boundary: logger ---------------------------------------------------------

test('the logger redacts strings and objects it emits', () => {
    const chunks = [];
    const origWrite = process.stdout.write;
    process.stdout.write = (s) => {
        chunks.push(String(s));
        return true;
    };
    try {
        log.info(`starting with ${LEAK}`);
        log.info('options', { auth: `Bearer ${LEAK}`, provider: 'claude', requestId: 7 });
    } finally {
        process.stdout.write = origWrite;
    }
    const all = chunks.join('');
    assertNoLeak(all, 'logger');
    assert.ok(all.includes('claude'), 'provider name must survive');
    assert.ok(all.includes('7'), 'requestId must survive');
    assert.ok(all.includes('gateway:info'), 'the level must be visible');
});

test('log.exception redacts a stack but keeps the diagnosis', () => {
    const chunks = [];
    const origWrite = process.stderr.write;
    process.stderr.write = (s) => {
        chunks.push(String(s));
        return true;
    };
    try {
        const e = new Error(`boom: ${LEAK}`);
        e.stack = `Error: boom: ${LEAK}\n    at Object.<anonymous> (/srv/src/gateway/src/index.js:71:9)`;
        e.code = 'ECONNRESET';
        log.exception(e, { phase: 'uncaughtException' });
    } finally {
        process.stderr.write = origWrite;
    }
    const all = chunks.join('');
    assertNoLeak(all, 'log.exception');
    assert.ok(all.includes('uncaughtException'), 'the phase must survive');
    assert.ok(all.includes('ECONNRESET'), 'the code must survive');
    assert.ok(all.includes('index.js'), 'the stack location must survive');
});

test('an unserialisable value does not crash the logger', () => {
    const chunks = [];
    const origWrite = process.stderr.write;
    process.stderr.write = (s) => {
        chunks.push(String(s));
        return true;
    };
    // A cycle would make a naive JSON.stringify throw. redact's depth cap terminates
    // it, so the logger must emit a record rather than blowing up.
    const cyclic = { provider: 'qwen' };
    cyclic.self = cyclic;
    let threw = false;
    try {
        log.error(cyclic);
    } catch {
        threw = true;
    } finally {
        process.stderr.write = origWrite;
    }
    assert.equal(threw, false, 'a cyclic value must not crash the logger');
    const all = chunks.join('');
    assert.ok(all.length > 0, 'a record must still be emitted');
    assert.ok(all.includes('qwen'), 'the readable fields must survive');
});

// ---- boundary: engines --------------------------------------------------------

test('the shipped reference engine does not echo a failure body', () => {
    const src = fs.readFileSync(
        path.join(__dirname, '..', 'engines', 'perplexity-engine.js'),
        'utf8'
    );
    // A provider can echo request headers in an error payload; the body must never be
    // placed into an error object.
    assert.ok(!/\.text\(\)/.test(src), 'the engine must not read the failure body into an error');
    assert.ok(!/body:\s*String\(/.test(src), 'no raw body may be attached to a classified failure');
    assertNoLeak(redactString('classifyFailure ok'), 'engine source scan');
});

test('every engine file avoids obvious credential logging', () => {
    const dir = path.join(__dirname, '..', 'engines');
    for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.js')) continue;
        const src = fs.readFileSync(path.join(dir, file), 'utf8');
        // An engine runs in the page, where there is no redactor, so it must not log at all.
        assert.ok(
            !/console\.(log|warn|error|debug)\s*\(/.test(src),
            `${file} logs from inside the page, where redaction is unavailable`
        );
    }
});
