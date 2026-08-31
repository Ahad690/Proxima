/**
 * Proxima — Claude Engine v4.1.0
 * Runs inside claude.ai BrowserView context. Uses org-based session auth,
 * creates persistent conversations, and streams responses via SSE.
 */
(function() {
    if (window.__proximaClaude) return;

    const CLAUDE_BASE = 'https://claude.ai';
    var TIMEOUT = 360000;
    let _orgId = null;
    let _convId = null;
    // true when a caller named a specific conversation. A pinned thread must never
    // be silently replaced on error — see the 404 branch in send().
    let _pinned = false;
    // { artifacts:[{path,description,fileText}], model, stopReason, limit, format }
    let _lastMeta = null;

    // --- Organization Management ---
    async function _getOrgId() {
        if (_orgId) return _orgId;
        const res = await fetch('/api/organizations', { credentials: 'include' });
        if (res.status === 401 || res.status === 403) {
            throw new Error('Not logged in to Claude');
        }
        if (!res.ok) throw new Error('Claude session check failed (' + res.status + ')');
        const orgs = await res.json();
        if (!Array.isArray(orgs) || orgs.length === 0) {
            throw new Error('No Claude organization found');
        }
        _orgId = orgs[0].uuid;
        return _orgId;
    }

    // ─── Conversation ────────────────────────────────
    async function _createConversation(orgId, promptPreview) {
        const res = await fetch('/api/organizations/' + orgId + '/chat_conversations', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: (promptPreview || 'proxima').substring(0, 50).replace(/\n/g, ' ').trim(),
                project_uuid: null,
                is_starred: false
            })
        });
        if (!res.ok) {
            if (res.status === 401 || res.status === 403) {
                _orgId = null;
                throw new Error('Claude auth error (' + res.status + ')');
            }
            const errBody = await res.text().catch(function() { return ''; });
            throw new Error('Conv create failed (' + res.status + '): ' + errBody.substring(0, 200));
        }
        const data = await res.json();
        return data.uuid;
    }

    // ─── Conversation targeting ─────────────────────
    // _convId is just the uuid in the claude.ai/chat/<uuid> URL, so any existing
    // conversation can be resumed by naming it. Needed for a long-running supervisor
    // thread: _convId is in-memory only (unlike the Qwen engine, which persists to
    // localStorage), so a page reload would otherwise orphan the thread and silently
    // start a fresh one.
    //
    // Whether resuming a conversation that already HAS history threads onto that
    // history is a server-side question: every message carries parent_message_uuid and
    // the conversation exposes current_leaf_message_uuid, yet the completion body sends
    // neither. If a resumed chat comes back with no memory of its own history, that
    // omission is the reason — see _completionBody.
    function setConversation(uuid) {
        if (!uuid || typeof uuid !== 'string') throw new Error('setConversation: uuid required');
        // Accept a full claude.ai URL as well as a bare uuid; callers copy either.
        var m = uuid.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
        if (!m) throw new Error('setConversation: not a uuid or claude.ai chat URL: ' + String(uuid).slice(0, 80));
        _convId = m[1];
        _pinned = true;
        console.log('[Proxima Claude] Conversation pinned:', _convId);
        return _convId;
    }

    function getConversation() {
        return _convId;
    }

    // Read the server's view of a conversation: how many messages it holds and which
    // leaf a new message would thread onto. Lets an orchestrator confirm it is talking
    // to the thread it thinks it is before sending.
    async function conversationInfo(uuid) {
        var orgId = await _getOrgId();
        var id = uuid || _convId;
        if (!id) return null;
        var res = await fetch('/api/organizations/' + orgId + '/chat_conversations/' + id +
            '?tree=True&rendering_mode=messages', { credentials: 'include' });
        if (!res.ok) return { uuid: id, ok: false, status: res.status };
        var j = await res.json();
        var msgs = (j && j.chat_messages) || [];
        return {
            uuid: id, ok: true, name: j.name, model: j.model,
            messages: msgs.length,
            currentLeaf: j.current_leaf_message_uuid || null,
            updatedAt: j.updated_at
        };
    }

    // ─── SSE Stream Parser ──────────────────────────
    // Handles BOTH wire formats, because rendering_mode decides which one arrives:
    //
    //   without rendering_mode  ->  legacy frames: {"type":"completion","completion":"..."}
    //   rendering_mode:messages ->  modern Messages-API frames: message_start,
    //                               content_block_start/delta/stop, message_delta,
    //                               message_limit, message_stop
    //
    // The legacy branch is kept because a caller can still opt out, and because the
    // account default could change under us again.
    //
    // ARTIFACTS. There is no artifact content-block type. An artifact is the generic
    // sandbox tool sequence — the model reads a skill file (`view`), writes the file
    // (`create_file`), then surfaces it (`present_files`) — and the body arrives as
    // input_json_delta fragments on the create_file block that concatenate into
    // {description, path, file_text}. A 12KB artifact was observed arriving as 1864
    // separate fragments, so nothing can be parsed until content_block_stop.
    //
    // Filter on type==='tool_use', NOT on name: tool_use and tool_result share the
    // name 'create_file', and the result block's input is empty, so keying on name
    // alone means trying to JSON.parse('') on every artifact.
    async function _parseStream(response) {
        var reader = response.body.getReader();
        var decoder = new TextDecoder();
        var fullText = '';
        var buffer = '';
        var blocks = {};          // index -> { type, name, pj }
        var artifacts = [];       // { path, description, fileText }
        var meta = { model: null, stopReason: null, limit: null, format: 'legacy' };

        while (true) {
            var chunk = await reader.read();
            if (chunk.done) break;

            buffer += decoder.decode(chunk.value, { stream: true });
            var lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (var i = 0; i < lines.length; i++) {
                var line = lines[i];
                if (line.indexOf('data:') !== 0) continue;
                var data = line.slice(5).trim();
                if (!data) continue;

                var parsed;
                try { parsed = JSON.parse(data); } catch (e) { continue; }

                // legacy
                if (parsed.type === 'completion' || parsed.completion) {
                    if (typeof parsed.completion === 'string') fullText += parsed.completion;
                    continue;
                }

                // modern
                if (parsed.type === 'message_start') {
                    meta.format = 'messages';
                    if (parsed.message && parsed.message.model) meta.model = parsed.message.model;
                    continue;
                }
                if (parsed.type === 'content_block_start') {
                    var cb = parsed.content_block || {};
                    blocks[parsed.index] = { type: cb.type, name: cb.name, pj: '' };
                    continue;
                }
                if (parsed.type === 'content_block_delta') {
                    var b = blocks[parsed.index];
                    if (!b) continue;
                    var d = parsed.delta || {};
                    // Only `text` blocks are the answer. `thinking` blocks arrive on their
                    // own path and must not be concatenated into it.
                    if (d.type === 'text_delta' && b.type === 'text') {
                        fullText += d.text || '';
                    } else if (d.type === 'input_json_delta') {
                        b.pj += d.partial_json || '';
                    }
                    continue;
                }
                if (parsed.type === 'content_block_stop') {
                    var bs = blocks[parsed.index];
                    if (bs && bs.type === 'tool_use' && bs.name === 'create_file' && bs.pj) {
                        try {
                            var f = JSON.parse(bs.pj);
                            if (f && f.path) {
                                artifacts.push({
                                    path: f.path,
                                    description: f.description || null,
                                    fileText: f.file_text || ''
                                });
                            }
                        } catch (e) {
                            console.warn('[Proxima Claude] create_file input did not parse (' +
                                bs.pj.length + ' chars) — artifact skipped');
                        }
                    }
                    continue;
                }
                if (parsed.type === 'message_delta') {
                    if (parsed.delta && parsed.delta.stop_reason) meta.stopReason = parsed.delta.stop_reason;
                    continue;
                }
                if (parsed.type === 'message_limit') {
                    // Usage lives here rather than in a header: 5h / 7d windows with a
                    // utilization fraction. The only quota signal this API gives.
                    meta.limit = parsed.message_limit || null;
                    continue;
                }
            }
        }

        reader.releaseLock();
        return { text: fullText, artifacts: artifacts, meta: meta };
    }

    // ─── Completion body ────────────────────────────
    // rendering_mode:'messages' is the single load-bearing field for artifacts, and it
    // is also what negotiates the modern stream format — one switch, not two. Without
    // it the server SUBSTITUTES every tool block with the literal string "This block is
    // not supported on your current device yet.", so an artifact request returns the
    // prose around the artifact and nothing else. That was silent data loss.
    //
    // Narrowed by deletion against the real app's 92-tool body: `tools` is NOT required
    // (not even its {type:'artifacts_v0'} entry), nor are model/effort/thinking_mode/
    // locale/parent_message_uuid/turn_message_uuids/completion_request_id/sync_sources.
    // `prompt` is the only genuinely required field.
    function _completionBody(message, options) {
        var body = {
            prompt: message,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata',
            attachments: [],
            files: []
        };
        // Opt out with renderingMode:null to get the old legacy-frame behaviour back.
        var rm = (options && Object.prototype.hasOwnProperty.call(options, 'renderingMode'))
            ? options.renderingMode : 'messages';
        if (rm) body.rendering_mode = rm;
        if (options && options.model) body.model = options.model;
        if (options && options.thinkingMode) body.thinking_mode = options.thinkingMode;
        if (options && options.effort) body.effort = options.effort;
        if (options && options.locale) body.locale = options.locale;
        return JSON.stringify(body);
    }

    // Fetch a file the sandbox wrote, by the virtual path from an artifact's create_file
    // call. Returns raw text — the response is the file bytes, not JSON-wrapped.
    // Note the path segment is /conversations/, not /chat_conversations/.
    async function downloadArtifact(path, conversationId) {
        var orgId = await _getOrgId();
        var cid = conversationId || _convId;
        if (!cid) throw new Error('downloadArtifact: no conversation');
        if (!path) throw new Error('downloadArtifact: path required');
        var res = await fetch('/api/organizations/' + orgId + '/conversations/' + cid +
            '/wiggle/download-file?path=' + encodeURIComponent(path), { credentials: 'include' });
        if (!res.ok) throw new Error('downloadArtifact failed (' + res.status + ') for ' + path);
        return await res.text();
    }

    function lastMeta() { return _lastMeta; }

    // ─── Send Message ───────────────────────────────
    async function send(message, options) {
        options = options || {};
        var orgId = await _getOrgId();

        // An explicit conversationId wins: this is how a supervisor thread is resumed
        // across restarts, and how one Proxima can drive several threads in turn.
        if (options.conversationId) setConversation(options.conversationId);
        if (options.newChat) { _convId = null; _pinned = false; }

        // Reuse existing conversation or create new one
        if (!_convId) {
            _convId = await _createConversation(orgId, message);
            console.log('[Proxima Claude] Created new conversation:', _convId);
        } else {
            console.log('[Proxima Claude] Continuing conversation:', _convId +
                (_pinned ? ' (pinned)' : ''));
        }

        try {
            var controller = new AbortController();
            var timeoutId = setTimeout(function() { controller.abort(); }, TIMEOUT);

            var res = await fetch('/api/organizations/' + orgId + '/chat_conversations/' + _convId + '/completion', {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'text/event-stream'
                },
                body: _completionBody(message, options),
                signal: controller.signal
            });

            if (!res.ok) {
                clearTimeout(timeoutId);
                var errBody = await res.text().catch(function() { return ''; });

                // Conversation expired or deleted — create new and retry
                if (res.status === 404 || res.status === 410) {
                    // Recreating is right for "any conversation" and WRONG for "this
                    // conversation": a caller resuming a supervisor thread would get a
                    // blank one and never be told the history was lost.
                    if (_pinned) {
                        throw new Error('Claude: pinned conversation ' + _convId +
                            ' is gone (' + res.status + '). Not creating a replacement — ' +
                            'the caller asked for this specific thread.');
                    }
                    console.log('[Proxima Claude] Conversation expired, creating new one...');
                    _convId = await _createConversation(orgId, message);

                    var retryController = new AbortController();
                    var retryTimeoutId = setTimeout(function() { retryController.abort(); }, TIMEOUT);

                    res = await fetch('/api/organizations/' + orgId + '/chat_conversations/' + _convId + '/completion', {
                        method: 'POST',
                        credentials: 'include',
                        headers: {
                            'Content-Type': 'application/json',
                            'Accept': 'text/event-stream'
                        },
                        body: _completionBody(message, options),
                        signal: retryController.signal
                    });

                    if (!res.ok) {
                        clearTimeout(retryTimeoutId);
                        throw new Error('Claude completion failed on retry (' + res.status + ')');
                    }

                    var r = await _parseStream(res);
                    clearTimeout(retryTimeoutId);
                    _lastMeta = { artifacts: r.artifacts, model: r.meta.model,
                        stopReason: r.meta.stopReason, limit: r.meta.limit,
                        format: r.meta.format, conversationId: _convId };
                    return r.text;
                }

                if (res.status === 429) throw new Error('Claude rate limited');
                throw new Error('Claude completion failed (' + res.status + '): ' + errBody.substring(0, 200));
            }

            var r = await _parseStream(res);
            clearTimeout(timeoutId);
            _lastMeta = { artifacts: r.artifacts, model: r.meta.model,
                stopReason: r.meta.stopReason, limit: r.meta.limit,
                format: r.meta.format, conversationId: _convId };
            if (r.artifacts.length) {
            console.log('[Proxima Claude] ' + r.artifacts.length + ' artifact(s): ' +
                r.artifacts.map(function (a) { return a.path + ' (' + a.fileText.length + 'B)'; }).join(', '));
            }
            return r.text;
        } catch(e) {
            // Reset on conversation-related errors so next call creates fresh
            if (e.message && (e.message.includes('404') || e.message.includes('410'))) {
                _convId = null;
            }
            throw e;
        }
    }


    function newConversation() {
        _convId = null;
        _pinned = false;
        console.log('[Proxima Claude] Conversation reset');
    }

    window.__proximaClaude = {
        send: send, newConversation: newConversation,
        setConversation: setConversation, getConversation: getConversation,
        conversationInfo: conversationInfo,
        downloadArtifact: downloadArtifact,
        lastMeta: lastMeta
    };
    console.log('[Proxima] Claude engine loaded');
})();
