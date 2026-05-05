# Proxima Perplexity Integration — Code Extraction

This document extracts the relevant code sections for reverse-engineering Perplexity's "Deep Research" mode.

---

## 1. `electron/providers/perplexity-engine.js`

### 1.1 MODEL_MAP (Lines 172-199)

```javascript
    // ─── Model Mapping ───────────────────────────────────────────
    // Map UI names to internal model_preference values for /rest/sse/perplexity_ask
    // All slugs confirmed via HAR analysis of Perplexity web app traffic
    var MODEL_MAP = {
        // Default / Best — routes to Perplexity's auto-select
        'best': 'pplx_pro',
        'default': 'pplx_pro',
        'sonar 2': 'pplx_pro',
        'sonar': 'pplx_pro',
        // Claude Sonnet 4.6 — confirmed slugs
        'claude sonnet 4.6': 'claude46sonnet',
        'claude sonnet 4.6 thinking': 'claude46sonnetthinking',
        'claude sonnet 4': 'claude46sonnet',
        'claude': 'claude46sonnet',
        // GPT-5.4 — confirmed slugs
        'gpt-5.4': 'gpt54',
        'gpt-5.4 thinking': 'gpt54_thinking',
        'gpt-5': 'gpt54',
        'gpt': 'gpt54',
        // Gemini 3.1 Pro — confirmed slug (note: _high suffix)
        'gemini 3.1 pro': 'gemini31pro_high',
        'gemini': 'gemini31pro_high',
        // Experimental
        'experimental': 'experimental',
        // Special modes
        'deep': 'pplx_alpha',
        'thinking': 'pplx_alpha'
    };

    function _resolveModelPreference(modelName) {
        if (!modelName) return 'pplx_pro';
        var key = String(modelName).toLowerCase().trim();
        var resolved = MODEL_MAP[key] || 'pplx_pro';
        console.log('[Proxima] model_preference: ' + resolved + ' (input: ' + modelName + ')');
        return resolved;
    }
```

### 1.2 Request Payload Construction (Lines 218-282)

```javascript
        var params = {
            version: '2',
            search_focus: 'internet',
            sources: ['web'],
            frontend_uuid: frontendUuid,
            mode: 'copilot',
            model_preference: modelPref,
            is_related_query: false,
            is_sponsored: false,
            prompt_source: 'user',
            query_source: _lastBackendUuid ? 'followup' : 'home',
            is_incognito: false,
            time_from_first_type: Math.floor(Math.random() * 5000) + 1000,
            local_search_enabled: false,
            use_schematized_api: true,
            send_back_text_in_streaming_api: true,
            supported_block_use_cases: [
                'answer_modes', 'media_items', 'knowledge_cards', 'inline_entity_cards',
                'place_widgets', 'finance_widgets', 'prediction_market_widgets', 'sports_widgets',
                'flight_status_widgets', 'news_widgets', 'shopping_widgets', 'search_result_widgets',
                'inline_images', 'inline_assets', 'placeholder_cards', 'diff_blocks',
                'inline_knowledge_cards', 'entity_group_v2', 'refinement_filters',
                'answer_tabs', 'preserve_latex', 'in_context_suggestions',
                'pending_followups', 'inline_claims', 'unified_assets'
            ],
            client_coordinates: null,
            mentions: [],
            skip_search_enabled: true,
            is_nav_suggestions_disabled: false,
            source: 'default',
            always_search_override: false,
            override_no_search: false,
            extended_context: false,
            version: '2.18'
        };

        var body = JSON.stringify({
            params: params,
            query_str: message
        });

        var controller = new AbortController();
        var timeoutId = setTimeout(function () { controller.abort(); }, TIMEOUT);

        var headers = {
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream',
            'x-perplexity-request-endpoint': 'https://www.perplexity.ai/rest/sse/perplexity_ask',
            'x-perplexity-request-reason': 'perplexity-query-state-provider',
            'x-perplexity-request-try-number': '1',
            'x-request-id': frontendUuid
        };

        var res = await fetch('/rest/sse/perplexity_ask', {
            method: 'POST',
            'credentials': 'include',
            headers: headers,
            body: body,
            signal: controller.signal
        });
```

### 1.3 SSE Stream Parsing (Lines 73-132)

