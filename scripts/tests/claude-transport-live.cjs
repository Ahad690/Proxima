#!/usr/bin/env node
/**
 * LIVE contract test — claude.ai sandbox file transport.
 *
 * NOT part of `automation-tests.cjs`. That suite is offline and static; this one needs
 * Proxima running, a signed-in claude.ai, and it spends two real turns in a throwaway
 * conversation. Run it deliberately:
 *
 *     node scripts/tests/claude-transport-live.cjs
 *
 * WHY THIS EXISTS. A new file is announced on the response stream as a `create_file`
 * tool block; an EDIT to an existing file is not announced at all, because the edit is
 * performed by a different tool. Proxima recovers edits by diffing the conversation's
 * sandbox listing and pulling only what changed — and that recovery rests on three
 * things Anthropic can change without warning:
 *
 *   1. the edit tool still being called `str_replace`
 *   2. its input still carrying {path, old_str, new_str}, which is what makes the
 *      resulting file size PREDICTABLE (previous + new_str - old_str) rather than
 *      guessed from a sandbox listing that lags
 *   3. the listing and download endpoints still converging within the poll window
 *
 * So this prints the whole TOOL TRACE, not just a verdict. If the transport still works
 * for a different reason than it used to, that shows up here as a changed input shape
 * instead of as a mystery failure three weeks later. An unfamiliar tool name in the
 * trace is the signal to update CLAUDE_READ_ONLY_TOOLS or claudeExpectedBytes in
 * electron/main-v2.cjs.
 *
 * HISTORY WORTH KNOWING, because each of these passed a unit test first:
 *   - the listing bumps created_at immediately but reports the OLD size for seconds, and
 *     the download serves the OLD body meanwhile
 *   - it then sits STABLE on that stale size, so waiting for it to "settle" settles on
 *     the wrong value
 *   - byte-matching the download against the listing does not save you: both are stale
 *     at the same number and agree with each other
 *   - and an EMPTY baseline is not evidence that nothing existed before — a listing that
 *     has not caught up looks identical to one with nothing in it. That last one only
 *     became reachable when claude.ai stopped calling `present_files` on an edit.
 *
 * exit: 0 = contract intact, 2 = something moved, 1 = could not run
 */
const net = require('net');
const fs = require('fs');
const path = require('path');

// Shared resolver: Proxima falls back to 19223 when 19222 is taken, and a test that
// reports a contract break because it knocked on the wrong door is worse than no test.
const proximaPort = require('../lib/proxima-port.cjs');
// Guessing is not enough here. Against a Proxima that fell back to 19223 while
// settings.json still said 19222, a sync guess knocks on the wrong door and this test
// reports a contract break that never happened — the single worst thing it could do.
// Discovery proves the port with a real ping before any of the checks run.
let PORT = proximaPort.resolvePortSync();

function ipc(req, ms) {
    return new Promise((res, rej) => {
        const s = net.createConnection(PORT, '127.0.0.1');
        let b = '';
        const t = setTimeout(() => { s.destroy(); rej(new Error('timed out after ' + ms + 'ms')); }, ms || 30000);
        s.on('connect', () => s.write(JSON.stringify(Object.assign({ requestId: String(Date.now()) }, req)) + '\n'));
        s.on('data', (d) => {
            b += d.toString();
            const i = b.indexOf('\n');
            if (i === -1) return;
            clearTimeout(t); s.end();
            try { res(JSON.parse(b.slice(0, i))); } catch (e) { rej(e); }
        });
        s.on('error', (e) => {
            clearTimeout(t);
            rej(new Error(e.code === 'ECONNREFUSED'
                ? 'Proxima is not running (nothing on 127.0.0.1:' + PORT + ')'
                : e.message));
        });
    });
}

const lastMeta = async () => {
    const r = await ipc({
        action: 'executeScript', provider: 'claude',
        data: { script: 'JSON.stringify(window.__proximaClaude.lastMeta() || null)' }
    }, 30000);
    const v = r.result !== undefined ? r.result : r.data;
    try { return JSON.parse(v); } catch (e) { return null; }
};

let fails = 0;
const ok = (cond, label) => { console.log((cond ? '  PASS  ' : '  FAIL  ') + label); if (!cond) fails++; };

function dump(label, res, meta, secs) {
    console.log(label + '  (' + secs + 's)');
    console.log('  tools    : ' + JSON.stringify(res.toolCalls));
    for (const t of ((meta && meta.toolCalls) || [])) {
        const keys = t.input ? Object.keys(t.input).join(',') : '-';
        console.log('     ' + String(t.name).padEnd(14) + 'input{' + keys + '}  bytes' +
            JSON.stringify(t.inputBytes || {}));
    }
    console.log('  recovered: ' + res.artifactsRecovered);
    const arts = res.artifacts || [];
    for (const a of arts) {
        console.log('  artifact : ' + a.path.split('/').pop().padEnd(14) +
            String(a.bytes).padStart(5) + 'B  via:' + a.via + (a.stale ? '  STALE' : ''));
    }
    if (!arts.length) console.log('  artifact : (none)');
}

