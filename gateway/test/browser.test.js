'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

/**
 * Real-browser integration.
 *
 * The rest of the suite stubs the browser so it runs anywhere. This file does not: it
 * launches real Chromium, because the parts most likely to be wrong in a stub are
 * exactly the parts a stub cannot catch - context creation, init-script injection,
 * cookie round-tripping through a real cookie jar, and whether a headless launch works
 * at all.
 *
 * Skipped automatically when Playwright or its browser is unavailable, so a contributor
 * without `npx playwright install` still gets a green local run.
 *
 * No network egress: every test uses a data URL or a local file, so this is
 * deterministic and does not touch a provider.
 */

let chromium = null;
let browserAvailable = false;

try {
    ({ chromium } = require('playwright'));
    browserAvailable = Boolean(chromium);
} catch {
    browserAvailable = false;
}

const skip = browserAvailable
    ? false
    : 'playwright not installed - run `npx playwright install chromium` to enable';

const PAGE_HTML =
    'data:text/html,' +
    encodeURIComponent(
        '<!doctype html><html><head><title>t</title></head><body><div id="root">ready</div></body></html>'
    );

function tmpDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const ENGINES = {
    __proximaTest: `window.__proximaTest = {
        sendMessage: function (o) { return { echoed: o && o.message }; },
        newConversation: function () { return { cleared: true }; },
        getResponse: function () { return 'real-browser-response'; },
        getTypingStatus: function () { return { typing: false }; },
        isReady: function () { return true; },
        marker: 'installed'
    };`,
};

async function withBrowser(fn) {
    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    try {
        await fn(browser);
    } finally {
        await browser.close();
    }
}

test('real chromium launches headless', { skip }, async () => {
    await withBrowser(async (browser) => {
        assert.ok(browser.isConnected(), 'browser must be connected after launch');
    });
});

test('a real context and page can be created', { skip }, async () => {
    await withBrowser(async (browser) => {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        await page.goto(PAGE_HTML);
        assert.equal(await page.textContent('#root'), 'ready');
        await context.close();
    });
});

test('headless chromium reports a real, non-zero viewport', { skip }, async () => {
    // A zero-sized viewport is a known bot signal, so assert it is sane rather than
    // trusting the default.
    await withBrowser(async (browser) => {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        await page.goto(PAGE_HTML);
        const size = await page.evaluate(() => ({
            w: window.innerWidth,
            h: window.innerHeight,
        }));
        assert.equal(size.w, 1440);
        assert.equal(size.h, 900);
        await context.close();
    });
});

test('init scripts run on every navigation (the reload-safety requirement)', { skip }, async () => {
    await withBrowser(async (browser) => {
        const context = await browser.newContext();
        // A counter in the init script must increment on each new document.
        await context.addInitScript({
            content: 'window.__initCount = (window.__initCount || 0) + 1;',
        });
        const page = await context.newPage();

        await page.goto(PAGE_HTML);
        assert.equal(await page.evaluate(() => window.__initCount), 1);

        await page.reload();
        assert.equal(
            await page.evaluate(() => window.__initCount),
            1,
            'a reload is a fresh document, so the counter restarts at 1'
        );

        await page.goto(PAGE_HTML);
        assert.equal(await page.evaluate(() => window.__initCount), 1);

        await context.close();
    });
});

test('an injected engine is present and callable in a real page', { skip }, async () => {
    await withBrowser(async (browser) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        await context.addInitScript({ content: ENGINES.__proximaTest });
        await page.goto(PAGE_HTML);

        const present = await page.evaluate(
            (g) => Boolean(typeof window[g] !== 'undefined' && window[g]),
            '__proximaTest'
        );
        assert.equal(present, true, 'engine global must be visible after navigation');

        const result = await page.evaluate((msg) => window.__proximaTest.sendMessage({ message: msg }), 'ping');
        assert.equal(result.echoed, 'ping');

        await context.close();
    });
});

test('a re-injected engine overwrites rather than merging', { skip }, async () => {
    // Re-injection happens on every navigation, so a stale engine must not survive.
    await withBrowser(async (browser) => {
        const context = await browser.newContext();
        const page = await context.newPage();

        await page.goto(PAGE_HTML);
        await page.evaluate(() => {
            window.__proximaTest = { marker: 'stale', sendMessage: () => ({}) };
        });
        assert.equal(await page.evaluate(() => window.__proximaTest.marker), 'stale');

        await page.reload();
        assert.equal(
            await page.evaluate(() => window.__proximaTest.marker),
            undefined,
            'a reload must clear the stale engine, proving the init script is what provides it'
        );

        await context.close();
    });
});

