/**
 * Proxima — Provider API Manager
 * Loads engine scripts into BrowserViews and provides unified sendViaAPI().
 * Each engine exposes window.__proximaXXX = { send, newConversation }.
 */

const fs = require('fs');
const path = require('path');


const _scripts = {};
// Why the last API send failed, per provider. sendViaAPI returns null on error so the
// caller can fall back to DOM, which throws the reason away — and the reason is
// exactly what a caller needs when the fallback is not safe to take.
const _lastError = {};


function _loadScript(provider) {
    if (_scripts[provider]) return _scripts[provider];

    const scriptMap = {
        chatgpt: 'chatgpt-engine.js',
        claude: 'claude-engine.js',
        gemini: 'gemini-engine.js',
        perplexity: 'perplexity-engine.js',
        qwen: 'qwen-engine.js'
    };

    const filename = scriptMap[provider];
    if (!filename) return null;

    const scriptPath = path.join(__dirname, 'providers', filename);
    try {
        _scripts[provider] = fs.readFileSync(scriptPath, 'utf8');
        console.log(`[ProviderAPI] Loaded ${filename} (${_scripts[provider].length} bytes)`);
        return _scripts[provider];
    } catch (e) {
        console.error(`[ProviderAPI] Failed to load ${filename}:`, e.message);
        return null;
    }
}


function clearScriptCache() {
    Object.keys(_scripts).forEach(k => delete _scripts[k]);
    console.log('[ProviderAPI] Script cache cleared');
}

/** Inject engine script into a BrowserView's webContents */
async function injectAPI(provider, webContents) {
    const script = _loadScript(provider);
    if (!script) {
        console.log(`[ProviderAPI] No API script for ${provider} — will use DOM fallback`);
        return false;
    }

    try {
        await webContents.executeJavaScript(script);
        console.log(`[ProviderAPI] ✔ Injected API for ${provider}`);
        return true;
    } catch (e) {
        console.error(`[ProviderAPI] ✘ Injection failed for ${provider}:`, e.message);
        return false;
    }
}


async function isAPIReady(provider, webContents) {
    const checkMap = {
        chatgpt: 'typeof window.__proximaChatGPT !== "undefined"',
        claude: 'typeof window.__proximaClaude !== "undefined"',
        gemini: 'typeof window.__proximaGemini !== "undefined"',
        perplexity: 'typeof window.__proximaPerplexity !== "undefined"',
        qwen: 'typeof window.__proximaQwen !== "undefined"'
    };

    const check = checkMap[provider];
    if (!check) return false;

    try {
        return await webContents.executeJavaScript(check);
    } catch (e) {
        return false;
    }
}

/** Inject if not already loaded */
async function ensureAPI(provider, webContents) {
    if (await isAPIReady(provider, webContents)) return true;
    return await injectAPI(provider, webContents);
}

/**
 * Send a message via provider engine (no DOM scraping).
 * @param {string} provider
 * @param {object} webContents - Electron webContents
 * @param {string} message
 * @param {object} options - Optional: { modelPreference, etc. }
 * @returns {string|null} Response text, or null if unavailable
 */
async function sendViaAPI(provider, webContents, message, options = {}) {
    // Ensure API is injected
    const ready = await ensureAPI(provider, webContents);
    if (!ready) {
        console.log(`[ProviderAPI] API not available for ${provider} — returning null for DOM fallback`);
        return null;
    }

    const sendMap = {
        chatgpt: '__proximaChatGPT',
        claude: '__proximaClaude',
        gemini: '__proximaGemini',
        perplexity: '__proximaPerplexity',
        qwen: '__proximaQwen'
    };

    const apiObj = sendMap[provider];
    if (!apiObj) return null;

    // Escape message for safe JS injection
    const escapedMessage = JSON.stringify(message);
    const escapedOptions = JSON.stringify(options);

    try {
        console.log(`[ProviderAPI] Sending via ${provider} API...options: ${escapedOptions}`);
        const startTime = Date.now();

        delete _lastError[provider];
        const result = await webContents.executeJavaScript(
            `window.${apiObj}.send(${escapedMessage}, ${escapedOptions})`
        );

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const charCount = typeof result === 'string' ? result.length : 0;
        console.log(`[ProviderAPI] ✔ ${provider} API response: ${charCount} chars in ${elapsed}s`);

        // Preserve empty string responses so caller can decide whether to wait
        // (patient API-first) instead of instantly falling back to DOM.
        if (typeof result === 'string') return result;
        if (result == null) return null;
        return String(result);
    } catch (e) {
        console.error(`[ProviderAPI] ✘ ${provider} API error:`, e.message);
        _lastError[provider] = e.message;
        return null;
    }
}

/** Auto-inject engine on page navigation */
function setupAutoInject(provider, webContents) {
    // Only on did-finish-load — engine scripts have their own duplicate guard
    webContents.on('did-finish-load', async () => {

        const alreadyReady = await isAPIReady(provider, webContents).catch(() => false);
        if (!alreadyReady) {
            await injectAPI(provider, webContents);
        }
    });
}

/** Reset conversation state for one or all providers */
async function resetConversation(provider, webContentsGetter) {
    const resetMap = {
        chatgpt: '__proximaChatGPT',
        claude: '__proximaClaude',
        gemini: '__proximaGemini',
        perplexity: '__proximaPerplexity',
        qwen: '__proximaQwen'
    };

    const providers = provider ? [provider] : ['chatgpt', 'claude', 'gemini', 'perplexity', 'qwen'];

    for (const p of providers) {
        const apiObj = resetMap[p];
        if (!apiObj) continue;

        try {
            const wc = typeof webContentsGetter === 'function' ? webContentsGetter(p) : webContentsGetter;
            if (!wc) continue;

            await wc.executeJavaScript(
                `if (window.${apiObj} && window.${apiObj}.newConversation) { window.${apiObj}.newConversation(); }`
            );
            console.log(`[ProviderAPI] ✔ Reset conversation for ${p}`);
        } catch (e) {
            console.error(`[ProviderAPI] ✘ Failed to reset conversation for ${p}:`, e.message);
        }
    }
}

function lastError(provider) { return _lastError[provider] || null; }

module.exports = {
    lastError,
    injectAPI,
    isAPIReady,
    ensureAPI,
    sendViaAPI,
    setupAutoInject,
    resetConversation,
    clearScriptCache
};
