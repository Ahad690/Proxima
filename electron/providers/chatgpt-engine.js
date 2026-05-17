/**
 * Proxima — ChatGPT Engine v4.1.0
 * Runs inside chatgpt.com BrowserView context. Uses session cookies for auth,
 * solves SHA3-512 proof-of-work challenges, and streams responses via SSE.
 * Requires DOM access (navigator/screen) for proof-of-work challenges.
 */
(function() {
    if (window.__proximaChatGPT) return;

    var CHATGPT_BASE = 'https://chatgpt.com';
    var CHATGPT_CONVERSATION_ENDPOINT = '/backend-api/f/conversation';
    var CHATGPT_ALT_CONVERSATION_ENDPOINT = '/backend-api/conversation';
    var CHATGPT_PREPARE_ENDPOINT = '/backend-api/f/conversation/prepare';
    var TIMEOUT = 360000;

    // ─── State ───────────────────────────────────────
    var _conversationId = null;
    var _parentMessageId = null;
    var _cachedToken = null;
    var _tokenExpiry = 0;

    // ─── SHA3-512 (pure JS, required for POW challenges) ───

    var SHA3 = (function() {
        var RC = [
            [0x00000001, 0x00000000], [0x00008082, 0x00000000], [0x0000808a, 0x80000000],
            [0x80008000, 0x80000000], [0x0000808b, 0x00000000], [0x80000001, 0x00000000],
            [0x80008081, 0x80000000], [0x00008009, 0x80000000], [0x0000008a, 0x00000000],
            [0x00000088, 0x00000000], [0x80008009, 0x00000000], [0x8000000a, 0x00000000],
            [0x8000808b, 0x00000000], [0x0000008b, 0x80000000], [0x00008089, 0x80000000],
            [0x00008003, 0x80000000], [0x00008002, 0x80000000], [0x00000080, 0x80000000],
            [0x0000800a, 0x00000000], [0x8000000a, 0x80000000], [0x80008081, 0x80000000],
            [0x00008080, 0x80000000], [0x80000001, 0x00000000], [0x80008008, 0x80000000]
        ];
        var ROTL = [
            [0,0],[1,0],[62,0],[28,0],[27,0],[36,0],[44,0],[6,0],[55,0],[20,0],
            [3,0],[10,0],[43,0],[25,0],[39,0],[41,0],[45,0],[15,0],[21,0],[8,0],
            [18,0],[2,0],[61,0],[56,0],[14,0]
        ];
        var PI = [0,10,20,5,15,16,1,11,21,6,7,17,2,12,22,23,8,18,3,13,14,24,9,19,4];

        function rot64(lo, hi, n) {
            if (n === 0) return [lo, hi];
            if (n < 32) return [(lo << n) | (hi >>> (32 - n)), (hi << n) | (lo >>> (32 - n))];
            n -= 32;
            return [(hi << n) | (lo >>> (32 - n)), (lo << n) | (hi >>> (32 - n))];
        }

        function keccakf(state) {
            var s = new Int32Array(50);
            for (var i = 0; i < 50; i++) s[i] = state[i];
            for (var round = 0; round < 24; round++) {
                var C = new Int32Array(10);
                for (var x = 0; x < 5; x++) {
                    C[x*2] = s[x*2]^s[(x+5)*2]^s[(x+10)*2]^s[(x+15)*2]^s[(x+20)*2];
                    C[x*2+1] = s[x*2+1]^s[(x+5)*2+1]^s[(x+10)*2+1]^s[(x+15)*2+1]^s[(x+20)*2+1];
                }
                for (var x = 0; x < 5; x++) {
                    var px = ((x+4)%5), nx = ((x+1)%5);
                    var d = rot64(C[nx*2], C[nx*2+1], 1);
                    var tlo = C[px*2]^d[0], thi = C[px*2+1]^d[1];
                    for (var y = 0; y < 25; y += 5) { s[(y+x)*2] ^= tlo; s[(y+x)*2+1] ^= thi; }
                }
                var B = new Int32Array(50);
                for (var i = 0; i < 25; i++) {
                    var r = rot64(s[i*2], s[i*2+1], ROTL[i][0]%64);
                    B[PI[i]*2] = r[0]; B[PI[i]*2+1] = r[1];
                }
                for (var y = 0; y < 25; y += 5) {
                    for (var x = 0; x < 5; x++) {
                        s[(y+x)*2] = B[(y+x)*2] ^ (~B[(y+(x+1)%5)*2] & B[(y+(x+2)%5)*2]);
                        s[(y+x)*2+1] = B[(y+x)*2+1] ^ (~B[(y+(x+1)%5)*2+1] & B[(y+(x+2)%5)*2+1]);
                    }
                }
                s[0] ^= RC[round][0]; s[1] ^= RC[round][1];
            }
            for (var i = 0; i < 50; i++) state[i] = s[i];
        }

        function sha3_512(message) {
            var rate = 72;
            var msgBytes = new TextEncoder().encode(message);
            var padLen = rate - (msgBytes.length % rate);
            var padded = new Uint8Array(msgBytes.length + padLen);
            padded.set(msgBytes);
            padded[msgBytes.length] = 0x06;
            padded[padded.length - 1] |= 0x80;
            var state = new Int32Array(50);
            for (var offset = 0; offset < padded.length; offset += rate) {
                for (var i = 0; i < rate; i += 4) {
                    var idx = (i/4);
                    if (idx < 50) {
                        state[idx] ^= (padded[offset+i]) | (padded[offset+i+1]<<8) | (padded[offset+i+2]<<16) | (padded[offset+i+3]<<24);
                    }
                }
                keccakf(state);
            }
            var hash = new Uint8Array(64);
            for (var i = 0; i < 64; i += 4) {
                var w = state[i/4];
                hash[i]=w&0xff; hash[i+1]=(w>>8)&0xff; hash[i+2]=(w>>16)&0xff; hash[i+3]=(w>>24)&0xff;
            }
            return Array.from(hash).map(function(b) { return b.toString(16).padStart(2,'0'); }).join('');
        }

        return { sha3_512: sha3_512 };
    })();

    // ─── POW Solver ─────────────────────────────────

    async function _solvePOW(seed, difficulty, scripts, dpl) {
        function encode(arr) {
            var json = JSON.stringify(arr);
            return btoa(String.fromCharCode.apply(null, new TextEncoder().encode(json)));
        }
        var startTime = performance.now();
        var navKeys = Object.keys(Object.getPrototypeOf(navigator));
        var pickRandom = function(arr) { return arr[Math.floor(Math.random() * arr.length)]; };

        var config = [
            navigator.hardwareConcurrency + screen.width + screen.height,
            new Date().toString(),
            (performance.memory && performance.memory.jsHeapSizeLimit) || 4294705152,
            0,
            navigator.userAgent,
            pickRandom(scripts || [null]),
            dpl || '',
            navigator.language,
            navigator.languages.join(','),
            0,
            pickRandom(navKeys) + '-' + navigator[pickRandom(navKeys)],
            pickRandom(Object.keys(document)),
            pickRandom(Object.keys(window)),
            performance.now(),
            crypto.randomUUID()
        ];

        for (var i = 1; i < 100000; i++) {
            // Yield to event loop periodically to avoid blocking UI
            if (i % 2000 === 0) await new Promise(function(r) { setTimeout(r, 10); });
            config[3] = i;
            config[9] = Math.round(performance.now() - startTime);
            var encoded = encode(config);
            var hash = SHA3.sha3_512(seed + encoded);
            if (hash.substring(0, difficulty.length) <= difficulty) {
                return encoded;
            }
        }
        return null;
    }

    // ─── Auth Token (cached 5 min) ──────────────────

    async function _getToken() {
        if (_cachedToken && Date.now() < _tokenExpiry) return _cachedToken;
        var res = await fetch('/api/auth/session', { credentials: 'include' });
        if (res.status === 429) throw new Error('Too many requests');
        if (res.status === 403) throw new Error('Cloudflare check required');
        if (!res.ok) throw new Error('Session failed (' + res.status + ')');
        var data = await res.json();
        if (!data.accessToken) throw new Error('Not logged in to ChatGPT');
        _cachedToken = data.accessToken;
        _tokenExpiry = Date.now() + 300000; // 5 min TTL
        return _cachedToken;
    }

    // ─── Page Scripts (needed for POW) ────────────────

    var _cachedScripts = null;
    var _cachedDpl = null;

    async function _getScriptsAndDpl() {
        if (_cachedScripts) return { scripts: _cachedScripts, dpl: _cachedDpl };
        try {
            var html = await fetch('/', { credentials: 'include' }).then(function(r) { return r.text(); });
            _cachedScripts = [];
            var m;
            var re = /src="([^"]*)"/g;
            while ((m = re.exec(html)) !== null) _cachedScripts.push(m[1]);
            var dplMatch = html.match(/dpl=([a-zA-Z0-9_-]+)/);
            _cachedDpl = dplMatch ? dplMatch[1] : '';
        } catch(e) {
            _cachedScripts = [null];
            _cachedDpl = '';
        }
        return { scripts: _cachedScripts, dpl: _cachedDpl };
    }

    // ─── Chat Requirements + POW ────────────────────

    async function _getRequirementsAndPOW(token) {
        var reqRes = await fetch('/backend-api/sentinel/chat-requirements', {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + token
            },
            body: JSON.stringify({ conversation_mode_kind: 'primary_assistant' })
        });

        if (!reqRes.ok) return {};
        var req = await reqRes.json();
        var result = { requirementsToken: req.token || null };

        if (req.proofofwork && req.proofofwork.required) {
            var sd = await _getScriptsAndDpl();
            var powToken = await _solvePOW(req.proofofwork.seed, req.proofofwork.difficulty, sd.scripts, sd.dpl);
            if (powToken) result.proofToken = 'gAAAAAB' + powToken;
        }

        return result;
    }

    function _extractAssistantTextFromMessage(message) {
        if (!message || !message.author || message.author.role !== 'assistant') return '';
        var content = message.content || {};
        if (Array.isArray(content.parts) && content.parts.length > 0) {
            return content.parts.join('');
        }
        if (typeof content.text === 'string') return content.text;
        if (Array.isArray(content.text) && content.text.length > 0) {
            return content.text.join('');
        }
        return '';
    }

    function _extractAssistantDelta(parsed) {
        if (!parsed || typeof parsed !== 'object') return '';
        if (typeof parsed.delta === 'string') return parsed.delta;
        if (parsed.delta && typeof parsed.delta.text === 'string') return parsed.delta.text;
        if (typeof parsed.text === 'string') return parsed.text;
        if (parsed.message_delta && typeof parsed.message_delta === 'string') return parsed.message_delta;
        return '';
    }

    // ─── SSE Stream Parser ──────────────────────────

    async function _parseSSEStream(response) {
        var reader = response.body.getReader();
        var decoder = new TextDecoder();
        var fullText = '';
        var streamText = '';
        var buffer = '';
        var sawAssistantEvent = false;

        function processLine(line) {
            if (!line.startsWith('data: ')) return;
            var data = line.slice(6).trim();
            if (!data || data === '[DONE]') return;

            try {
                var parsed = JSON.parse(data);

                // Persist conversation context for follow-up messages
                if (parsed.conversation_id) {
                    _conversationId = parsed.conversation_id;
                }

                if (parsed.message && parsed.message.id) {
                    _parentMessageId = parsed.message.id;
                }

                var assistantText = _extractAssistantTextFromMessage(parsed.message);
                if (assistantText) {
                    fullText = assistantText;
                    sawAssistantEvent = true;
                }

                // Some ChatGPT responses stream deltas rather than full parts snapshots.
                var deltaText = _extractAssistantDelta(parsed);
                if (deltaText) {
                    streamText += deltaText;
                    sawAssistantEvent = true;
                }
            } catch (e) {}
        }

        while (true) {
            var chunk = await reader.read();
            if (chunk.done) break;

            buffer += decoder.decode(chunk.value, { stream: true });
            var lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (var i = 0; i < lines.length; i++) {
                processLine(lines[i]);
            }
        }

        // Process trailing partial line if the stream ended without newline.
        if (buffer && buffer.indexOf('data: ') === 0) processLine(buffer);
        reader.releaseLock();
        if (fullText) return fullText;
        if (streamText) return streamText;
        return sawAssistantEvent ? streamText : '';
    }

    function _conversationFetchOptions(headers, payload, signal) {
        return {
            method: 'POST',
            credentials: 'include',
            headers: headers,
            body: JSON.stringify(payload),
            signal: signal
        };
    }

    function _isJsonResponse(res) {
        var contentType = (res && res.headers && res.headers.get('content-type')) || '';
        return contentType.toLowerCase().indexOf('application/json') === 0;
    }

    function _shouldTryAlternateConversationEndpoint(res) {
        if (!res) return true;
        // Keep token-refresh path intact.
        if (res.status === 401) return false;
        if (!res.ok) return true;
        // If primary endpoint returns JSON, alternate endpoint often carries SSE.
        return _isJsonResponse(res);
    }

    async function _cancelResponseBody(res) {
        try {
            if (res && res.body && typeof res.body.cancel === 'function') {
                await res.body.cancel();
            }
        } catch (e) {}
    }

    async function _fetchConversationWithFallback(headers, payload, signal) {
        var res = await fetch(
            CHATGPT_CONVERSATION_ENDPOINT,
            _conversationFetchOptions(headers, payload, signal)
        );
        if (_shouldTryAlternateConversationEndpoint(res)) {
            await _cancelResponseBody(res);
            res = await fetch(
                CHATGPT_ALT_CONVERSATION_ENDPOINT,
                _conversationFetchOptions(headers, payload, signal)
            );
        }
        return res;
    }

    function _resolveThinkingEffort(options, model) {
        if (options && typeof options.thinkingEffort === 'string') return options.thinkingEffort;
        if (typeof model === 'string' && model.toLowerCase().includes('thinking')) return 'extended';
        return 'standard';
    }

    function _buildConversationMeta(model, thinkingEffort, state) {
        var tz = 'UTC';
        try {
            tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
        } catch (e) {}

        return {
            action: 'next',
            conversation_id: _conversationId || undefined,
            parent_message_id: _parentMessageId || crypto.randomUUID(),
            model: model,
            client_prepare_state: state,
            timezone_offset_min: new Date().getTimezoneOffset(),
            timezone: tz,
            conversation_mode: { kind: 'primary_assistant' },
            system_hints: [],
            supports_buffering: true,
            supported_encodings: ['v1'],
            client_contextual_info: { app_name: 'chatgpt.com' },
            thinking_effort: thinkingEffort
        };
    }

    // ─── Send Message ───────────────────────────────

    async function send(message, options) {
        var token = await _getToken();

        // OAI-Device-Id header required for API auth
        var deviceId = '';
        try {
            var cookies = document.cookie.split(';');
            for (var i = 0; i < cookies.length; i++) {
                var c = cookies[i].trim();
                if (c.startsWith('oai-did=')) { deviceId = c.substring(8); break; }
            }
        } catch(e) {}

        var powData = await _getRequirementsAndPOW(token);

        var headers = {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token,
            'Accept': 'text/event-stream',
            'OAI-Language': 'en-US'
        };

        if (deviceId) headers['OAI-Device-Id'] = deviceId;
        if (powData.requirementsToken) headers['Openai-Sentinel-Chat-Requirements-Token'] = powData.requirementsToken;
        if (powData.proofToken) headers['Openai-Sentinel-Proof-Token'] = powData.proofToken;

        var model = (options && options.model) ? options.model : 'gpt-5-5-thinking';
        var thinkingEffort = _resolveThinkingEffort(options, model);
        var conversationMeta = _buildConversationMeta(model, thinkingEffort, 'success');

        var payload = {
            action: conversationMeta.action,
            messages: [{
                id: crypto.randomUUID(),
                author: { role: 'user' },
                content: { content_type: 'text', parts: [message] },
                metadata: {}
            }],
            conversation_id: conversationMeta.conversation_id,
            parent_message_id: conversationMeta.parent_message_id,
            model: conversationMeta.model,
            client_prepare_state: conversationMeta.client_prepare_state,
            timezone_offset_min: conversationMeta.timezone_offset_min,
            timezone: conversationMeta.timezone,
            conversation_mode: conversationMeta.conversation_mode,
            enable_message_followups: true,
            system_hints: conversationMeta.system_hints,
            supports_buffering: conversationMeta.supports_buffering,
            supported_encodings: conversationMeta.supported_encodings,
            client_contextual_info: conversationMeta.client_contextual_info,
            paragen_cot_summary_display_override: 'allow',
            force_parallel_switch: 'auto',
            thinking_effort: conversationMeta.thinking_effort
        };
        if (!payload.conversation_id) delete payload.conversation_id;

        var preparePayload = _buildConversationMeta(model, thinkingEffort, 'none');
        preparePayload.fork_from_shared_post = false;
        if (!preparePayload.conversation_id) delete preparePayload.conversation_id;

        try {
            await fetch(CHATGPT_PREPARE_ENDPOINT, {
                method: 'POST',
                credentials: 'include',
                headers: headers,
                body: JSON.stringify(preparePayload)
            });
        } catch (e) {
            // Prepare is best-effort; send can still succeed without it.
        }


        if (_conversationId) {
            payload.conversation_id = _conversationId;
            console.log('[Proxima ChatGPT] Continuing conversation:', _conversationId);
        } else {
            console.log('[Proxima ChatGPT] Starting new conversation');
        }

        var controller = new AbortController();
        var timeoutId = setTimeout(function() { controller.abort(); }, TIMEOUT);

        var res = await _fetchConversationWithFallback(headers, payload, controller.signal);

        // Token expired — refresh and retry once
        if (res.status === 401) {
            var newToken = await _getToken();
            headers['Authorization'] = 'Bearer ' + newToken;
            var retryController = new AbortController();
            var retryTimeoutId = setTimeout(function() { retryController.abort(); }, TIMEOUT);
            res = await _fetchConversationWithFallback(headers, payload, retryController.signal);
            if (!res.ok) {
                clearTimeout(retryTimeoutId);
                var err = await res.text().catch(function() { return ''; });
                throw new Error('ChatGPT API error (' + res.status + '): ' + err.substring(0, 300));
            }
            var result = await _parseSSEStream(res);
            clearTimeout(retryTimeoutId);
            return result;
        }

        if (!res.ok) {
            clearTimeout(timeoutId);
            var err = await res.text().catch(function() { return ''; });
            throw new Error('ChatGPT API error (' + res.status + '): ' + err.substring(0, 300));
        }

        // ChatGPT sometimes returns JSON instead of SSE (WebSocket redirect)
        var resContentType = res.headers.get('content-type') || '';
        if (resContentType.startsWith('application/json')) {
            clearTimeout(timeoutId);
            throw new Error('WebSocket mode not supported');
        }

        var result = await _parseSSEStream(res);
        clearTimeout(timeoutId);
        return result;
    }


    function newConversation() {
        _conversationId = null;
        _parentMessageId = null;
        console.log('[Proxima ChatGPT] Conversation reset');
    }

    window.__proximaChatGPT = { send: send, newConversation: newConversation };
    console.log('[Proxima] ChatGPT engine loaded');
    // Pre-warm auth token and page scripts to speed up first request
    _getToken().catch(function(){});
    _getScriptsAndDpl().catch(function(){});
})();