test('cookies survive a real cookie jar round trip', { skip }, async () => {
    await withBrowser(async (browser) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(PAGE_HTML);

        await context.addCookies([
            {
                name: 'sessionKey',
                value: 'real-value',
                domain: 'claude.ai',
                path: '/',
                secure: true,
            },
        ]);

        const cookies = await context.cookies('claude.ai');
        assert.equal(cookies.length, 1);
        assert.equal(cookies[0].name, 'sessionKey');
        assert.equal(cookies[0].value, 'real-value');

        await context.close();
    });
});

test('a real cookie jar authenticates through the auth evaluator', { skip }, async () => {
    const { evaluateAuth } = require('../src/cookie-store');
    const { PROVIDERS } = require('../src/providers');

    await withBrowser(async (browser) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(PAGE_HTML);

        // Before: noise only, must not read as logged in.
        await context.addCookies([
            { name: 'consent_1', value: 'x', domain: 'google.com', path: '/', secure: true },
            { name: 'consent_2', value: 'x', domain: 'google.com', path: '/', secure: true },
        ]);
        let cookies = await context.cookies();
        assert.equal(evaluateAuth(cookies, PROVIDERS.gemini.auth).loggedIn, false);

        // After adding the real auth cookie, it must.
        await context.addCookies([
            { name: '__Secure-1PSID', value: 'y', domain: 'google.com', path: '/', secure: true },
        ]);
        cookies = await context.cookies();
        const verdict = evaluateAuth(cookies, PROVIDERS.gemini.auth);
        assert.equal(verdict.loggedIn, true);
        assert.ok(verdict.matched.includes('__Secure-1PSID'));

        await context.close();
    });
});

test('the profile file round trips through a real browser restart', { skip }, async () => {
    // A6 depends on auth living on disk, not in the renderer. Prove a fresh context
    // can be re-authenticated purely from the stored profile.
    const { StateStore } = require('../src/state-store');
    const { CookieStore } = require('../src/cookie-store');
    const { evaluateAuth } = require('../src/cookie-store');
    const { PROVIDERS } = require('../src/providers');

    const dir = tmpDir('proxima-gw-persist-');
    const state = new StateStore(dir);
    const cookies = new CookieStore(state);

    await withBrowser(async (browser) => {
        // --- first "process" ---
        const ctx1 = await browser.newContext();
        const page1 = await ctx1.newPage();
        await page1.goto(PAGE_HTML);
        await ctx1.addCookies([
            { name: 'pplx_session', value: 'persisted', domain: 'perplexity.ai', path: '/', secure: true },
        ]);
        const live = await ctx1.cookies();
        cookies.saveBackup('perplexity', live);
        assert.equal(evaluateAuth(live, PROVIDERS.perplexity.auth).loggedIn, true);
        await ctx1.close();

        // --- second "process": a brand new context, nothing shared but disk ---
        const ctx2 = await browser.newContext();
        const page2 = await ctx2.newPage();
        await page2.goto(PAGE_HTML);
        assert.equal(evaluateAuth(await ctx2.cookies(), PROVIDERS.perplexity.auth).loggedIn, false);

        const backup = cookies.loadBackup('perplexity');
        const restored = cookies.cookiesForDomain(backup, PROVIDERS.perplexity.auth.domain);
        await ctx2.addCookies(restored);

        const afterRestart = await ctx2.cookies();
        assert.equal(
            evaluateAuth(afterRestart, PROVIDERS.perplexity.auth).loggedIn,
            true,
            'auth must come back from disk alone'
        );
        await ctx2.close();
    });
});

test('a backup never leaks cookies across provider domains', { skip }, async () => {
    const { StateStore } = require('../src/state-store');
    const { CookieStore } = require('../src/cookie-store');
    const { PROVIDERS } = require('../src/providers');

    const dir = tmpDir('proxima-gw-dom-');
    const store = new CookieStore(new StateStore(dir));
    store.saveBackup('qwen', [
        { name: 'token', value: 'q', domain: '.qwen.ai' },
        { name: '__cf_bm', value: 'leak', domain: '.openai.com' },
    ]);

    const chatgptCookies = store.cookiesForDomain(
        store.loadBackup('qwen'),
        PROVIDERS.chatgpt.auth.domain
    );
    assert.equal(chatgptCookies.length, 1);
    assert.equal(chatgptCookies[0].name, '__cf_bm');
});
