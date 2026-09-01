#!/usr/bin/env node
/**
 * Proxima — supervisor orchestration layer
 *
 * Drives a long-lived claude.ai thread as a SUPERVISOR for a local coding agent: the
 * agent builds and verifies, the supervisor decides. One turn per invocation.
 *
 * It talks to Proxima through the real MCP server over stdio — the same `ask_claude`
 * tool an agent would call — rather than reaching past it to the IPC socket. That
 * matters: driving the socket directly bypasses the tool schema, the argument
 * validation and the response shaping, so anything that works here is known to work
 * for a real agent too.
 *
 * THE THREAD IS THE POINT. Claude's conversation id lives in memory in the page, so a
 * tab reload silently starts a fresh conversation and the supervisor loses everything
 * it knew. This script persists the id to a state file and passes it back explicitly on
 * every turn, which is what makes an unattended multi-hour run survive a restart.
 *
 * usage:
 *   node supervisor.cjs --message-file turn.txt [--attach a.md --attach b.json]
 *                       [--conversation-id <uuid|url>] [--new] [--state s.json]
 *                       [--effort high] [--model claude-opus-5] [--no-tag]
 *
 * --conversation-id is OPTIONAL and wins over the state file when given, so a run can
 * be pointed at an existing thread (paste the uuid out of a claude.ai URL). With
 * neither, the state file's id is reused; with --new, a fresh thread is started and its
 * id recorded.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const MCP_SERVER = path.resolve(__dirname, '../../src/mcp-server-v3.js');

function parseArgs(argv) {
    const a = {
        messageFile: null, message: null, attach: [], conversationId: null,
        isNew: false, state: path.join(process.cwd(), 'supervisor-state.json'),
        effort: null, model: null, tag: true, timeoutMs: 1800000,
        tool: null, toolArgs: {}
    };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i], v = argv[i + 1];
        if (k === '--message-file') { a.messageFile = v; i++; }
        else if (k === '--message') { a.message = v; i++; }
        else if (k === '--attach') { a.attach.push(path.resolve(v)); i++; }
        else if (k === '--conversation-id') { a.conversationId = v; i++; }
        else if (k === '--state') { a.state = path.resolve(v); i++; }
        else if (k === '--effort') { a.effort = v; i++; }
        else if (k === '--model') { a.model = v; i++; }
        else if (k === '--timeout-ms') { a.timeoutMs = Number(v); i++; }
        else if (k === '--new') { a.isNew = true; }
        else if (k === '--no-tag') { a.tag = false; }
        // Escape hatch for the other Proxima tools (claude_conversation,
        // claude_artifacts, ask_qwen...). Without it this script can only ever
        // exercise ask_claude, which is a thin slice of the surface it fronts.
        else if (k === '--tool') { a.tool = v; i++; }
        else if (k === '--arg') {
            // Must reject eq < 1 explicitly. indexOf returns -1 with no '=', and
            // slice(0, -1) then silently drops the key's last character while slice(0)
            // puts the whole token in the value — the tool gets a mangled argument and
            // nothing reports it. eq === 0 is an empty key, equally wrong. Found in code
            // review of e6045142.
            const eq = String(v).indexOf('=');
            if (eq < 1) {
                console.error('--arg needs key=value (got "' + v + '")');
                process.exit(1);
            }
            const key = v.slice(0, eq), raw = v.slice(eq + 1);
            let val = raw;
            if (raw === 'true') val = true;
            else if (raw === 'false') val = false;
            else if (raw !== '' && !isNaN(Number(raw))) val = Number(raw);
            a.toolArgs[key] = val; i++;
        }
    }
    return a;
}

/** Minimal MCP stdio client: initialize, initialized, tools/call. */
function mcpCall(toolName, args, timeoutMs) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [MCP_SERVER], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: Object.assign({}, process.env)
        });
        let out = '';
        let settled = false;
        const stderr = [];
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill();
            reject(new Error('MCP call timed out after ' + timeoutMs + 'ms'));
        }, timeoutMs);

        const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');

        child.stdout.on('data', (d) => {
            out += d.toString();
            let i;
            while ((i = out.indexOf('\n')) !== -1) {
                const line = out.slice(0, i).trim();
                out = out.slice(i + 1);
                if (!line) continue;
                let msg;
                try { msg = JSON.parse(line); } catch (e) { continue; }

                if (msg.id === 1 && msg.result) {
                    // Handshake accepted; announce readiness, then call the tool.
                    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
                    send({
                        jsonrpc: '2.0', id: 2, method: 'tools/call',
                        params: { name: toolName, arguments: args }
                    });
                } else if (msg.id === 2) {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    child.kill();
                    if (msg.error) return reject(new Error('MCP error: ' + JSON.stringify(msg.error)));
                    const content = (msg.result && msg.result.content) || [];
                    const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
                    resolve({ text: text, isError: !!(msg.result && msg.result.isError) });
                }
            }
        });
        // The server logs progress to stderr; keep the tail for diagnosis on failure.
        child.stderr.on('data', (d) => {
            stderr.push(d.toString());
            if (stderr.length > 40) stderr.shift();
        });
        child.on('error', (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
        child.on('exit', (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(new Error('MCP server exited (' + code + ') before answering. stderr tail:\n' +
                stderr.join('').slice(-1200)));
        });

        send({
            jsonrpc: '2.0', id: 1, method: 'initialize',
            params: {
                protocolVersion: '2024-11-05',
                capabilities: {},
                clientInfo: { name: 'proxima-supervisor', version: '1.0.0' }
            }
        });
    });
}

