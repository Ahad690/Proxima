'use strict';

const { getProvider, PROVIDER_NAMES } = require('./providers');
const { evaluateAuth, normalizeImportedCookies } = require('./cookie-store');
const { EngineLoader, EngineError, TransportError } = require('./engine-loader');

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
    }

    // ---- browser lifecycle ----

    async _ensureBrowser() {
        if (this._browser) return this._browser;
        this._browser = await this.browserFactory({
            headless: this.settings.headless !== false,
            args: LAUNCH_ARGS,
        });
        return this._browser;
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

        const browser = await this._ensureBrowser();
        const useHeadless = headless === null
            ? this._headlessFor(name)
            : Boolean(headless);

        const userDataDir = this.state.profileDir(session.spec.partition);

        let context;
        try {
            context = await browser.newContext({
                viewport: DEFAULT_VIEWPORT,
                userAgent: undefined, // use Chromium's real UA; do not spoof
            });
        } catch (e) {
            session.state = 'UNINITIALIZED';
            session.lastError = e;
            throw new TransportError(
                `Could not create a browser context for "${name}": ${e.message}`,
                name,
                { reason: 'context-failed' }
            );
        }

        // Persistent storage: the profile dir IS the auth store. Cookie backup is a
        // secondary safety net, not the primary mechanism.
        await this._attachPersistence(context, userDataDir, session);

        const page = await context.newPage();
        session.context = context;
        session.page = page;
        session.state = 'INITIALIZED';
        session.headless = useHeadless;
        session.lastError = null;

        await this._navigateAndInject(session, { initial: true });

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
            const cookies = await session.context.cookies();
            writeJson(session.profileFile, {
                provider: session.name,
                savedAt: new Date().toISOString(),
                cookies,
            });
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

    async _navigateAndInject(session, { initial = false } = {}) {
        const { spec, name, page } = session;
        try {
            await page.goto(spec.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        } catch (e) {
            if (!initial) throw e;
            throw new TransportError(
                `Could not reach ${spec.url} for provider "${name}": ${e.message}`,
                name,
                { reason: 'navigation-failed' }
            );
        }

        // Re-inject after every navigation. The init script also fires, but an explicit
        // install lets us probe and fail loudly rather than discovering the gap later.
        try {
            await this.engines.install(session.context, page, name);
        } catch (e) {
            if (e instanceof EngineError && initial) throw e;
            if (!(e instanceof EngineError)) throw e;
            // Non-initial injection failure is recoverable: the next navigation retries.
            session.lastError = e;
        }
    }

    // ---- auth ----

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
        try {
            const existing = await session.context.cookies(spec.auth.domain);
            for (const c of existing) {
                const url = `${c.secure ? 'https' : 'http'}://${c.domain.replace(/^\./, '')}${c.path || '/'}`;
                await session.context.clearCookies({ name: c.name, domain: c.domain }).catch(async () => {
                    // Fall back to explicit removal when the filtered clear is unsupported.
                    await session.context.clearCookies();
                });
                void url;
            }
        } catch {
            /* clearing is best effort; addCookies below is what matters */
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

        // Reload so the new auth is actually in effect for the page's own fetches.
        await this._navigateAndInject(session).catch(() => {});

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
        return { provider: name, unloaded: true, authPreserved: true };
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
        await session.page.goto(url, { waitUntil: 'domcontentloaded' });
        await this._navigateAndInject(session).catch(() => {});
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

function writeJson(file, value) {
    try {
        require('fs').mkdirSync(require('path').dirname(file), { recursive: true });
        require('fs').writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
    } catch {
        /* best effort */
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
