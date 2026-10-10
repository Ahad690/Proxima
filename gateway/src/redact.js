'use strict';

/**
 * Secret redaction.
 *
 * The gateway holds session cookies and provider bearer tokens. Those values reach error
 * paths: a Playwright failure can quote the URL it was fetching, and a provider can echo
 * a request header back in an error body. Any of that landing in a log or an IPC
 * response is a credential disclosure.
 *
 * Two techniques, because neither alone is sufficient:
 *
 *   redaction  - regex, for values whose shape is known (bearer tokens, JWTs, cookies)
 *   truncation - a length cap, for values whose shape is not (an opaque session blob)
 *
 * The goal is to remove secrets WITHOUT destroying diagnostics. Action names,
 * requestIds, provider names, status codes and error text all survive; only the
 * secret-shaped parts are replaced.
 */

const REDACTED = '[REDACTED]';

/** Default cap for any single redacted string. */
const DEFAULT_MAX = 512;

const { PROVIDERS } = require('./providers');

/**
 * Cookie/query names whose values are credentials.
 *
 * Declared before PATTERNS because the pattern table references it at module init, and
 * a const below its use would be in the temporal dead zone on first load.
 *
 * Derived from the provider registry rather than hand-listed, because a hand-maintained
 * list silently drifts: __cf_bm was an auth cookie in the registry but absent here, so
 * it was neither masked nor detected. Deriving makes that class of bug impossible.
 */
const PROVIDER_AUTH_COOKIE_NAMES = Array.from(
    new Set(Object.values(PROVIDERS).flatMap((p) => p.auth.cookies))
).map((n) => n.toLowerCase());

const HARDCODED_SENSITIVE_NAMES = [
    // Cloudflare bot clearance. Not an auth cookie for any one provider, but it is
    // bearer-grade: replaying it is enough to impersonate the session.
    '__cf_bm',
    'cf_clearance',
    'csrf',
    'xsrf',
    'auth',
];

const SENSITIVE_COOKIE_NAMES = new RegExp(
    '^(?:__Secure-|__Host-)?(?:' +
        [...PROVIDER_AUTH_COOKIE_NAMES, ...HARDCODED_SENSITIVE_NAMES]
            .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            .join('|') +
        ')$|^pplx',
    'i'
);

/** Values that look like opaque credentials even without a name we recognise. */
const OPAQUE_SECRET = /^[A-Za-z0-9._~+/=-]{24,}$/;

/**
 * Patterns applied in order. Each captures the secret and rewrites only that group,
 * leaving surrounding context readable.
 */
