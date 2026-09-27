'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { redact, redactString, redactCookies, truncate, fingerprint, containsSecret } = require('../src/redact');

/**
 * Redaction tests.
 *
 * These assert two things at once: that a known secret does not survive, and that the
 * diagnostic value around it does. A redaction pass that also eats requestIds and
 * provider names is not a fix, it is a different bug.
 */

const SECRETS = {
    openaiSession: 'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    bearer: 'sk-proj-abc123DEF456ghi789JKL012mno345',
    claudeSession: 'sessionKey=abc123def456ghi789jkl012mno345',
    qwenToken: 'token=ssxmod_itna_9f8e7d6c5b4a3210zzzz',
    googleSid: 'SID=1a2b3c4d5e6f7g8h9i0j; HSID=9i8h7g6f5e4d3c2b1a0;',
};

test('a JWT never survives redaction', () => {
    const out = redactString(`failed with token ${SECRETS.openaiSession} attached`);
    assert.ok(!out.includes(SECRETS.openaiSession), 'the JWT must be gone');
    assert.ok(!out.includes('eyJ0eXAiOiJKV1Qi'), 'no fragment of the JWT may remain');
    assert.ok(out.includes('failed with token'), 'the surrounding sentence must survive');
});

test('a bearer token never survives redaction', () => {
    const out = redactString(`Authorization: Bearer ${SECRETS.bearer}`);
    assert.ok(!out.includes('abc123DEF456'));
    assert.match(out, /Bearer/, 'the scheme is diagnostic and should stay');
});

test('provider cookies never survive redaction', () => {
    const cases = [
        ['claude', `cookie jar: ${SECRETS.claudeSession}`],
        ['qwen', `${SECRETS.qwenToken}`],
        ['google', SECRETS.googleSid],
    ];
    for (const [label, input] of cases) {
        const out = redactString(input);
        assert.ok(!out.includes('abc123def456'), `${label}: claude cookie value leaked`);
        assert.ok(!out.includes('9f8e7d6c5b4a'), `${label}: qwen token leaked`);
        assert.ok(!out.includes('1a2b3c4d5e6f'), `${label}: google SID leaked`);
    }
});

test('cookie names survive so the log is still useful', () => {
    const out = redactString(SECRETS.claudeSession);
    assert.ok(out.includes('sessionKey='), 'the name is diagnostic and must remain');
});

test('a sensitive query parameter is masked, an ordinary one is not', () => {
    const out = redactString('GET https://x.test/cb?session=abcdef123456&page=2&sort=desc');
    assert.ok(!out.includes('abcdef123456'), 'session value must be masked');
    assert.ok(out.includes('page=2'), 'an ordinary parameter must stay readable');
    assert.ok(out.includes('sort=desc'));
});

test('a non-sensitive cookie is left alone', () => {
    // Over-redaction would hide this and cost real diagnostic value.
    const out = redactString('theme=dark; locale=en-GB');
    assert.ok(out.includes('theme=dark'), 'a preference cookie is not a credential');
    assert.ok(out.includes('locale=en-GB'));
});

test('long opaque values are truncated even when unnamed', () => {
    const opaque = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZg';
    const out = redactString(`blob=${opaque}`, { max: 20 });
    assert.ok(out.includes('truncated'), 'a cut must be visible, never silent');
    assert.ok(out.length < opaque.length + 40);
});

test('truncate never silently shortens', () => {
    const s = 'x'.repeat(1000);
    const out = truncate(s, 50);
    assert.ok(out.startsWith('x'.repeat(50)));
    assert.match(out, /\+\d+ chars truncated/);
    assert.equal(truncate('short', 50), 'short', 'a value under the cap is untouched');
});

test('redact walks nested objects and arrays', () => {
    const payload = {
        action: 'sendMessage',
        requestId: 42,
        provider: 'claude',
        nested: {
            headers: { Authorization: `Bearer ${SECRETS.bearer}` },
            jar: [`sessionKey=${SECRETS.claudeSession.split('=')[1]}`],
        },
    };
    const out = redact(payload, { max: 4096 });
    const flat = JSON.stringify(out);
    assert.ok(!flat.includes('abc123def456'), 'nested cookie leaked');
    assert.ok(!flat.includes('DEF456'), 'nested bearer leaked');
    // Diagnostics preserved:
    assert.equal(out.action, 'sendMessage');
    assert.equal(out.requestId, 42);
    assert.equal(out.provider, 'claude');
});

