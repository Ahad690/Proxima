'use strict';
/**
 * In-page request capture for any Proxima provider tab, sanitized at the source.
 *
 * Replaces "open DevTools, reproduce, Save all as HAR, hand it over". A recorder is
 * installed into the page's own JavaScript world, wrapping fetch and XMLHttpRequest,
 * so it sees exactly what the site's app sends — including calls made by Proxima's own
 * engines, which run in the same world.
 *
 * ONE SANITIZER, TWO PLACES. The cap* functions below are plain JavaScript with no Node
 * or browser-only dependencies. They are injected into pages through Function.toString,
 * and the same functions run again in Node as a second pass over the finished HAR. A
 * copied sanitizer drifts from its original. That is not hypothetical here: an earlier,
 * ChatGPT-only capture scrubbed request URLs and headers but not response BODIES, and
 * shipped an Azure SAS upload URL with its sig= intact.
 *
 * Nothing is per-site. "Own origin" is whatever location.origin the page reports; a URL
 * on any other origin loses its query string, because that is where signed URLs (Azure
 * SAS, Alibaba OSS, S3, GCS) keep their credential.
 */

// ---------------------------------------------------------------------------------------
// In-page functions. Keep these self-contained: no closures over module scope, no arrow
// functions that capture `this`, nothing Node-specific. They are serialised with
// toString() and evaluated inside the provider's page.
// ---------------------------------------------------------------------------------------

function capSecretHeader(name) {
    return /authorization|cookie|token|sentinel|proof|conduit|device|session|signature|secret|key|observation|csrf|xsrf|umid|sapisid|^bx-|^x-client-data$/i
        .test(String(name));
}

