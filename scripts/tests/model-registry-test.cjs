/**
 * Universal model-family/version selection and last-working fallback.
 *
 * Run directly:
 *   node scripts/tests/model-registry-test.cjs
 *
 * The point of this file is that model ids are not interchangeable across families:
 * `gpt-6.2-thinking` and `claude-opus-5-5` are different products. We group by the
 * non-numeric skeleton first, then compare the major.minor inside that family.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '../..');
const { parseModel, sortModels, createRegistry, isModelUnavailableError } =
    require(path.join(REPO, 'electron/model-registry.cjs'));

function testParseModel() {
    console.log('Testing universal model parsing...');

    const cases = [
        ['gpt-6-thinking', 'gpt-thinking', [6, 0]],
        ['gpt-6.2-thinking', 'gpt-thinking', [6, 2]],
        ['gpt-5.6-thinking', 'gpt-thinking', [5, 6]],
        ['gpt-6-astra-wm', 'gpt-astra-wm', [6, 0]],
        ['qwen3.8-max', 'qwen-max', [3, 8]],
        ['qwen3.9-max', 'qwen-max', [3, 9]],
        ['claude-opus-5-5', 'claude-opus', [5, 5]],
        ['claude-opus-5', 'claude-opus', [5, 0]],
        ['claude-sonnet-5', 'claude-sonnet', [5, 0]],
        ['claude-haiku-4-5-20251001', 'claude-haiku', [4, 5]],
        ['claude-3-7-sonnet-20250219', 'claude-sonnet', [3, 7]],
        ['gemini-3.1-pro', 'gemini-pro', [3, 1]],
        ['o3-mini', 'o-mini', [3, 0]],
        ['sonar-pro', 'sonar-pro', [0, 0]],
        ['pplx_pro', 'pplx-pro', [0, 0]]
    ];

    for (const [id, family, version] of cases) {
        const got = parseModel(id);
        assert.strictEqual(got.family, family, id + ' family');
        assert.deepStrictEqual(got.version, version, id + ' version');
    }
}

function testSortModels() {
    console.log('Testing version ordering...');

    assert.deepStrictEqual(
        sortModels(['gpt-6-thinking', 'gpt-6.2-thinking', 'gpt-5.6-thinking']),
        ['gpt-6.2-thinking', 'gpt-6-thinking', 'gpt-5.6-thinking'],
        'highest minor first, then older within the same family'
    );
    assert.deepStrictEqual(
        sortModels(['qwen3.8-max', 'qwen3.9-max']),
        ['qwen3.9-max', 'qwen3.8-max'],
        'qwen versions must sort as 3.9 before 3.8'
    );
    assert.deepStrictEqual(
        sortModels(['claude-opus-5-5', 'claude-sonnet-6-0']),
        ['claude-opus-5-5', 'claude-sonnet-6-0'],
        'different families keep their config order; a bigger number is not a newer tier'
    );
    assert.deepStrictEqual(
        sortModels(['claude-opus-5-4', 'claude-opus-5-5']),
        ['claude-opus-5-5', 'claude-opus-5-4'],
        'same family sorts by version'
    );
}

function makeRegistry(config) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'proxima-model-registry-'));
    fs.writeFileSync(path.join(tmp, 'models.json'), JSON.stringify(config));
    const registry = createRegistry({
        repoRoot: tmp,
        userDataPath: tmp,
        env: {},
        logger: { log: function () {}, error: function () {} }
    });
    return { tmp, registry };
}

function testProviderChains() {
    console.log('Testing per-provider chains and last-working fallback...');
    const { tmp, registry } = makeRegistry({
        chatgpt: { effort: 'high', models: ['gpt-6-thinking', 'gpt-6.2-thinking'] },
        qwen: { models: ['qwen3.8-max', 'qwen3.9-max'] },
        claude: { models: ['claude-opus-5-5'] }
    });

    assert.deepStrictEqual(registry.getChain('chatgpt'),
        ['gpt-6.2-thinking', 'gpt-6-thinking'], 'chatgpt chain sorted by version');
    assert.strictEqual(registry.getEffort('chatgpt'), 'high');
    assert.deepStrictEqual(registry.getChain('qwen'),
        ['qwen3.9-max', 'qwen3.8-max'], 'qwen chain sorted by version');

    registry.rememberWorking('chatgpt', 'gpt-6-thinking');
    assert.deepStrictEqual(registry.getChain('chatgpt'),
        ['gpt-6.2-thinking', 'gpt-6-thinking'], 'an existing fallback stays in place');

    // A last-working model that is no longer in the config is still tried, after
    // the newer configured candidates. That is the safety net.
    registry.rememberWorking('chatgpt', 'gpt-5.6-thinking');
    assert.deepStrictEqual(registry.getChain('chatgpt'),
        ['gpt-6.2-thinking', 'gpt-6-thinking', 'gpt-5.6-thinking']);

    registry.rememberWorking('qwen', 'qwen3.7-max');
    assert.deepStrictEqual(registry.getChain('qwen'),
        ['qwen3.9-max', 'qwen3.8-max', 'qwen3.7-max']);

    // Claude's chain comes from the Anthropic resolver (API latest + config); the
    // registry only merges the last-working fallback into it.
    const claudeBase = ['claude-mythos-5-2', 'claude-opus-5-5'];
    assert.deepStrictEqual(registry.mergeChain('claude', claudeBase), claudeBase);
    registry.rememberWorking('claude', 'claude-mythos-5-1');
    assert.deepStrictEqual(registry.mergeChain('claude', claudeBase),
        ['claude-mythos-5-2', 'claude-mythos-5-1', 'claude-opus-5-5']);

    const state = JSON.parse(fs.readFileSync(path.join(tmp, 'model-state.json'), 'utf8'));
    assert.strictEqual(state.chatgpt['gpt-thinking'], 'gpt-5.6-thinking');
    assert.strictEqual(state.qwen['qwen-max'], 'qwen3.7-max');

    // Reload picks up an edited models.json without a restart.
    fs.writeFileSync(path.join(tmp, 'models.json'), JSON.stringify({
        chatgpt: { models: ['gpt-6-thinking'] },
        qwen: { models: ['qwen3.10-max', 'qwen3.9-max'] }
    }));
    registry.reload();
    assert.deepStrictEqual(registry.getChain('qwen'),
        ['qwen3.10-max', 'qwen3.9-max', 'qwen3.7-max'],
        'reload must re-read the file and sort multi-digit minors numerically');

    fs.rmSync(tmp, { recursive: true, force: true });
}

function testErrorClassifier() {
    console.log('Testing model-unavailable classification...');

    assert.strictEqual(isModelUnavailableError(
        'ChatGPT API error (400): The model gpt-9 does not exist'), true);
    assert.strictEqual(isModelUnavailableError(
        'Qwen validation (model_not_found) {"model":"qwen9-max"}'), true);
    assert.strictEqual(isModelUnavailableError(
        'Claude: model claude-opus-9-9 is not available (403)'), true);
    assert.strictEqual(isModelUnavailableError('Claude rate limited'), false);
    assert.strictEqual(isModelUnavailableError(
        'Qwen waf_interstitial — solve the slider'), false);
    assert.strictEqual(isModelUnavailableError('Network timeout'), false);
}

try {
    testParseModel();
    testSortModels();
    testProviderChains();
    testErrorClassifier();
    console.log('\nAll model registry tests passed.');
} catch (e) {
    console.error('\nModel registry test failed:');
    console.error(e && e.stack || e);
    process.exit(1);
}
