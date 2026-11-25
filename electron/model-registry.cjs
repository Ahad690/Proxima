/**
 * Proxima — universal model family/version registry.
 *
 * Model ids are not uniformly shaped:
 *   gpt-6-thinking          family gpt-thinking,      6.0
 *   gpt-6.2-thinking        family gpt-thinking,      6.2
 *   qwen3.8-max             family qwen-max,          3.8
 *   claude-opus-5-5         family claude-opus,       5.5
 *   claude-haiku-4-5-20251001 family claude-haiku,    4.5  (date is not a version)
 *
 * So "greater floating point" is applied INSIDE a family, never across families.
 * A newer Sonnet is not a newer Opus. The family is the non-numeric skeleton of
 * the id, which is why claude-opus-5-5 and claude-sonnet-6-0 stay in their own
 * chains. This also covers dates and the old claude-3-7-sonnet-* naming.
 *
 * models.json holds an ordered candidate list per provider. The registry sorts
 * each family by version, then keeps the last model that actually answered as a
 * fallback, so a new id can be tried without losing the last known-good one.
 */
const fs = require('fs');
const path = require('path');

const PROVIDERS = ['chatgpt', 'claude', 'gemini', 'perplexity', 'qwen'];

function tokenizeModel(id) {
    return String(id || '')
        .toLowerCase()
        // qwen3.8 -> qwen 3.8; o3 -> o 3; gpt-4o -> gpt-4 o
        .replace(/([a-z])(\d)/g, '$1 $2')
        .replace(/(\d)([a-z])/g, '$1 $2')
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
}

/**
 * Return { family, version: [major, minor] }. A recognised date token is ignored;
 * it is not a version and not part of the family.
 */
function parseModel(id) {
    const tokens = tokenizeModel(id);
    const rest = [];
    let version = [0, 0];
    let found = false;

    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (/^\d+$/.test(t)) {
            // 4/8-digit years and snapshot dates are metadata, not versions.
            if (t.length >= 4) continue;
            if (!found) {
                const major = Number(t);
                let minor = 0;
                const next = tokens[i + 1];
                if (next && /^\d{1,2}$/.test(next)) {
                    minor = Number(next);
                    i++;
                }
                version = [major, minor];
                found = true;
            }
            // Any further short numbers are suffix noise (a split date, for example).
            continue;
        }
        rest.push(t);
    }

    return {
        family: rest.length ? rest.join('-') : 'unknown',
        version: version,
        versionText: version[0] + '.' + version[1]
    };
}

function compareVersion(a, b) {
    if (a[0] !== b[0]) return b[0] - a[0];
    return b[1] - a[1];
}

/**
 * Group by family in first-appearance order, then sort each family newest first.
 * This is the "always pick the greater floating point" rule, scoped correctly.
 */
function sortModels(models) {
    const list = (Array.isArray(models) ? models : [])
        .filter((m) => typeof m === 'string' && m.trim())
        .map((m) => m.trim())
        .filter((m, i, a) => a.indexOf(m) === i);

    const families = [];
    const byFamily = {};
    for (const id of list) {
        const p = parseModel(id);
        if (!byFamily[p.family]) {
            byFamily[p.family] = [];
            families.push(p.family);
        }
        byFamily[p.family].push({ id, version: p.version });
    }

    const out = [];
    for (const family of families) {
        byFamily[family].sort((a, b) => compareVersion(a.version, b.version));
        for (const item of byFamily[family]) out.push(item.id);
    }
    return out;
}

/** Model-unavailable errors from the web APIs are text-only; classify conservatively. */
function isModelUnavailableError(err) {
    const s = String(err && err.message || err || '').toLowerCase();
    if (s.indexOf('model') === -1) return false;
    return s.indexOf('not found') !== -1 ||
        s.indexOf('not available') !== -1 ||
        s.indexOf('unsupported') !== -1 ||
        s.indexOf('invalid') !== -1 ||
        s.indexOf('does not exist') !== -1 ||
        s.indexOf('not supported') !== -1 ||
        s.indexOf('unknown model') !== -1 ||
        s.indexOf('model_not_found') !== -1 ||
        s.indexOf('model_not_available') !== -1;
}

function findConfigPath(opts) {
    opts = opts || {};
    const env = opts.env || process.env;
    if (env.PROXIMA_MODELS) return path.resolve(env.PROXIMA_MODELS);

    const dirs = [];
    if (opts.userDataPath) dirs.push(opts.userDataPath);
    dirs.push(opts.repoRoot || path.join(__dirname, '..'));
    for (const dir of dirs) {
        const p = path.join(dir, 'models.json');
        if (fs.existsSync(p)) return p;
    }
    return null;
}

