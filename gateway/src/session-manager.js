'use strict';

const { getProvider, PROVIDER_NAMES } = require('./providers');
const { evaluateAuth, normalizeImportedCookies } = require('./cookie-store');
const { EngineLoader, EngineError, TransportError } = require('./engine-loader');
const { redactString } = require('./redact');

/**
 * Per-provider persistent browser sessions.
 *
 * A6: auth lives in the persistent profile on disk, never in the page. That is what makes
 * unloadProvider safe - the renderer dies, the credentials do not.
 *
 * States: UNINITIALIZED -> INITIALIZED -> ACTIVE, plus NEEDS_AUTH as a report rather
 * than a destructive transition. purgeProvider is the only operation that destroys auth
 * and it is deliberately a different method.
 */

/** Chromium needs a real window size; a zero-sized headless viewport is a bot signal. */
const DEFAULT_VIEWPORT = { width: 1440, height: 900 };

const LAUNCH_ARGS = [
    '--disable-blink-features=AutomationControlled',
    '--no-sandbox',
    '--disable-dev-shm-usage',
];

class ProviderSession {
    constructor(name, spec) {
        this.name = name;
        this.spec = spec;
        this.context = null;
        this.page = null;
        this.state = 'UNINITIALIZED';
        this.sentThisProcess = false;
        this.lastError = null;
    }

    get isOpen() {
        return Boolean(this.context);
    }

    get isActive() {
        return this.state === 'ACTIVE';
    }
}

class SessionManager {
    /**
     * @param {object} opts
     * @param {object} opts.stateStore
     * @param {object} opts.cookieStore
     * @param {EngineLoader} [opts.engineLoader]
     * @param {object} [opts.settings] persisted settings (headless per provider, etc.)
     * @param {Function} [opts.browserFactory] injectable for tests; returns a Browser
     */
    constructor({
        stateStore,
        cookieStore,
        engineLoader = null,
        settings = {},
        browserFactory = null,
    }) {
        this.state = stateStore;
        this.cookies = cookieStore;
        this.engines = engineLoader || new EngineLoader({ stateStore });
        this.settings = settings;
        this.browserFactory = browserFactory || defaultBrowserFactory;
        this._browser = null;
        this._sessions = new Map();
        this._startedAt = new Date().toISOString();
        this.activeProvider = null;
        // Guards against concurrent first-touches leaking a context or a browser.
        this._inflight = new Map();
        this._browserInflight = null;
    }

    // ---- browser lifecycle ----

    async _ensureBrowser() {
        if (this._browser) return this._browser;
        // Without this, two concurrent first-touches launch Chromium twice and one
        // process is orphaned with no reference to close it.
        if (this._browserInflight) return this._browserInflight;
        this._browserInflight = this.browserFactory({
            headless: this.settings.headless !== false,
            args: LAUNCH_ARGS,
        })
            .then((b) => {
                this._browser = b;
                return b;
            })
            .finally(() => {
                this._browserInflight = null;
            });
        return this._browserInflight;
    }

    async close() {
        for (const s of this._sessions.values()) {
            if (s.context) {
                try {
                    await s.context.close();
                } catch {
                    /* already gone */
                }
            }
        }
        this._sessions.clear();
        if (this._browser) {
            try {
                await this._browser.close();
            } catch {
                /* already gone */
            }
            this._browser = null;
        }
    }

    // ---- session lifecycle ----

    _session(name) {
        const spec = getProvider(name);
        if (!this._sessions.has(name)) {
            this._sessions.set(name, new ProviderSession(name, spec));
        }
        return this._sessions.get(name);
    }

    initializedProviders() {
        return [...this._sessions.values()].filter((s) => s.isOpen).map((s) => s.name);
    }

    /**
     * Create the persistent context and load the provider page.
     * Does not require login (F1: a failure here is reported, never faked as ready).
     */
    async initProvider(name, { headless = null } = {}) {
        const session = this._session(name);
        if (session.isOpen) return session;

        // I6: without an in-flight guard, two concurrent first-touches both build a
        // context and the second overwrites the first, leaking it permanently - it is
        // on neither the session nor any list close() walks.
        if (this._inflight.has(name)) return this._inflight.get(name);
        const work = this._initProviderInner(session, headless).finally(() => {
            this._inflight.delete(name);
        });
        this._inflight.set(name, work);
        return work;
    }

