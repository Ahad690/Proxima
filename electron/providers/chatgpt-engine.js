/**
 * Proxima — ChatGPT Engine v4.1.0
 * Runs inside chatgpt.com BrowserView context. Uses session cookies for auth,
 * solves SHA3-512 proof-of-work challenges, and streams responses via SSE.
 * Requires DOM access (navigator/screen) for proof-of-work challenges.
 */
(function() {
    if (window.__proximaChatGPT) return;

    var CHATGPT_BASE = 'https://chatgpt.com';
    var TIMEOUT = 360000;


    // ─── Attachment upload (in-page steps) ──────────
    // Captured 2026-09-25. Only these three touch chatgpt.com; the bytes go straight
    // to Azure from Node — see providers/chatgpt-upload.cjs for why.

    // Step 1: reserve the file and get a pre-signed blob URL back.
    async function createUpload(meta) {
        var token = await _getToken();
        var headers = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
        if (_accountId) headers['ChatGPT-Account-Id'] = _accountId;
        var body = {
            file_name: meta.name,
            file_size: meta.size,
            use_case: 'multimodal',
            timezone_offset_min: new Date().getTimezoneOffset(),
            reset_rate_limits: false,
            supports_direct_azure_multipart: true,
            mime_type: meta.mime,
            entry_surface: 'chat_composer',
            selection_method: 'file_picker',
            client_resolved_mime_type: meta.mime,
            mime_resolution_source: 'filename_extension',
            store_in_library: true,
            library_persistence_mode: 'opportunistic'
        };
        var res = await fetch('/backend-api/files', {
            method: 'POST', credentials: 'include', headers: headers,
            body: JSON.stringify(body)
        });
        if (!res.ok) {
            var errTxt = await res.text();
            throw new Error('ChatGPT file create failed (' + res.status + '): ' + errTxt.slice(0, 300));
        }
        var j = await res.json();
        if (!j || !j.upload_url || !j.file_id) {
            throw new Error('ChatGPT file create returned no upload_url/file_id');
        }
        return { uploadUrl: j.upload_url, fileId: j.file_id };
    }

    // Step 3: tell the server the bytes have landed. The response is a stream of
    // file.processing.* events; the turn only needs it to have been accepted, so the
    // body is drained rather than parsed.
    async function finalizeUpload(meta) {
        var token = await _getToken();
        var headers = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
        if (_accountId) headers['ChatGPT-Account-Id'] = _accountId;
        var res = await fetch('/backend-api/files/process_upload_stream', {
            method: 'POST', credentials: 'include', headers: headers,
            body: JSON.stringify({
                file_id: meta.fileId,
                use_case: 'multimodal',
                index_for_retrieval: false,
                file_name: meta.name,
                library_persistence_mode: 'opportunistic',
                entry_surface: 'chat_composer',
                metadata: {
                    store_in_library: true,
                    is_temporary_chat: false,
                    library_eligibility_reason: 'eligible',
                    is_project_thread: false
                },
                mime_type: meta.mime
            })
        });
        if (!res.ok) {
            var e1 = await res.text();
            throw new Error('ChatGPT finalize failed (' + res.status + '): ' + e1.slice(0, 300));
        }
        try { await res.text(); } catch (e) { }
        return true;
    }

    // Step 4: metadata. library_file_id belongs in the attachment descriptor; the rest
    // is informational. A failure here is NOT fatal — the turn can reference the file
    // without it, so the caller keeps going rather than losing an uploaded file.
    async function uploadedFileInfo(fileId) {
        var token = await _getToken();
        var headers = { 'Authorization': 'Bearer ' + token };
        if (_accountId) headers['ChatGPT-Account-Id'] = _accountId;
        var res = await fetch('/backend-api/files/' + encodeURIComponent(fileId) + '/simple',
            { credentials: 'include', headers: headers });
        if (!res.ok) return null;
        try { return await res.json(); } catch (e) { return null; }
    }

    // ─── Default model and effort ───────────────────
    // GPT-5.6 Sol on the thinking lane, at the picker's "High" preset.
    //
    // Read off /backend-api/models -> versions[id=5.6].intelligence_presets, which is
    // where the app encodes what each picker entry actually sends:
    //   Instant  gpt-5-6-instant
    //   Medium   gpt-5-6-thinking   thinking_effort 'standard'
    //   High     gpt-5-6-thinking   thinking_effort 'extended'
    // So 'extended' IS high — it is not a third level above it.
    //
    // NOT gpt-6-sol-wm. That slug is listed by /backend-api/models and looks like the
    // obvious pick for "GPT-6 Sol", but it is in no versions[].slugs and this account
    // cannot use it: asking for it returns a reply whose model_slug is gpt-5-6 — the
    // INSTANT lane. Measured, all four downgrading identically:
    //   gpt-6-sol-wm   -> gpt-5-6     gpt-6-luna-wm  -> gpt-5-6
    //   gpt-6-astra-wm -> gpt-5-6     gpt-5.6-sol-wm -> gpt-5-6
    // Defaulting to it would have silently removed thinking altogether. The 5.6 family
    // is itself branded "Sol" (gpt-5-6* all carry the title "GPT-5.6 Sol"), which is
    // where the name confusion comes from.
    //
    // Do not verify a slug by reading message.metadata.model_slug back and comparing:
    // a deliberately bogus 'gpt-6-nonexistent-zz' came back echoed as itself, so that
    // field confirms nothing on its own. Only the server REWRITING it is evidence.
    // gpt-6-astra-wm is NOT the default, though it is the one we want. Measured on a
    // fresh conversation against the live engine: asking for it returns a reply whose
    // model_slug is gpt-5-6, the INSTANT lane — a downgrade, not an upgrade — while the
    // effort field IS honoured (the reply carries max). Same for luna/astra/sol -wm.
    //
    // The missing piece is the rest of the captured flow, not the payload: the app posts
    // to /backend-api/f/conversation after a /f/conversation/prepare call whose
    // conduit_token rides back as x-conduit-token. Implement that and this can move to
    // 'gpt-6-astra-wm' with DEFAULT_EFFORT 'max'.
    //
    // Until then the thinking lane is the best that actually serves: 'extended' is the
    // 5.6 picker's High preset, and High is its maximum.
    var DEFAULT_MODEL = 'gpt-5-6-thinking';
    var DEFAULT_EFFORT = 'extended';

    // Efforts seen on the wire. 'standard'/'extended' are the 5.6 picker's Medium/High;
    // 'max' is what the app sends for Astra. Not a closed list — it is what has been
    // observed, and the server has not been made to enumerate it.
    var EFFORTS_SEEN = ['standard', 'extended', 'max'];

    // ─── State ───────────────────────────────────────
    var _conversationId = null;
    var _parentMessageId = null;
    var _cachedToken = null;
    var _tokenExpiry = 0;
    var _accountId = null;      // ChatGPT-Account-Id, needed to resolve image assets
    var _lastImages = [];       // generated images from the most recent turn

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

    // ─── Generated images ────────────────────────────
    // Image turns do NOT arrive as the assistant speaking. They come back as a separate
    // message whose author.role is "tool" (name is an opaque per-tool token), carrying
    // content_type "multimodal_text" and a single object part:
    //
    //   { content_type: "image_asset_pointer",
    //     asset_pointer: "sediment://file_0000...",   // NOT file-service://
    //     mime_type: "image/png", size_bytes, width, height,
    //     metadata: { dalle: {gen_id, ...}, generation: {...} } }
    //
    // So the reason images were silently lost was never the parts.join('') below — that
    // line is correct for text and simply never ran, because the author.role === 'assistant'
    // filter excluded the entire message first. Verified by capture, not inferred.
    var IMAGE_PART = 'image_asset_pointer';

    /** Pull asset pointers out of any message, whatever role it claims. */
    function collectImageParts(msg, into) {
        var c = msg && msg.content;
        if (!c || !c.parts || !c.parts.length) return;
        for (var i = 0; i < c.parts.length; i++) {
            var p = c.parts[i];
            if (!p || typeof p !== 'object' || p.content_type !== IMAGE_PART) continue;
            if (!p.asset_pointer) continue;
            // "sediment://file_abc" -> "file_abc". The scheme is decoration; the download
            // endpoint takes the bare id.
            var id = String(p.asset_pointer).replace(/^[a-z]+:\/\//i, '');
            if (into.some(function (x) { return x.id === id; })) continue;
            var meta = p.metadata || {};
            into.push({
                id: id,
                assetPointer: p.asset_pointer,
                mimeType: p.mime_type || null,
                width: p.width || null,
                height: p.height || null,
                sizeBytes: p.size_bytes || null,
                genId: (meta.dalle && meta.dalle.gen_id) || (meta.generation && meta.generation.gen_id) || null
            });
        }
    }

    /**
     * Resolve one asset id to a fetchable URL.
     *
     * Needs the session's bearer — cookies alone return 404, which was measured, not
     * assumed. The URL it returns is self-contained and needs no auth at all, which is
     * what lets the main process download it without the token ever leaving this page.
     *
     * The returned URL EXPIRES in under three minutes (measured: worked immediately,
     * 403 "File stream access denied" after 173s). So it is resolved at the end of the
     * turn and handed straight over — never stored for later.
     */
    async function resolveImageUrl(fileId, conversationId) {
        var token = await _getToken();
        var url = '/backend-api/files/download/' + encodeURIComponent(fileId) +
            (conversationId ? '?conversation_id=' + encodeURIComponent(conversationId) + '&inline=true'
                            : '?inline=true');
        var headers = { 'Authorization': 'Bearer ' + token };
        if (_accountId) headers['ChatGPT-Account-Id'] = _accountId;
        var res = await fetch(url, { credentials: 'include', headers: headers });
        if (!res.ok) throw new Error('resolve ' + fileId + ' failed (' + res.status + ')');
        var j = await res.json();
        if (!j || !j.download_url) throw new Error('resolve ' + fileId + ' returned no download_url');
        return { downloadUrl: j.download_url, fileName: j.file_name || null, bytes: j.file_size_bytes || null };
    }

    /**
     * Read image pointers back out of a STORED conversation.
     *
     * This is not a fallback, it is the primary path for generation, and the measurement
     * says why: an image turn took 74.7s end to end (create_time to update_time) while the
     * streaming read returned after 30.6s with nothing. Catching the asset live means
     * racing a generator that is slower than the stream.
     *
     * Note the response SHAPE depends on the query string. With num_turns the payload is
     * `messages` — a flat array — NOT the `mapping` object the endpoint returns bare. A
     * parser written for `mapping` silently finds zero here, which is exactly what happened
     * on the first attempt.
     */
    async function fetchConversationImages(convId) {
        if (!convId) return { images: [], settled: false };
        var token = await _getToken();
        var headers = { 'Authorization': 'Bearer ' + token };
        if (_accountId) headers['ChatGPT-Account-Id'] = _accountId;
        var res = await fetch('/backend-api/conversations/' + encodeURIComponent(convId) +
            '?num_turns=10&include_has_versions=true', { credentials: 'include', headers: headers });
        if (!res.ok) throw new Error('conversation read failed (' + res.status + ')');
        var j = await res.json();
        var msgs = Array.isArray(j.messages) ? j.messages
                 : Object.keys(j.mapping || {}).map(function (k) { return j.mapping[k].message; });
        // ONLY the latest rendered output, never the whole conversation.
        //
        // This scanned every message and settled if ANY assistant text reply had ever
        // finished. Send a text question and then ask for an image in the same thread,
        // and the poll returns instantly on the OLD reply and reports no image —
        // measured, that is exactly what happened. Scanning everything would also
        // re-save an image generated several turns earlier as though it were new.
        //
        // `channel: "final"` marks a turn's rendered output, so the last such message is
        // this turn's: multimodal_text means an image landed, text means it answered in
        // prose and nothing is coming.
        // THE TURN BOUNDARY IS THE LAST USER MESSAGE. Everything after it belongs to
        // the turn being waited on; everything before it is history.
        //
        // Two earlier attempts got this wrong in the same direction. Scanning the whole
        // conversation settled on any past text reply. Taking the last channel:"final"
        // message settled on the PREVIOUS turn's reply, because while an image is still
        // generating this turn has produced no final message yet — so the newest one is
        // still the last answer. Measured tail at the moment of failure:
        //   [2] assistant text            final   <- the previous turn, wrongly used
        //   [3] user      text            null    <- the request being waited on
        //   [4] tool      multimodal_text final   <- did not exist yet
        var lastUser = -1;
        for (var i = 0; i < msgs.length; i++) {
            if (msgs[i] && msgs[i].author && msgs[i].author.role === 'user') lastUser = i;
        }
        var turn = msgs.slice(lastUser + 1);

        var found = [];
        var finals = [];
        for (var t = 0; t < turn.length; t++) {
            if (!turn[t]) continue;
            collectImageParts(turn[t], found);
            if (turn[t].channel === 'final') finals.push(turn[t]);
        }

        // Nothing final yet means the turn has not produced its output — keep waiting.
        // Settling here is what made both earlier versions give up early.
        var last = finals.length ? finals[finals.length - 1] : null;
        var lastCt = last && last.content && last.content.content_type;
        var settled = !!(last && lastCt === 'text');
        return { images: found, settled: settled };
    }

    /**
     * Wait for a generated image to land, then stop. Gives up quietly rather than
     * throwing: a turn with no image is the normal case, not an error.
     */
    async function awaitGeneratedImages(convId, deadlineMs) {
        var deadline = Date.now() + (deadlineMs || 150000);
        var everySeen = [];
        while (Date.now() < deadline) {
            var r;
            try { r = await fetchConversationImages(convId); }
            catch (e) { r = { images: [], settled: false }; }
            if (r.images.length) return r.images;
            // Answered in text with nothing generating — nothing to wait for.
            if (r.settled) return everySeen;
            await new Promise(function (ok) { setTimeout(ok, 5000); });
        }
        return everySeen;
    }

    /**
     * Fetch the asset bytes IN THE PAGE and hand them back base64.
     *
     * The download cannot be done from the main process. Measured on one signed URL, four
     * ways, seconds apart:
     *   in-page fetch WITH cookies        200
     *   in-page fetch WITHOUT cookies     200   <- so it is not the cookies
     *   plain node https                  403
     *   plain node + User-Agent + Referer 403   <- nor the headers
     *   electronNet on persist:chatgpt    403   <- nor Chromium's stack on the right session
     * The asset sits behind Cloudflare on chatgpt.com and only a request originating in
     * the page itself is accepted. So the bytes come back through executeJavaScript as
     * base64 rather than being fetched again outside.
     *
     * That costs ~4/3 the file size as a string over IPC, which is fine for an image and
     * would NOT be fine for video — hence the cap below rather than a blanket rule.
     */
    var IMAGE_BYTES_MAX = 12 * 1024 * 1024;

    async function fetchImageBase64(url) {
        var res = await fetch(url, { credentials: 'include' });
        if (!res.ok) throw new Error('asset fetch failed (' + res.status + ')');
        var buf = await res.arrayBuffer();
        if (buf.byteLength > IMAGE_BYTES_MAX) {
            throw new Error('asset is ' + buf.byteLength + ' bytes, over the ' +
                IMAGE_BYTES_MAX + ' transfer cap');
        }
        var bytes = new Uint8Array(buf);
        // Chunked: String.fromCharCode.apply over a megabyte of arguments blows the stack.
        var chunks = [];
        for (var i = 0; i < bytes.length; i += 8192) {
            chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 8192)));
        }
        return { base64: btoa(chunks.join('')), byteLength: buf.byteLength };
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
        // The image-resolve endpoint wants this alongside the bearer. Same payload we
        // already fetch, so it costs nothing extra.
        if (data.account && data.account.id) _accountId = data.account.id;
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

    // ─── SSE Stream Parser ──────────────────────────

    async function _parseSSEStream(response) {
        var reader = response.body.getReader();
        var decoder = new TextDecoder();
        var fullText = '';
        var streamText = '';
        var buffer = '';
        // Reset per turn. A module-level array would carry the previous turn's image
        // into this one, which reads as a brand-new generation to the caller.
        var _pendingImages = [];

        while (true) {
            var chunk = await reader.read();
            if (chunk.done) break;

            buffer += decoder.decode(chunk.value, { stream: true });
            var lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (var i = 0; i < lines.length; i++) {
                var line = lines[i];
                var normalized = String(line || '').trimStart();
                if (!normalized.startsWith('data:')) continue;
                // Accept both "data: {...}" and "data:{...}" forms.
                var data = normalized.slice(5).trimStart();
                if (!data || data === '[DONE]') continue;

                try {
                    var parsed = JSON.parse(data);

                    // Persist conversation context for follow-up messages
                    if (parsed.conversation_id) {
                        _conversationId = parsed.conversation_id;
                    }

                    // BEFORE the role filter, deliberately. An image arrives on a message
                    // whose author.role is 'tool', so anything gated on 'assistant' never
                    // sees it — which is exactly how images were dropped with no error
                    // anywhere. The parts.join() below was never the problem; it never ran.
                    if (parsed && parsed.message) collectImageParts(parsed.message, _pendingImages);

                    // `channel` is the real discriminator, not author.role. It marks the
                    // turn's rendered output whatever produced it — assistant+text for a
                    // text reply, tool+multimodal_text for an image. A reasoning_recap
                    // message is authored by the assistant too but carries channel null
                    // and parts null: an internal stub, never a reply.
                    //
                    // The role fallback stays for responses that carry no channel at all,
                    // so a shape older or newer than the one measured still yields text
                    // rather than silence.
                    var _m = parsed && parsed.message;
                    var _ctype = _m && _m.content && _m.content.content_type;
                    var _isFinal = _m && (_m.channel === 'final' ||
                        (_m.channel == null && _m.author && _m.author.role === 'assistant'));
                    var parts = _m && _m.content && _m.content.parts;
                    if (parts && parts.length > 0 && _isFinal && _ctype !== 'multimodal_text') {
                        fullText = parts.join('');

                        if (parsed.message.id) {
                            _parentMessageId = parsed.message.id;
                        }
                    }

                    // Also support delta-style and JSON-patch style events.
                    var delta = '';
                    if (typeof parsed.delta === 'string') delta = parsed.delta;
                    else if (parsed.delta && typeof parsed.delta.text === 'string') delta = parsed.delta.text;
                    else if (typeof parsed.text === 'string') delta = parsed.text;
                    else if (typeof parsed.message_delta === 'string') delta = parsed.message_delta;
                    else if (
                        typeof parsed.value === 'string' &&
                        ((typeof parsed.p === 'string' && parsed.p.indexOf('/message/content/parts/') >= 0) ||
                         (typeof parsed.path === 'string' && parsed.path.indexOf('/message/content/parts/') >= 0))
                    ) delta = parsed.value;
                    else if (
                        Array.isArray(parsed.value) &&
                        ((typeof parsed.p === 'string' && parsed.p.indexOf('/message/content/parts/') >= 0) ||
                         (typeof parsed.path === 'string' && parsed.path.indexOf('/message/content/parts/') >= 0))
                    ) delta = parsed.value.join('');

                    if (delta) streamText += delta;
                } catch(e) {}
            }
        }

        // Handle trailing buffered line if stream ended without newline.
        if (buffer) {
            var trailing = String(buffer || '').trimStart();
            if (trailing.startsWith('data:')) {
                try {
                    var trailingData = trailing.slice(5).trimStart();
                    if (trailingData && trailingData !== '[DONE]') {
                        var trailingParsed = JSON.parse(trailingData);
                        if (trailingParsed && trailingParsed.message) collectImageParts(trailingParsed.message, _pendingImages);
                        var trailingParts = trailingParsed && trailingParsed.message && trailingParsed.message.content && trailingParsed.message.content.parts;
                        if (trailingParts && trailingParts.length > 0 && trailingParsed.message.author && trailingParsed.message.author.role === 'assistant') {
                            fullText = trailingParts.join('');
                            if (trailingParsed.message.id) _parentMessageId = trailingParsed.message.id;
                        }
                    }
                } catch (e) {}
            }
        }

        reader.releaseLock();
        // Resolve every pointer to a signed URL now, while the turn is fresh. These URLs
        // expire in UNDER THREE MINUTES (measured: fetched fine immediately, 403 "File
        // stream access denied" after 173s), so they are handed straight to the caller to
        // download rather than stored anywhere.
        // The stream is slower than the generator: an image turn measured 74.7s while
        // the stream read returned at 30.6s with nothing. So when the stream produced no
        // pointer AND no prose, ask the stored conversation instead — it settles on its
        // own and stops early if the turn merely answered in text.
        if (!_pendingImages.length && !fullText && !streamText && _conversationId) {
            try {
                var late = await awaitGeneratedImages(_conversationId, 150000);
                for (var li = 0; li < late.length; li++) _pendingImages.push(late[li]);
                if (late.length) {
                    console.log('[Proxima] ChatGPT: ' + late.length + ' image(s) recovered from the stored conversation');
                }
            } catch (e) { /* no image is the normal case, not an error */ }
        }

        _lastImages = [];
        for (var ii = 0; ii < _pendingImages.length; ii++) {
            var img = _pendingImages[ii];
            try {
                var r = await resolveImageUrl(img.id, _conversationId);
                // Fetch here, immediately, and in this context — the main process
                // cannot retrieve this URL at all (see fetchImageBase64).
                var data = await fetchImageBase64(r.downloadUrl);
                _lastImages.push({
                    id: img.id, fileName: r.fileName,
                    mimeType: img.mimeType, width: img.width, height: img.height,
                    sizeBytes: data.byteLength, genId: img.genId,
                    base64: data.base64
                });
            } catch (e) {
                // Record the failure rather than dropping it: "no image" and "an image
                // we could not resolve" are different facts.
                _lastImages.push({ id: img.id, error: String(e && e.message || e) });
            }
        }
        if (_lastImages.length) {
            console.log('[Proxima] ChatGPT: ' + _lastImages.length + ' generated image(s) resolved');
        }
        // An image turn has NO prose. Measured sequence for a pure generation:
        //   user(text) -> tool(multimodal_text, channel:final) -> assistant(reasoning_recap,
        //   channel:null, parts:null)
        // That recap is a chain-of-thought stub, not a reply — the image IS the whole
        // response. So an empty string here is correct and "No response captured", which
        // is what the caller printed, was technically true and useless. Say what actually
        // happened instead.
        if (!fullText && !streamText && _lastImages.length) {
            var okCount = _lastImages.filter(function (x) { return !x.error; }).length;
            return 'Generated ' + okCount + ' image(s); see the saved paths on this reply.';
        }
        return fullText || streamText;
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

        var _model = (options && options.model) ? options.model : DEFAULT_MODEL;

        // Attachments arrive already uploaded — main-v2 does the three-step dance and
        // hands back descriptors. Captured shape: images make the turn 'multimodal_text'
        // with the pointers FIRST and the text last, and every file also appears in
        // metadata.attachments. A turn with no attachments is unchanged.
        var _atts = (options && options.attachments) || [];
        var _content = { content_type: 'text', parts: [message] };
        var _msgMeta = {};
        if (_atts.length) {
            var _imgs = _atts.filter(function (a) { return a.isImage; });
            if (_imgs.length) {
                var _parts = _imgs.map(function (a) {
                    var p = {
                        content_type: 'image_asset_pointer',
                        asset_pointer: 'sediment://' + a.fileId,
                        size_bytes: a.size
                    };
                    if (a.width && a.height) { p.width = a.width; p.height = a.height; }
                    return p;
                });
                _parts.push(message);
                _content = { content_type: 'multimodal_text', parts: _parts };
            }
            _msgMeta.attachments = _atts.map(function (a) {
                var d = { id: a.fileId, size: a.size, name: a.name,
                    mime_type: a.mime, source: 'local', is_big_paste: false };
                if (a.width && a.height) { d.width = a.width; d.height = a.height; }
                if (a.libraryFileId) d.library_file_id = a.libraryFileId;
                return d;
            });
            console.log('[Proxima ChatGPT] attaching ' + _atts.length + ' file(s)');
        }

        var payload = {
            action: 'next',
            messages: [{
                id: crypto.randomUUID(),
                author: { role: 'user' },
                content: _content,
                metadata: _msgMeta
            }],
            model: _model,

            parent_message_id: _parentMessageId || crypto.randomUUID(),
            timezone_offset_min: new Date().getTimezoneOffset(),
            history_and_training_disabled: false,
            conversation_mode: { kind: 'primary_assistant' },
            force_paragen: false,
            force_nulligen: false,
            force_rate_limit: false,
            websocket_request_id: crypto.randomUUID()
        };

        // Effort is a TOP-LEVEL field, sent for every model. Captured from a real
        // chatgpt.com turn (HAR, 2026-09-25): the app sends thinking_effort:'max' beside
        // model:'gpt-6-astra-wm', and sends NO oai-last-model-config at all.
        //
        // Two earlier shapes were wrong, both failing silently rather than loudly:
        //  - the effort went in oai-last-model-config, which the app no longer sends;
        //  - the block was gated on the model name containing 'thinking', and
        //    'gpt-6-astra-wm' does not contain it, so Astra would have gone out with no
        //    effort at all.
        // That second point is also the likely cause of the earlier reading that every
        // gpt-6-*-wm slug 'downgrades to gpt-5-6': the slug was fine, the request was not.
        var _effort = (options && options.thinkingEffort) ? options.thinkingEffort : DEFAULT_EFFORT;
        if (_effort) {
            payload.thinking_effort = _effort;
            if (EFFORTS_SEEN.indexOf(_effort) === -1) {
                console.warn('[Proxima ChatGPT] effort "' + _effort + '" has not been seen on ' +
                    'the wire (known: ' + EFFORTS_SEEN.join(', ') + ') — sending it anyway');
            }
            console.log('[Proxima ChatGPT] model ' + _model + ' at thinking_effort ' + _effort);
        }


        if (_conversationId) {
            payload.conversation_id = _conversationId;
            console.log('[Proxima ChatGPT] Continuing conversation:', _conversationId);
        } else {
            console.log('[Proxima ChatGPT] Starting new conversation');
        }

        var controller = new AbortController();
        var timeoutId = setTimeout(function() { controller.abort(); }, TIMEOUT);

        var res = await fetch('/backend-api/conversation', {
            method: 'POST',
            credentials: 'include',
            headers: headers,
            body: JSON.stringify(payload),
            signal: controller.signal
        });

        // Token expired — refresh and retry once
        if (res.status === 401) {
            var newToken = await _getToken();
            headers['Authorization'] = 'Bearer ' + newToken;
            var retryController = new AbortController();
            var retryTimeoutId = setTimeout(function() { retryController.abort(); }, TIMEOUT);
            res = await fetch('/backend-api/conversation', {
                method: 'POST',
                credentials: 'include',
                headers: headers,
                body: JSON.stringify(payload),
                signal: retryController.signal
            });
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

    window.__proximaChatGPT = {
        send: send, newConversation: newConversation,
        createUpload: createUpload, finalizeUpload: finalizeUpload,
        uploadedFileInfo: uploadedFileInfo,
        // Read by the main process right after a send, because the signed URLs inside
        // expire in under three minutes.
        lastImages: function () { return _lastImages; },
        conversationId: function () { return _conversationId; }
    };
    console.log('[Proxima] ChatGPT engine loaded');
    // Pre-warm auth token and page scripts to speed up first request
    _getToken().catch(function(){});
    _getScriptsAndDpl().catch(function(){});
})();
