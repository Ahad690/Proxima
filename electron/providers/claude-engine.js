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
    async function _parseStream(response) {
        var reader = response.body.getReader();
        var decoder = new TextDecoder();
        var fullText = '';
        var buffer = '';

        while (true) {
            var chunk = await reader.read();
            if (chunk.done) break;

            buffer += decoder.decode(chunk.value, { stream: true });
            var lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (var i = 0; i < lines.length; i++) {
                var line = lines[i];
                if (!line.startsWith('data: ')) continue;
                var data = line.slice(6).trim();
                if (!data) continue;

                try {
                    var parsed = JSON.parse(data);
                    if (parsed.type === 'content_block_delta' && parsed.delta && parsed.delta.type === 'text_delta') {
                        fullText += parsed.delta.text;
                    }
                    if (parsed.completion) {
                        fullText += parsed.completion;
                    }
                } catch(e) {}
            }
        }

        reader.releaseLock();
        return fullText;
    }

    // ─── Completion body ────────────────────────────
    // Pins a specific model / thinking mode when the caller supplies them
    // (e.g. model="claude-haiku-4-5-20251001"); otherwise claude.ai uses the
    // account default, matching the engine's original behavior.
    function _completionBody(message, options) {
        var body = {
            prompt: message,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata',
            attachments: [],
            files: []
        };
        if (options && options.model) body.model = options.model;
        if (options && options.thinkingMode) body.thinking_mode = options.thinkingMode;
        if (options && options.locale) body.locale = options.locale;
        return JSON.stringify(body);
    }

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

                    var result = await _parseStream(res);
                    clearTimeout(retryTimeoutId);
                    return result;
                }

                if (res.status === 429) throw new Error('Claude rate limited');
                throw new Error('Claude completion failed (' + res.status + '): ' + errBody.substring(0, 200));
            }

            var result = await _parseStream(res);
            clearTimeout(timeoutId);
            return result;
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
        conversationInfo: conversationInfo
    };
    console.log('[Proxima] Claude engine loaded');
})();
