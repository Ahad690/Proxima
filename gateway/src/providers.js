'use strict';

/**
 * Provider registry.
 *
 * This is the ONLY place provider knowledge lives, and it is deliberately limited to
 * what the gateway must know to manage a session: where to navigate, and how to tell
 * whether the persisted profile is authenticated.
 *
 * Provider API protocol knowledge belongs in engines, not here. The gateway never
 * learns what a completion request looks like.
 */

/** Long-lived auth cookies are re-persisted with this expiry so restart != logout. */
const AUTH_COOKIE_TTL_MS = 365 * 24 * 60 * 60 * 1000;

const PROVIDERS = {
    chatgpt: {
        name: 'chatgpt',
        url: 'https://chatgpt.com/',
        origin: 'https://chatgpt.com',
        partition: 'chatgpt',
        engineGlobal: '__proximaChatGPT',
        auth: {
            domain: 'openai.com',
            cookies: ['__Secure-next-auth.session-token', '__cf_bm'],
        },
        // ChatGPT's in-origin API requires a bearer the page holds; cookies alone 404.
        // The engine extracts it. The gateway only records that it must be present.
        requiresBearer: true,
        supportsUploads: true,
        supportsDomFallback: true,
    },

    perplexity: {
        name: 'perplexity',
        url: 'https://www.perplexity.ai/',
        origin: 'https://www.perplexity.ai',
        partition: 'perplexity',
        engineGlobal: '__proximaPerplexity',
        auth: {
            domain: 'perplexity.ai',
            cookies: ['__Secure-next-auth.session-token', 'pplx_'],
        },
        requiresBearer: false,
        supportsUploads: false,
        supportsDomFallback: true,
    },

    claude: {
        name: 'claude',
        url: 'https://claude.ai/',
        origin: 'https://claude.ai',
        partition: 'claude',
        engineGlobal: '__proximaClaude',
        auth: {
            domain: 'claude.ai',
            cookies: ['sessionKey', '__cf_bm'],
        },
        requiresBearer: false,
        supportsUploads: true,
        supportsDomFallback: true,
    },

    gemini: {
        name: 'gemini',
        url: 'https://gemini.google.com/',
        origin: 'https://gemini.google.com',
        partition: 'gemini',
        engineGlobal: '__proximaGemini',
        auth: {
            // Google sets many consent/tracking cookies, so a count is meaningless here.
            // Only these names indicate a real session.
            domain: 'google.com',
            cookies: ['SID', 'HSID', 'SSID', '__Secure-1PSID', '__Secure-3PSID'],
        },
        requiresBearer: false,
        // Gemini has no dedicated upload path. Login + message only.
        supportsUploads: false,
        supportsDomFallback: true,
    },

    qwen: {
        name: 'qwen',
        url: 'https://chat.qwen.ai/',
        origin: 'https://chat.qwen.ai',
        partition: 'qwen',
        engineGlobal: '__proximaQwen',
        auth: {
            domain: 'qwen.ai',
            cookies: ['token', 'ssxmod_itna', 'cna', 'x5sec'],
        },
        requiresBearer: false,
        supportsUploads: true,
        // A4: the API engine owns the conversation completely. There is no scrape fallback,
        // so a capture failure here is a hard failure rather than a retry-the-DOM case.
        supportsDomFallback: false,
    },
};

const PROVIDER_NAMES = Object.keys(PROVIDERS);

function getProvider(name) {
    const p = PROVIDERS[name];
    if (!p) {
        throw new Error(
            `Unknown provider "${name}". Known: ${PROVIDER_NAMES.join(', ')}`
        );
    }
    return p;
}

function isKnownProvider(name) {
    return Object.prototype.hasOwnProperty.call(PROVIDERS, name);
}

module.exports = {
    PROVIDERS,
    PROVIDER_NAMES,
    AUTH_COOKIE_TTL_MS,
    getProvider,
    isKnownProvider,
};
