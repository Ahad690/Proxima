// Proxima — BrowserView manager (sessions, compatibility, auth popups)

const { BrowserView, BrowserWindow, session, shell } = require('electron');
const path = require('path');

class BrowserManager {
    constructor(mainWindow) {
        this.mainWindow = mainWindow;
        this.views = new Map();
        this.activeProvider = null;
        this.isDestroyed = false;
        this.authPopups = new Map();
        // Views whose renderer has been killed to reclaim memory. Kept only so
        // teardown can close them; nothing reads from here.
        this.orphans = [];

        // Provider configurations
        this.providers = {
            perplexity: {
                url: 'https://www.perplexity.ai/',
                partition: 'persist:perplexity',
                color: '#20b2aa'
            },
            chatgpt: {
                url: 'https://chatgpt.com/',
                partition: 'persist:chatgpt',
                color: '#10a37f'
            },
            claude: {
                url: 'https://claude.ai/',
                partition: 'persist:claude',
                color: '#cc785c'
            },
            gemini: {
                url: 'https://gemini.google.com/app',
                partition: 'persist:gemini',
                color: '#4285f4'
            },
            qwen: {
                url: 'https://chat.qwen.ai/',
                partition: 'persist:qwen',
                color: '#615ced'
            }
        };

        // Must match Electron 33's bundled Chromium version for compatibility
        this.chromeVersion = '130.0.6723.191';
        this.userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${this.chromeVersion} Safari/537.36`;
    }

    /** Browser compatibility script — ensures proper Chrome environment */
    getStealthScript() {
        return `
            (function() {
                'use strict';
                try {

                    Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });

                    // 'global' and 'Buffer' excluded — sandbox:true handles them, and
                    // defineProperty traps break polyfills (e.g. Claude's Buffer.isBuffer)
                    const electronGlobals = ['process', 'require', 'module', '__filename', '__dirname'];
                    electronGlobals.forEach(g => {
                        try { delete window[g]; } catch(e) {}
                        try { Object.defineProperty(window, g, { get: () => undefined, configurable: true }); } catch(e) {}
                    });


                    if (!window.chrome) window.chrome = {};
                    if (!window.chrome.runtime) {
                        window.chrome.runtime = {
                            OnInstalledReason: {},
                            OnRestartRequiredReason: {},
                            PlatformArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
                            PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
                            PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
                            RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' },
                            connect: function() { throw new Error('Could not establish connection. Receiving end does not exist.'); },
                            sendMessage: function() { throw new Error('Could not establish connection. Receiving end does not exist.'); },
                            id: undefined
                        };
                    }
                    if (!window.chrome.app) window.chrome.app = { isInstalled: false, InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }, RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' } };
                    if (!window.chrome.csi) window.chrome.csi = function() { return { pageT: performance.now(), startE: Date.now(), onloadT: Date.now() }; };
                    if (!window.chrome.loadTimes) window.chrome.loadTimes = function() { return { commitLoadTime: Date.now()/1000, connectionInfo: 'h2', finishDocumentLoadTime: Date.now()/1000, finishLoadTime: Date.now()/1000, firstPaintAfterLoadTime: 0, firstPaintTime: Date.now()/1000, navigationType: 'Other', npnNegotiatedProtocol: 'h2', requestTime: Date.now()/1000, startLoadTime: Date.now()/1000, wasAlternateProtocolAvailable: false, wasFetchedViaSpdy: true, wasNpnNegotiated: true }; };


                    const navProps = {
                        platform: 'Win32',
                        vendor: 'Google Inc.',
                        languages: ['en-US', 'en'],
                        hardwareConcurrency: navigator.hardwareConcurrency || 8,
                        deviceMemory: 8,
                        maxTouchPoints: 0,
                    };
                    Object.entries(navProps).forEach(([key, val]) => {
                        try { Object.defineProperty(navigator, key, { get: () => val, configurable: true }); } catch(e) {}
                    });


                    try {
                        Object.defineProperty(navigator, 'plugins', {
                            get: () => {
                                const arr = [
                                    { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
                                    { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
                                    { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
                                ];
                                arr.item = (i) => arr[i];
                                arr.namedItem = (name) => arr.find(p => p.name === name);
                                arr.refresh = () => {};
                                return arr;
                            },
                            configurable: true
                        });
                    } catch(e) {}


                    try {
                        const brands = [
                            { brand: "Chromium", version: "130" },
                            { brand: "Google Chrome", version: "130" },
                            { brand: "Not?A_Brand", version: "99" }
                        ];
                        const uad = {
                            brands,
                            mobile: false,
                            platform: "Windows",
                            getHighEntropyValues: (hints) => Promise.resolve({
                                brands,
                                mobile: false,
                                platform: "Windows",
                                platformVersion: "15.0.0",
                                architecture: "x86",
                                bitness: "64",
                                model: "",
                                uaFullVersion: "130.0.6723.191",
                                fullVersionList: [
                                    { brand: "Chromium", version: "130.0.6723.191" },
                                    { brand: "Google Chrome", version: "130.0.6723.191" },
                                    { brand: "Not?A_Brand", version: "99.0.0.0" }
                                ],
                                wow64: false
                            }),
                            toJSON: function() { return { brands, mobile: false, platform: "Windows" }; }
                        };
                        Object.defineProperty(navigator, 'userAgentData', { get: () => uad, configurable: true });
                    } catch(e) {}


                    try {
                        const origQuery = window.Permissions.prototype.query;
                        window.Permissions.prototype.query = function(params) {
                            if (params && params.name === 'notifications') {
                                return Promise.resolve({ state: Notification.permission });
                            }
                            return origQuery.call(this, params);
                        };
                    } catch(e) {}


                    try {
                        const getParam = WebGLRenderingContext.prototype.getParameter;
                        WebGLRenderingContext.prototype.getParameter = function(param) {
                            if (param === 37445) return 'Google Inc. (NVIDIA)';
                            if (param === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)';
                            return getParam.call(this, param);
                        };
                        const getParam2 = WebGL2RenderingContext.prototype.getParameter;
                        WebGL2RenderingContext.prototype.getParameter = function(param) {
                            if (param === 37445) return 'Google Inc. (NVIDIA)';
                            if (param === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)';
                            return getParam2.call(this, param);
                        };
                    } catch(e) {}


                    try {
                        const origContentWindow = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
                        Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
                            get: function() {
                                const win = origContentWindow.get.call(this);
                                if (win) {
                                    try {
                                        Object.defineProperty(win, 'chrome', { get: () => window.chrome, configurable: true });
                                    } catch(e) {}
                                }
                                return win;
                            }
                        });
                    } catch(e) {}

                    // ─── Cloudflare Turnstile compatibility ──────────────
                    // Cloudflare checks these to detect headless/embedded browsers.
                    // BrowserView can report wrong values, causing CAPTCHA loops.

                    // 1. Screen properties must be consistent and realistic
                    try {
                        const screenProps = {
                            colorDepth: 24,
                            pixelDepth: 24,
                            availWidth: screen.availWidth || 1920,
                            availHeight: screen.availHeight || 1040,
                            width: screen.width || 1920,
                            height: screen.height || 1080,
                        };
                        Object.entries(screenProps).forEach(([key, val]) => {
                            try { Object.defineProperty(screen, key, { get: () => val, configurable: true }); } catch(e) {}
                        });
                    } catch(e) {}

                    // 2. outerWidth/outerHeight — BrowserView often reports 0 (major Cloudflare red flag)
                    try {
                        if (!window.outerWidth || window.outerWidth === 0) {
                            Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth || 1920, configurable: true });
                        }
                        if (!window.outerHeight || window.outerHeight === 0) {
                            Object.defineProperty(window, 'outerHeight', { get: () => (window.innerHeight || 1040) + 85, configurable: true });
                        }
                    } catch(e) {}

                    // 3. Notification constructor must be proper (Cloudflare probes this)
                    try {
                        if (typeof Notification !== 'undefined') {
                            const OrigNotification = Notification;
                            if (!OrigNotification.requestPermission) {
                                OrigNotification.requestPermission = function(cb) {
                                    const p = Promise.resolve('default');
                                    if (cb) p.then(cb);
                                    return p;
                                };
                            }
                        }
                    } catch(e) {}

                    console.log('[Compat] v4.1 active');
                } catch(e) {
                    console.log('[Compat] Error:', e.message);
                }
            })();
        `;
    }

    /** Setup session with proper Chrome headers */
    setupSession(provider) {
        const config = this.providers[provider];
        const ses = session.fromPartition(config.partition, { cache: true });
        ses.setUserAgent(this.userAgent);

        // Set Chrome client hints headers
        ses.webRequest.onBeforeSendHeaders((details, callback) => {
            const headers = { ...details.requestHeaders };


            headers['sec-ch-ua'] = `"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"`;
            headers['sec-ch-ua-mobile'] = '?0';
            headers['sec-ch-ua-platform'] = '"Windows"';
            headers['sec-ch-ua-platform-version'] = '"15.0.0"';
            headers['sec-ch-ua-full-version-list'] = `"Chromium";v="130.0.6723.191", "Google Chrome";v="130.0.6723.191", "Not?A_Brand";v="99.0.0.0"`;
            headers['sec-ch-ua-arch'] = '"x86"';
            headers['sec-ch-ua-bitness'] = '"64"';
            headers['sec-ch-ua-wow64'] = '?0';
            headers['sec-ch-ua-model'] = '""';


            delete headers['X-Electron-Version'];

            callback({ requestHeaders: headers });
        });

        // Google uses Accept-CH to negotiate high-entropy hints
        ses.webRequest.onHeadersReceived((details, callback) => {
            if (details.url.includes('google.com') || details.url.includes('gstatic.com') || details.url.includes('googleapis.com')) {
                const headers = { ...details.responseHeaders };

                delete headers['accept-ch'];
                delete headers['Accept-CH'];
                delete headers['Accept-Ch'];

                delete headers['permissions-policy'];
                delete headers['Permissions-Policy'];
                callback({ responseHeaders: headers });
            } else {
                callback({});
            }
        });

        return ses;
    }

    /** Create and configure a BrowserView for a provider */
    createView(provider) {
        if (this.isDestroyed) return null;

        if (this.views.has(provider)) {
            return this.views.get(provider);
        }

        const config = this.providers[provider];
        if (!config) {
            throw new Error(`Unknown provider: ${provider}`);
        }

        const ses = this.setupSession(provider);

        const view = new BrowserView({
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                session: ses,
                webSecurity: true,
                sandbox: true,
                allowRunningInsecureContent: false,
                javascript: true,
                images: true,
                webgl: true,
                backgroundThrottling: false,
            }
        });

        this.views.set(provider, view);


        view.webContents.on('dom-ready', () => {
            if (view.webContents.isDestroyed()) return;
            view.webContents.executeJavaScript(this.getStealthScript()).catch(() => { });
        });


        view.webContents.on('did-navigate', (event, url) => {
            console.log(`[${provider}] Navigated to:`, url.substring(0, 80));
            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                this.mainWindow.webContents.send('provider-navigated', { provider, url });
            }
        });

        view.webContents.on('did-navigate-in-page', (event, url) => {
            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                this.mainWindow.webContents.send('provider-navigated', { provider, url });
            }
        });

        // Google OAuth uses popup windows
        view.webContents.setWindowOpenHandler(({ url, frameName, features }) => {
            console.log(`[${provider}] Popup requested:`, url.substring(0, 80));


            if (url.includes('accounts.google.com') ||
                url.includes('accounts.youtube.com') ||
                url.includes('appleid.apple.com') ||
                url.includes('login.microsoftonline.com') ||
                url.includes('login.live.com') ||
                url.includes('github.com/login') ||
                url.includes('auth0.com')) {

                this.openAuthPopup(provider, url);
                return { action: 'deny' };
            }


            return {
                action: 'allow',
                overrideBrowserWindowOptions: {
                    width: 600,
                    height: 700,
                    webPreferences: {
                        session: ses,
                        sandbox: true,
                        contextIsolation: true,
                        nodeIntegration: false,
                    }
                }
            };
        });


        view.webContents.on('console-message', (event, level, message) => {
            if (level >= 2) {
                // Our own [Proxima] diagnostics carry JSON samples of undocumented
                // response frames; truncating them at 100 chars throws away the exact
                // thing they exist to show. Page noise stays capped.
                const limit = message.indexOf('[Proxima]') === 0 ? 4000 : 100;
                console.log(`[${provider}] Console:`, message.substring(0, limit));
            }
        });


        view.webContents.on('did-finish-load', () => {
            console.log(`[${provider}] Page loaded`);
            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                this.mainWindow.webContents.send('provider-loaded', { provider });
            }
        });


        view.webContents.loadURL(config.url);

        return view;
    }

    /** Auth popup — standalone window for OAuth providers */
    openAuthPopup(provider, url) {
        const config = this.providers[provider];
        const ses = session.fromPartition(config.partition, { cache: true });
        ses.setUserAgent(this.userAgent);

        // Standalone window (not child/modal) for clean auth flow
        const authWindow = new BrowserWindow({
            width: 500,
            height: 700,
            show: true,
            title: 'Sign in',
            autoHideMenuBar: true,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                session: ses,
                sandbox: true,
                webSecurity: true,
            }
        });

        this.authPopups.set(provider, authWindow);


        authWindow.webContents.on('dom-ready', () => {
            if (!authWindow.isDestroyed()) {
                authWindow.webContents.executeJavaScript(this.getStealthScript()).catch(() => { });
            }
        });



        authWindow.loadURL(url);

        // Close popup when user lands back on the provider domain
        authWindow.webContents.on('did-navigate', (event, navUrl) => {
            console.log(`[Auth ${provider}] Navigated to:`, navUrl.substring(0, 80));

            const providerDomains = {
                perplexity: 'perplexity.ai',
                chatgpt: 'chatgpt.com',
                claude: 'claude.ai',
                gemini: 'gemini.google.com'
            };

            const domain = providerDomains[provider];
            if (domain && navUrl.includes(domain)) {
                console.log(`[Auth ${provider}] Auth complete! Closing popup and reloading.`);
                setTimeout(() => {
                    if (!authWindow.isDestroyed()) {
                        authWindow.close();
                    }
                }, 1500);
            }
        });

        authWindow.on('closed', () => {
            console.log(`[${provider}] Auth popup closed`);
            this.authPopups.delete(provider);


            const view = this.views.get(provider);
            if (view && !view.webContents.isDestroyed()) {
                console.log(`[${provider}] Reloading after auth...`);
                view.webContents.reload();
            }
        });
    }

    // ─── Memory: unload and reload providers on demand ───
    // Each provider is a full Chromium renderer running that vendor's React app, and they
    // are not cheap: measured JS heaps of qwen 84MB, chatgpt 75MB, claude 71MB,
    // perplexity 38MB, with process RSS running to roughly twice the heap once DOM,
    // layout, compositor and the V8 baseline are counted. Four providers plus the app's
    // own window came to ~583MB of renderer RSS.
    //
    // Hiding the window does NOT reclaim any of that — a hidden BrowserView keeps its
    // renderer. The only way to get the memory back is to destroy the renderer.
    //
    // What makes that safe is the session partition. Auth lives in `persist:<provider>`
    // on disk, not in the view, so destroying a view does not log anyone out: the OAuth
    // dance is a one-time cost and the cookies outlive the renderer. Unload a provider you
    // are not using, and the next call to it transparently loads it again.

    /**
     * Destroy a provider's renderer, keeping its cookies. Returns a small report.
     *
     * The first version of this called `webContents.close()` and freed exactly nothing:
     * measured 362MB before and 362MB after, with the process count unchanged at 6. The
     * reason is in the API — Electron 33's WebContents has no public `destroy()`, and
     * `close()` is documented as behaving "as if the web content had called
     * window.close()", which for a BrowserView with no window semantics is a no-op. Worse,
     * the map entry was deleted anyway, so the renderer was orphaned and still resident:
     * a leak dressed as a saving.
     *
     * What actually reclaims the memory, in this order:
     *   1. navigate to about:blank — deterministically drops the site's JS heap and DOM,
     *      and is the part that works even if step 3 is ever restricted.
     *   2. detach from the window, so nothing holds it for layout.
     *   3. forcefullyCrashRenderer() — the only call in this version that ends the
     *      renderer PROCESS.
     * The webContents object survives step 3 as a husk, so it is kept in `orphans` and
     * closed at teardown rather than left for the GC to worry about.
     */
    async unloadProvider(provider) {
        const view = this.views.get(provider);
        if (!view) return { provider, unloaded: false, reason: 'not resident' };
        const wc = view.webContents;
        const steps = [];

        // 1. Drop the page. This is the reliable half of the saving.
        try {
            if (wc && !wc.isDestroyed()) {
                await Promise.race([
                    wc.loadURL('about:blank'),
                    new Promise((r) => setTimeout(r, 5000))
                ]);
                steps.push('blanked');
            }
        } catch (e) { steps.push('blank-failed:' + e.message); }

        // 2. Detach from the window.
        try {
            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                this.mainWindow.removeBrowserView(view);
                steps.push('detached');
            }
        } catch (e) { steps.push('detach-failed:' + e.message); }

        // 3. End the renderer process. Providers sit in separate `persist:` partitions,
        // so they are separate site instances and this does not take another provider
        // down with it — but that is an assumption worth re-checking if process counts
        // ever move by more than one per unload.
        try {
            if (wc && !wc.isDestroyed()) {
                wc.forcefullyCrashRenderer();
                steps.push('renderer-killed');
            }
        } catch (e) { steps.push('kill-failed:' + e.message); }

        this.views.delete(provider);
        this.orphans.push(view);
        if (this.activeProvider === provider) this.activeProvider = null;
        const cfg = this.providers[provider];
        console.log(`[${provider}] unloaded (${steps.join(', ')}) — cookies kept in ` +
            (cfg ? cfg.partition : 'its partition'));
        return { provider, unloaded: true, steps };
    }

    /**
     * Guarantee a provider is live and its app is loaded, creating it if it was never
     * started or has been unloaded. Safe to call on every request: it is a no-op when the
     * view is already up, so the cost falls only on the first call after an unload.
     */
    async ensureProvider(provider) {
        if (this.isDestroyed) return null;
        const config = this.providers[provider];
        if (!config) throw new Error(`Unknown provider: ${provider}`);

        let wc = this.getWebContents(provider);
        if (wc) return wc;

        console.log(`[${provider}] not resident — loading ${config.url}`);
        const view = this.createView(provider);
        if (!view) return null;
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            // Attached but parked off-screen: a BrowserView must belong to a window to
            // run at all, and the app positions views itself when one is shown.
            try {
                this.mainWindow.addBrowserView(view);
                view.setBounds({ x: -20000, y: 0, width: 1200, height: 800 });
            } catch (e) { /* bounds are cosmetic here */ }
        }
        wc = this.getWebContents(provider);
        if (!wc) return null;

        await wc.loadURL(config.url);
        // Wait for the app to actually boot, not merely for the document. Qwen in
        // particular needs its anti-bot SDK initialised before any signed request, and
        // returning too early would hand back a renderer that fails its first call.
        await new Promise((resolve) => {
            if (wc.isDestroyed()) return resolve();
            if (!wc.isLoading()) return resolve();
            const done = () => resolve();
            wc.once('did-finish-load', done);
            wc.once('did-fail-load', done);
            setTimeout(done, 30000);
        });
        return wc.isDestroyed() ? null : wc;
    }

    /**
     * Ask an idle renderer to hand back what it can without being destroyed. Uses the CDP
     * Memory domain, the only route to a real heap purge from the main process — a plain GC
     * hint is not exposed here. Non-destructive: no reload, no navigation, no lost auth.
     *
     * EVERY step is timed out individually, and the outcome of each is returned to the
     * caller rather than only logged. The first version of this wrapped the CDP calls in
     * try/catch and awaited them bare; it hung for every provider, and because the failure
     * was invisible from outside the process there was nothing to diagnose but a stopwatch.
     * An IPC action that can block forever is a liability in an unattended system, and one
     * that fails without saying where is worse than one that fails loudly.
     */
    async purgeProvider(provider) {
        const wc = this.getWebContents(provider);
        if (!wc) return { provider, skipped: 'not resident' };

        const steps = [];
        const step = async (label, ms, fn) => {
            const t = Date.now();
            try {
                const v = await Promise.race([
                    Promise.resolve().then(fn),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), ms))
                ]);
                steps.push(label + ' ok ' + (Date.now() - t) + 'ms');
                return v;
            } catch (e) {
                steps.push(label + ' FAILED (' + e.message + ') ' + (Date.now() - t) + 'ms');
                return null;
            }
        };

        const heap = () => wc.isDestroyed() ? 0 : wc.executeJavaScript(
            '(performance.memory && performance.memory.usedJSHeapSize) || 0', true);

        const before = (await step('read-heap-before', 5000, heap)) || 0;

        const wasAttached = await step('is-attached', 2000,
            () => wc.debugger.isAttached());
        if (wasAttached === false) {
            await step('attach', 5000, () => { wc.debugger.attach('1.3'); return true; });
        }
        await step('collectGarbage', 8000,
            () => wc.debugger.sendCommand('HeapProfiler.collectGarbage'));
        await step('forciblyPurge', 8000,
            () => wc.debugger.sendCommand('Memory.forciblyPurgeJavaScriptMemory'));
        // Detach UNCONDITIONALLY. The first version detached inside a `finally` after
        // bare awaits; when the CDP call hung, the finally never ran and the debugger was
        // left attached to all four renderers, which wedged them — every provider went
        // unresponsive to executeJavaScript and the app had to be restarted. A detach on a
        // webContents that is not attached simply throws, and the step swallows it, so
        // attempting it always is strictly safer than deciding whether to.
        await step('detach', 2000, () => { wc.debugger.detach(); return true; });

        const after = (await step('read-heap-after', 5000, heap)) || 0;
        return { provider, before, after, freed: Math.max(0, before - after), steps };
    }

    /** Show provider BrowserView */
    showProvider(provider, bounds) {
        if (this.isDestroyed || !this.mainWindow || this.mainWindow.isDestroyed()) return null;

        if (!this.views.has(provider)) {
            this.createView(provider);
        }

        const view = this.views.get(provider);
        if (!view || view.webContents.isDestroyed()) return null;

        try {
            // Move non-active views off-screen, bring active one to front
            for (const [p, v] of this.views) {
                if (!v.webContents.isDestroyed()) {
                    const existingViews = this.mainWindow.getBrowserViews();
                    if (!existingViews.includes(v)) {
                        this.mainWindow.addBrowserView(v);
                    }

                    if (p === provider) {
                        v.setBounds(bounds);
                    } else {
                        v.setBounds({ x: -10000, y: 0, width: bounds.width, height: bounds.height });
                    }
                }
            }


            this.mainWindow.removeBrowserView(view);
            this.mainWindow.addBrowserView(view);
            view.setBounds(bounds);
            view.setAutoResize({ width: true, height: true });

            this.activeProvider = provider;
        } catch (e) {
            console.log('Could not show view:', e.message);
        }

        return view;
    }

    hideCurrentView() {
        if (this.isDestroyed) return;

        if (this.activeProvider) {
            const view = this.views.get(this.activeProvider);
            if (view && !view.webContents.isDestroyed() && this.mainWindow && !this.mainWindow.isDestroyed()) {
                try {
                    this.mainWindow.removeBrowserView(view);
                } catch (e) {
                    console.log('Could not hide view:', e.message);
                }
            }
            this.activeProvider = null;
        }
    }

    getWebContents(provider) {
        const view = this.views.get(provider);
        if (!view || view.webContents.isDestroyed()) return null;
        return view.webContents;
    }

    async executeScript(provider, script) {
        // Loads the provider if it has been unloaded to save memory. Without this,
        // unloading anything would turn every later call into "not initialized".
        const webContents = await this.ensureProvider(provider);
        if (!webContents) throw new Error(`Provider ${provider} could not be loaded`);
        return await webContents.executeJavaScript(script);
    }

    async navigate(provider, url) {
        const webContents = this.getWebContents(provider);
        if (!webContents) {
            this.createView(provider);
            const newWebContents = this.getWebContents(provider);
            if (newWebContents) await newWebContents.loadURL(url);
            return;
        }
        await webContents.loadURL(url);
    }

    async reload(provider) {
        const webContents = this.getWebContents(provider);
        if (webContents) await webContents.reload();
    }

    async isLoggedIn(provider) {
        // MUST load the provider rather than answer from whether it happens to be
        // resident. Returning false for an unloaded provider conflates "no renderer" with
        // "not authenticated", and those have opposite remedies: one needs a page load,
        // the other needs the user to sign in. Measured before this fix: unload chatgpt,
        // ask isLoggedIn, get `false` back in 0.0s on an account that was perfectly
        // logged in — an orchestrator acting on that would start a pointless OAuth flow.
        //
        // Cheap enough to be correct: this is called by the MCP layer and the settings UI,
        // never inside a send loop, and the cookies it checks against survive in the
        // persist: partition regardless.
        const webContents = await this.ensureProvider(provider);
        if (!webContents) return false;

        try {
            switch (provider) {
                case 'perplexity':
                    return await webContents.executeJavaScript(`
                        (function() {
                            const buttons = Array.from(document.querySelectorAll('button, a'));
                            const hasLoginBtn = buttons.some(b => b.innerText === 'Log in' || b.innerText === 'Sign Up');
                            if (hasLoginBtn) return false;
                            const hasInput = !!document.querySelector('textarea') || !!document.querySelector('[contenteditable="true"]');
                            return !hasLoginBtn && hasInput;
                        })()
                    `);
                case 'chatgpt':
                    return await webContents.executeJavaScript(`
                        (function() {
                            const hasInput = !!document.querySelector('#prompt-textarea');
                            const hasLoginModal = !!document.querySelector('[data-testid="login-button"]');
                            return hasInput && !hasLoginModal;
                        })()
                    `);
                case 'claude':
                    return await webContents.executeJavaScript(`
                        (function() {
                            const hasInput = !!document.querySelector('[contenteditable="true"]');
                            const hasLoginPage = window.location.href.includes('/login');
                            return hasInput && !hasLoginPage;
                        })()
                    `);
                case 'gemini':
                    return await webContents.executeJavaScript(`
                        (function() {
                            const hasInput = !!document.querySelector('.ql-editor') ||
                                           !!document.querySelector('[contenteditable="true"]') ||
                                           !!document.querySelector('rich-textarea');
                            const hasSignIn = !!document.querySelector('a[href*="ServiceLogin"]') ||
                                            !!document.querySelector('a[data-action-id="sign-in"]');
                            return hasInput && !hasSignIn;
                        })()
                    `);
                case 'qwen':
                    // Qwen has no usable negative signal on the network side: this API
                    // answers 200 for everything, so a logged-out session looks exactly
                    // like a WAF block (see providers/qwen-engine.js classifyFailure).
                    // That rules out probing an endpoint to decide, so this is a DOM +
                    // localStorage check like the other four. Without a qwen case here
                    // the switch fell through to `default: return false`, so Qwen
                    // reported logged-out permanently even with a live session.
                    return await webContents.executeJavaScript(`
                        (function() {
                            const hasInput = !!document.querySelector('textarea') ||
                                           !!document.querySelector('[contenteditable="true"]');
                            const buttons = Array.from(document.querySelectorAll('button, a'))
                                .map(b => (b.innerText || '').trim());
                            const hasLoginBtn = buttons.some(t =>
                                /^(log ?in|sign ?in|sign ?up)$/i.test(t));
                            // The JWT in localStorage is not what authenticates requests
                            // (the httpOnly cookie is), but it only appears once the page
                            // has completed a login, so it is a useful extra signal.
                            let hasToken = false;
                            try { hasToken = !!localStorage.getItem('token'); } catch (e) {}
                            return hasInput && !hasLoginBtn && hasToken;
                        })()
                    `);
                default:
                    return false;
            }
        } catch (e) {
            return false;
        }
    }

    openGoogleSignIn(provider) {

        this.openAuthPopup(provider, 'https://accounts.google.com/ServiceLogin?continue=' + encodeURIComponent(this.providers[provider]?.url || 'https://google.com'));
    }

    getInitializedProviders() {
        return Array.from(this.views.keys());
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    destroy() {
        if (this.isDestroyed) return;
        this.isDestroyed = true;


        for (const [provider, popup] of this.authPopups) {
            try { if (!popup.isDestroyed()) popup.close(); } catch (e) { }
        }
        this.authPopups.clear();


        for (const view of this.orphans) {
            try { if (!view.webContents.isDestroyed()) view.webContents.close(); } catch (e) { }
        }
        this.orphans = [];

        for (const [provider, view] of this.views) {
            try {
                if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                    this.mainWindow.removeBrowserView(view);
                }
            } catch (e) { }
        }


        for (const [provider, view] of this.views) {
            try {
                if (!view.webContents.isDestroyed()) view.webContents.destroy();
            } catch (e) { }
        }

        this.views.clear();
        this.activeProvider = null;
    }
}

module.exports = BrowserManager;