(async () => {
    // Fail loudly and early rather than reporting a contract break that is really a
    // missing prerequisite.
    try {
        const found = await proximaPort.discover(null, 2500);
        PORT = found.port;
        console.log('Proxima on 127.0.0.1:' + PORT + ' (via ' + found.via + ')\n');
    } catch (e) {
        console.error('cannot run: ' + e.message);
        console.error('start Proxima, then re-run. `node tools/orchestrate/preflight.cjs` checks the rest.');
        process.exit(1);
    }
    try {
        const st = await ipc({ action: 'getStatus' }, 10000);
        if (!st.providers || st.providers.indexOf('claude') === -1) {
            console.error('claude is not an enabled provider — enable it in Agent Hub first');
            process.exit(1);
        }
    } catch (e) {
        console.error('cannot run: ' + e.message);
        console.error('start Proxima, then re-run. `node tools/orchestrate/preflight.cjs` checks the rest.');
        process.exit(1);
    }

    const FILE = '/mnt/user-data/outputs/TRANSPORT-CHECK.md';

    // ── Turn 1: create. Served from the stream, which is also what leaves the sandbox
    // listing un-exercised — the precondition for the empty-baseline bug.
    let t = Date.now();
    const r1 = await ipc({
        action: 'sendMessage', provider: 'claude', data: {
            message: 'Create a file at ' + FILE + ' whose entire contents are exactly these two ' +
                'lines:\n\n# Check\nLine one.\n\nThen reply with only: MADE',
            newChat: true
        }
    }, 600000);
    dump('TURN 1 — create a new file', r1, await lastMeta(), ((Date.now() - t) / 1000).toFixed(1));
    const cid = r1.conversationId;
    console.log('  conv     : ' + cid);
    ok(!!cid, 'a conversation id came back');
    const made = (r1.artifacts || []).find((a) => a.path.indexOf('TRANSPORT-CHECK') !== -1);
    ok(!!made && made.via === 'stream', 'the new file arrived via the stream');

    // ── Turn 2: edit, and explicitly ask NOT to present the file, since claude.ai no
    // longer does so on its own and the recovery must not depend on it.
    t = Date.now();
    const r2 = await ipc({
        action: 'sendMessage', provider: 'claude', data: {
            message: 'EDIT the existing ' + FILE + ' in place: append one line reading ' +
                '"Line two." Do not rewrite it from scratch, do not create a new file, and do ' +
                'NOT present or attach the file afterwards.\n\nThen reply with only: EDITED',
            conversationId: cid
        }
    }, 600000);
    const m2 = await lastMeta();
    dump('\nTURN 2 — edit in place, without presenting', r2, m2, ((Date.now() - t) / 1000).toFixed(1));

    // ── The assumptions, checked explicitly rather than implied by the outcome.
    const names = ((m2 && m2.toolCalls) || []).map((x) => x.name);
    const edit = ((m2 && m2.toolCalls) || []).find((x) => x.name === 'str_replace');
    console.log('\nASSUMPTIONS');
    ok(names.length > 0, 'the stream still reports tool calls');
    ok(!!edit, 'the edit tool is still str_replace (saw: ' + names.join(',') + ')');
    if (edit) {
        ok(!!(edit.input && edit.input.path), 'str_replace still names the path it edits');
        ok(!!(edit.inputBytes && typeof edit.inputBytes.old_str === 'number' &&
              typeof edit.inputBytes.new_str === 'number'),
            'old_str/new_str byte lengths present, so the size stays predictable');
    }

    // ── The outcome, read off DISK rather than off the reply.
    console.log('\nOUTCOME');
    const a = (r2.artifacts || []).find((x) => x.path.indexOf('TRANSPORT-CHECK') !== -1);
    ok(!!a, 'the edited file transported at all');
    if (a) {
        ok(a.via === 'listing', 'recovered via the sandbox listing, as designed');
        ok(!a.stale, 'not flagged stale');
        let body = '';
        try { body = fs.readFileSync(a.localPath, 'utf8'); } catch (e) { body = ''; }
        console.log('  on disk  : ' + JSON.stringify(body));
        ok(body.indexOf('Line one') !== -1, 'kept the original content');
        ok(body.indexOf('Line two') !== -1,
            'contains the EDIT — this is the assertion that has caught every regression');
    }

    console.log('\n' + (fails
        ? fails + ' FAILURE(S) — the transport contract moved; read the tool trace above'
        : 'contract intact'));
    console.log('throwaway conversation left behind: ' + cid);
    process.exit(fails ? 2 : 0);
})().catch((e) => { console.error('ERR ' + e.message); process.exit(1); });
