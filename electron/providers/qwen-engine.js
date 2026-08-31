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
 * 2. SIGNING IS PER-ENDPOINT, and matching the app matters more than signing hard.
 *    A capture of the real app shows bx-ua/bx-umidtoken/bx-v on chats/new and the
 *    chats/* GETs, and NOT on chat/completions or files/getstsToken. bx-* is not a
 *    hard gate anywhere — omitting it is served, it just accrues WAF risk score, and
 *    that accrual is what eventually plants a slider CAPTCHA on the session. So the
 *    rule is: sign exactly what the app signs. The values come from the Alibaba baxia
 *    SDK on the page, so this engine only works injected into the real page's main
 *    world — which is how Proxima runs it. See sign() for the bug that made this
 *    engine sign nothing at all for its first two days.
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

    // ─── State, PER CALLER ───────────────────────────
    // One engine instance serves every caller that reaches this page: the MCP tools, the
    // automation review loop, the repair loop, the QA video reviewer and the
    // orchestrator. They arrive over different sockets and are NOT serialised against
    // each other, so a single shared chat pointer is a collision waiting to happen.
    //
    // It happened. A `git push` fired the review loop while an orchestrated thread was
    // mid-conversation, and the review's "You are a senior code auditor" turn was
    // appended into the middle of that thread. The reviewer got the wrong context and
    // the orchestrator's conversation was polluted — with nothing logged anywhere.
    //
    // So state is keyed by session. A caller that names one gets its own conversation,
    // parent chain and mode; callers that name none share 'default', which preserves the
    // old single-thread behaviour for anything not yet updated.
    //
    // Still persisted, not merely in-memory: a CAPTCHA, a manual click or any navigation
    // destroys this script and Proxima re-injects a fresh copy, which would otherwise
    // lose the id of a conversation still generating server-side. An 11-minute
    // deep_research run died exactly that way.
    var STORE_KEY = '__proxima_qwen_state';
    var STATE_TTL_MS = 7200000;          // 2h
    var DEFAULT_SESSION = 'default';
    var _sessions = {};                  // key -> session object

    function newSession() {
        return {
            chatId: null,
            parentId: null,              // previous turn's response_id
            chatMode: null,              // chat_type the CURRENT chatId was created with
            lastMeta: null,              // { usage, thinking[], responseId, phases }
            // True when a caller named a specific conversation. ensureChat must then
            // trust the pin rather than starting a fresh chat on a mode mismatch.
            pinned: false
        };
    }

    /** The session object for a key, created on first use. */
    function sess(key) {
        var k = key || DEFAULT_SESSION;
        if (!_sessions[k]) _sessions[k] = newSession();
        return _sessions[k];
    }

    function loadState() {
        try {
            var raw = window.localStorage.getItem(STORE_KEY);
            if (!raw) return;
            var st = JSON.parse(raw);
            if (!st) return;
            // Older builds stored a single flat conversation. Adopt it as 'default' so an
            // upgrade in the middle of a live conversation does not strand it.
            var stored = st.sessions || (st.chatId ? { 'default': st } : null);
            if (!stored) return;
            var restored = 0;
            for (var k in stored) {
                if (!Object.prototype.hasOwnProperty.call(stored, k)) continue;
                var e = stored[k];
                if (!e || !e.chatId || (Date.now() - (e.ts || 0)) > STATE_TTL_MS) continue;
                var s = sess(k);
                s.chatId = e.chatId;
                s.parentId = e.parentId || null;
                s.chatMode = e.chatMode || null;
                s.pinned = !!e.pinned;
                restored++;
            }
            if (restored) {
                console.log('[Proxima] Qwen: resumed ' + restored + ' session(s): ' +
                    Object.keys(_sessions).map(function (k2) {
                        return k2 + '=' + _sessions[k2].chatId + '(' + _sessions[k2].chatMode + ')';
                    }).join(', '));
            }
        } catch (e) { /* storage blocked — degrade to in-memory */ }
    }

    function saveState() {
        try {
            var out = {};
            for (var k in _sessions) {
                if (!Object.prototype.hasOwnProperty.call(_sessions, k)) continue;
                var s = _sessions[k];
                if (!s.chatId) continue;
                out[k] = {
                    chatId: s.chatId, parentId: s.parentId, chatMode: s.chatMode,
                    pinned: s.pinned, ts: Date.now()
                };
            }
            window.localStorage.setItem(STORE_KEY, JSON.stringify({ sessions: out }));
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
    // The four above are load-bearing. The rest are the app's own trimmings — each was
    // deleted individually with no effect — but they are sent anyway so our request
    // matches the app's header set byte for byte. After being CAPTCHA'd once for
    // looking unlike the app (see sign()), fidelity is worth four free headers.
    // Timezone is the first 33 chars of JS Date.toString(), which is what the app does.
    function headers() {
        return {
            'Content-Type': 'application/json',
            'Version': FE_VERSION,
            'source': 'web',
            'X-Request-Id': uuid4(),
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Timezone': new Date().toString().slice(0, 33),
            'X-Accel-Buffering': 'no'
        };
    }

    // ─── baxia request signing ───────────────────────
    // Applied to chats/new and the chats/* GETs only, because that is exactly where a
    // header capture of the real app shows it. bx-* is not required by any endpoint —
    // unsigned requests are served — but omitting it accrues WAF risk score, and the
    // accrual is what eventually plants a slider CAPTCHA that then breaks everything.
    //
    // THE BUG THIS FIXES: the first cut gated signing on `window.baxiaCommon &&
    // window.um`. window.um does not exist on build 0.2.87 at all — the page's own
    // readiness gate (main.js `Bu`) reads __baxia__.getFYModule.getUidToken(). So the
    // condition was never true, sign() silently did nothing on every call, the session
    // submitted no fingerprint for two days, and the score ran up until
    // chat/completions started answering with a punish redirect instead of a stream.
    function umidToken() {
        try {
            if (window.__baxia__ && window.__baxia__.getFYModule) {
                return window.__baxia__.getFYModule.getUidToken();
            }
        } catch (e) { /* fall through */ }
        try { if (window.um && window.um.getToken) return window.um.getToken(); } catch (e) { }
        return null;
    }

    function signingReady() {
        try {
            return !!(window.baxiaCommon && window.baxiaCommon.getUA && window.baxiaInitialized && umidToken());
        } catch (e) { return false; }
    }

    function sign(h) {
        var ua = null, tok = null;
        try { ua = window.baxiaCommon && window.baxiaCommon.getUA({}); } catch (e) { }
        try { tok = umidToken(); } catch (e) { }
        if (!ua || !tok) {
            // Fatal on purpose. "Send unsigned and hope" is what the first cut did, and
            // the cost is not one failed request: it is a CAPTCHA'd session and a
            // multi-minute hang with no error. One second and a clear message beats it.
            var e = new Error('Qwen: baxia signing unavailable (' +
                (ua ? '' : 'no bx-ua; ') + (tok ? '' : 'no bx-umidtoken; ') +
                'baxiaInitialized=' + !!window.baxiaInitialized +
                '). Reload the Qwen tab and let the page finish booting its Alibaba SDKs.');
            e.failure = { kind: 'unsigned', hint: 'signing SDK not available on the page' };
            throw e;
        }
        h['bx-ua'] = ua;
        h['bx-umidtoken'] = tok;
        h['bx-v'] = (window.baxiaCommon && window.baxiaCommon.version) || '2.5.37';
        return h;
    }

    // The SDKs finish booting a moment after load, and a send fired in that window
    // would otherwise take the fatal path above for a condition that fixes itself.
    function waitForSigning(timeoutMs) {
        if (signingReady()) return Promise.resolve(true);
        var deadline = Date.now() + (timeoutMs || 10000);
        return new Promise(function (resolve) {
            (function poll() {
                if (signingReady()) return resolve(true);
                if (Date.now() > deadline) return resolve(false);
                setTimeout(poll, 250);
            })();
        });
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
        // baxia/sufei_data are page globals — see sign() and header comment #2.
        var h = sign(headers());

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
    function ensureChat(model, chatType, S) {
        var want = chatType || 't2t';
        if (S.chatId && S.chatMode === want) return Promise.resolve(S.chatId);
        // A pinned conversation is used as given. Its real chat_type is unreadable, so
        // replacing it on a suspected mismatch would throw away the thread the caller
        // explicitly asked for — the one thing a pin must never do.
        if (S.chatId && S.pinned) {
            if (S.chatMode && S.chatMode !== want) {
                console.warn('[Proxima] Qwen: pinned conversation was created as ' + S.chatMode +
                    ' but ' + want + ' was requested. chat_type is fixed at creation, so the ' +
                    'conversation keeps its original mode.');
            }
            return Promise.resolve(S.chatId);
        }
        if (S.chatId && S.chatMode !== want) {
            console.log('[Proxima] Qwen: mode ' + S.chatMode + ' -> ' + want +
                '; starting a new conversation (chat_type is fixed at creation).');
            S.parentId = null;
        }
        return createChat(model, want).then(function (id) {
            S.chatId = id;
            S.chatMode = want;
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
        // Signed: the app fingerprints every /api/v2/chats/* GET, and these recovery
        // reads are the cheapest place to keep the session's score healthy.
        var h = { 'Accept': 'application/json', 'source': 'web', 'Version': FE_VERSION };
        try { sign(h); } catch (e) { /* recovery must not fail over a missing SDK */ }
        return fetch(ORIGIN + '/api/v2/chats/' + encodeURIComponent(chatId), {
            credentials: 'include',
            headers: h
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

    // ─── Attachments ─────────────────────────────────
    // Step 1 of 3. Qwen takes no bytes on the chat endpoint: the client asks for
    // short-lived Alibaba STS credentials, PUTs the file straight to OSS itself, and
    // then names the result in messages[0].files. Only this step has to happen in the
    // page — it is a baxia-signed path and it rides the session cookie. The upload
    // and the descriptor live in electron/providers/qwen-upload.cjs, where Node can
    // stream a 500MB video off disk instead of pushing base64 through
    // executeJavaScript.
    //
    // `meta` is { filename, filesize (string), filetype: image|video|audio|file }.
    // Note filesize is a STRING on the wire — the app stringifies it and a number was
    // never tested.
    // Resolves to the camelCased token, or throws through the usual classifier.
    function getUploadToken(meta) {
        // NOT signed. A capture of the app's own image and video uploads shows exactly
        // Accept, Content-Type, Accept-Language, Version, source, X-Request-Id and
        // Timezone on this request — no bx-* and no bearer.
        var h = headers();
        // The one exception: the app's uploader adds a bearer if localStorage.token is
        // set, which it is under Proxima. It was absent in the capture because that
        // session had no such key. Conditional, so we match the app either way.
        try { if (window.localStorage.token) h['Authorization'] = 'Bearer ' + window.localStorage.token; } catch (e) { }

        return fetch(ORIGIN + '/api/v2/files/getstsToken', {
            method: 'POST',
            credentials: 'include',
            headers: h,
            body: JSON.stringify(meta || {})
        }).then(function (res) {
            var ct = res.headers.get('content-type') || '';
            return res.text().then(function (txt) {
                var j = null;
                try { j = JSON.parse(txt); } catch (e) { /* handled below */ }
                if (!j || !j.success || !j.data) {
                    // Same rule as everywhere else in this API: 200 is not success.
                    var f = classifyFailure(ct, txt);
                    if (f) throw failureError(f, res.status);
                    throw new Error('Qwen getstsToken: ' + txt.slice(0, 300));
                }
                var d = j.data;
                return {
                    accessKeyId: d.access_key_id,
                    accessKeySecret: d.access_key_secret,
                    stsToken: d.security_token,
                    bucket: d.bucketname,
                    region: d.region,
                    endpoint: d.endpoint,
                    fileId: d.file_id,
                    filePath: d.file_path,
                    fileCDNUrl: d.file_url
                };
            });
        });
    }

    // The id the NEXT turn should chain from. Deliberately separate from
    // latestAssistant(): that one exists to recover an answer's TEXT after a dead
    // stream and returns nothing when the text is empty — and a re-read of a finished
    // conversation shows assistant messages with empty content, so using it here
    // silently produced a null parent and a branch from the root. The thread looked
    // resumed and the model saw none of it.
    //
    // history.currentId is the server's own leaf pointer, the same idea as Claude's
    // current_leaf_message_uuid, so prefer it and only fall back to scanning.
    function latestResponseId(chatJson) {
        try {
            var d = chatJson && chatJson.data;
            var chat = d && d.chat;
            var hist = chat && chat.history;
            var leaf = (hist && hist.currentId) || (d && d.currentId) || null;
            var msgs = (hist && hist.messages) || {};
            if (leaf && msgs[leaf] && msgs[leaf].role === 'assistant') return leaf;
            // Fall back to the newest assistant message, by timestamp, text or not.
            var best = null;
            for (var k in msgs) {
                if (!Object.prototype.hasOwnProperty.call(msgs, k)) continue;
                var m = msgs[k];
                if (!m || m.role !== 'assistant') continue;
                if (!best || (m.timestamp || 0) > (best.timestamp || 0)) best = m;
            }
            return best ? (best.id || null) : (leaf || null);
        } catch (e) { return null; }
    }
    // ─── Conversation targeting ─────────────────────
    // Pin a specific Qwen conversation, so an orchestrator can keep one long-lived
    // thread rather than depending on whatever this page last used.
    //
    // Harder than the Claude equivalent for two reasons, both protocol-level:
    //
    // 1. Qwen threads by parent_id, and it does NOT resolve the leaf for us. Sending
    //    with parentId null into a chat that already has history starts a new branch
    //    from the root, so the model sees none of it — the resume would look like it
    //    worked and quietly lose the entire conversation. So the last assistant
    //    response_id is recovered from the server first, via the same readChat() the
    //    stream-death recovery path uses, and used as the parent.
    // 2. chat_type is fixed when a conversation is CREATED and cannot change. A pinned
    //    chat therefore carries whatever mode it was made with. We cannot read that
    //    back, so _chatMode is set to null — "unknown" — which makes ensureChat trust
    //    the pin instead of silently starting a fresh conversation on a mode mismatch.
    //    The caller is warned when it asks for a mode we cannot verify.
    function setConversation(chatId, wantedMode, S) {
        if (!chatId || typeof chatId !== 'string') {
            return Promise.reject(new Error('setConversation: chatId required'));
        }
        var m = chatId.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
        if (!m) {
            return Promise.reject(new Error('setConversation: not a uuid or chat.qwen.ai URL: ' +
                String(chatId).slice(0, 80)));
        }
        var id = m[1];
        return readChat(id).then(function (j) {
            if (!j || !j.data || !j.data.chat) {
                throw new Error('Qwen: conversation ' + id + ' not found or not readable');
            }
            S.chatId = id;
            S.pinned = true;
            // Unknown until proven otherwise — see note 2 above.
            S.chatMode = wantedMode || null;
            S.parentId = latestResponseId(j);
            saveState();
            console.log('[Proxima] Qwen: pinned conversation ' + id +
                (S.parentId ? ' (chained to response ' + S.parentId + ')'
                           : ' (no prior assistant turn; starting at root)'));
            return { chatId: S.chatId, parentId: S.parentId };
        });
    }

    function getConversation(S) { return S.chatId; }

    // ─── Request body ────────────────────────────────
    function buildBody(message, model, thinking, opts, S) {
        var parent = S.parentId;
        var ct = (opts && opts.chatType) || 't2t';
        // §11.5: which of chat_type / auto_search actually switches web search on was
        // never isolated, so for any search-ish mode we set BOTH.
        var searchy = (ct === 'search' || ct === 'deep_research');
        var autoSearch = (opts && opts.autoSearch !== undefined) ? !!opts.autoSearch : searchy;
        // 'deep' is a GUESS from the report and was never validated by the server.
        // Was `deep` for deep_research. A full capture of a real 7-minute run shows
        // research_mode staying 'normal' on BOTH turns — that field is not the switch,
        // sub_chat_type is. The old value was a guess this engine shipped as if measured.
        var researchMode = (opts && opts.researchMode) || 'normal';
        // chat_type and sub_chat_type are identical in every mode EXCEPT deep research,
        // where chat_type stays deep_research while sub_chat_type moves deep_thinking ->
        // deep_research between the two turns. So they need to be separable.
        var sct = (opts && opts.subChatType) || ct;
        // Attachment descriptors, already uploaded to OSS by qwen-upload.cjs. The app
        // omits the key entirely when there is nothing attached rather than sending
        // an empty array (main.js createUserMessage: `files.length > 0 ? files : void 0`),
        // so match that instead of inventing a third state the server never sees.
        var files = (opts && opts.files) || [];
        var body = {
            stream: true,
            version: '2.1',
            incremental_output: true,        // answer deltas are new chars only
            chatId: S.chatId,
            parentId: parent === null ? '' : parent,
            chat_id: S.chatId,
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
                extra: { meta: { subChatType: sct } },
                sub_chat_type: sct,
                parent_id: parent
            }],
            timestamp: nowSec()
        };
        if (files.length) body.messages[0].files = files;
        return body;
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
            phases: {},             // phase -> { n, keys, samples } — see the tally below
            reportFiles: null,      // deep research: signed pdf/md links from PdfMdGen
            researchQueries: []     // deep research: one per parallel thread
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
            // Deep research hangs its state off extra.deep_research. Two things are
            // worth keeping: the terminal PdfMdGen frame, which carries signed links to
            // the report as PDF and Markdown, and the WebResearch frames, which name
            // the parallel research threads the model spawned.
            if (d.extra && d.extra.deep_research) {
                var dr = d.extra.deep_research;
                if (dr.pdf || dr.md) {
                    state.reportFiles = {
                        pdf: dr.pdf ? { name: dr.pdf.name, size: dr.pdf.size, link: dr.pdf.link } : null,
                        md: dr.md ? { name: dr.md.name, size: dr.md.size, link: dr.md.link } : null
                    };
                }
                // WebResearch keys this dict by stringified thread index, not as a flat
                // object, so walk it rather than reading fields off the top.
                for (var rk in dr) {
                    if (!Object.prototype.hasOwnProperty.call(dr, rk)) continue;
                    var th = dr[rk];
                    if (th && th.query && state.researchQueries.indexOf(th.query) === -1) {
                        state.researchQueries.push(th.query);
                    }
                }
            }

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

    // ─── deep_research is TWO turns ──────────────────
    // A capture of a real run settled this, and it is not what this engine assumed:
    //
    //   chats/new              chat_type: "deep_research"     (NOT t2t)
    //   turn 1                 sub_chat_type: "deep_thinking"    31 frames,   4.2s
    //   turn 2                 sub_chat_type: "deep_research"  2537 frames, 436.7s
    //
    // Turn 1 does NOT research. It returns a ~550-char clarifying question asking what to
    // focus on. Turn 2, chained on turn 1's response id, is the seven-minute run that
    // actually does the work.
    //
    // So a single-turn deep_research call — which is what this engine did — returns the
    // clarifying question and nothing else, and the caller has no way to tell that apart
    // from a finished answer. It reads as a fast, oddly vague research result.
    //
    // The auto-reply below exists only to unblock turn 2. It is deliberately neutral and
    // overridable via options.researchReply, because putting words in the user's mouth is
    // the one thing that could quietly narrow the research.
    var DEEP_RESEARCH_REPLY =
        'You decide the scope and focus. Proceed with the research now.';

    function deepResearch(message, o, S) {
        var reply = o.researchReply || DEEP_RESEARCH_REPLY;
        // Turn 1. Same chatType, so ensureChat creates/keeps ONE deep_research
        // conversation and turn 2 chains onto it by parentId as usual.
        var t1Opts = {};
        for (var k in o) { if (Object.prototype.hasOwnProperty.call(o, k)) t1Opts[k] = o[k]; }
        t1Opts.subChatType = 'deep_thinking';
        t1Opts._drTurn = 1;

        return send(message, t1Opts).then(function (clarifying) {
            var m1 = S.lastMeta || {};
            console.log('[Proxima] Qwen deep_research turn 1 (deep_thinking): ' +
                String(clarifying).length + ' chars — this is the clarifying question, ' +
                'not the research. Proceeding to turn 2.');

            var t2Opts = {};
            for (var k2 in o) { if (Object.prototype.hasOwnProperty.call(o, k2)) t2Opts[k2] = o[k2]; }
            t2Opts.subChatType = 'deep_research';
            t2Opts._drTurn = 2;

            return send(reply, t2Opts).then(function (research) {
                // Keep turn 1's question on the meta: it is the only record of what the
                // model wanted narrowed, and it explains the shape of the answer.
                if (S.lastMeta) {
                    S.lastMeta.clarifyingQuestion = String(clarifying);
                    S.lastMeta.researchReply = reply;
                    S.lastMeta.turns = 2;
                }
                return research;
            });
        });
    }

    // Abort an in-flight generation. Worth having when one call can run seven minutes:
    // without it a caller that gives up leaves the model working server-side.
    // Plain request, no bx-* signing.
    function stopGeneration(chatId, S) {
        var cid = chatId || S.chatId;
        if (!cid) return Promise.resolve(false);
        return fetch(ORIGIN + '/api/v2/chat/completions/stop', {
            method: 'POST',
            credentials: 'include',
            headers: headers(),
            body: JSON.stringify({ chat_id: cid })
        }).then(function (r) { return r.ok; }).catch(function () { return false; });
    }

    // ─── send ────────────────────────────────────────
    // Resolves to a STRING (the answer text), matching the other four engines'
    // contract with provider-api.cjs. Thinking/usage go to __proximaQwen.lastMeta().
    function send(message, options) {
        var o = options || {};
        // Resolved ONCE, here, and threaded through everything below. Reading it
        // again later would reintroduce the shared-pointer bug for any caller that
        // interleaves with another.
        var S = sess(o.session);
        var model = o.model || DEFAULT_MODEL;
        var thinking = !!o.thinking;

        var chatType = o.chatType || 't2t';
        if (CHAT_TYPES.indexOf(chatType) === -1) {
            return Promise.reject(new Error('Qwen: unknown chat_type "' + chatType +
                '". Valid: ' + CHAT_TYPES.join(', ')));
        }
        o.chatType = chatType;
        // An explicit conversationId pins the thread before anything else happens, so
        // ensureChat below reuses it rather than creating a new one.
        if (o.conversationId && o.conversationId !== S.chatId) {
            return setConversation(o.conversationId, chatType, S).then(function () {
                var o2 = {};
                for (var k in o) { if (Object.prototype.hasOwnProperty.call(o, k)) o2[k] = o[k]; }
                delete o2.conversationId;
                return send(message, o2);
            });
        }
        // deep_research needs two turns; deepResearch() calls back into send() for each
        // one with an explicit subChatType. The _drTurn guard stops that recursing.
        if (chatType === 'deep_research' && !o._drTurn) {
            return deepResearch(message, o, S);
        }
        // deep_research is a long-running multi-step mode; 6 min is not enough.
        var timeout = (chatType === 'deep_research') ? DEEP_RESEARCH_TIMEOUT : TIMEOUT;

        // Both requests below are signed, so wait out the SDK boot rather than
        // failing a send that was fired a second too early after a page load.
        return waitForSigning(10000).then(function () {
            return ensureChat(model, chatType, S);
        }).then(function () {
            var url = ORIGIN + '/api/v2/chat/completions?chat_id=' + encodeURIComponent(S.chatId);
            var ctl = new AbortController();
            var tid = setTimeout(function () { ctl.abort(); }, timeout);

            return fetch(url, {
                method: 'POST',
                credentials: 'include',
                // NOT signed, deliberately. A header capture of the real app across 27
                // requests shows chat/completions is the one request it does not
                // fingerprint — no bx-ua, no bx-umidtoken, no bx-v, no bearer. Adding
                // them here would make our send the only one on the wire that looks
                // unlike the app's. The four headers below are the whole requirement.
                headers: headers(),
                body: JSON.stringify(buildBody(message, model, thinking, o, S)),
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
                        ' attachments=' + ((o.files && o.files.length) || 0) +
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
                    if (r.state.responseId) { S.parentId = r.state.responseId; saveState(); }
                    S.lastMeta = {
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
                        restartFromStart: r.state.restartFromStart,
                        reportFiles: r.state.reportFiles,
                        researchQueries: r.state.researchQueries
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
                    'so re-reading conversation ' + S.chatId + ' to recover it.');

                if (!S.chatId) {
                    if (aborted) throw new Error('Qwen: timed out after ' + (timeout / 1000) + 's (mode ' + chatType + ')');
                    throw e;
                }
                // Long modes may still be writing; poll rather than asking once.
                var tries = (chatType === 'deep_research') ? 20 : 3;
                return recoverAnswer(S.chatId, tries, 15000).then(function (got) {
                    if (got && got.text) {
                        console.log('[Proxima] Qwen: RECOVERED ' + got.text.length +
                            ' chars from the conversation after the stream died.');
                        if (got.responseId) { S.parentId = got.responseId; saveState(); }
                        S.lastMeta = {
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

    function newConversation(S) {
        S.chatId = null;
        S.parentId = null;
        S.chatMode = null;
        S.pinned = false;
        S.lastMeta = null;
        try { window.localStorage.removeItem(STORE_KEY); } catch (e) { }
        return true;
    }

    // Cached for the page's lifetime: the roster changes on Qwen's release cadence,
    // not within a session, and checkAttachmentSupport() would otherwise refetch it on
    // every attached turn.
    var _models = null;

    function fetchModels() {
        if (_models) return Promise.resolve(_models);
        return fetch(ORIGIN + '/api/v2/models', {
            credentials: 'include',
            headers: { 'Accept': 'application/json', 'source': 'web', 'Version': FE_VERSION }
        }).then(function (r) { return r.json(); }).then(function (j) {
            _models = (j.data && j.data.data ? j.data.data : []).map(function (m) {
                var meta = (m.info && m.info.meta) || {};
                return {
                    id: m.id, name: m.name,
                    capabilities: meta.capabilities || {},
                    modality: meta.modality || [],
                    chatTypes: meta.chat_type || []
                };
            });
            return _models;
        });
    }

    function listModels() {
        return fetchModels().then(function (list) {
            return list.map(function (m) {
                return { id: m.id, name: m.name, modality: m.modality };
            });
        });
    }

    // file_class (what qwen-upload classified the file as) -> the capability flag the
    // model has to declare in GET /api/v2/models.
    var CLASS_CAPABILITY = {
        vision: 'vision', video: 'video', audio: 'audio',
        document: 'document', 'default': 'document'
    };

    // Guards against the quietest failure in this whole path: pin a text-only model
    // (qwen3.7-max declares modality ['text']) and the attachment uploads fine, the
    // send succeeds, and the model simply never sees the file. No error anywhere.
    // Called BEFORE the upload so a 226MB video is not pushed for nothing.
    function checkAttachmentSupport(model, fileClasses) {
        var classes = fileClasses || [];
        if (!classes.length) return Promise.resolve({ ok: true, model: model || DEFAULT_MODEL });
        var target = model || DEFAULT_MODEL;
        var needed = {};
        classes.forEach(function (c) {
            var cap = CLASS_CAPABILITY[c];
            if (cap) needed[cap] = true;
        });
        var names = Object.keys(needed);
        return fetchModels().then(function (list) {
            var m = null;
            for (var i = 0; i < list.length; i++) { if (list[i].id === target) { m = list[i]; break; } }
            // An id we do not recognise is not necessarily wrong — the roster changes.
            // Let the server be the judge rather than blocking on stale local knowledge.
            if (!m) return { ok: true, model: target, unverified: true };
            var missing = names.filter(function (n) { return !m.capabilities[n]; });
            if (missing.length) {
                var has = Object.keys(m.capabilities).filter(function (k) { return m.capabilities[k]; });
                throw new Error('Qwen: model "' + target + '" does not accept ' +
                    missing.join('/') + ' input (it declares: ' + (has.join(', ') || 'none') +
                    '; modality ' + JSON.stringify(m.modality) + '). The attachment would upload ' +
                    'and then be silently ignored. Use a multimodal model such as ' + DEFAULT_MODEL + '.');
            }
            return { ok: true, model: target, modality: m.modality };
        });
    }

    // Public surface. Every conversation-scoped entry point takes a SESSION KEY and
    // resolves it here, so callers never see the internal session objects and a caller
    // that passes nothing keeps the old single-thread behaviour under "default".
    window.__proximaQwen = {
        send: send,
        newConversation: function (session) { return newConversation(sess(session)); },
        setConversation: function (chatId, session) {
            return setConversation(chatId, null, sess(session));
        },
        getConversation: function (session) { return getConversation(sess(session)); },
        stopGeneration: function (chatId, session) { return stopGeneration(chatId, sess(session)); },
        lastMeta: function (session) { return sess(session).lastMeta; },
        state: function (session) {
            var S = sess(session);
            return { chatId: S.chatId, parentId: S.parentId, pinned: S.pinned, chatMode: S.chatMode };
        },
        // Every live session at once — for diagnosing exactly the collision this
        // design exists to prevent.
        sessions: function () {
            var out = {};
            for (var k in _sessions) {
                if (!Object.prototype.hasOwnProperty.call(_sessions, k)) continue;
                out[k] = { chatId: _sessions[k].chatId, chatMode: _sessions[k].chatMode,
                           pinned: _sessions[k].pinned };
            }
            return out;
        },
        listModels: listModels,
        getUploadToken: getUploadToken,
        checkAttachmentSupport: checkAttachmentSupport,
        defaultModel: function () { return DEFAULT_MODEL; }
    };

    loadState();   // survive the re-injection that follows a CAPTCHA or navigation
    console.log('[Proxima] Qwen engine ready (build ' + FE_VERSION + ')');
})();
