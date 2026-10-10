'use strict';

const fs = require('fs');
const path = require('path');
const { AUTH_COOKIE_TTL_MS } = require('./providers');

/**
 * Auth cookie management.
 *
 * Operates on a plain cookie array so it is testable without a browser. The session
 * manager supplies cookies from Playwright's context; this module decides whether they
 * mean "logged in", and owns backup/restore/injection.
 */

/**
 * Decide whether a cookie set represents a real authenticated session.
 *
 * Domain-scoped and name-matched on purpose. Counting cookies is invalid: Google sets
 * many consent and tracking cookies, so a Gemini profile with 30 cookies and no session
 * would otherwise read as logged in.
 *
 * @param {Array<{name:string,domain:string,value:string,expires?:number}>} cookies
 * @param {{domain:string, cookies:string[]}} authConfig
 * @returns {{loggedIn:boolean, matched:string[], domain:string}}
 */
function evaluateAuth(cookies, authConfig) {
    const matched = [];
    if (!Array.isArray(cookies) || !authConfig) {
        return { loggedIn: false, matched, domain: authConfig ? authConfig.domain : null };
    }

    const domain = authConfig.domain;
    const inDomain = cookies.filter(
        (c) => c && typeof c.domain === 'string' && c.domain.includes(domain)
    );

    for (const name of authConfig.cookies) {
        // startsWith covers Google's __Secure-1PSID / __Secure-3PSID families and
        // Perplexity's pplx_* suffixes without enumerating every variant.
        const hit = inDomain.some((c) => c.name === name || c.name.startsWith(name));
        if (hit) matched.push(name);
    }

    return { loggedIn: matched.length > 0, matched, domain };
}

/**
 * Normalize an operator-supplied cookie export into a shape safe to set.
 * Accepts the array shape produced by EditThisCookie / Cookie-Editor.
 */
function normalizeImportedCookies(input) {
    let parsed = input;
    if (typeof input === 'string') {
        try {
            parsed = JSON.parse(input);
        } catch {
            throw new Error('Cookie payload is not valid JSON');
        }
    }
    if (!Array.isArray(parsed)) {
        throw new Error('Cookies should be an array. Try exporting from EditThisCookie or Cookie-Editor.');
    }

    return parsed
        .filter((c) => c && typeof c.name === 'string' && typeof c.domain === 'string')
        .map((c) => {
            const url = c.url || `https://${c.domain.replace(/^\./, '')}`;
            return {
                name: c.name,
                value: String(c.value ?? ''),
                domain: c.domain,
                path: c.path || '/',
                // Refreshed so an imported session cookie does not become a session cookie
                // again on the next restart and silently log the operator out.
                expires: Math.floor(
                    (typeof c.expires === 'number' && c.expires > Date.now() / 1000
                        ? c.expires * 1000
                        : Date.now() + AUTH_COOKIE_TTL_MS) / 1000
                ),
                httpOnly: Boolean(c.httpOnly),
                secure: c.secure !== false,
                sameSite: normalizeSameSite(c.sameSite),
                ...(url ? { url } : {}),
            };
        });
}

function normalizeSameSite(value) {
    if (!value) return 'Lax';
    const v = String(value).toLowerCase();
    if (v === 'no_restriction' || v === 'none') return 'None';
    if (v === 'strict') return 'Strict';
    return 'Lax';
}

/** Strip the fields we do not persist, keeping a portable backup blob. */
function toBackupRecord(provider, cookies) {
    return {
        provider,
        savedAt: new Date().toISOString(),
        cookies: cookies.map((c) => ({
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path || '/',
            expires: c.expires,
            httpOnly: Boolean(c.httpOnly),
            secure: c.secure !== false,
            sameSite: normalizeSameSite(c.sameSite),
        })),
    };
}

class CookieStore {
    constructor(stateStore) {
        this.state = stateStore;
    }

    _backupPath(provider) {
        return path.join(this.state.cookieBackupDir, `${provider}.json`);
    }

