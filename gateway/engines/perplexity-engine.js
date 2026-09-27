/**
 * REFERENCE ENGINE - clean-room implementation of the provider engine contract.
 *
 * Purpose: prove the gateway contract is sufficient to build against. This file was
 * written from the engine interface documented in docs/product/capability-manifest.md
 * and gateway/engines/README.md. It is NOT derived from any upstream engine source.
 *
 * Provider: perplexity
 * Protocol: the page's own fetch(), with credentials included, so the browser's session
 * cookies and origin clearance ride along automatically. No bearer extraction, no header
 * spoofing, no DOM scraping.
 *
 * Lifecycle:
 *   - Evaluated as an init script, so it re-runs on every document.
 *   - Must expose window.<GLOBAL> or the gateway reports an engine failure.
 *   - Must be safe to evaluate repeatedly (navigations re-run it).
 */
(function () {
    'use strict';

    var GLOBAL = '__proximaPerplexity';
    var ORIGIN = 'https://www.perplexity.ai';

    // Conversation continuity is deliberate: consecutive calls chain onto one thread.
    // reset() is how a caller forces independence, so an automated verdict never
    // inherits a previous run's context.
    var state = {
        conversationId: null,
        lastResponse: '',
        typing: false,
        conversationStartedAt: null,
    };

    function nowIso() {
        return new Date().toISOString();
    }

    function isLoggedIn() {
        return document.cookie.indexOf('pplx') !== -1 ||
            document.cookie.indexOf('session-token') !== -1;
    }

    function newConversation() {
        state.conversationId = null;
        state.lastResponse = '';
        state.conversationStartedAt = null;
        return { cleared: true };
    }

    function getConversation() {
        return { conversationId: state.conversationId, startedAt: state.conversationStartedAt };
    }

    function isReady() {
        return true; // no composer probe required for this provider
    }

    function getTypingStatus() {
        return { typing: state.typing };
    }

    function getResponse() {
        return state.lastResponse;
    }

    function classifyFailure(status, body) {
        // Distinguishing a WAF block from an ordinary auth failure is what lets a caller
        // decide between "wait and retry" and "re-login". The gateway surfaces this as a
        // distinct error kind.
        if (status === 403 || status === 429) {
            return { kind: 'waf', retryable: true, status: status };
        }
        if (status === 401 || status === 403) {
            return { kind: 'auth', retryable: false, status: status };
        }
        if (status >= 500) {
            return { kind: 'upstream', retryable: true, status: status };
        }
        return { kind: 'unknown', retryable: false, status: status, body: String(body || '').slice(0, 200) };
    }

    async function sendMessage(options) {
        options = options || {};
        var message = options.message;
        if (typeof message !== 'string' || !message.trim()) {
            throw new Error('sendMessage requires a non-empty message');
        }

        state.typing = true;
        state.lastResponse = '';
        state.conversationStartedAt = state.conversationStartedAt || nowIso();

        try {
            // The only authenticated egress this system needs: same-origin, credentials
            // included. The browser attaches whatever the profile is holding.
            var res = await fetch('/api/search/completions', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    query: message,
                    model_preference: options.modelPreference || 'default',
                    search_mode: options.researchMode ? 'on' : 'off',
                    is_structured_output_enabled: false,
                    source: 'proxima-gateway',
                }),
            });

            if (!res.ok) {
                var body = await res.text().catch(function () { return ''; });
                var failure = classifyFailure(res.status, body);
                var err = new Error(
                    'perplexity completion failed: ' + failure.kind + ' (status ' + res.status + ')'
                );
                err.kind = failure.kind;
                err.retryable = failure.retryable;
                err.status = res.status;
                throw err;
            }

            var data = await res.json().catch(function () { return {}; });

            state.conversationId =
                data.conversation_id || data.conversationId || state.conversationId;

            state.lastResponse = extractText(data);
            return { conversationId: state.conversationId, length: state.lastResponse.length };
        } finally {
            state.typing = false;
        }
    }

    function extractText(data) {
        // Defensive: an empty extraction must stay empty so the gateway's placeholder
        // retry (A8) can see it and retry, rather than receiving a fabricated string.
        if (!data) return '';
        if (typeof data.text === 'string') return data.text;
        if (typeof data.answer === 'string') return data.answer;
        if (Array.isArray(data.content)) {
            return data.content
                .map(function (c) {
                    if (typeof c === 'string') return c;
                    return c && typeof c.text === 'string' ? c.text : '';
                })
                .filter(Boolean)
                .join('\n');
        }
        return '';
    }

    // Expose the contract. Overwriting on re-eval is intentional: a navigation must
    // leave exactly one live engine, not a stale one.
    window[GLOBAL] = {
        sendMessage: sendMessage,
        newConversation: newConversation,
        getConversation: getConversation,
        getResponse: getResponse,
        getTypingStatus: getTypingStatus,
        isReady: isReady,
        isLoggedIn: isLoggedIn,
        version: '0.1.0-reference',
    };
})();