```javascript
    // ─── SSE Stream Parser ──────────────────────────

    async function _parseStream(response) {
        var reader = response.body.getReader();
        var decoder = new TextDecoder();
        var buffer = '';
        var answer = '';
        var backendUuid = null;

        while (true) {
            var chunk = await reader.read();
            if (chunk.done) break;

            buffer += decoder.decode(chunk.value, { stream: true });
            var lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (var i = 0; i < lines.length; i++) {
                var line = lines[i].trim();
                if (!line.startsWith('data:')) continue;
                var data = line.slice(5).trim();
                if (!data || data === '[DONE]') continue;

                try {
                    var parsed = JSON.parse(data);


                    if (parsed.backend_uuid) {
                        backendUuid = parsed.backend_uuid;
                    }

                    // Answer lives in blocks[].markdown_block.answer
                    if (parsed.blocks && Array.isArray(parsed.blocks)) {
                        for (var bi = 0; bi < parsed.blocks.length; bi++) {
                            var block = parsed.blocks[bi];


                            if (block.markdown_block && block.markdown_block.answer &&
                                typeof block.markdown_block.answer === 'string') {
                                var blockAnswer = block.markdown_block.answer;
                                if (blockAnswer.length > answer.length) {
                                    answer = blockAnswer;
                                }
                            }


                            if (block.markdown_block && block.markdown_block.chunks &&
                                Array.isArray(block.markdown_block.chunks)) {
                                var chunked = block.markdown_block.chunks.join('');
                                if (chunked.length > answer.length) {
                                    answer = chunked;
                                }
                            }
                        }
                    }


                    if (parsed.answer && typeof parsed.answer === 'string' &&
                        parsed.answer.length > answer.length && parsed.answer.length < 50000) {
                        answer = parsed.answer;
                    }
                } catch (e) { /* ignore parse errors */ }
            }
        }

        _lastBackendUuid = backendUuid;
        return answer;
    }
```

---

## 2. `src/mcp-server-v3.js`

### 2.1 Tool Definitions (Lines 557-587, 621-668)

```javascript
// --- Search tools ---

server.tool(
    'proxima_deep_search',
    {
        query: z.string().describe('Search query for deep research. Perplexity does not have context of your codebase - attach relevant code via files parameter. Use for research across >=50 websites. IMPORTANT: Perplexity does not support parallelization - combine all queries into one prompt, or call sequentially and wait for each response before calling again.'),
        files: z.array(z.string()).optional().describe('Optional: file paths to include as context. Supports line ranges like "path/file.js:10-50". Always specify relevant code ranges - the AI needs actual code to reference, not just filenames.'),
        provider: z.string().optional().describe('AI provider to use: chatgpt, claude, gemini, perplexity. Default: auto-select best available')
    },
    async ({ query, files, provider: providerName }) => {
        const p = resolveProvider(providerName, 'research');
        if (!p) return toolResponse('No providers available. Enable at least one provider.');
        
        // If using Perplexity, enable Deep Research mode and wait for previous responses
        if (p.name === 'perplexity') {
            await new Promise(r => setTimeout(r, 5000));
            const fullQuery = buildMessageWithFiles(query, files);
            try {
                return toolResponse(await p.instance.chat(fullQuery, false, { deepSearch: true }));
            } catch (apiErr) {
                console.error('[proxima_deep_search] API failed, falling back to DOM: ' + apiErr.message);
                return toolResponse(await p.instance.chat(fullQuery, false, { deepSearch: true, forceDOM: true }));
            }
        }
        
        try {
            const fullQuery = buildMessageWithFiles(query, files);
            return toolResponse(await p.instance.chat(fullQuery));
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'proxima_pro_search',
    {
        query: z.string().describe('Query for detailed Pro search. Perplexity does not have context of your codebase - attach relevant code via files parameter. Use for research across <=30 websites. IMPORTANT: Perplexity does not support parallelization - combine all queries into one prompt, or call sequentially and wait for each response before calling again.'),
        files: z.array(z.string()).optional().describe('Optional: file paths to include as context. Supports line ranges like "path/file.js:10-50". Always specify relevant code ranges - the AI needs actual code to reference, not just filenames.'),
        model: z.string().optional().describe('Model to use: "claude sonnet 4.6", "claude sonnet 4.6 thinking", "gpt-5.4", "gpt-5.4 thinking", "gemini 3.1 pro", "experimental", "best". Default: best')
    },
    async ({ query, files, model }) => {
        const disabled = checkDisabled('perplexity');
        if (disabled) return disabled;
        
        // Wait 5 seconds before sending to let any previous responses complete
        await new Promise(r => setTimeout(r, 5000));
        
        const fullQuery = buildMessageWithFiles(query, files);
        
        try {
            return toolResponse(await perplexity.search(`Provide a comprehensive, detailed answer with sources: ${fullQuery}`, true, { deepSearch: false, modelPreference: model }));
        } catch (apiErr) {
            console.error('[proxima_pro_search] API failed, falling back to DOM: ' + apiErr.message);
            return toolResponse(await perplexity.search(`Provide a comprehensive, detailed answer with sources: ${fullQuery}`, true, { deepSearch: false, modelPreference: model, forceDOM: true }));
        }
    }
);

server.tool(
    '_search',
    {
        query: z.string().describe('Query for detailed Pro search. Perplexity does not have context of your codebase - attach relevant code via files parameter. Use for research across <=30 websites. IMPORTANT: Perplexity does not support parallelization - combine all queries into one prompt, or call sequentially and wait for each response before calling again.'),
        files: z.array(z.string()).optional().describe('Optional: file paths to include as context. Supports line ranges like "path/file.js:10-50". Always specify relevant code ranges - the AI needs actual code to reference, not just filenames.'),
        model: z.string().optional().describe('Model to use: "claude sonnet 4.6", "claude sonnet 4.6 thinking", "gpt-5.4", "gpt-5.4 thinking", "gemini 3.1 pro", "experimental", "best". Default: best')
    },
    async ({ query, files, model }) => {
        const disabled = checkDisabled('perplexity');
        if (disabled) return disabled;
        
        // Wait 5 seconds before sending to let any previous responses complete
        await new Promise(r => setTimeout(r, 5000));
        
        const fullQuery = buildMessageWithFiles(query, files);
        
        try {
            return toolResponse(await perplexity.search(`Provide a comprehensive, detailed answer with sources: ${fullQuery}`, true, { deepSearch: false, modelPreference: model }));
        } catch (err) {
            return toolError(err);
        }
    }
);
```