function loadState(file) {
    if (!file) return {};
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (e) { return {}; }
}

function validateProvider(raw) {
    const out = { models: [], effort: null, thinking: undefined, autoLatest: false };
    if (!raw || typeof raw !== 'object') return out;

    if (Array.isArray(raw.models)) {
        for (const id of raw.models) {
            if (typeof id !== 'string') continue;
            const trimmed = id.trim();
            if (!/^[a-z0-9][a-z0-9._-]*$/i.test(trimmed)) continue;
            if (out.models.indexOf(trimmed) === -1) out.models.push(trimmed);
        }
    }
    if (typeof raw.effort === 'string' && raw.effort.trim()) out.effort = raw.effort.trim();
    if (typeof raw.thinking === 'boolean') out.thinking = raw.thinking;
    if (typeof raw.autoLatest === 'boolean') out.autoLatest = raw.autoLatest;
    return out;
}

function loadConfig(opts) {
    opts = opts || {};
    const logger = opts.logger || console;
    const file = findConfigPath(opts);
    if (!file) {
        return { configPath: null, providers: {} };
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        const source = parsed && parsed.providers && typeof parsed.providers === 'object'
            ? parsed.providers
            : parsed;
        const providers = {};
        for (const provider of PROVIDERS) {
            providers[provider] = validateProvider(source && source[provider]);
        }
        return { configPath: file, providers: providers };
    } catch (e) {
        logger.error('[model-registry] could not read ' + file + ': ' + e.message);
        return { configPath: file, providers: {} };
    }
}

/**
 * Long-lived registry. getChain() is synchronous and always safe to call.
 * rememberWorking() persists only the family -> last model that answered.
 */
function createRegistry(opts) {
    opts = opts || {};
    const logger = opts.logger || console;
    const loadOpts = {
        repoRoot: opts.repoRoot,
        userDataPath: opts.userDataPath,
        env: opts.env,
        logger: logger
    };
    let loaded = loadConfig(loadOpts);
    const statePath = opts.statePath ||
        (opts.userDataPath ? path.join(opts.userDataPath, 'model-state.json') : null);
    let state = loadState(statePath);

    function saveState() {
        if (!statePath) return;
        try {
            fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
        } catch (e) {
            logger.error('[model-registry] could not write ' + statePath + ': ' + e.message);
        }
    }

    function getProvider(provider) {
        return loaded.providers[provider] || { models: [], effort: null, thinking: undefined };
    }

    function getChain(provider) {
        const p = getProvider(provider);
        const models = p.models.slice();
        const remembered = state[provider] || {};
        for (const family of Object.keys(remembered)) {
            const id = remembered[family];
            if (id && models.indexOf(id) === -1) models.push(id);
        }
        return sortModels(models);
    }

    /** Merge the last-working fallbacks into a chain produced by another resolver. */
    function mergeChain(provider, base) {
        const models = (Array.isArray(base) ? base : []).slice();
        const remembered = state[provider] || {};
        for (const family of Object.keys(remembered)) {
            const id = remembered[family];
            if (id && models.indexOf(id) === -1) models.push(id);
        }
        return sortModels(models);
    }

    function rememberWorking(provider, model) {
        if (!model || typeof model !== 'string') return;
        const p = parseModel(model);
        if (!state[provider]) state[provider] = {};
        state[provider][p.family] = model;
        saveState();
    }

    /** Re-read models.json; the six-hour cycle calls this so edits apply without a restart. */
    function reload() {
        loaded = loadConfig(loadOpts);
        return describe();
    }

    function describe() {
        return {
            configPath: loaded.configPath,
            statePath: statePath,
            providers: PROVIDERS.reduce((acc, provider) => {
                acc[provider] = {
                    chain: getChain(provider),
                    effort: getProvider(provider).effort,
                    thinking: getProvider(provider).thinking
                };
                return acc;
            }, {})
        };
    }

    return {
        getChain: getChain,
        mergeChain: mergeChain,
        getEffort: (provider) => getProvider(provider).effort,
        getThinking: (provider) => getProvider(provider).thinking,
        getProvider: getProvider,
        rememberWorking: rememberWorking,
        reload: reload,
        isModelUnavailableError: isModelUnavailableError,
        describe: describe
    };
}

module.exports = {
    PROVIDERS,
    parseModel,
    sortModels,
    compareVersion,
    isModelUnavailableError,
    findConfigPath,
    loadConfig,
    createRegistry
};