    async _initProviderInner(session, headless) {
        const { spec, name } = session;
        const browser = await this._ensureBrowser();
        const useHeadless = headless === null ? this._headlessFor(name) : Boolean(headless);

        // I6: build into locals and publish only once navigate+inject have succeeded.
        // Publishing first left a failed provider looking INITIALIZED on about:blank,
        // and every later initProvider short-circuited past it - poisoned for the
        // lifetime of the process.
        let context = null;
        let page = null;

        try {
            context = await browser.newContext({ viewport: DEFAULT_VIEWPORT });
            await this._attachPersistence(context, this.state.profileDir(spec.partition), session);
            page = await context.newPage();

            await this._navigateAndInject(session, { initial: true, context, page });
        } catch (e) {
            // Never leave a context behind that nothing holds a reference to.
            if (context) {
                try {
                    await context.close();
                } catch {
                    /* best effort */
                }
            }
            session.context = null;
            session.page = null;
            session.state = 'UNINITIALIZED';
            session.lastError = e;
            throw e;
        }

        session.context = context;
        session.page = page;
        session.state = 'INITIALIZED';
        session.headless = useHeadless;
        session.lastError = null;

        const auth = await this.isLoggedIn(name);
        if (!auth.loggedIn) {
            // NEEDS_AUTH is a report. The context and any stored cookies stay put.
            session.state = 'NEEDS_AUTH';
        }
        return session;
    }

    /**
     * Cookie persistence.
     *
     * Playwright's persistent context API is launch-time, so a per-provider userDataDir
     * is emulated: cookies are loaded from the profile dir on create, and flushed back
     * after every mutation and on shutdown.
     */
    async _attachPersistence(context, userDataDir, session) {
        const profileFile = path_join(userDataDir, 'storage-state.json');

        // Restore: prefer the profile, fall back to the cookie backup.
        let restored = readJson(profileFile);
        if (restored && Array.isArray(restored.cookies) && restored.cookies.length) {
            try {
                await context.addCookies(restored.cookies);
            } catch {
                /* a malformed cookie should not block startup */
            }
        } else {
            const backup = this.cookies.loadBackup(session.name);
            if (backup) {
                const domainCookies = this.cookies.cookiesForDomain(
                    backup,
                    session.spec.auth.domain
                );
                if (domainCookies.length) {
                    try {
                        await context.addCookies(domainCookies);
                    } catch {
                        /* ignore */
                    }
                }
            }
        }

        session.profileFile = profileFile;
    }

    async _flushCookies(session) {
        if (!session.context || !session.profileFile) return;
        try {
            const all = await session.context.cookies();
            // Scope to the provider's own auth domain. Persisting every cookie the page
            // touched accumulates consent and tracking cookies for unrelated domains,
            // which is both noise and extra credential-shaped material on disk.
            const cookies = all.filter((c) =>
                String(c.domain || '').includes(session.spec.auth.domain)
            );
            if (cookies.length === 0) return;

            // The PRIMARY auth store, so it must be written with the same protection as
            // the backup. It previously had no mode at all, making the file the code
            // calls the auth store the least protected of the two.
            this.cookies.writeSecure(
                session.profileFile,
                JSON.stringify(
                    { provider: session.name, savedAt: new Date().toISOString(), cookies },
                    null,
                    2
                )
            );
            this.cookies.saveBackup(session.name, cookies);
        } catch {
            /* flush is best effort; shutdown retries */
        }
    }

    _headlessFor(name) {
        const perProvider = this.settings.headlessByProvider || {};
        if (Object.prototype.hasOwnProperty.call(perProvider, name)) {
            return Boolean(perProvider[name]);
        }
        return this.settings.headless !== false;
    }

