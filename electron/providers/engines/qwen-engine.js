/**
 * Proxima — Qwen Engine v1.0.0
 * Runs inside chat.qwen.ai BrowserView context. Pure cookie session auth
 * (credentials:'include') — no bearer token, no proof-of-work, no signed header
 * on the send path. Streams via SSE.
 *
 * Protocol derived from a deletion-narrowed capture of frontend build 0.2.87.
 * Full notes: C:\Users\subha\Downloads\qwenprotocol.md
 *
 * THREE THINGS THAT MAKE THIS ENGINE DIFFERENT FROM THE OTHER FOUR:
 *
 * 1. Every failure is HTTP 200 — validation errors, WAF blocks and logged-out
 *    alike. There is no 401 anywhere in this API. We branch on
 *    `content-type: text/event-stream`, never on res.status.
 * 2. POST /api/v2/chats/new must be SIGNED. Unsigned replays hung for ~3 min and
 *    then tripped an interactive slider CAPTCHA. The signing values come from the
 *    Alibaba baxia/sufei_data SDKs on the page, so this engine only works injected
 *    into the real page's main world — which is exactly how Proxima runs it.
 *    The send endpoint itself needs no signature.
 * 3. There is NO DOM fallback. Unlike the other providers, if the API path fails
 *    there is nothing to fall back to; main-v2 raises instead of typing.
 */
