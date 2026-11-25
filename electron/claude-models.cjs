/**
 * Proxima — Claude model configuration and latest-version resolution.
 *
 * The claude.ai web session has no models-list endpoint. Two capture passes looked
 * for one and found nothing, and a third HAR covering the Mythos 5.2 picker contains
 * no models request either. What that session DOES expose is per-request `model`
 * selection: an unavailable id returns 403 permission_error/model_not_available.
 *
 * So there are two sources, in this order:
 *
 *   1. models.json (the claude section) — an ordered fallback chain, editable without code.
 *   2. The official Anthropic Models API (`GET /v1/models`) — only when
 *      ANTHROPIC_API_KEY is present. It returns ids, display names, line and
 *      lifecycle, so the newest active model per family can replace the configured
 *      id automatically. This is a Console key, not the claude.ai session.
 *
 * Resolution failure is never fatal: the configured chain is what gets used.
 */
const fs = require('fs');
const path = require('path');

const API_URL = 'https://api.anthropic.com/v1/models';
const API_VERSION = '2026-10-21';
const CACHE_MS = 6 * 60 * 60 * 1000; // model releases are monthly, six hours is plenty
const MAX_PAGES = 10;

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// These are the ids the claude.ai session has actually accepted. Mythos 5.2 was
// confirmed from a HAR where message_start echoed `claude-mythos-5-2`.
const DEFAULTS = {
    effort: 'high',
    autoLatest: true,
    families: ['mythos', 'opus'],
    models: ['claude-mythos-5-2', 'claude-opus-5-5']
};

function familyOf(id) {
    const m = String(id || '').match(/^claude-([a-z]+)-/i);
    return m ? m[1].toLowerCase() : null;
}

/**
 * `claude-opus-5-5` -> [5, 5]
 * `claude-sonnet-5` -> [5]
 * `claude-haiku-4-5-20251001` -> [4, 5]  (the date is not a version)
 * `claude-3-7-sonnet-20250219` -> null (different naming scheme; sort by created_at)
 */
function parseVersion(id) {
    const m = String(id || '').match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-(\d{8}))?$/i);
    if (!m) return null;
    const out = [Number(m[2])];
    if (m[3]) out.push(Number(m[3]));
    return out;
}

function compareVersion(a, b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const av = a[i] === undefined ? -1 : a[i];
        const bv = b[i] === undefined ? -1 : b[i];
        if (av !== bv) return bv - av;
    }
    return 0;
}

function compareModels(a, b) {
    const av = parseVersion(a.id);
    const bv = parseVersion(b.id);
    if (av && bv) {
        const v = compareVersion(av, bv);
        if (v) return v;
    } else if (av) {
        return -1;
    } else if (bv) {
        return 1;
    }
    const ac = Date.parse(a.created_at || '') || 0;
    const bc = Date.parse(b.created_at || '') || 0;
    if (ac !== bc) return bc - ac;
    return String(b.id).localeCompare(String(a.id));
}

/**
 * Reduce an Anthropic Models API page set to one id per requested family.
 * Dated snapshots are kept only when a family has no short web-style id: the
 * claude.ai session has rejected dated ids for Opus/Mythos before.
 */
function pickLatest(apiModels, families) {
    const list = Array.isArray(apiModels) ? apiModels : [];
    const out = [];
    for (const family of (families || [])) {
        const candidates = list.filter((m) => {
            if (!m || !m.id) return false;
            const line = String(m.line || '').toLowerCase();
            const lineMatch = line === family || line.indexOf(family + '-') === 0;
            return lineMatch || familyOf(m.id) === family;
        }).filter((m) => !m.lifecycle || m.lifecycle === 'active');

        if (!candidates.length) continue;

        const shortIds = candidates.filter((m) => !/-\d{8}$/.test(m.id));
        const pool = shortIds.length ? shortIds : candidates;
        pool.sort(compareModels);
        if (pool[0]) out.push(pool[0].id);
    }
    return out;
}

/**
 * Put the newest candidate first, then keep the configured ids as same-family
 * fallbacks. Example:
 *   configured [mythos-5-2, opus-5-5]
 *   latest     [mythos-5-3, opus-5-6]
 *   result     [mythos-5-3, mythos-5-2, opus-5-6, opus-5-5]
 */