    /**
     * Write a file that holds credentials.
     *
     * The mode must be set ON the write, not after it. Calling writeFileSync then
     * chmodSync leaves a window where the file exists at the umask default, and
     * `mode` on a write is ignored when the file already exists - which is the common
     * case for a profile. So: create a temp file with the restrictive mode, then
     * rename over the target, which is atomic and carries the mode with it.
     *
     * On win32 Node maps chmod to a read-only attribute and a POSIX 0600 is not
     * achievable. That is reported rather than swallowed, because the alternative is
     * code that appears to protect a credential and does not.
     */
    writeSecure(file, contents) {
        // The parent must exist. A per-provider profile directory is created lazily, so
        // a missing mkdir here makes every flush throw into a silent catch and the
        // auth store is never written at all.
        fs.mkdirSync(path.dirname(file), { recursive: true });

        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        try {
            fs.renameSync(tmp, file);
        } catch (e) {
            try {
                fs.unlinkSync(tmp);
            } catch {
                /* leave no temp behind */
            }
            throw e;
        }
        this._warnIfModeUnsupported(file);
        return file;
    }

    _warnIfModeUnsupported(file) {
        if (process.platform !== 'win32') return;
        if (CookieStore._winModeWarned) return;
        CookieStore._winModeWarned = true;
        const dir = path.dirname(file);
        // Reported once, not thrown: the state dir is inside the user profile, so the
        // practical exposure is limited, but the limitation should not be invisible.
        process.emitWarning(
            `POSIX 0600 is not enforceable on win32; credential file modes in ${dir} ` +
                `rely on inherited directory ACLs. Move PROXIMA_GATEWAY_STATE_DIR off a ` +
                `shared path if that is a concern.`,
            'SecurityWarning'
        );
    }

    saveBackup(provider, cookies) {
        if (!Array.isArray(cookies) || cookies.length === 0) return null;
        const record = toBackupRecord(provider, cookies);
        this.writeSecure(this._backupPath(provider), JSON.stringify(record, null, 2));
        return record;
    }

    loadBackup(provider) {
        try {
            const rec = JSON.parse(fs.readFileSync(this._backupPath(provider), 'utf8'));
            return rec && Array.isArray(rec.cookies) ? rec : null;
        } catch {
            return null;
        }
    }

    clearBackup(provider) {
        try {
            fs.unlinkSync(this._backupPath(provider));
        } catch {
            /* already gone */
        }
    }
    /**
     * Cookies that a restore would actually install, i.e. those whose domain matches.
     * Prevents a Qwen backup from writing perplexity.ai cookies into the wrong profile.
     */
    cookiesForDomain(record, domain) {
        if (!record || !Array.isArray(record.cookies)) return [];
        return record.cookies.filter((c) => String(c.domain || '').includes(domain));
    }
}

/**
 * Placeholder strings that must never be surfaced to a caller as a real answer (A8).
 *
 * Matched by prefix rather than exact equality: providers use variants of the same
 * sentinel, and an exact set silently fails open on a wording it did not anticipate -
 * which turns "no answer yet" into a delivered answer.
 */
const PLACEHOLDER_PREFIXES = ['', 'no response', 'no answer', 'nothing returned', '(no'];

/** Values a JSON body can produce that are not answers. */
const PLACEHOLDER_LITERALS = new Set(['null', 'undefined', 'false', 'nil', 'none']);

function isPlaceholderResponse(text) {
    if (text === null || text === undefined) return true;
    const t = String(text).trim().toLowerCase();
    if (t === '') return true;
    if (PLACEHOLDER_LITERALS.has(t)) return true;
    return PLACEHOLDER_PREFIXES.some((p) => p !== '' && t.startsWith(p));
}

const PLACEHOLDER_RESPONSES = new Set([
    '',
    'no response captured',
    'no response received',
]);

module.exports = {
    CookieStore,
    evaluateAuth,
    normalizeImportedCookies,
    normalizeSameSite,
    toBackupRecord,
    isPlaceholderResponse,
    AUTH_COOKIE_TTL_MS,
};