    async _navigateAndInject(session, { initial = false, context = null, page = null } = {}) {
        const { spec, name } = session;
        const ctx = context || session.context;
        const pg = page || session.page;
        try {
            await pg.goto(spec.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        } catch (e) {
            const err = new TransportError(
                `Could not reach ${spec.url} for provider "${name}": ${e.message}`,
                name,
                { reason: 'navigation-failed' }
            );
            if (initial) throw err;
            // I3/I4: a later navigation failing must be visible. Swallowing it here is
            // what let navigate() report success and then fail on the next call with an
            // unexplained "engine not loaded".
            throw err;
        }

        try {
            await this.engines.install(ctx, pg, name);
        } catch (e) {
            if (e instanceof EngineError && !initial) {
                // A navigation tore the engine down. Surface it: the next call would
                // otherwise fail with a confusing error instead of the real cause.
                session.lastError = e;
                throw e;
            }
            throw e;
        }
    }

    // ---- auth ----

    /** Auth as recorded on disk, independent of any live context. */
    _authOnDisk(name) {
        const spec = getProvider(name);
        const session = this._sessions.get(name);
        const fromDisk = (session && readJson(session.profileFile)) || {};
        const cookies = fromDisk.cookies || [];
        const verdict = evaluateAuth(cookies, spec.auth);
        return { provider: name, loggedIn: verdict.loggedIn, matched: verdict.matched };
    }

    async isLoggedIn(name) {
        const spec = getProvider(name);
        const session = this._session(name);

        let cookies = [];
        if (session.isOpen && session.context) {
            try {
                cookies = await session.context.cookies();
            } catch {
                cookies = [];
            }
        } else {
            // Not loaded: answer from disk so an operator can check auth without
            // paying for a browser launch.
            const fromDisk = readJson(session.profileFile) || {};
            cookies = fromDisk.cookies || [];
        }

        const verdict = evaluateAuth(cookies, spec.auth);
        if (session.isOpen) {
            session.state = verdict.loggedIn ? session.state : 'NEEDS_AUTH';
        }
        return { provider: name, loggedIn: verdict.loggedIn, matched: verdict.matched };
    }

    /**
     * Inject an operator-supplied cookie export. This is a full supported login path -
     * interactive login is not required for the gateway to work.
     */
    async setCookies(name, cookieInput) {
        const spec = getProvider(name);
        const normalized = normalizeImportedCookies(cookieInput); // throws on bad input

        const session = this._session(name);
        if (!session.isOpen) {
            await this.initProvider(name);
        }

        // Clear the domain's existing cookies first, or the old and new sets interleave.
        // Scoped to the auth domain so a provider's cookies cannot disturb another's.
        try {
            await session.context.clearCookies({ domain: spec.auth.domain });
        } catch {
            // A filtered clear is not always supported; an unfiltered clear would wipe
            // every cookie in the context, so it is deliberately NOT used as a
            // fallback. addCookies below is what actually establishes the session.
        }

        let set = 0;
        let failed = 0;
        for (const cookie of normalized) {
            try {
                await session.context.addCookies([cookie]);
                set += 1;
            } catch {
                failed += 1;
            }
        }

        await this._flushCookies(session);

        // Reload so the new auth is actually in effect for the page's own fetches. A
        // failure here is reported: silently continuing would leave the caller
        // believing the cookies took effect when the page never re-read them.
        await this._navigateAndInject(session);

        const verdict = await this.isLoggedIn(name);
        return {
            provider: name,
            set,
            failed,
            loggedIn: verdict.loggedIn,
            message:
                `Applied ${set} cookies` +
                (failed ? `, ${failed} failed` : '') +
                '. ' +
                (verdict.loggedIn ? 'Session authenticated.' : 'No recognised auth cookie found.'),
        };
    }

    async getCookies(name) {
        const spec = getProvider(name);
        const session = this._session(name);
        let cookies = [];
        if (session.isOpen && session.context) {
            cookies = await session.context.cookies();
        } else {
            const fromDisk = readJson(session.profileFile) || {};
            cookies = fromDisk.cookies || [];
        }
        const filtered = cookies.filter((c) =>
            String(c.domain || '').includes(spec.auth.domain)
        );
        return { provider: name, cookies: filtered, count: filtered.length };
    }

    // ---- memory control ----

    /**
     * Free renderer memory WITHOUT logging out (A6).
     *
     * Asynchronous by contract: the page is blanked before the context closes, and an
     * un-awaited call would report success for every provider regardless of outcome.
     * A settling delay precedes the memory reading because Chromium reaps the process
     * asynchronously and an immediate reading understates the saving.
     */
    async unloadProvider(name) {
        const session = this._session(name);
        if (!session.isOpen) {
            return { provider: name, unloaded: false, reason: 'not-loaded' };
        }

        // A6: auth lives on disk, so the context's cookie jar MUST be flushed before it
        // is discarded. Without this, an operator who logged in interactively loses the
        // session the moment the renderer is unloaded, while the response still claims
        // authPreserved: true.
        await this._flushCookies(session);

        try {
            await session.page.goto('about:blank').catch(() => {});
        } catch {
            /* blanking is an optimisation, not a requirement */
        }
        try {
            await session.context.close();
        } catch (e) {
            return { provider: name, unloaded: false, reason: e.message };
        }
        session.context = null;
        session.page = null;
        session.state = 'UNINITIALIZED';
        session.sentThisProcess = false;
        if (this.activeProvider === name) this.activeProvider = null;

        // Report what actually happened, not what was intended. A response that claims
        // preservation without checking is worse than no claim at all.
        const authPreserved = this._authOnDisk(name).loggedIn;
        return {
            provider: name,
            unloaded: true,
            authPreserved,
            ...(authPreserved ? {} : { warning: 'cookies were not on disk before unload; session may need re-auth' }),
        };
    }

    /** The only operation that destroys auth. Never reachable from unloadProvider. */
    async purgeProvider(name) {
        const session = this._session(name);
        if (session.isOpen) {
            try {
                await session.context.clearCookies();
                await session.context.close();
            } catch {
                /* ignore */
            }
            session.context = null;
            session.page = null;
        }
        this.cookies.clearBackup(name);
        session.state = 'UNINITIALIZED';
        session.sentThisProcess = false;
        if (session.profileFile) removeFile(session.profileFile);
        return { provider: name, purged: true };
    }

    // ---- messaging ----

    async _ensureLoaded(name) {
        const session = this._session(name);
        if (!session.isOpen) await this.initProvider(name);
        return session;
    }

    async sendMessage(name, data) {
        const session = await this._ensureLoaded(name);
        this.activeProvider = name;

        const options = allowlistOptions(data);
        const payload = { ...options, message: data.message };

        // A5-ish: an explicit newChat clears per-engine conversation state so an
        // automated turn cannot land inside somebody's unrelated thread.
        if (data.newChat) {
            await this.engines.call(session.page, name, 'newConversation').catch(() => {});
        }

        await this.engines.call(session.page, name, 'sendMessage', payload);

        session.sentThisProcess = true;
        session.state = 'ACTIVE';
        return { provider: name, queued: true };
    }

    async getResponse(name) {
        const session = await this._ensureLoaded(name);
        const raw = await this.engines.call(session.page, name, 'getResponse');
        const text = typeof raw === 'string' ? raw : (raw && raw.response) || '';
        return { provider: name, response: text };
    }

    async getTypingStatus(name) {
        const session = await this._ensureLoaded(name);
        const raw = await this.engines.call(session.page, name, 'getTypingStatus');
        return { provider: name, typing: Boolean(raw && raw.typing) };
    }

    async newConversation(name) {
        const session = await this._ensureLoaded(name);
        await this.engines.call(session.page, name, 'newConversation');
        return { provider: name, cleared: true };
    }

    async executeScript(name, script) {
        const session = await this._ensureLoaded(name);
        return { provider: name, result: await session.page.evaluate(script) };
    }

    async navigate(name, url) {
        const session = await this._ensureLoaded(name);
        // I4: wrap so a navigation failure is typed as transport, matching
        // initProvider. Two code paths disagreeing about the same failure is exactly
        // what the F6 engine/transport split exists to prevent.
        try {
            await session.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        } catch (e) {
            throw new TransportError(
                `Navigation to ${redactString(String(url))} failed for "${name}": ${e.message}`,
                name,
                { reason: 'navigation-failed' }
            );
        }
        // I3: re-inject and surface a failure. Reporting success here and then failing
        // on the next call with "engine not loaded" is worse than reporting the cause.
        await this._navigateAndInject(session);
        return { provider: name, url };
    }

    async flushAll() {
        for (const session of this._sessions.values()) {
            if (session.isOpen) await this._flushCookies(session);
        }
    }
}

/**
 * A1: the option allowlist.
 *
 * Unlisted keys are dropped without error. This is deliberate. A caller sending
 * modelPreference to a provider that reads `thinking` would otherwise get a silently
 * wrong configuration with no error anywhere - which is exactly what happened upstream.
 */
const OPTION_ALLOWLIST = [
    'modelPreference',
    'model',
    'thinkingEffort',
    'thinkingMode',
    'autoSearch',
    'thinking',
    'chatType',
    'researchMode',
    'files',
    'attachments',
    'conversationId',
    'newChat',
    'session',
    'effort',
    'renderingMode',
    'tag',
];

function allowlistOptions(data) {
    const out = {};
    for (const key of OPTION_ALLOWLIST) {
        if (data[key] !== undefined) out[key] = data[key];
    }
    return out;
}

// A2: centralized, once-only timestamp stamping.
function stampTimestamp(message) {
    if (typeof message !== 'string') return message;
    return `${message}\n\nCurrent time: ${new Date().toISOString()}`;
}

// ---- small fs helpers (kept local so the module has no import cycle) ----

function path_join(...parts) {
    return require('path').join(...parts);
}

function readJson(file) {
    try {
        return JSON.parse(require('fs').readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

function removeFile(file) {
    try {
        require('fs').unlinkSync(file);
    } catch {
        /* already gone */
    }
}

async function defaultBrowserFactory({ headless, args }) {
    // Lazy require so unit tests can run without Playwright installed.
    const { chromium } = require('playwright');
    return chromium.launch({ headless, args });
}

module.exports = {
    SessionManager,
    ProviderSession,
    OPTION_ALLOWLIST,
    allowlistOptions,
    stampTimestamp,
    PROVIDER_NAMES,
    DEFAULT_VIEWPORT,
    LAUNCH_ARGS,
};