/**
 * Print the reply and exit, WITHOUT losing the tail of it.
 *
 * process.exit() abandons queued async writes, and stdout to a pipe is async — which is
 * exactly how this script's output is consumed, since the whole point is for a calling
 * agent to capture the reply. So `console.log(text); process.exit(0)` can truncate or
 * drop the payload, the more readily the longer it is. A supervisor turn returning a long
 * plan is the worst case. Found in code review of e6045142.
 *
 * fs.writeSync on fd 1 blocks until the bytes are handed over. EAGAIN is possible on a
 * full non-blocking pipe, so it retries rather than dropping the remainder.
 */
function emitAndExit(text, code) {
    const buf = Buffer.from(String(text) + '\n', 'utf8');
    // The EAGAIN retry MUST yield and MUST be bounded. `continue` on its own is an
    // unbounded busy-spin: with a stalled reader it pegs a core and never exits, which
    // in an unattended supervisor loop is worse than the truncation it was guarding
    // against. Measured with a stubbed writeSync: 5,000,000 syscalls in 53s of CPU,
    // zero bytes of progress, no exit.
    //
    // Atomics.wait on a SharedArrayBuffer is a genuine synchronous sleep — the only kind
    // available here, since the whole point is to finish before process.exit.
    const parked = new Int32Array(new SharedArrayBuffer(4));
    const nap = (ms) => { try { Atomics.wait(parked, 0, 0, ms); } catch (e) { /* no SAB */ } };
    const deadline = Date.now() + 5000;
    let off = 0;
    while (off < buf.length) {
        try { off += fs.writeSync(1, buf, off, buf.length - off); }
        catch (e) {
            if (e.code === 'EAGAIN' && Date.now() < deadline) { nap(1); continue; }
            // Last resort. This is the path that CAN truncate, so it says so on stderr
            // rather than losing the tail quietly.
            console.error('[supervisor] stdout stalled after ' + off + '/' + buf.length +
                ' bytes (' + (e.code || e.message) + '); the reply may be truncated');
            try { process.stdout.write(buf.slice(off)); } catch (e2) { /* give up */ }
            break;
        }
    }
    process.exit(code);
}

const loadState = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return {}; } };

(async () => {
    const args = parseArgs(process.argv);

    // Generic tool mode: call any tool the MCP server exposes and print its reply.
    if (args.tool) {
        console.error('[supervisor] ' + args.tool + ' via MCP | args ' + JSON.stringify(args.toolArgs));
        const t = Date.now();
        const r = await mcpCall(args.tool, args.toolArgs, args.timeoutMs);
        console.error('[supervisor] ' + ((Date.now() - t) / 1000).toFixed(1) + 's' +
            (r.isError ? ' | TOOL REPORTED ERROR' : ''));
        emitAndExit(r.text, r.isError ? 2 : 0);
    }

    const message = args.message !== null
        ? args.message
        : (args.messageFile ? fs.readFileSync(args.messageFile, 'utf8') : null);
    if (!message) { console.error('--message-file or --message is required'); process.exit(1); }

    const st = loadState(args.state);
    // Explicit id wins; then the remembered one; --new overrides both.
    const convId = args.isNew ? null : (args.conversationId || st.conversationId || null);

    const toolArgs = { message: message };
    if (convId) toolArgs.conversation_id = convId;
    // --no-tag set args.tag and stopped there, so the flag did nothing and every turn was
    // tagged regardless. Forwarded only when false: omitting it leaves the MCP tool's own
    // default in charge. Found in code review of 3b6e3047.
    if (args.tag === false) toolArgs.tag = false;
    if (args.isNew) toolArgs.new_chat = true;
    if (args.attach.length) toolArgs.attachments = args.attach;
    if (args.effort) toolArgs.effort = args.effort;
    if (args.model) toolArgs.model = args.model;

    const missing = args.attach.filter((f) => !fs.existsSync(f));
    if (missing.length) { console.error('attachment not found: ' + missing.join(', ')); process.exit(1); }

    console.error('[supervisor] ask_claude via MCP' +
        (convId ? ' | thread ' + convId : ' | NEW thread') +
        (args.attach.length ? ' | ' + args.attach.length + ' attachment(s)' : ''));

    const t0 = Date.now();
    const res = await mcpCall('ask_claude', toolArgs, args.timeoutMs);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);

    // ask_claude appends the conversation id to its reply; that is how a first turn
    // learns the thread it just created.
    const m = res.text.match(/_conversation_id:\s*([0-9a-f-]{36})_/);
    const learned = m ? m[1] : convId;
    // Never persist on a failed turn. Without this, a call that failed BECAUSE the
    // conversation id was bad writes that id into the state file as the remembered
    // thread, so every later turn inherits the failure. Observed: two failing calls
    // incremented the counter and stored a dead uuid.
    if (learned && !res.isError) {
        st.conversationId = learned;
        st.turns = (st.turns || 0) + 1;
        st.updatedAt = new Date().toISOString();
        fs.writeFileSync(args.state, JSON.stringify(st, null, 2));
    }

    console.error('[supervisor] ' + secs + 's | thread ' + (learned || 'unknown') +
        ' | turn ' + (st.turns || '?') + (res.isError ? ' | TOOL REPORTED ERROR' : ''));
    emitAndExit(res.text, res.isError ? 2 : 0);
})().catch((e) => { console.error('[supervisor] FAILED: ' + e.message); process.exit(1); });