test('redact is cycle-safe via a depth cap', () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: { h: 'leaf' } } } } } } } };
    const out = JSON.stringify(redact(deep, { max: 100 }));
    assert.ok(out.includes('depth limit'), 'must stop rather than recurse forever');
});

test('redact handles errors without losing the diagnosis', () => {
    const err = new Error(`request to /cb?token=${SECRETS.qwenToken.split('=')[1]} failed`);
    err.code = 'ECONNREFUSED';
    const out = redact(err);
    assert.equal(out.name, 'Error');
    assert.equal(out.code, 'ECONNREFUSED', 'the diagnostic code must survive');
    assert.ok(!out.message.includes('ssxmod_itna'), 'token leaked through the error message');
    assert.ok(out.message.includes('failed'), 'the reason must survive');
});

test('redact passes through scalars unchanged', () => {
    assert.equal(redact(42), 42);
    assert.equal(redact(true), true);
    assert.equal(redact(null), null);
    assert.equal(redact(undefined), undefined);
});

test('redact does not walk into a buffer', () => {
    const out = redact(Buffer.from('super secret bytes'));
    assert.match(out, /^\[buffer \d+ bytes\]$/);
    assert.ok(!out.includes('super secret'));
});

test('redactCookies masks values but keeps names and domains', () => {
    const cookies = [
        { name: 'sessionKey', value: 'abc123def456', domain: '.claude.ai' },
        { name: 'theme', value: 'dark', domain: '.claude.ai' },
    ];
    const out = redactCookies(cookies);
    assert.equal(out[0].name, 'sessionKey');
    assert.equal(out[0].domain, '.claude.ai');
    assert.ok(!out[0].value.includes('abc123def456'), 'auth cookie value must not appear');
    assert.ok(out[0].value.includes('len 12'), 'a correlatable length hint is kept');
    assert.equal(out[1].value, 'dark', 'a non-auth cookie is not masked');
});

test('fingerprint is correlatable but not replayable', () => {
    const a = fingerprint('abc123def456ghi');
    const b = fingerprint('abc123def456XYZ');
    assert.notEqual(a, b, 'different secrets should not collide into the same value');
    assert.ok(a.includes('len 15'));
    assert.ok(!a.includes('def456'), 'the middle must not survive');
});

test('containsSecret can detect a leak, so a regression is testable', () => {
    assert.equal(containsSecret(`Bearer ${SECRETS.bearer}`), true);
    assert.equal(containsSecret(`sessionKey=${SECRETS.claudeSession.split('=')[1]}`), true);
    assert.equal(containsSecret('sendMessage failed for provider perplexity'), false);
    assert.equal(containsSecret('requestId 42 action ping'), false);
    // Already redacted output must not read as a fresh leak.
    assert.equal(containsSecret(redactString(`Bearer ${SECRETS.bearer}`)), false);
});

test('an operator can still see what failed', () => {
    const message = 'Response capture failed after 120 attempts for provider qwen on /api/chat (status 429)';
    assert.equal(redactString(message, { max: 4096 }), message, 'no secret means no change');
});

test('every redaction path is leak-free for a realistic error', () => {
    // One composite payload crossing several secret shapes at once.
    const composite = {
        url: `https://chatgpt.com/backend-api/conversation?session=${SECRETS.openaiSession.slice(-20)}`,
        auth: `Bearer ${SECRETS.bearer}`,
        cookie: SECRETS.googleSid,
        note: 'claude sessionKey=abc123def456ghi789',
    };
    const out = JSON.stringify(redact(composite, { max: 8192 }));
    for (const needle of [
        SECRETS.openaiSession.slice(-20),
        'DEF456',
        '1a2b3c4d5e6f',
        'abc123def456ghi789',
    ]) {
        assert.ok(!out.includes(needle), `leaked: ${needle}`);
    }
    assert.ok(out.includes('backend-api'), 'the path is diagnostic and should survive');
});
