'use strict';

const { getProvider, isKnownProvider, PROVIDER_NAMES } = require('./providers');
const { isPlaceholderResponse } = require('./cookie-store');
const { stampTimestamp, allowlistOptions } = require('./session-manager');
const { toSafeError } = require('./logger');
const { redactCookies } = require('./redact');

/**
 * The 28-action contract.
 *
 * GUI actions from the upstream contract are deliberately absent: P1-P3 removed the
 * window, the REST API and the WebSocket server, so there is nothing for showWindow /
 * hideWindow / toggleWindow / isWindowVisible to act on. They are listed in REJECTED
 * so their absence is a decision on record rather than an oversight.
 */

const CAPTURE_MAX_ATTEMPTS = 120;
const CAPTURE_RETRY_DELAY_MS = 2500;
const MEMORY_SETTLE_MS = 1500;

const REJECTED_ACTIONS = {
    showWindow: 'P1: the gateway has no window.',
    hideWindow: 'P1: the gateway has no window.',
    toggleWindow: 'P1: the gateway has no window.',
    isWindowVisible: 'P1: the gateway has no window.',
    claudeArtifacts: 'Artifact listing is provider-API work. Belongs in the claude engine, not the gateway.',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createHandler({ sessions, stateStore, startedAt, getFileReferenceEnabled }) {
    const fileReferenceEnabled = getFileReferenceEnabled || (() => true);

    // ---- actions ----

    const actions = {
        ping: async () => ({ success: true, message: 'pong' }),

        getStatus: async () => ({
            success: true,
            providers: sessions.initializedProviders(),
            knownProviders: PROVIDER_NAMES,
            activeProvider: sessions.activeProvider,
            startedAt,
            pid: process.pid,
            port: stateStore.readPortFact()?.port ?? null,
            fileReferenceEnabled: fileReferenceEnabled(),
        }),

        memory: async () => ({ success: true, memory: processMemoryReport(sessions.initializedProviders()) }),

        initProvider: async (req) => {
            await sessions.initProvider(req.provider);
            return { success: true, provider: req.provider };
        },

        isLoggedIn: async (req) => {
            const result = await sessions.isLoggedIn(req.provider);
            return { success: true, ...result };
        },

        unloadProvider: async (req) => {
            const targets = resolveTargets(req, sessions.initializedProviders());
            if (targets.length === 0) {
                return { success: false, error: 'name a provider, or pass data.providers' };
            }
            // AWAITED. An un-awaited unload reports success for every provider whether
            // or not it worked, because the returned promise is truthy.
            const reports = [];
            for (const name of targets) {
                reports.push(await sessions.unloadProvider(name));
            }
            const unloaded = reports.filter((r) => r.unloaded);
            // Only settle when something actually unloaded. Chromium reaps the renderer
            // asynchronously, so a reading taken immediately understates the saving -
            // but paying 1.5s for a no-op purge of five providers is a pointless 7.5s.
            if (unloaded.length > 0) await sleep(MEMORY_SETTLE_MS);
            return {
                success: true,
                unloaded: unloaded.map((r) => r.provider),
                reports,
                stillLoaded: sessions.initializedProviders(),
                memory: processMemoryReport(sessions.initializedProviders()),
            };
        },

        purgeProvider: async (req) => {
            const targets = resolveTargets(req, sessions.initializedProviders());
            // This is the ONE destructive operation, so a no-op must not report success.
            if (targets.length === 0) {
                return { success: false, error: 'name a provider, or pass data.providers' };
            }
            const results = [];
            for (const name of targets) {
                results.push(await sessions.purgeProvider(name));
            }
            return { success: true, purged: results, memory: processMemoryReport(sessions.initializedProviders()) };
        },

        sendMessage: async (req) => {
            const data = req.data || {};
            let message = data.message;

            if (message === undefined || message === null) {
                return { success: false, error: 'sendMessage requires data.message' };
            }

            // A3: attachment failure must fail the call, never degrade to text-only.
            if (hasAttachments(data) && !fileReferenceEnabled()) {
                return {
                    success: false,
                    error: 'File reference is disabled. Enable it in gateway settings.',
                };
            }

            // A2: stamped exactly once, here, so every route into the gateway is covered.
            if (data.timestamp !== false) {
                message = stampTimestamp(message);
            }

            // A1: allowlist before anything reaches an engine.
            const options = allowlistOptions(data);
            const payload = { ...options, message };

            if (data.tag !== false && req.provider === 'claude' && typeof message === 'string') {
                // Mark agent-authored turns so a human reading the thread can tell them
                // apart from turns they typed themselves. Claude-only, by design.
                if (!message.startsWith('[PROXIMA]')) {
                    payload.message = `[PROXIMA]\n${message}`;
                }
            }

            await sessions.sendMessage(req.provider, payload);
            return { success: true, provider: req.provider, queued: true };
        },

        getResponse: async (req) => {
            const result = await sessions.getResponse(req.provider);
            // A8: this is a single-shot probe, so a placeholder here must be reported as
            // a failure rather than handed back as a successful empty answer. The
            // retrying variant is getResponseWithTyping.
            if (isPlaceholderResponse(result.response)) {
                return {
                    success: false,
                    provider: req.provider,
                    error: 'No response captured yet. Use getResponseWithTyping to retry.',
                    errorKind: 'capture',
                    response: result.response,
                };
            }
            return { success: true, ...result };
        },

        getTypingStatus: async (req) => {
            const result = await sessions.getTypingStatus(req.provider);
            return { success: true, ...result };
        },

        /**
         * Capture with placeholder retry (A8).
         *
         * An empty string or a "no response" sentinel is not an answer. Retrying is
         * bounded so a rate-limited provider cannot be hammered indefinitely.
         */
        getResponseWithTyping: async (req) => {
            // I7: clamp rather than trust the caller. An unbounded attempt count is a
            // denial of service on this connection's request queue, because handlers are
            // serialised per socket. The delay needs a ceiling for the same reason and a
            // floor so a caller cannot spin the loop.
            const requestedAttempts = Number.parseInt(req.data?.maxAttempts, 10);
            const requestedDelay = Number.parseInt(req.data?.retryDelayMs, 10);
            const maxAttempts = Number.isFinite(requestedAttempts)
                ? Math.min(Math.max(requestedAttempts, 1), CAPTURE_MAX_ATTEMPTS)
                : CAPTURE_MAX_ATTEMPTS;
            const delay = Number.isFinite(requestedDelay)
                ? Math.min(Math.max(requestedDelay, 50), 5000)
                : CAPTURE_RETRY_DELAY_MS;

            let last = '';
            for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
                const { response } = await sessions.getResponse(req.provider);
                last = response || '';
                if (!isPlaceholderResponse(last)) {
                    return { success: true, provider: req.provider, response: last, attempts: attempt };
                }
                if (attempt < maxAttempts) await sleep(delay);
            }
            return {
                success: false,
                provider: req.provider,
                error: `Response capture failed after ${maxAttempts} attempts`,
                response: last,
                attempts: maxAttempts,
            };
        },

        newConversation: async (req) => {
            const result = await sessions.newConversation(req.provider);
            return { success: true, ...result };
        },

        waitForSendButton: async (req) => {
            const session = await sessions._ensureLoaded(req.provider);
            const spec = getProvider(req.provider);
            const ready = await session.page
                .evaluate((g) => {
                    const engine = window[g];
                    if (!engine) return false;
                    if (typeof engine.isReady === 'function') return Boolean(engine.isReady());
                    return true; // an engine without a readiness probe is assumed ready
                }, spec.engineGlobal)
                .catch(() => false);
            return { success: true, provider: req.provider, ready };
        },

        executeScript: async (req) => {
            if (typeof req.data?.script !== 'string') {
                return { success: false, error: 'executeScript requires data.script' };
            }
            const result = await sessions.executeScript(req.provider, req.data.script);
            return { success: true, ...result };
        },

        navigate: async (req) => {
            if (typeof req.data?.url !== 'string') {
                return { success: false, error: 'navigate requires data.url' };
            }
            const result = await sessions.navigate(req.provider, req.data.url);
            return { success: true, ...result };
        },

        debugDOM: async (req) => {
            const session = await sessions._ensureLoaded(req.provider);
            const html = await session.page
                .content()
                .catch(() => null);
            return {
                success: html !== null,
                provider: req.provider,
                length: html ? html.length : 0,
                html: typeof req.data?.full === 'boolean' ? html : undefined,
            };
        },

        setCookies: async (req) => {
            const result = await sessions.setCookies(req.provider, req.data?.cookies);
            return { success: true, ...result };
        },

        getCookies: async (req) => {
            const result = await sessions.getCookies(req.provider);
            // redactCookies, not the generic redactor: a cookie value is a bare string
            // with no "name=value" shape, so a regex pass cannot see it as a secret.
            // Without this, every session cookie goes out in plaintext. Names, domains
            // and expiries are preserved so the call stays useful for diagnosis.
            return { success: true, ...result, cookies: redactCookies(result.cookies) };
        },

        getSettings: async () => ({ success: true, settings: stateStore.loadSettings() }),

        setSetting: async (req) => {
            if (!req.data || typeof req.data.key !== 'string') {
                return { success: false, error: 'setSetting requires data.key' };
            }
            const settings = stateStore.saveSettings({ [req.data.key]: req.data.value });
            return { success: true, settings };
        },

        /**
         * Q3: flipping headless cannot reliably re-launch contexts in-process, so this
         * persists the preference and reports that a restart is required. It is kept in
         * the contract rather than dropped so the operator is not left guessing.
         */
        setHeadlessMode: async (req) => {
            const headless = req.data?.headless !== false;
            stateStore.saveSettings({ headless });
            return {
                success: true,
                headless,
                requiresRestart: true,
                message: `Headless mode set to ${headless}. Restart the gateway to apply.`,
            };
        },
    };

    // ---- dispatch ----

    return async function handle(request) {
        const { action, provider } = request;

        if (REJECTED_ACTIONS[action]) {
            return {
                success: false,
                error: `Action "${action}" is not available: ${REJECTED_ACTIONS[action]}`,
            };
        }

        const handler = actions[action];
        if (!handler) {
            return {
                success: false,
                error: `Unknown action "${action}". Known: ${Object.keys(actions).sort().join(', ')}`,
            };
        }

        // Provider-scoped actions must name a real provider.
        if (provider !== undefined && provider !== null && provider !== '') {
            if (!isKnownProvider(provider)) {
                return {
                    success: false,
                    error: `Unknown provider "${provider}". Known: ${PROVIDER_NAMES.join(', ')}`,
                };
            }
        } else if (NEEDS_PROVIDER.has(action)) {
            return { success: false, error: `Action "${action}" requires a provider` };
        }

        try {
            return await handler(request);
        } catch (e) {
            // F6 + redaction: keep the classification so a caller can tell "the browser
            // broke" from "the provider rejected us", but never let a raw internal
            // message reach the wire - a Playwright error can quote a URL carrying a
            // token, and an engine can echo a request header back in a failure body.
            return {
                success: false,
                ...toSafeError(e, {
                    ...(e?.provider ? { provider: e.provider } : {}),
                }),
            };
        }
    };
}

