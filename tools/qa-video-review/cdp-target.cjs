/**
 * Choosing a Chrome tab, safely, on a machine where more than one agent is working.
 *
 * THE HAZARD THIS REPLACES. Every tool here used to fall back to `pages[0]` when its
 * filter matched nothing:
 *
 *     record-cdp   if (f.length) pages = f; else console.error('...using the first page')
 *     drive-routes targets.find(...) || targets[0]        // no warning at all
 *     drive-script filter ? find || targets[0] : targets[0]
 *
 * On a shared debug port `pages[0]` is whatever tab happens to be first — measured on
 * this machine: eight page targets belonging to a different project, so `pages[0]` was
 * `https://tx-2fded057.pages.dev/`. A typo'd filter therefore records SOMEONE ELSE'S
 * application and the reviewer returns a confident verdict about the wrong app. The
 * drivers are worse than the recorder: they navigate that tab away and click into it.
 *
 * A silent fallback is indistinguishable from success, which is the property that makes
 * it dangerous rather than merely wrong. So: no fallback. Either the caller names the
 * tab, or the filter matches exactly one, or this throws and says what it saw.
 *
 * Three ways to name a tab, in order of safety:
 *   --target <ws://...>   pinned outright. Immune to anything else on the port.
 *   --new-tab <url>       opens a FRESH tab and pins it. Best on a shared browser: the
 *                         tab did not exist until you asked for it, so nothing else is
 *                         using it.
 *   --url-filter <s>      matches open tabs. Ambiguity is an ERROR, not a coin toss.
 */
const http = require('http');

function getJSON(url, timeoutMs) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
            let b = '';
            res.on('data', (d) => { b += d; });
            res.on('end', () => {
                try { resolve(JSON.parse(b)); }
                catch (e) {
                    reject(new Error('CDP ' + url + ' returned non-JSON (HTTP ' +
                        res.statusCode + '): ' + b.slice(0, 120)));
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(timeoutMs || 5000, () => { req.destroy(new Error('timeout')); });
    });
}

/**
 * Chrome binds the debug port to ONE loopback family and which one is not predictable:
 * if something already holds 127.0.0.1:PORT it silently binds [::1]:PORT and logs a
 * bind error nobody reads. Probing one family then finds a DIFFERENT browser, or none.
 */
async function listPages(port, host) {
    const hosts = (!host || host === '127.0.0.1') ? ['127.0.0.1', '[::1]'] : [host];
    let lastErr = null;
    for (const h of hosts) {
        try {
            const list = await getJSON('http://' + h + ':' + port + '/json/list');
            return {
                host: h,
                pages: list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
            };
        } catch (e) { lastErr = e; }
    }
    throw new Error('cannot reach Chrome debug port ' + port + ' on ' + hosts.join(' or ') +
        ' (' + (lastErr && lastErr.message) + '). Start it with start-browser.cjs --port ' + port);
}

/**
 * Open a brand-new tab and return its target. Nothing else can be using it.
 *
 * PUT, not GET. Current Chrome answers a GET on /json/new with HTTP 405 and the body
 * "Using unsafe HTTP verb GET to invoke /json/new. This action supports only PUT verb."
 * — which is easy to miss because it is a 200-shaped failure to anything that only
 * checks for a response. Worth knowing that the obvious PowerShell one-liner for this
 * (`Invoke-RestMethod .../json/new?url`) defaults to GET and hits the same wall.
 */
function putJSON(url, timeoutMs) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = http.request({
            method: 'PUT', host: u.hostname, port: u.port,
            path: u.pathname + u.search
        }, (res) => {
            let b = '';
            res.on('data', (d) => { b += d; });
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    return reject(new Error('CDP ' + u.pathname + ' returned HTTP ' +
                        res.statusCode + ': ' + b.slice(0, 160)));
                }
                try { resolve(JSON.parse(b)); }
                catch (e) { reject(new Error('CDP returned non-JSON: ' + b.slice(0, 160))); }
            });
        });
        req.on('error', reject);
        req.setTimeout(timeoutMs || 5000, () => { req.destroy(new Error('timeout')); });
        req.end();
    });
}

async function openTab(port, host, url) {
    const h = host || '127.0.0.1';
    const endpoint = 'http://' + h + ':' + port + '/json/new?' +
        encodeURIComponent(url || 'about:blank');
    let target;
    try {
        target = await putJSON(endpoint);
    } catch (e) {
        // Older Chrome builds only accept GET here, so try it rather than failing on a
        // version difference.
        target = await getJSON(endpoint);
    }
    if (!target || !target.webSocketDebuggerUrl) {
        throw new Error('Chrome did not return a target for the new tab');
    }
    return target;
}

function describe(pages) {
    if (!pages.length) return '(no page targets)';
    return pages.map((p, i) => '  [' + i + '] ' + (p.url || '(no url)').slice(0, 90)).join('\n');
}

/**
 * Resolve to a webSocketDebuggerUrl, or throw.
 *
 * opts: { port, host, target, newTab, urlFilter, allowAnyTab }
 * `allowAnyTab` restores the old take-the-first-page behaviour for someone working
 * alone who genuinely wants it — opt-in, loudly, never the default.
 */
async function resolveTarget(opts) {
    if (opts.target) return { ws: opts.target, how: 'pinned --target' };

    if (opts.newTab) {
        const t = await openTab(opts.port, opts.host, opts.newTab);
        return { ws: t.webSocketDebuggerUrl, how: 'opened a new tab', id: t.id, url: t.url };
    }

    const { pages } = await listPages(opts.port, opts.host);
    if (!pages.length) {
        throw new Error('no page targets on debug port ' + opts.port +
            '. Open a tab, or pass --new-tab <url> to make your own.');
    }

    if (opts.urlFilter) {
        const hit = pages.filter((t) => (t.url || '').indexOf(opts.urlFilter) !== -1);
        if (hit.length === 1) {
            return { ws: hit[0].webSocketDebuggerUrl, how: 'matched --url-filter', url: hit[0].url };
        }
        if (hit.length > 1) {
            // Picking one would be a coin toss between two of the caller's own tabs. Say so.
            throw new Error('--url-filter "' + opts.urlFilter + '" matched ' + hit.length +
                ' tabs; refusing to guess between them:\n' + describe(hit) +
                '\nNarrow the filter, or pass --target with the exact webSocketDebuggerUrl.');
        }
        throw new Error('--url-filter "' + opts.urlFilter + '" matched NOTHING. The port has ' +
            pages.length + ' page(s), which may belong to another agent:\n' + describe(pages) +
            '\nThis used to fall back to the first tab, which meant driving or recording ' +
            'someone else\'s application and reporting a confident verdict about it. ' +
            'Pass --new-tab <url> for your own tab, or --target for an exact one.');
    }

    if (pages.length === 1) {
        return { ws: pages[0].webSocketDebuggerUrl, how: 'the only open tab', url: pages[0].url };
    }
    if (opts.allowAnyTab) {
        return { ws: pages[0].webSocketDebuggerUrl, how: 'first tab (--allow-any-tab)', url: pages[0].url };
    }
    throw new Error('debug port ' + opts.port + ' has ' + pages.length +
        ' page targets and no tab was named:\n' + describe(pages) +
        '\nOn a shared browser the first tab is very likely another agent\'s. Pass ' +
        '--new-tab <url> to get your own, --url-filter to match one, --target to pin one, ' +
        'or --allow-any-tab if you really do want whichever is first.');
}

module.exports = { getJSON, listPages, openTab, resolveTarget, describe };