function mergeChain(config, latest) {
    const configured = (config.models || []).filter(Boolean);
    const families = (config.families || []).filter(Boolean);
    if (!latest.length || !families.length) return configured.slice();

    const latestByFamily = {};
    families.forEach((f, i) => { if (latest[i]) latestByFamily[f] = latest[i]; });

    const out = [];
    const add = (id) => { if (id && out.indexOf(id) === -1) out.push(id); };

    for (const family of families) {
        const configuredFamily = configured.filter((id) => familyOf(id) === family);
        const preferred = configuredFamily[0];
        const candidate = latestByFamily[family];

        // The Models API is a hint, not an override. If it reports an older id than
        // the one the user pinned, keep the user's id: a downgrade is never intended.
        let useCandidate = false;
        if (candidate) {
            if (!preferred) {
                useCandidate = true;
            } else {
                const cv = parseVersion(candidate);
                const pv = parseVersion(preferred);
                if (cv && pv) {
                    // compareVersion sorts descending, so a newer candidate is < 0.
                    useCandidate = compareVersion(cv, pv) < 0;
                } else {
                    useCandidate = candidate !== preferred;
                }
            }
        }

        if (useCandidate) add(candidate);
        for (const id of configuredFamily) add(id);
    }
    for (const id of configured) {
        if (families.indexOf(familyOf(id)) === -1) add(id);
    }
    return out;
}

function validate(raw, fallback) {
    const out = Object.assign({}, fallback);
    if (!raw || typeof raw !== 'object') return out;

    if (EFFORTS.indexOf(raw.effort) !== -1) out.effort = raw.effort;
    if (typeof raw.autoLatest === 'boolean') out.autoLatest = raw.autoLatest;

    if (Array.isArray(raw.models)) {
        const models = [];
        for (const id of raw.models) {
            if (typeof id !== 'string') continue;
            const trimmed = id.trim();
            if (!/^claude-[a-z0-9-]+$/i.test(trimmed)) continue;
            if (models.indexOf(trimmed) === -1) models.push(trimmed);
        }
        if (models.length) out.models = models;
    }

    if (Array.isArray(raw.families)) {
        const families = [];
        for (const f of raw.families) {
            if (typeof f !== 'string') continue;
            const trimmed = f.trim().toLowerCase();
            if (!/^[a-z][a-z0-9-]*$/.test(trimmed)) continue;
            if (families.indexOf(trimmed) === -1) families.push(trimmed);
        }
        if (families.length) out.families = families;
    } else {
        // Derive from the model order when the file does not name families.
        const families = [];
        for (const id of out.models) {
            const f = familyOf(id);
            if (f && families.indexOf(f) === -1) families.push(f);
        }
        if (families.length) out.families = families;
    }

    return out;
}

function findConfigPath(opts) {
    opts = opts || {};
    const env = opts.env || process.env;
    if (env.PROXIMA_CLAUDE_MODELS) return path.resolve(env.PROXIMA_CLAUDE_MODELS);
    if (env.PROXIMA_MODELS) return path.resolve(env.PROXIMA_MODELS);

    const dirs = [];
    if (opts.userDataPath) dirs.push(opts.userDataPath);
    dirs.push(opts.repoRoot || path.join(__dirname, '..'));

    for (const dir of dirs) {
        // The universal file is the default. claude-models.json is kept as a
        // backward-compatible per-user override from the first release of this feature.
        const universal = path.join(dir, 'models.json');
        if (fs.existsSync(universal)) return universal;
        const legacy = path.join(dir, 'claude-models.json');
        if (fs.existsSync(legacy)) return legacy;
    }
    return null;
}

function loadConfig(opts) {
    opts = opts || {};
    const logger = opts.logger || console;
    const file = findConfigPath(opts);
    if (!file) {
        return Object.assign({}, DEFAULTS, { source: 'built-in', configPath: null });
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        // models.json is provider-keyed; claude-models.json is the legacy top-level shape.
        const section = parsed && parsed.providers && parsed.providers.claude
            ? parsed.providers.claude
            : (parsed && parsed.claude && typeof parsed.claude === 'object'
                ? parsed.claude
                : parsed);
        const cfg = validate(section, DEFAULTS);
        cfg.source = file;
        cfg.configPath = file;
        return cfg;
    } catch (e) {
        logger.error('[claude-models] could not read ' + file + ': ' + e.message +
            ' — using built-in defaults');
        return Object.assign({}, DEFAULTS, { source: 'built-in', configPath: file });
    }
}