const NEEDS_PROVIDER = new Set([
    'initProvider',
    'isLoggedIn',
    'sendMessage',
    'getResponse',
    'getTypingStatus',
    'getResponseWithTyping',
    'newConversation',
    'waitForSendButton',
    'executeScript',
    'navigate',
    'debugDOM',
    'setCookies',
    'getCookies',
]);

function resolveTargets(req, fallback) {
    if (Array.isArray(req.data?.providers) && req.data.providers.length) {
        return req.data.providers;
    }
    if (req.provider) return [req.provider];
    return fallback;
}

function hasAttachments(data) {
    const raw = data.attachments || data.files || data.filePath;
    if (!raw) return false;
    if (Array.isArray(raw)) return raw.length > 0;
    return true;
}

function processMemoryReport(loadedProviders = null) {
    const m = process.memoryUsage();
    return {
        rssMB: +(m.rss / 1048576).toFixed(1),
        heapUsedMB: +(m.heapUsed / 1048576).toFixed(1),
        heapTotalMB: +(m.heapTotal / 1048576).toFixed(1),
        externalMB: +(m.external / 1048576).toFixed(1),
        loadedProviders,
    };
}

module.exports = {
    createHandler,
    CAPTURE_MAX_ATTEMPTS,
    CAPTURE_RETRY_DELAY_MS,
    MEMORY_SETTLE_MS,
    REJECTED_ACTIONS,
    NEEDS_PROVIDER,
    processMemoryReport,
};
