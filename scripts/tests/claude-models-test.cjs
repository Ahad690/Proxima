/**
 * Claude model configuration and fallback tests.
 *
 * Run directly:
 *   node scripts/tests/claude-models-test.cjs
 *
 * Covered here:
 *   - the checked-in models.json is valid and names the intended Claude chain
 *   - the Anthropic Models API result is reduced to the newest web-style id per family
 *   - no API key means "use the config", and no network call
 *   - the browser engine actually retries the next model on model_not_available
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.join(__dirname, '../..');

function testConfigFile() {
    console.log('Testing models.json Claude section...');
    const { loadConfig } = require(path.join(REPO, 'electron/claude-models.cjs'));
    const cfg = loadConfig({ repoRoot: REPO });

    assert.strictEqual(cfg.effort, 'high', 'default effort should be high');
    assert.ok(Array.isArray(cfg.models) && cfg.models.length >= 2, 'chain needs at least two models');
    assert.strictEqual(cfg.models[0], 'claude-mythos-5-2', 'primary should be Mythos 5.2');
    assert.strictEqual(cfg.models[1], 'claude-opus-5-5', 'secondary should be Opus 5.5');
    assert.strictEqual(cfg.autoLatest, true, 'autoLatest should be on by default');
    assert.deepStrictEqual(cfg.families, ['mythos', 'opus'], 'family order should be mythos then opus');
}

function testMergeChain() {
    console.log('Testing chain merge and no-downgrade...');
    const { mergeChain } = require(path.join(REPO, 'electron/claude-models.cjs'));

    assert.deepStrictEqual(
        mergeChain({ families: ['mythos'], models: ['claude-mythos-5-2'] }, ['claude-mythos-5-3']),
        ['claude-mythos-5-3', 'claude-mythos-5-2'],
        'a newer API entry must go first and keep the configured id as fallback'
    );
    assert.deepStrictEqual(
        mergeChain({ families: ['mythos'], models: ['claude-mythos-5-2'] }, ['claude-mythos-5-1']),
        ['claude-mythos-5-2'],
        'must not downgrade a configured model to an older API entry'
    );
    assert.deepStrictEqual(
        mergeChain({ families: ['mythos'], models: ['claude-mythos-5-2'] }, ['claude-mythos-5-2']),
        ['claude-mythos-5-2'],
        'an equal API entry must not duplicate or reorder the configured id'
    );
    assert.deepStrictEqual(
        mergeChain({ families: ['fable'], models: ['claude-opus-5-5'] }, ['claude-fable-5']),
        ['claude-fable-5', 'claude-opus-5-5'],
        'a family absent from the config should still be added'
    );
}

function testPickLatest() {
    console.log('Testing latest-per-family selection...');
    const { pickLatest } = require(path.join(REPO, 'electron/claude-models.cjs'));

    const apiModels = [
        { id: 'claude-mythos-5-1', line: 'mythos', lifecycle: 'active', created_at: '2026-09-01T00:00:00Z' },
        { id: 'claude-mythos-5-2', line: 'mythos', lifecycle: 'active', created_at: '2026-11-01T00:00:00Z' },
        { id: 'claude-mythos-5-3', line: 'mythos', lifecycle: 'deprecated', created_at: '2026-12-01T00:00:00Z' },
        { id: 'claude-opus-5-4', line: 'opus', lifecycle: 'active', created_at: '2026-08-01T00:00:00Z' },
        { id: 'claude-opus-5-5', line: 'opus', lifecycle: 'active', created_at: '2026-09-21T00:00:00Z' },
        { id: 'claude-opus-4-8', line: 'opus', lifecycle: 'active', created_at: '2025-01-01T00:00:00Z' }
    ];

    assert.deepStrictEqual(
        pickLatest(apiModels, ['mythos', 'opus']),
        ['claude-mythos-5-2', 'claude-opus-5-5'],
        'must pick the newest active short id per family'
    );

    // A dated snapshot may be newer than the short id but the claude.ai session
    // rejects dated ids for the Opus/Mythos lines. Prefer the short form.
    const withSnapshot = apiModels.concat([
        { id: 'claude-mythos-5-2-20261101', line: 'mythos', lifecycle: 'active', created_at: '2026-11-02T00:00:00Z' }
    ]);
    assert.deepStrictEqual(
        pickLatest(withSnapshot, ['mythos']),
        ['claude-mythos-5-2'],
        'must prefer the short web-style id over a dated snapshot'
    );

    // Unknown family -> no replacement.
    assert.deepStrictEqual(pickLatest(apiModels, ['fable']), [], 'unknown family returns nothing');
}

async function testResolveWithoutKey() {
    console.log('Testing resolve without an API key...');
    const { resolveLatest } = require(path.join(REPO, 'electron/claude-models.cjs'));
    const cfg = {
        effort: 'high', autoLatest: true, families: ['mythos', 'opus'],
        models: ['claude-mythos-5-2', 'claude-opus-5-5']
    };

    let called = false;
    const resolved = await resolveLatest(cfg, {
        apiKey: '',
        fetchImpl: function () { called = true; throw new Error('must not fetch without a key'); }
    });

    assert.strictEqual(called, false, 'must not call the network without a key');
    assert.deepStrictEqual(resolved.models, cfg.models, 'config chain must be preserved');
    assert.strictEqual(resolved.source, 'config', 'source should be config');
}

async function testResolveWithKey() {
    console.log('Testing resolve with the Anthropic Models API...');
    const { resolveLatest } = require(path.join(REPO, 'electron/claude-models.cjs'));
    const cfg = {
        effort: 'high', autoLatest: true, families: ['mythos', 'opus'],
        models: ['claude-mythos-5-2', 'claude-opus-5-5']
    };

    const payload = {
        data: [
            { id: 'claude-mythos-5-3', line: 'mythos', lifecycle: 'active', created_at: '2026-12-01T00:00:00Z' },
            { id: 'claude-mythos-5-2', line: 'mythos', lifecycle: 'active', created_at: '2026-11-01T00:00:00Z' },
            { id: 'claude-opus-5-6', line: 'opus', lifecycle: 'active', created_at: '2026-12-01T00:00:00Z' },
            { id: 'claude-opus-5-5', line: 'opus', lifecycle: 'active', created_at: '2026-09-21T00:00:00Z' }
        ],
        has_more: false
    };

    let seenUrl = null;
    let seenHeaders = null;
    const resolved = await resolveLatest(cfg, {
        apiKey: 'test-key-not-real',
        fetchImpl: async function (url, init) {
            seenUrl = url;
            seenHeaders = init.headers;
            return { ok: true, status: 200, json: async function () { return payload; } };
        }
    });

    assert.ok(seenUrl.startsWith('https://api.anthropic.com/v1/models'), 'must call the Models API');
    assert.strictEqual(seenHeaders['x-api-key'], 'test-key-not-real', 'must send the key');
    assert.ok(seenHeaders['anthropic-version'], 'must send an anthropic-version header');
    assert.deepStrictEqual(
        resolved.models,
        ['claude-mythos-5-3', 'claude-mythos-5-2', 'claude-opus-5-6', 'claude-opus-5-5'],
        'latest candidate first, configured id kept as the same-family fallback'
    );
    assert.strictEqual(resolved.source, 'anthropic-models-api');
}

function createEngineHarness() {
    const source = fs.readFileSync(path.join(REPO, 'electron/providers/claude-engine.js'), 'utf8');
    const completionModels = [];
    let plan = {};
    const expiredOnce = {};

    async function fetchImpl(url, init) {
        const u = String(url);
        if (u.indexOf('/completion') !== -1) {
            const body = JSON.parse(init.body);
            completionModels.push(body.model);
            const mode = plan[body.model] || 'ok';

            if (mode === 'expire-once' && !expiredOnce[body.model]) {
                expiredOnce[body.model] = true;
                return { ok: false, status: 404, text: async function () { return 'gone'; } };
            }

            if (mode === 'unavailable') {
                return {
                    ok: false, status: 403,
                    text: async function () {
                        return JSON.stringify({
                            type: 'error',
                            error: { type: 'permission_error', message: 'model_not_available' }
                        });
                    }
                };
            }
            if (mode === 'auth') {
                return {
                    ok: false, status: 403,
                    text: async function () {
                        return JSON.stringify({
                            type: 'error',
                            error: { type: 'permission_error', message: 'not logged in' }
                        });
                    }
                };
            }

            const chunks = [
                'data: {"type":"message_start","message":{"model":"' + body.model + '"}}\n\n',
                'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
                'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
                'data: {"type":"content_block_stop","index":0}\n\n',
                'data: {"type":"message_stop"}\n\n'
            ];
            let i = 0;
            return {
                ok: true, status: 200,
                body: {
                    getReader: function () {
                        return {
                            read: async function () {
                                if (i >= chunks.length) return { done: true };
                                return { done: false, value: new TextEncoder().encode(chunks[i++]) };
                            },
                            releaseLock: function () {}
                        };
                    }
                }
            };
        }

        if (u.indexOf('/chat_conversations') !== -1) {
            return { ok: true, status: 200, json: async function () { return { uuid: 'conv-test' }; } };
        }
        if (u.indexOf('/api/organizations') !== -1) {
            return { ok: true, status: 200, json: async function () { return [{ uuid: 'org-test' }]; } };
        }
        throw new Error('unexpected fetch: ' + u);
    }

    const context = {
        window: {},
        console: { log: function () {}, warn: function () {}, error: function () {} },
        fetch: fetchImpl,
        setTimeout: setTimeout,
        clearTimeout: clearTimeout,
        AbortController: AbortController,
        TextDecoder: TextDecoder,
        TextEncoder: TextEncoder,
        Intl: Intl
    };
    vm.createContext(context);
    vm.runInContext(source, context);

    return {
        engine: context.window.__proximaClaude,
        completionModels: completionModels,
        setPlan: function (p) { plan = p; }
    };
}

async function testEngineFallback() {
    console.log('Testing the engine fallback on model_not_available...');
    const h = createEngineHarness();

    h.setPlan({
        'claude-mythos-5-2': 'unavailable',
        'claude-opus-5-5': 'ok'
    });
    const text = await h.engine.send('hello', {
        modelChain: ['claude-mythos-5-2', 'claude-opus-5-5'],
        effort: 'high'
    });

    assert.strictEqual(text, 'ok', 'the second model should answer');
    assert.deepStrictEqual(h.completionModels, ['claude-mythos-5-2', 'claude-opus-5-5'],
        'must try the primary, then the secondary');
    assert.strictEqual(h.engine.lastMeta().model, 'claude-opus-5-5',
        'lastMeta must report the model that actually answered');

    // An explicit model is the caller's decision: no silent substitution.
    h.engine.newConversation();
    h.completionModels.length = 0;
    h.setPlan({ 'claude-mythos-5-2': 'unavailable' });
    await assert.rejects(
        function () { return h.engine.send('hello', { model: 'claude-mythos-5-2', effort: 'high' }); },
        /not available|403/i,
        'an explicit unavailable model should fail, not fall back'
    );
    assert.deepStrictEqual(h.completionModels, ['claude-mythos-5-2'],
        'explicit model must not trigger a fallback');

    // A 403 that is not model_not_available is an auth/session error. Falling through
    // to another model would hide it and send the same doomed request twice.
    h.engine.newConversation();
    h.completionModels.length = 0;
    h.setPlan({ 'claude-opus-5-5': 'auth' });
    await assert.rejects(
        function () {
            return h.engine.send('hello', {
                modelChain: ['claude-opus-5-5', 'claude-mythos-5-2'],
                effort: 'high'
            });
        },
        /403|auth/i,
        'a generic 403 must surface immediately'
    );
    assert.deepStrictEqual(h.completionModels, ['claude-opus-5-5'],
        'generic 403 must not fall through');
}

async function testEngineConversationRecovery() {
    console.log('Testing conversation recovery with the model chain...');

    // Unpinned 404: recreate the conversation and retry the SAME model.
    const h = createEngineHarness();
    h.setPlan({ 'claude-opus-5-5': 'expire-once' });
    const text = await h.engine.send('hello', { model: 'claude-opus-5-5', effort: 'high' });
    assert.strictEqual(text, 'ok');
    assert.deepStrictEqual(h.completionModels, ['claude-opus-5-5', 'claude-opus-5-5'],
        'a 404 should recreate and retry the same model');

    // Pinned 404: never create a replacement thread.
    const h2 = createEngineHarness();
    h2.engine.setConversation('11111111-1111-1111-1111-111111111111');
    h2.setPlan({ 'claude-opus-5-5': 'expire-once' });
    await assert.rejects(
        function () { return h2.engine.send('hello', { model: 'claude-opus-5-5' }); },
        /pinned conversation/i,
        'a pinned 404 must fail rather than silently starting a new thread'
    );
    assert.deepStrictEqual(h2.completionModels, ['claude-opus-5-5'],
        'a pinned 404 must not retry');
}

function testWiring() {    console.log('Testing main-process and MCP wiring...');

    const main = fs.readFileSync(path.join(REPO, 'electron/main-v2.cjs'), 'utf8');
    assert.ok(main.indexOf("require('./claude-models.cjs')") !== -1,
        'main-v2 must load the Claude model resolver');
    assert.ok(main.indexOf('claudeModels.getChain()') !== -1,
        'main-v2 must read the configured chain');
    assert.ok(main.indexOf('options.modelChain = chain') !== -1,
        'main-v2 must forward the chain to the engine');
    assert.ok(main.indexOf('claudeModels.getEffort()') !== -1,
        'main-v2 must apply the configured effort');
    assert.ok(main.indexOf("require('./model-registry.cjs')") !== -1,
        'main-v2 must load the universal model registry');
    assert.ok(main.indexOf('modelRegistry.mergeChain(\'claude\'') !== -1,
        'Claude must merge its API chain with the last-working fallback');
    assert.ok(main.indexOf('modelRegistry.getChain(provider)') !== -1,
        'ChatGPT/Qwen must read their provider chain');
    assert.ok(main.indexOf('modelRegistry.rememberWorking') !== -1,
        'successful sends must record the last working model');
    assert.ok(main.indexOf('modelRegistry.isModelUnavailableError') !== -1,
        'the send path must classify model-unavailable errors');
    assert.ok(main.indexOf('function applyProviderModelOptions') !== -1,
        'main-v2 must centralise provider model option injection');
    assert.ok((main.match(/applyProviderModelOptions\(/g) || []).length >= 3,
        'both the normal send and sendMessageWithFile must use the helper');

    const mcp = fs.readFileSync(path.join(REPO, 'src/mcp-server-v3.js'), 'utf8');
    assert.ok(mcp.indexOf('models.json') !== -1,
        'ask_claude docs must point at models.json');

    const engine = fs.readFileSync(path.join(REPO, 'electron/providers/claude-engine.js'), 'utf8');
    const cfgFile = JSON.parse(fs.readFileSync(path.join(REPO, 'models.json'), 'utf8'));
    const cfg = cfgFile.claude;
    for (const id of cfg.models) {
        assert.ok(engine.indexOf(id) !== -1,
            'engine wire-confirmed block must mention ' + id);
    }

    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
    assert.ok(pkg.build && Array.isArray(pkg.build.files) && pkg.build.files.indexOf('models.json') !== -1,
        'packaged app must include models.json');
}

async function testResolverIntegration() {
    console.log('Testing resolver precedence, refresh and cache...');
    const os = require('os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'proxima-claude-models-'));
    const cfgPath = path.join(tmp, 'custom-models.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
        effort: 'high',
        autoLatest: true,
        families: ['mythos', 'opus'],
        models: ['claude-mythos-5-1', 'claude-opus-5-4']
    }));

    const { createResolver } = require(path.join(REPO, 'electron/claude-models.cjs'));
    let fetched = 0;
    const resolver = createResolver({
        repoRoot: tmp,
        env: { PROXIMA_CLAUDE_MODELS: cfgPath, ANTHROPIC_API_KEY: 'test-key' },
        logger: { log: function () {}, error: function () {} },
        fetchImpl: async function () {
            fetched++;
            return {
                ok: true,
                status: 200,
                json: async function () {
                    return {
                        data: [
                            { id: 'claude-mythos-5-2', line: 'mythos', lifecycle: 'active', created_at: '2026-11-01T00:00:00Z' },
                            { id: 'claude-opus-5-5', line: 'opus', lifecycle: 'active', created_at: '2026-09-21T00:00:00Z' }
                        ],
                        has_more: false
                    };
                }
            };
        }
    });

    assert.deepStrictEqual(resolver.getChain(), ['claude-mythos-5-1', 'claude-opus-5-4'],
        'PROXIMA_CLAUDE_MODELS path must win over the repo default');
    assert.strictEqual(resolver.getEffort(), 'high');

    await resolver.refresh();
    assert.strictEqual(fetched, 1, 'first refresh must query the Models API');
    assert.deepStrictEqual(
        resolver.getChain(),
        ['claude-mythos-5-2', 'claude-mythos-5-1', 'claude-opus-5-5', 'claude-opus-5-4'],
        'resolved chain must put the newest first and keep the configured fallbacks'
    );

    await resolver.refresh();
    assert.strictEqual(fetched, 1, 'a second refresh inside the cache window must not fetch');

    await resolver.refresh(true);
    assert.strictEqual(fetched, 2, 'a forced refresh must fetch again');

    fs.rmSync(tmp, { recursive: true, force: true });
}

(async function main() {
    try {
        testConfigFile();
        testMergeChain();
        testPickLatest();
        await testResolveWithoutKey();
        await testResolveWithKey();
        await testEngineFallback();
        await testEngineConversationRecovery();
        testWiring();
        await testResolverIntegration();
        console.log('\nAll Claude model config tests passed.');
    } catch (e) {
        console.error('\nClaude model config test failed:');
        console.error(e && e.stack || e);
        process.exit(1);
    }
})();