/**
 * Ask the official Models API for the newest active id per family.
 * Returns the configured chain unchanged when there is no key or autoLatest is off.
 * Never throws; a failed lookup is a warning plus the config chain.
 */
async function resolveLatest(config, opts) {
    opts = opts || {};
    const logger = opts.logger || console;
    const cfg = config || DEFAULTS;
    if (!cfg.autoLatest || !opts.apiKey) {
        return Object.assign({}, cfg, { source: 'config' });
    }

    const fetchImpl = opts.fetchImpl || fetch;
    const timeoutMs = opts.timeoutMs || 10000;
    const apiVersion = opts.apiVersion || process.env.ANTHROPIC_VERSION || API_VERSION;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const all = [];
        let afterId = null;
        for (let page = 0; page < MAX_PAGES; page++) {
            const url = API_URL + '?limit=1000' +
                (afterId ? '&after_id=' + encodeURIComponent(afterId) : '');
            const res = await fetchImpl(url, {
                headers: {
                    'x-api-key': opts.apiKey,
                    'anthropic-version': apiVersion
                },
                signal: controller.signal
            });
            if (!res.ok) {
                throw new Error('Models API returned ' + res.status);
            }
            const body = await res.json();
            if (Array.isArray(body.data)) all.push.apply(all, body.data);
            if (!body.has_more || !body.last_id) break;
            afterId = body.last_id;
        }

        const latest = pickLatest(all, cfg.families);
        const models = mergeChain(cfg, latest);
        return Object.assign({}, cfg, {
            models: models,
            source: 'anthropic-models-api',
            resolvedAt: new Date().toISOString(),
            latest: latest
        });
    } catch (e) {
        logger.error('[claude-models] latest-version lookup failed (' + e.message +
            ') — using the configured chain');
        return Object.assign({}, cfg, { source: 'config', error: e.message });
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Long-lived resolver used by the Electron main process. getChain() is synchronous
 * and always returns something usable; refresh() updates it in the background.
 */
function createResolver(opts) {
    opts = opts || {};
    const logger = opts.logger || console;
    const env = opts.env || process.env;

    let state = loadConfig({
        repoRoot: opts.repoRoot,
        userDataPath: opts.userDataPath,
        env: env,
        logger: logger
    });
    let chain = state.models.slice();
    let effort = state.effort;
    let source = state.source;
    let lastRefresh = 0;
    let inFlight = null;

    function describe() {
        return {
            models: chain.slice(),
            effort: effort,
            source: source,
            configPath: state.configPath,
            autoLatest: state.autoLatest,
            hasApiKey: !!env.ANTHROPIC_API_KEY,
            lastRefresh: lastRefresh ? new Date(lastRefresh).toISOString() : null
        };
    }

    async function refresh(force) {
        if (inFlight) return inFlight;
        if (!force && lastRefresh && Date.now() - lastRefresh < CACHE_MS) {
            return describe();
        }
        inFlight = (async () => {
            // Re-read the file on every refresh so an edit is picked up by the
            // six-hour cycle without restarting the app.
            const fresh = loadConfig({
                repoRoot: opts.repoRoot,
                userDataPath: opts.userDataPath,
                env: env,
                logger: logger
            });
            state = Object.assign({}, state, fresh);
            const resolved = await resolveLatest(state, {
                apiKey: env.ANTHROPIC_API_KEY,
                fetchImpl: opts.fetchImpl,
                logger: logger
            });
            state = Object.assign({}, state, resolved);
            chain = state.models.slice();
            effort = state.effort;
            source = state.source;
            lastRefresh = Date.now();
            logger.log('[claude-models] using ' + chain.join(' -> ') +
                ' @ ' + effort + ' (' + source + ')');
            return describe();
        })();
        try {
            return await inFlight;
        } finally {
            inFlight = null;
        }
    }

    return {
        getChain: () => chain.slice(),
        getEffort: () => effort,
        getConfig: () => Object.assign({}, state, { models: chain.slice() }),
        describe: describe,
        refresh: refresh
    };
}

module.exports = {
    API_URL,
    API_VERSION,
    EFFORTS,
    DEFAULTS,
    familyOf,
    parseVersion,
    pickLatest,
    mergeChain,
    findConfigPath,
    loadConfig,
    resolveLatest,
    createResolver
};
