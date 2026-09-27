'use strict';

const fs = require('fs');
const path = require('path');
const { getProvider } = require('./providers');

/**
 * Engine injection.
 *
 * The gateway holds no provider API knowledge. An engine is a JS file that runs in the
 * page's own origin context and exposes a documented global. All provider protocol
 * knowledge lives in the engine, which is why an engine can be rewritten without
 * touching the gateway.
 *
 * Engines are injected BEFORE first navigation and RE-INJECTED after every navigation:
 * a reload tears down page globals, and a capture request that navigates will lose them.
 */

const ENGINE_DIR = path.join(__dirname, '..', 'engines');

class EngineError extends Error {
    constructor(message, provider, detail = {}) {
        super(message);
        this.name = 'EngineError';
        this.provider = provider;
        this.kind = 'engine';
        Object.assign(this, detail);
    }
}

class TransportError extends Error {
    constructor(message, provider, detail = {}) {
        super(message);
        this.name = 'TransportError';
        this.provider = provider;
        // Distinct from 'engine' so a caller can tell "the browser broke" from
        // "the provider rejected us" (F6).
        this.kind = 'transport';
        Object.assign(this, detail);
    }
}

class EngineLoader {
    constructor({ engineDir = ENGINE_DIR, stateStore = null } = {}) {
        this.engineDir = engineDir;
        this.state = stateStore;
        this._sources = new Map(); // provider -> source string
    }

    enginePath(provider) {
        return path.join(this.engineDir, `${provider}-engine.js`);
    }

    hasEngine(provider) {
        return fs.existsSync(this.enginePath(provider));
    }

    /** Read + cache an engine's source. Throws if the engine is absent. */
    load(provider) {
        if (this._sources.has(provider)) return this._sources.get(provider);
        const file = this.enginePath(provider);
        if (!fs.existsSync(file)) {
            throw new EngineError(
                `No engine installed for provider "${provider}". Expected ${file}`,
                provider,
                { reason: 'engine-missing' }
            );
        }
        const src = fs.readFileSync(file, 'utf8');
        this._sources.set(provider, src);
        return src;
    }

    /**
     * Register the engine so it survives every navigation, and inject it now.
     *
     * addInitScript is the load-bearing call: it re-runs on every document, which is what
     * makes reload-safe operation possible.
     */
    async install(context, page, provider) {
        const spec = getProvider(provider);
        const source = this.load(provider);

        await context.addInitScript({ content: source });

        // Inject into the already-loaded document too, or the first call after a
        // navigation races the init script.
        try {
            await page.evaluate(source);
        } catch (e) {
            // An about:blank or mid-navigation page can refuse evaluation. The init
            // script will still fire on the next document, so this is not fatal.
        }

        // Probe, never assume (F6).
        const present = await this.probe(page, provider);
        if (!present) {
            throw new EngineError(
                `Engine for "${provider}" installed but global ${spec.engineGlobal} is absent. ` +
                    `The engine likely threw during init or the page is not on ${spec.origin}.`,
                provider,
                { reason: 'engine-absent', global: spec.engineGlobal }
            );
        }
        return true;
    }

    /** Is the engine global actually present right now? */
    async probe(page, provider) {
        const spec = getProvider(provider);
        try {
            return await page.evaluate(
                (g) => Boolean(typeof window[g] !== 'undefined' && window[g]),
                spec.engineGlobal
            );
        } catch (e) {
            return false;
        }
    }

    /**
     * Call a method on an engine global, converting absence into a typed error rather
     * than a generic undefined failure.
     */
    async call(page, provider, method, ...args) {
        const spec = getProvider(provider);
        const available = await this.probe(page, provider);
        if (!available) {
            throw new EngineError(
                `Engine for "${provider}" is not loaded (${spec.engineGlobal} absent). ` +
                    `A navigation may have torn it down.`,
                provider,
                { reason: 'engine-absent' }
            );
        }
        return page.evaluate(
            ({ g, m, a }) => {
                const engine = window[g];
                if (!engine || typeof engine[m] !== 'function') {
                    return {
                        __error: `engine method ${g}.${m} is not a function`,
                    };
                }
                return Promise.resolve(engine[m](...a));
            },
            { g: spec.engineGlobal, m: method, a: args }
        );
    }
}

module.exports = { EngineLoader, EngineError, TransportError, ENGINE_DIR };