const PATTERNS = [
    // Authorization: [<scheme>] <value>, listed BEFORE the bare-bearer rule.
    //
    // The scheme is a generic word, not a fixed list: an allowlist of schemes leaks every
    // scheme not on it, and a previous version behaved exactly that way - "Basic" passed
    // through untouched while "ApiKey" had its scheme destroyed and kept its credential,
    // so the line looked redacted while leaking.
    //
    // Running first means the bare-bearer rule finds nothing left to do, so the scheme
    // is preserved once and the value is masked once - no double marker, and "Bearer"
    // survives for diagnosis.
    {
        name: 'authorization',
        re: /(authorization"?\s*[:=]\s*"?)(?:([A-Za-z][A-Za-z0-9_-]*)\s+)?(\[\s*redacted\s*\]|[^\s"',}]{3,})/gi,
        repl: (m, prefix, scheme, value) => {
            // Match the redaction marker as a first-class alternative rather than
            // excluding it with a lookahead. A lookahead does not survive backtracking:
            // the engine retries without the scheme group, matches the scheme word as
            // the value, and the line is rewritten on a second pass. Matching the
            // marker explicitly makes redaction genuinely idempotent.
            if (/^\[\s*redacted\s*\]$/i.test(value)) {
                return `${prefix}${scheme ? `${scheme} ` : ''}${value}`;
            }
            return scheme ? `${prefix}${scheme} ${REDACTED}` : `${prefix}${REDACTED}`;
        },
    },
    // A bare "Bearer <token>" with no header name, e.g. in pasted cURL output.
    {
        name: 'bearer',
        re: /\b(bearer)\s+([A-Za-z0-9._~+/=-]{8,})/gi,
        repl: (_m, scheme) => `${scheme} ${REDACTED}`,
    },
    // JSON Web Tokens
    {
        name: 'jwt',
        re: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g,
        repl: () => REDACTED,
    },
    // Provider API keys
    {
        name: 'apikey',
        re: /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,
        repl: (_m, prefix) => `${prefix}-${REDACTED}`,
    },
    // Cookie assignment: name=value. Covers Set-Cookie, document.cookie dumps, and
    // Cookie headers all at once, because they share this shape.
    {
        name: 'cookie',
        re: /(\b(?:__Secure-|__Host-)?[A-Za-z0-9_-]{2,})=([^;"'\s,}]{4,})/g,
        repl: (_m, name) => `${name}=${REDACTED}`,
        // Only redact names that look like credentials, so ordinary query parameters
        // in a diagnostic URL stay readable.
        nameFilter: SENSITIVE_COOKIE_NAMES,
    },
    // Sensitive query parameters
    {
        name: 'query',
        re: /([?&](?:token|access_token|refresh_token|id_token|key|api_key|session|sessionKey|auth|sid|ssid|psid|cna|x5sec|ssxmod_itna|__Secure-next-auth\.session-token|pplx[A-Za-z0-9_]*)=)([^&\s"']{4,})/gi,
        repl: (_m, prefix) => `${prefix}${REDACTED}`,
    },
];

/**
 * Reduce a single secret to a short, non-reversible hint.
 * Enough to correlate two log lines, not enough to replay the credential.
 */
function fingerprint(secret) {
    const s = String(secret);
    if (s.length <= 8) return REDACTED;
    return `${s.slice(0, 3)}...${s.slice(-2)} (len ${s.length})`;
}

/**
 * Truncate with an explicit marker, so a cut is never mistaken for a complete value.
 */
function truncate(input, max = DEFAULT_MAX) {
    const s = typeof input === 'string' ? input : String(input);
    if (s.length <= max) return s;
    return `${s.slice(0, max)}…[+${s.length - max} chars truncated]`;
}

/**
 * Redact a single string: regex first, then truncate.
 *
 * @param {string} input
 * @param {object} [opts]
 * @param {number} [opts.max] truncation cap; Infinity to disable
 * @param {boolean} [opts.fingerprint] keep a correlatable hint instead of a flat marker
 * @returns {string}
 */
function redactString(input, { max = DEFAULT_MAX, fingerprint: fp = false } = {}) {
    if (input === null || input === undefined) return '';
    let s = String(input);

    for (const rule of PATTERNS) {
        s = s.replace(rule.re, (...args) => {
            // A replace callback receives: match, ...captures, offset, input.
            // The last CAPTURE is therefore at length-3, not length-2 - length-2 is
            // the offset. Getting this wrong silently skips name-filtered redaction,
            // which is how a cookie value survives a pass that appears to run.
            const name = args[1];

            if (!rule.nameFilter) return rule.repl(...args);
            // nameFilter is a predicate over the captured NAME, not the value. Testing
            // the value here would match nothing and disable the rule entirely.
            if (typeof name !== 'string' || !rule.nameFilter.test(name)) {
                return args[0];
            }
            return fp ? `${name}=${fingerprint(args[2])}` : rule.repl(...args);
        });
    }

    return truncate(s, max);
}

/**
 * Redact any value, recursively.
 *
 * Applied to anything headed for a log or an IPC response. Structure is preserved so a
 * reader can still see which field was present, only the value is masked.
 */
function redact(value, opts = {}, depth = 0) {
    const MAX_DEPTH = 6;

    if (value === null || value === undefined) return value;

    if (typeof value === 'string') {
        return redactString(value, opts);
    }

    if (typeof value === 'number' || typeof value === 'boolean') return value;

    if (typeof value === 'bigint') return value.toString();

    if (value instanceof Error) {
        return {
            name: value.name,
            message: redactString(value.message, opts),
            ...(value.code ? { code: value.code } : {}),
            ...(value.kind ? { kind: value.kind } : {}),
        };
    }

    if (Buffer.isBuffer(value)) {
        return `[buffer ${value.length} bytes]`;
    }

    if (depth >= MAX_DEPTH) return '[depth limit]';

    if (Array.isArray(value)) {
        return value.map((v) => redact(v, opts, depth + 1));
    }

    if (typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = redact(v, opts, depth + 1);
        }
        return out;
    }

    // Functions, symbols, and anything exotic
    return `[${typeof value}]`;
}

/**
 * Redact a cookie array, keeping names visible and masking values.
 * `fingerprint: true` leaves a correlatable hint per cookie, which is what you want
 * when diagnosing "which session is stale" without being able to replay it.
 */
function redactCookies(cookies, { fingerprint: fp = true } = {}) {
    if (!Array.isArray(cookies)) return [];
    return cookies.map((c) => {
        if (!c || typeof c !== 'object') return redact(c);
        const name = c.name ?? '';
        const sensitive = SENSITIVE_COOKIE_NAMES.test(String(name));
        return {
            name: String(name),
            domain: c.domain,
            path: c.path,
            ...(sensitive
                ? { value: fp ? fingerprint(c.value) : REDACTED }
                : { value: c.value }),
            ...(c.expires !== undefined ? { expires: c.expires } : {}),
        };
    });
}

/**
 * Does this string still look like it contains a credential?
 * Used by the logger's own assertions and by tests, so a redaction regression is
 * detectable rather than merely improbable.
 */
function containsSecret(text) {
    if (text === null || text === undefined) return false;
    // Strip existing markers first. Otherwise a value that has already been redacted
    // still matches the shape of a credential, and the oracle reports a leak in
    // correctly-redacted output - which is how a leak check quietly stops being one.
    const s = String(text).split(REDACTED).join('');
    for (const rule of PATTERNS) {
        const re = new RegExp(rule.re.source, rule.re.flags);
        let m;
        while ((m = re.exec(s)) !== null) {
            if (m[0].includes(REDACTED)) continue;
            if (rule.nameFilter) {
                // For name-filtered rules the predicate applies to the captured NAME.
                const name = m[1];
                if (typeof name === 'string' && rule.nameFilter.test(name)) return true;
            } else if (rule.name === 'authorization') {
                // A scheme word on its own ("Basic", "Bearer") is not a credential. The
                // redaction pattern is deliberately broad, so the detector must be
                // narrower than it or it flags the scheme and reports a leak in
                // correctly-redacted output - which is how a leak check quietly stops
                // being one. A real credential carries entropy.
                const value = m[3] || '';
                if (!/^[A-Za-z]{1,12}$/.test(value)) return true;
            } else {
                return true;
            }
            if (m.index === re.lastIndex) re.lastIndex += 1;
        }
    }
    return OPAQUE_SECRET.test(s.trim());
}

module.exports = {
    REDACTED,
    DEFAULT_MAX,
    redact,
    redactString,
    redactCookies,
    truncate,
    fingerprint,
    containsSecret,
    PATTERNS,
    SENSITIVE_COOKIE_NAMES,
};