(function () {
    if (window.__proximaQwen) return;

    var ORIGIN = 'https://chat.qwen.ai';
    var FE_VERSION = '0.2.87';
    var DEFAULT_MODEL = 'qwen3.8-max';
    var TIMEOUT = 360000;

    // Message-level mode enum (protocol §11.1). Valid values from
    // GET /api/v2/models -> info.meta.chat_type. It is NOT a separate endpoint: the
    // value must match in FOUR places — chats/new body, messages[0].chat_type,
    // messages[0].sub_chat_type and messages[0].extra.meta.subChatType.
    var CHAT_TYPES = ['t2t', 't2v', 't2i', 'image_edit', 'search', 'artifacts',
                      'web_dev', 'deep_research', 'travel', 'learn', 'slides'];
    // deep_research ran >3.5 min without completing in testing, so it gets its own
    // ceiling rather than the normal 6 min. Deliberately 25 min, NOT 30: the MCP IPC
    // layer rejects at exactly 1800000ms (src/mcp-server-v3.js, "Request timeout").
    // Matching it would be a race whose loser is the useful error message, so the
    // engine gives up first and reports which mode timed out.
    var DEEP_RESEARCH_TIMEOUT = 1500000;   // 25 min

    // ─── State ───────────────────────────────────────
    // Persisted, NOT just in-memory. A CAPTCHA, a manual click or any page
    // navigation destroys this script and Proxima re-injects a fresh copy — which
    // would otherwise lose the chat id of a conversation that is still generating
    // server-side. An 11-minute deep_research run died exactly that way.
    var STORE_KEY = '__proxima_qwen_state';
    var _chatId = null;
    var _parentId = null;          // previous turn's response_id
    var _chatMode = null;          // chat_type the CURRENT _chatId was created with
    var _lastMeta = null;          // { usage, thinking[], responseId, phases }

    function loadState() {
        try {
            var raw = window.localStorage.getItem(STORE_KEY);
            if (!raw) return;
            var st = JSON.parse(raw);
            // Only adopt state that is still plausibly live (2h).
            if (!st || !st.chatId || (Date.now() - (st.ts || 0)) > 7200000) return;
            _chatId = st.chatId; _parentId = st.parentId || null; _chatMode = st.chatMode || null;
            console.log('[Proxima] Qwen: resumed conversation ' + _chatId + ' (mode ' + _chatMode + ')');
        } catch (e) { /* storage blocked — degrade to in-memory */ }
    }

    function saveState() {
        try {
            window.localStorage.setItem(STORE_KEY, JSON.stringify({
                chatId: _chatId, parentId: _parentId, chatMode: _chatMode, ts: Date.now()
            }));
        } catch (e) { /* ignore */ }
    }

    function uuid4() {
        if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            var r = Math.random() * 16 | 0;
            var v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    function nowSec() { return Math.floor(Date.now() / 1000); }

    // ─── Headers ─────────────────────────────────────
    // Narrowed by deletion, not copied from DevTools. Each of these four fails
    // differently when removed, which is how the attribution was confirmed:
    //   Content-Type -> 200 {"success":false, code:"RequestValidationError"}
    //   Version      -> 200 {"success":false, code:"Bad_Request"}
    //   source       -> 200 {"ret":["FAIL_SYS_USER_VALIDATE",...]}   (WAF)
    //   X-Request-Id -> 200 + Aliyun WAF HTML interstitial            (WAF)
    // Accept / Accept-Language / Timezone / X-Accel-Buffering were each deleted
    // with no effect. X-Request-Id only has to exist and be UUID-shaped; it is
    // not a server-issued nonce.
    function headers() {
        return {
            'Content-Type': 'application/json',
            'Version': FE_VERSION,
            'source': 'web',
            'X-Request-Id': uuid4()
        };
    }

    // ─── Failure classification ──────────────────────
    // Never branch on res.status: it is 200 for everything.
    function classifyFailure(contentType, text) {
        if (contentType.indexOf('event-stream') !== -1) return null;
        if (text.indexOf('aliyun_waf') !== -1) {
            return { kind: 'waf_interstitial', hint: 'Aliyun WAF challenge page — session is flagged. Open the Qwen tab and solve the slider.' };
        }
        if (text.indexOf('FAIL_SYS_USER_VALIDATE') !== -1 || text.indexOf('RGV587_ERROR') !== -1) {
            return { kind: 'waf_punish', hint: 'WAF punish. Either not logged in to Qwen, or the session is flagged. This API has no 401 — this IS what logged-out looks like.' };
        }
        try {
            var j = JSON.parse(text);
            if (j && j.success === false) {
                return { kind: 'validation', code: j.data && j.data.code, details: j.data && j.data.details };
            }
        } catch (e) { /* not JSON */ }
        return { kind: 'unknown', body: text.slice(0, 300) };
    }

    function failureError(f, status) {
        var msg = 'Qwen ' + f.kind;
        if (f.code) msg += ' (' + f.code + ')';
        if (f.details) msg += ' ' + JSON.stringify(f.details);
        if (f.hint) msg += ' — ' + f.hint;
        if (f.body) msg += ' — ' + f.body;
        var e = new Error(msg);
        e.failure = f;
        e.httpStatus = status;   // will usually be 200. yes, really.
        return e;
    }

    // ─── Conversation creation (MUST be signed) ──────
    function createChat(model, chatType) {
        var h = headers();
        // baxia/sufei_data are page globals. Present because we are injected into
        // the real page's main world. Without these the request hangs and the
        // session gets a CAPTCHA — see header comment #2.
        try {
            if (window.baxiaCommon && window.um) {
                h['bx-ua'] = window.baxiaCommon.getUA({});
                h['bx-umidtoken'] = window.um.getToken();
                h['bx-v'] = '2.5.37';
            }
        } catch (e) { /* SDK not ready — send unsigned and hope */ }

        return fetch(ORIGIN + '/api/v2/chats/new', {
            method: 'POST',
            credentials: 'include',
            headers: h,
            body: JSON.stringify({
                chatId: '',
                models: [model || DEFAULT_MODEL],
                project_id: '',
                timestamp: Date.now(),      // ms here; SECONDS in the send body
                chat_type: chatType || 't2t',
                chat_mode: 'normal'
            })
        }).then(function (res) {
            return res.text().then(function (txt) {
                var j;
                try { j = JSON.parse(txt); }
                catch (e) { throw new Error('Qwen chats/new: non-JSON ' + res.status + ' ' + txt.slice(0, 160)); }
                if (!j || !j.data || !j.data.id) {
                    var f = classifyFailure(res.headers.get('content-type') || '', txt);
                    if (f) throw failureError(f, res.status);
                    throw new Error('Qwen chats/new: no id in ' + txt.slice(0, 200));
                }
                return j.data.id;
            });
        });
    }

    // The mode is baked into the conversation at chats/new time, so a chat created
    // as t2t can never become deep_research. Switching mode therefore has to start a
    // NEW conversation — reusing the cached id would silently run the old mode.
    function ensureChat(model, chatType) {
        var want = chatType || 't2t';
        if (_chatId && _chatMode === want) return Promise.resolve(_chatId);
        if (_chatId && _chatMode !== want) {
            console.log('[Proxima] Qwen: mode ' + _chatMode + ' -> ' + want +
                '; starting a new conversation (chat_type is fixed at creation).');
            _parentId = null;
        }
        return createChat(model, want).then(function (id) {
            _chatId = id;
            _chatMode = want;
            saveState();
            return id;
        });
    }

    // ─── Recovery ────────────────────────────────────
    // The stream is a view onto work happening SERVER-side. If the socket dies the
    // generation usually keeps going and lands in the conversation anyway, so a
    // dead stream is not the same as a failed answer. GET /api/v2/chats/{id} is
    // documented as the resume path and needs no bx-* signing.
    function readChat(chatId) {
        return fetch(ORIGIN + '/api/v2/chats/' + encodeURIComponent(chatId), {
            credentials: 'include',
            headers: { 'Accept': 'application/json', 'source': 'web', 'Version': FE_VERSION }
        }).then(function (r) { return r.json(); });
    }

    // Returns { text, responseId } for the newest assistant message, or null.
    function latestAssistant(chatJson) {
        try {
            var hist = chatJson && chatJson.data && chatJson.data.chat && chatJson.data.chat.history;
            if (!hist || !hist.messages) return null;
            var msgs = hist.messages;
            var wanted = hist.currentId || (chatJson.data.chat && chatJson.data.chat.currentId);
            var m = wanted && msgs[wanted];
            if (!m || m.role !== 'assistant') {
                // Fall back to the newest assistant message by timestamp.
                m = null;
                for (var k in msgs) {
                    if (!Object.prototype.hasOwnProperty.call(msgs, k)) continue;
                    var c = msgs[k];
                    if (c && c.role === 'assistant' && (!m || (c.timestamp || 0) > (m.timestamp || 0))) m = c;
                }
            }
            if (!m) return null;
            var txt = typeof m.content === 'string' ? m.content : '';
            if (!txt) return null;
            return { text: txt, responseId: m.id || null };
        } catch (e) { return null; }
    }

    // Poll, because a long mode may still be writing when the stream drops.
    function recoverAnswer(chatId, attempts, delayMs) {
        var tries = attempts || 1;
        function attempt(n) {
            return readChat(chatId).then(function (j) {
                var got = latestAssistant(j);
                if (got && got.text) return got;
                if (n >= tries) return null;
                return new Promise(function (r) { setTimeout(r, delayMs || 15000); }).then(function () {
                    return attempt(n + 1);
                });
            }).catch(function () { return null; });
        }
        return attempt(1);
    }

    // ─── Request body ────────────────────────────────
    function buildBody(message, model, thinking, opts) {
        var parent = _parentId;
        var ct = (opts && opts.chatType) || 't2t';
        // §11.5: which of chat_type / auto_search actually switches web search on was
        // never isolated, so for any search-ish mode we set BOTH.
        var searchy = (ct === 'search' || ct === 'deep_research');
        var autoSearch = (opts && opts.autoSearch !== undefined) ? !!opts.autoSearch : searchy;
        // 'deep' is a GUESS from the report and was never validated by the server.
        var researchMode = (opts && opts.researchMode) || (ct === 'deep_research' ? 'deep' : 'normal');
        return {
            stream: true,
            version: '2.1',
            incremental_output: true,        // answer deltas are new chars only
            chatId: _chatId,
            parentId: parent === null ? '' : parent,
            chat_id: _chatId,
            chat_mode: 'normal',
            model: model,
            parent_id: parent,
            messages: [{
                id: null,
                fid: uuid4(),
                parentId: parent,
                childrenIds: [uuid4()],
                role: 'user',
                content: message,
                user_action: 'chat',
                files: (opts && opts.files) || [],
                timestamp: nowSec(),
                models: [model],
                model: '',
                chat_type: ct,
                feature_config: {
                    thinking_enabled: !!thinking,
                    output_schema: 'phase',   // puts delta.phase on every frame
                    research_mode: researchMode,
                    auto_thinking: false,
                    thinking_mode: thinking ? 'Thinking' : '',
                    thinking_format: 'summary',
                    auto_search: autoSearch
                },
                extra: { meta: { subChatType: ct } },
                sub_chat_type: ct,
                parent_id: parent
            }],
            timestamp: nowSec()
        };
    }

    // ─── SSE stream parser ───────────────────────────
    function parseStream(response, onDelta) {
        var reader = response.body.getReader();
        var decoder = new TextDecoder('utf-8');
        var buf = '';
        var text = '';
        var state = {
            responseId: null, usage: null, thinking: [], finished: false,
            dropped: 0,
            answerFrames: 0,        // how many phase:"answer" deltas carried content
            ids: {},                // every distinct top-level response_id seen
            dupChunks: 0,           // WEAK: chunk text seen before (noisy on tables/prose)
            restartFromStart: 0,    // STRONG: stream re-emitted its own opening
            firstChunk: null,
            phases: {}              // phase -> { n, keys, samples } — see the tally below
        };
        // Which response_id owns the answer we are assembling. Every frame carries a
        // top-level response_id; a single request has been observed returning answer
        // deltas for MORE THAN ONE of them, whose text then interleaves
        // character-by-character into one garbled paragraph. Lock onto the first
        // response_id that produces answer content and ignore the rest.
        var answerOwner = null;

        function handleLine(line) {
            line = line.replace(/\r$/, '');
            if (line.slice(0, 5) !== 'data:') return;
            var payload = line.slice(5).trim();
            if (!payload) return;
            if (payload === '[DONE]') { state.finished = true; return; }  // never observed; handled anyway

            var j;
            try { j = JSON.parse(payload); } catch (e) { return; }

            if (j['response.created']) {
                // Only the FIRST response.created defines the turn we are chaining from.
                if (!state.responseId) state.responseId = j['response.created'].response_id;
                return;
            }
            if (j.usage) state.usage = j.usage;

            var choice = j.choices && j.choices[0];
            var d = choice && choice.delta;
            if (!d) return;

            var frameId = j.response_id || null;
            if (frameId) state.ids[frameId] = (state.ids[frameId] || 0) + 1;

            // Tally every phase we see. search/deep_research were never fully captured
            // (§11.4), so any phase beyond the two known ones is recorded verbatim
            // rather than dropped — that is where search queries and source lists
            // would surface. Silently ignoring them is how a client ends up with an
            // empty answer and no idea why.
            if (d.phase) {
                if (!state.phases[d.phase]) state.phases[d.phase] = { n: 0, keys: {}, samples: [] };
                var ph = state.phases[d.phase];
                ph.n++;
                for (var k in d) { if (Object.prototype.hasOwnProperty.call(d, k)) ph.keys[k] = true; }
                if (d.phase !== 'answer' && d.phase !== 'thinking_summary' && ph.samples.length < 3) {
                    try { ph.samples.push(JSON.stringify(d).slice(0, 600)); } catch (e) { }
                }
            }

            // Thinking summary is re-broadcast byte-identical every frame —
            // REPLACE it, never append, or you get N copies of the same text.
            if (d.phase === 'thinking_summary') {
                if (d.extra) {
                    var st = d.extra.summary_title && d.extra.summary_title.content;
                    var sh = d.extra.summary_thought && d.extra.summary_thought.content;
                    state.thinking = [{
                        title: st && st.length ? st[0] : '',
                        thought: sh && sh.length ? sh[0] : ''
                    }];
                }
                return;
            }
            // Answer deltas ARE incremental — append.
            if (d.phase === 'answer') {
                if (frameId) {
                    if (answerOwner === null) answerOwner = frameId;
                    else if (frameId !== answerOwner) {
                        // A second concurrent generation. Appending it produces the
                        // interleaved-gibberish failure this guard exists for.
                        state.dropped++;
                        return;
                    }
                }
                if (d.content) {
                    state.answerFrames++;
                    // Two different things get conflated here, so measure them apart.
                    //
                    // dupChunks: this chunk's text already appears somewhere. On a long
                    // structured document this fires constantly on legitimate repeats —
                    // markdown table rules ("| :--- |"), blank lines, stock phrases — so
                    // it is a WEAK signal only. The 12-char threshold used originally
                    // reported 38 hits on a clean 22k-char report; treat it as noise
                    // unless restartFromStart also fires.
                    if (d.content.length >= 40 && text.indexOf(d.content) !== -1) state.dupChunks++;
                    // restartFromStart: the stream re-emitted its own opening. THAT is a
                    // genuine restart, and it is the failure that produces interleaved
                    // gibberish. Unambiguous, so it is the one worth acting on.
                    if (state.firstChunk && state.firstChunk.length >= 20 &&
                        d.content.indexOf(state.firstChunk) !== -1) state.restartFromStart++;
                    if (!state.firstChunk) state.firstChunk = d.content;
                    text += d.content;
                    if (onDelta) { try { onDelta(d.content); } catch (e) { } }
                }
                // No [DONE] and no finish_reason. This is the only terminator.
                if (d.status === 'finished') state.finished = true;
            }
        }

        function drain(flush) {
            var idx;
            while ((idx = buf.indexOf('\n')) !== -1) {
                handleLine(buf.slice(0, idx));
                buf = buf.slice(idx + 1);
            }
            if (flush && buf) { handleLine(buf); buf = ''; }
        }

        function pump() {
            return reader.read().then(function (r) {
                if (r.done) {
                    drain(true);
                    return { text: text, state: state };
                }
                buf += decoder.decode(r.value, { stream: true });
                drain(false);
                return pump();
            });
        }
        return pump();
    }

    // ─── send ────────────────────────────────────────
    // Resolves to a STRING (the answer text), matching the other four engines'
    // contract with provider-api.cjs. Thinking/usage go to __proximaQwen.lastMeta().
    // v5 engine contract is POSITIONAL: send(message, engine, attachments, sessionId).
    // `engine` is the provider:suffix from "qwen:deep_research" — Proxima already
    // splits it in providers/api.cjs, so the mode rides that existing channel and
    // needs no new plumbing. It arrives as 'auto' when no suffix was given.
    function send(message, engine, attachments, sessionId) {
        var o = (engine && typeof engine === 'object') ? engine : {};   // tolerate the old shape
        var model = o.model || DEFAULT_MODEL;
        var thinking = !!o.thinking;

        var chatType = o.chatType ||
            ((typeof engine === 'string' && engine && engine !== 'auto') ? engine : 't2t');
        if (CHAT_TYPES.indexOf(chatType) === -1) {
            return Promise.reject(new Error('Qwen: unknown chat_type "' + chatType +
                '". Valid: ' + CHAT_TYPES.join(', ')));
        }
        o.chatType = chatType;
        // deep_research is a long-running multi-step mode; 6 min is not enough.
        var timeout = (chatType === 'deep_research') ? DEEP_RESEARCH_TIMEOUT : TIMEOUT;

        return ensureChat(model, chatType).then(function () {
            var url = ORIGIN + '/api/v2/chat/completions?chat_id=' + encodeURIComponent(_chatId);
            var ctl = new AbortController();
            var tid = setTimeout(function () { ctl.abort(); }, timeout);

            return fetch(url, {
                method: 'POST',
                credentials: 'include',
                headers: headers(),
                body: JSON.stringify(buildBody(message, model, thinking, o)),
                signal: ctl.signal
            }).then(function (res) {
                var ct = res.headers.get('content-type') || '';
                if (ct.indexOf('event-stream') === -1) {
                    return res.text().then(function (t) {
                        clearTimeout(tid);
                        throw failureError(classifyFailure(ct, t), res.status);
                    });
                }
                if (!res.body) { clearTimeout(tid); throw new Error('Qwen: no response body stream'); }
                return parseStream(res, o.onDelta).then(function (r) {
                    clearTimeout(tid);
                    // One diagnostic line per turn. `ids>1` means concurrent responses
                    // (the response-id lock handles it). `restarts>0` with `ids=1` means
                    // a single stream replayed its own answer — a different bug needing
                    // a different fix. Both were candidates for the interleaving seen
                    // on long answers; this is how we tell them apart.
                    var idCount = Object.keys(r.state.ids).length;
                    var phaseNames = Object.keys(r.state.phases);
                    console.log('[Proxima] Qwen turn: mode=' + (o.chatType || 't2t') +
                        ' chars=' + r.text.length +
                        ' answerFrames=' + r.state.answerFrames +
                        ' responseIds=' + idCount +
                        ' dropped=' + r.state.dropped +
                        ' dupChunks=' + r.state.dupChunks +
                        ' restartFromStart=' + r.state.restartFromStart +
                        ' finished=' + r.state.finished +
                        ' phases=[' + phaseNames.map(function (p) {
                            return p + ':' + r.state.phases[p].n;
                        }).join(' ') + ']');
                    // Anything beyond the two known phases is undocumented territory.
                    // Print the raw sample so the shape can be read off directly rather
                    // than guessed at.
                    phaseNames.forEach(function (p) {
                        if (p === 'answer' || p === 'thinking_summary') return;
                        var e = r.state.phases[p];
                        console.warn('[Proxima] Qwen UNKNOWN phase "' + p + '" x' + e.n +
                            ' keys=' + Object.keys(e.keys).join(',') +
                            '\n  sample: ' + (e.samples[0] || '(none)'));
                    });
                    if (idCount > 1) {
                        console.warn('[Proxima] Qwen: ' + idCount + ' concurrent response_ids in one ' +
                            'stream; dropped ' + r.state.dropped + ' foreign answer frame(s).');
                    }
                    if (r.state.restartFromStart) {
                        console.warn('[Proxima] Qwen: the answer stream RE-EMITTED ITS OPENING ' +
                            r.state.restartFromStart + 'x — a genuine restart. The response-id lock ' +
                            'does not cover this; the text is probably garbled.');
                    } else if (r.state.dupChunks) {
                        console.log('[Proxima] Qwen: ' + r.state.dupChunks + ' repeated chunk(s) — expected ' +
                            'on long structured output (table rules, stock phrases). Not a restart.');
                    }
                    // Chain the next turn. History is NOT resent — turn 2 sends one
                    // message plus parent_id = this turn's response_id.
                    if (r.state.responseId) { _parentId = r.state.responseId; saveState(); }
                    _lastMeta = {
                        usage: r.state.usage,
                        thinking: r.state.thinking,
                        responseId: r.state.responseId,
                        finished: r.state.finished,
                        model: model,
                        chatType: chatType,
                        phases: r.state.phases,
                        responseIds: Object.keys(r.state.ids),
                        dropped: r.state.dropped,
                        dupChunks: r.state.dupChunks,
                        restartFromStart: r.state.restartFromStart
                    };
                    return r.text;
                });
            }).catch(function (e) {
                clearTimeout(tid);
                var aborted = e && e.name === 'AbortError';
                // A WAF/validation rejection is a real refusal — nothing was generated,
                // so do not go looking for an answer that does not exist.
                if (e && e.failure) throw e;

                console.warn('[Proxima] Qwen stream died (' + (aborted ? 'timeout' : (e && e.message)) +
                    ') in mode ' + chatType + '. The generation usually continues server-side, ' +
                    'so re-reading conversation ' + _chatId + ' to recover it.');

                if (!_chatId) {
                    if (aborted) throw new Error('Qwen: timed out after ' + (timeout / 1000) + 's (mode ' + chatType + ')');
                    throw e;
                }
                // Long modes may still be writing; poll rather than asking once.
                var tries = (chatType === 'deep_research') ? 20 : 3;
                return recoverAnswer(_chatId, tries, 15000).then(function (got) {
                    if (got && got.text) {
                        console.log('[Proxima] Qwen: RECOVERED ' + got.text.length +
                            ' chars from the conversation after the stream died.');
                        if (got.responseId) { _parentId = got.responseId; saveState(); }
                        _lastMeta = {
                            recovered: true, chatType: chatType, responseId: got.responseId,
                            usage: null, thinking: [], phases: {}, responseIds: [], dropped: 0, dupChunks: 0, restartFromStart: 0
                        };
                        return got.text;
                    }
                    if (aborted) throw new Error('Qwen: timed out after ' + (timeout / 1000) +
                        's (mode ' + chatType + ') and the conversation held no assistant reply.');
                    throw e;
                });
            });
        });
    }

    function newConversation() {
        _chatId = null;
        _parentId = null;
        _chatMode = null;
        _lastMeta = null;
        try { window.localStorage.removeItem(STORE_KEY); } catch (e) { }
        return true;
    }

    function listModels() {
        return fetch(ORIGIN + '/api/v2/models', {
            credentials: 'include',
            headers: { 'Accept': 'application/json', 'source': 'web', 'Version': FE_VERSION }
        }).then(function (r) { return r.json(); }).then(function (j) {
            return (j.data && j.data.data ? j.data.data : []).map(function (m) {
                return { id: m.id, name: m.name };
            });
        });
    }

    window.__proximaQwen = {
        send: send,
        newConversation: newConversation,
        listModels: listModels,
        lastMeta: function () { return _lastMeta; },
        state: function () { return { chatId: _chatId, parentId: _parentId }; }
    };

    loadState();   // survive the re-injection that follows a CAPTCHA or navigation
    console.log('[Proxima] Qwen engine ready (build ' + FE_VERSION + ')');
})();