---

## 3. `electron/provider-api.cjs`

### 3.1 Routing Logic (Lines 95-134)

```javascript
/**
 * @param {string} provider - Provider name (chatgpt, perplexity, etc.)
 * @param {object} webContents - Electron webContents
 * @param {string} message
 * @param {object} options - Optional: { modelPreference, deepSearch, etc. }
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
        perplexity: '__proximaPerplexity'
    };

    const apiObj = sendMap[provider];
    if (!apiObj) return null;

    // Escape message for safe JS injection
    const escapedMessage = JSON.stringify(message);
    const escapedOptions = JSON.stringify(options);

    try {
        console.log(`[ProviderAPI] Sending via ${provider} API...options: ${escapedOptions}`);
        const startTime = Date.now();

        const result = await webContents.executeJavaScript(
            `window.${apiObj}.send(${escapedMessage}, ${escapedOptions})`
        );

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const charCount = result ? result.length : 0;
        console.log(`[ProviderAPI] ✔ ${provider} API response: ${charCount} chars in ${elapsed}s`);

        return result || null;
    } catch (e) {
        console.error(`[ProviderAPI] ✘ ${provider} API error:`, e.message);
        return null;
    }
}
```

### 3.2 How options are passed (from `main-v2.cjs`)

```javascript
// Line 735: sendMessageToProvider receives options
async function sendMessageToProvider(provider, message, forceDOM = false, options = {}) {
    // ... 

    if (options.deepSearch === true) {
        // Deep Search mode logic
    } else if (options.deepSearch === false) {
        // Pro Search mode logic
    }

    // Line 745: calls providerAPI.sendViaAPI with options
    const apiResponse = await providerAPI.sendViaAPI(provider, webContents, message, options);
}
```

---

## Summary of Key Parameters

| Parameter | Where Used | Purpose |
|-----------|------------|--------|
| `model_preference` | `params` object | Model selection (pplx_pro, claude46sonnet, gpt54, etc.) |
| `deepSearch` | Options object | Enables Deep Research vs Pro mode |
| `deepSearchCount` | Options object | Counter to limit Deep Research (3 uses max before fallback to pro_search) |
| `forceDOM` | Options object | Fallback to DOM scraping on API failure |
| `mode` | params object | `'copilot'` for pro_search, `'agentic_research'` for deep_search (when count > 2) |
| `search_focus` | params object | Currently set to `'internet'` |