function capCleanText(s, max, ownOrigin) {
    s = String(s == null ? '' : s);
    // JSON Web Tokens.
    s = s.replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '<jwt>');
    // A URL on another origin loses its query: signed URLs keep their credential there.
    // Backslash is excluded so a URL inside JSON-escaped text cannot swallow its own \".
    s = s.replace(/(https?:\/\/[^"'\s?\\]+)\?[^"'\s<\\]*/g, function (m, base) {
        return ownOrigin && base.indexOf(ownOrigin) === 0 ? m : base + '?<signed params removed>';
    });
    // Signing and session parameters wherever they survive: own-origin queries, form bodies.
    s = s.replace(/\b(sig|se|sp|sv|sr|scid|skoid|sktid|skt|ske|sks|skv|st|spr|sip|Signature|Expires|OSSAccessKeyId|security-token|x-oss-[a-z-]+|X-Amz-[A-Za-z-]+|at|f\.sid|sid|SAPISID|__Secure-[A-Za-z0-9_-]+)=[^&"'\s<\\]*/g,
        '$1=<removed>');
    // JSON fields whose name says they hold a secret.
    s = s.replace(/("[^"\\]*(token|secret|signature|access_key|accesskey|security|password|conduit|credential)[^"\\]*"\s*:\s*")[^"\\]*"/gi,
        '$1<redacted>"');
    // Email addresses are PII; account endpoints return them freely.
    s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>');
    // Personal fields by name. Found by looking at real output: claude.ai /api/account
    // returns full_name and display_name, chatgpt.com /api/auth/session a deviceId and a
    // region. Bare "name" is deliberately absent — it would also erase model names, which
    // protocol work needs. Opaque ids (user/org/account uuids) are kept for the same reason.
    s = s.replace(/("(full_name|display_name|given_name|family_name|first_name|last_name|nickname|phone|phone_number|deviceId|device_id|ip|ip_address|region|city|postal_code|street_address|address)"\s*:\s*")[^"\\]*"/gi,
        '$1<pii>"');
    // Anything long and opaque enough to be a credential or key material.
    s = s.replace(/[A-Za-z0-9+\/=_-]{60,}/g, '<long-opaque>');
    if (max && s.length > max) s = s.slice(0, max) + '…[' + s.length + ' chars]';
    return s;
}

function capCleanUrl(u, ownOrigin) {
    try {
        var x = new URL(u, ownOrigin);
        var s = x.origin === ownOrigin
            ? x.pathname + x.search
            : x.origin + x.pathname + (x.search ? '?<signed params removed>' : '');
        return capCleanText(s, 2000, ownOrigin);
    } catch (e) {
        return String(u).split('?')[0];
    }
}

function capCleanHeaders(h, ownOrigin) {
    var out = {};
    if (!h) return out;
    var add = function (k, v) {
        out[k] = capSecretHeader(k) ? '<redacted>' : capCleanText(v, 300, ownOrigin);
    };
    if (Array.isArray(h)) h.forEach(function (p) { add(p[0], p[1]); });
    else if (typeof h.forEach === 'function') h.forEach(function (v, k) { add(k, v); });
    else Object.keys(h).forEach(function (k) { add(k, h[k]); });
    return out;
}

function capInstall(ownOrigin, maxBody) {
    if (window.__proximaCapture && window.__proximaCapture.installed) {
        return { state: 'already', origin: window.__proximaCapture.origin };
    }
    var cap = window.__proximaCapture = {
        installed: true, origin: ownOrigin, startedAt: Date.now(), log: [], pending: 0, seq: 0
    };
    // Static assets are noise for protocol work and can be megabytes each.
    var STATIC = /\.(m?js|css|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|map)(\?|$)/i;
    var keep = function (u) { return !STATIC.test(String(u)); };
    var bodyDesc = function (b) {
        if (b == null) return null;
        if (typeof b === 'string') return capCleanText(b, maxBody, ownOrigin);
        if (typeof URLSearchParams !== 'undefined' && b instanceof URLSearchParams) {
            return capCleanText(b.toString(), maxBody, ownOrigin);
        }
        if (typeof FormData !== 'undefined' && b instanceof FormData) {
            var parts = [];
            b.forEach(function (v, k) {
                parts.push(k + '=' + (typeof v === 'string' ? capCleanText(v, 400, ownOrigin)
                    : '<file ' + (v.name || '') + ' ' + v.type + ' ' + v.size + ' bytes>'));
            });
            return '<FormData> ' + parts.join(' & ');
        }
        return '<' + ((b.constructor && b.constructor.name) || 'binary') + ' ' +
            (b.size || b.byteLength || '?') + ' bytes>';
    };
    var settle = function (e) { e.done = true; e.tEnd = Date.now(); cap.pending--; };

    cap.origFetch = window.fetch;
    window.fetch = function (input, init) {
        var url = typeof input === 'string' ? input : (input && input.url) || String(input);
        var e = null;
        if (keep(url)) {
            e = {
                n: ++cap.seq, via: 'fetch', t: Date.now(),
                method: String((init && init.method) || (input && input.method) || 'GET').toUpperCase(),
                url: capCleanUrl(url, ownOrigin),
                reqHeaders: capCleanHeaders((init && init.headers) || (input && input.headers), ownOrigin),
                reqBody: bodyDesc(init && init.body)
            };
            cap.log.push(e);
            cap.pending++;
        }
        var p = cap.origFetch.apply(this, arguments);
        if (e) {
            p.then(function (res) {
                e.status = res.status;
                e.resType = res.headers.get('content-type') || '';
                e.resHeaders = capCleanHeaders(res.headers, ownOrigin);
                if (!e.resType || /json|text|event-stream|xml|javascript|x-www-form/i.test(e.resType)) {
                    res.clone().text().then(function (t) {
                        e.resBody = capCleanText(t, maxBody, ownOrigin); settle(e);
                    }).catch(function () { e.resBody = '<unreadable>'; settle(e); });
                } else {
                    e.resBody = '<' + e.resType + '>'; settle(e);
                }
            }).catch(function (err) { e.error = String(err && err.message || err); settle(e); });
        }
        return p;
    };

    var X = XMLHttpRequest.prototype;
    cap.origOpen = X.open; cap.origSend = X.send; cap.origSet = X.setRequestHeader;
    X.open = function (m, u) {
        this.__proximaCap = { m: m, u: u, h: {} };
        return cap.origOpen.apply(this, arguments);
    };
    X.setRequestHeader = function (k, v) {
        if (this.__proximaCap) this.__proximaCap.h[k] = v;
        return cap.origSet.apply(this, arguments);
    };
    X.send = function (body) {
        var c = this.__proximaCap, xhr = this;
        if (c && keep(c.u)) {
            var e = {
                n: ++cap.seq, via: 'xhr', t: Date.now(), method: String(c.m).toUpperCase(),
                url: capCleanUrl(c.u, ownOrigin), reqHeaders: capCleanHeaders(c.h, ownOrigin),
                reqBody: bodyDesc(body)
            };
            cap.log.push(e);
            cap.pending++;
            xhr.addEventListener('loadend', function () {
                e.status = xhr.status;
                try { e.resType = xhr.getResponseHeader('content-type') || ''; } catch (er) { /* opaque */ }
                try {
                    e.resBody = (xhr.responseType === '' || xhr.responseType === 'text')
                        ? capCleanText(xhr.responseText, maxBody, ownOrigin) : '<' + xhr.responseType + '>';
                } catch (er) { e.resBody = '<unreadable>'; }
                settle(e);
            });
        }
        return cap.origSend.apply(this, arguments);
    };
    return { state: 'installed', origin: ownOrigin };
}

/**
 * Hand finished entries to the caller and forget them, so the page holds only what is
 * still in flight. `final` hands over everything, finished or not.
 */
function capDrain(final) {
    var cap = window.__proximaCapture;
    if (!cap) return { missing: true };
    var out = [], keepers = [];
    cap.log.forEach(function (e) { (final || e.done ? out : keepers).push(e); });
    cap.log = keepers;
    return { origin: cap.origin, startedAt: cap.startedAt, entries: out, inFlight: keepers.length };
}

function capUninstall() {
    var cap = window.__proximaCapture;
    if (!cap) return false;
    // Only restore what is still ours: if something wrapped fetch after us, leave it.
    if (cap.origFetch) window.fetch = cap.origFetch;
    var X = XMLHttpRequest.prototype;
    if (cap.origOpen) { X.open = cap.origOpen; X.send = cap.origSend; X.setRequestHeader = cap.origSet; }
    delete window.__proximaCapture;
    return true;
}

// ---------------------------------------------------------------------------------------
// Node side.
// ---------------------------------------------------------------------------------------

const PAGE_FNS = [capSecretHeader, capCleanText, capCleanUrl, capCleanHeaders,
    capInstall, capDrain, capUninstall].map((f) => f.toString()).join('\n');

/** Wrap a call expression so it runs in the page with the cap* functions in scope. */
function pageScript(callExpr) {
    return '(function () {\n' + PAGE_FNS + '\nreturn JSON.stringify(' + callExpr + ');\n})()';
}

/** Like pageScript, but first waits (bounded) for in-flight responses to settle. */
function pageDrainScript(final, waitMs) {
    return '(async function () {\n' + PAGE_FNS + '\n' +
        'var cap = window.__proximaCapture, t0 = Date.now();\n' +
        'while (cap && cap.pending > 0 && Date.now() - t0 < ' + Number(waitMs || 0) + ') ' +
        'await new Promise(function (r) { setTimeout(r, 250); });\n' +
        'return JSON.stringify(capDrain(' + (final ? 'true' : 'false') + '));\n})()';
}

/**
 * Checks for anything that still looks like a credential or PII after sanitizing. Run
 * against the finished file: the label "sanitized" has been wrong before, and only
 * looking at the output caught it.
 */
const LEAK_CHECKS = {
    'JWT': /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    'Bearer value': /Bearer\s+[A-Za-z0-9._~+\/-]{20,}/g,
    'signed-URL parameter': /[?&](sig|se|Signature|OSSAccessKeyId|X-Amz-Signature|X-Amz-Credential)=(?!<removed>)[^&"<\\\s]{6,}/g,
    'session/XSRF parameter': /\b(at|f\.sid|SAPISID)=(?!<removed>)[^&"<\\\s]{6,}/g,
    'long opaque string': /[A-Za-z0-9+\/=_-]{60,}/g,
    'secret-named JSON field': /"[a-z_]*(token|secret|signature|password|credential)[a-z_]*"\s*:\s*"(?!<redacted>)[^"\\]{12,}"/gi,
    'email address': /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
};

function scan(text) {
    const hits = [];
    for (const [name, re] of Object.entries(LEAK_CHECKS)) {
        const m = String(text).match(re);
        if (m && m.length) hits.push({ check: name, count: m.length, sample: m[0].slice(0, 16) + '…' });
    }
    return hits;
}

/** Second pass, in Node, with the SAME function the page used. No truncation. */
function scrub(text, ownOrigin) {
    return capCleanText(text, 0, ownOrigin);
}

/** Captured entries -> HAR 1.2, so existing HAR tooling reads it unchanged. */
function toHar(entries, meta) {
    const abs = (u) => (/^https?:\/\//.test(u) ? u : String(meta.origin || '') + u);
    const pairs = (o) => Object.keys(o || {}).map((k) => ({ name: k, value: String(o[k]) }));
    return {
        log: {
            version: '1.2',
            creator: { name: 'proxima page-capture', version: '1' },
            comment: 'Captured in-page and sanitized at the source, then re-scrubbed and scanned in Node. ' +
                'Secret-named headers redacted; signed URLs on other origins stripped of their query; ' +
                'JWTs, signing/session parameters, secret-named JSON fields, emails and long opaque strings masked.' +
                (meta.note ? ' ' + meta.note : ''),
            pages: [{ id: 'page_1', title: meta.origin || '', startedDateTime: new Date(meta.startedAt || Date.now()).toISOString(), pageTimings: {} }],
            entries: entries.map((e) => ({
                pageref: 'page_1',
                startedDateTime: new Date(e.t).toISOString(),
                time: e.tEnd ? e.tEnd - e.t : -1,
                request: {
                    method: e.method, url: abs(e.url), httpVersion: '', cookies: [],
                    headers: pairs(e.reqHeaders), queryString: [], headersSize: -1, bodySize: -1,
                    postData: e.reqBody != null ? { mimeType: (e.reqHeaders || {})['content-type'] || '', text: e.reqBody } : undefined
                },
                response: {
                    status: e.status || 0, statusText: '', httpVersion: '', cookies: [],
                    headers: pairs(e.resHeaders), redirectURL: '', headersSize: -1, bodySize: -1,
                    content: { size: -1, mimeType: e.resType || '', text: e.resBody || '' }
                },
                cache: {}, timings: { send: 0, wait: e.tEnd ? e.tEnd - e.t : -1, receive: 0 },
                comment: 'via ' + e.via + (e.error ? ' | error: ' + e.error : '') + (e.done ? '' : ' | still in flight at stop')
            }))
        }
    };
}

module.exports = {
    pageScript, pageDrainScript, toHar, scan, scrub, LEAK_CHECKS,
    // exported for tests
    capCleanText, capCleanUrl, capCleanHeaders, capSecretHeader
};
