/**
 * Lift reconcileClaudeArtifacts out of main-v2 and drive it against a simulated sandbox
 * that lags exactly the way the real one was measured to lag:
 *
 *   poll 1  created_at bumped, size STILL 12   <- the trap: it "changed", so the old code
 *                                                 downloaded here and got stale content
 *   poll 2  size now 24
 *   poll 3  size 24, identical to poll 2       <- settled
 *
 * and a download endpoint that serves the old 12-byte body until the listing has caught up.
 */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../../electron/main-v2.cjs'), 'utf8');
const grab = (re, what) => {
    const m = src.match(re);
    if (!m) throw new Error('could not lift ' + what + ' — main-v2 shape changed');
    return m[0];
};

const OLD = 'VERSION ONE\n';                 // 12 bytes
const NEW = 'VERSION ONE\nVERSION TWO\n';    // 24 bytes
const P = '/mnt/user-data/outputs/probe.md';
const T1 = '2026-09-01T09:39:35.000000Z';
const T2 = '2026-09-01T09:39:48.000000Z';

let listPolls = 0;
let downloads = 0;
const entry = (bytes, createdAt) => [{
    path: P, kind: 'output', name: 'probe.md', bytes, createdAt, contentType: 'text/markdown'
}];

// The listing lags: created_at moves first, size follows a poll later.
const LISTING = [
    entry(12, T2),   // poll 1 — differs from baseline but size is stale
    entry(24, T2),   // poll 2 — size caught up
    entry(24, T2)    // poll 3 — identical to poll 2, therefore settled
];

const browserManager = {
    executeScript: async (provider, script) => {
        if (script.indexOf('listArtifacts') !== -1) {
            const i = Math.min(listPolls, LISTING.length - 1);
            listPolls++;
            return JSON.stringify(LISTING[i]);
        }
        if (script.indexOf('downloadArtifact') !== -1) {
            downloads++;
            // Content is stale until the listing has moved past its first poll.
            return listPolls >= 2 ? NEW : OLD;
        }
        throw new Error('unexpected script: ' + script.slice(0, 60));
    }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5)));   // keep the test fast

const code = [
    grab(/const CLAUDE_RECONCILE_MS[\s\S]*?const CLAUDE_READ_ONLY_TOOLS = \['view'\];/, 'consts'),
    grab(/async function claudeListOutputs\([\s\S]*?\n\}/, 'claudeListOutputs'),
    grab(/function claudeFingerprint\([\s\S]*?\n\}/, 'claudeFingerprint'),
    grab(/function claudeToolPaths\([\s\S]*?\n\}/, 'claudeToolPaths'),
    grab(/async function downloadClaudeFile\([\s\S]*?\n\}/, 'downloadClaudeFile'),
    grab(/function claudeTouchedFiles\([\s\S]*?\n\}/, 'claudeTouchedFiles'),
    grab(/async function reconcileClaudeArtifacts\([\s\S]*?\n\}/, 'reconcileClaudeArtifacts')
].join('\n');

const reconcile = new Function('browserManager', 'sleep', 'Buffer', 'console',
    code + '\n return reconcileClaudeArtifacts;')(browserManager, sleep, Buffer, console);

let fails = 0;
const ok = (cond, label) => { console.log((cond ? '  PASS  ' : '  FAIL  ') + label); if (!cond) fails++; };

(async () => {
    // ── The reported bug: an edit, with the listing lagging.
    const baseline = { [P]: '12|' + T1 };
    const toolCalls = [{ name: 'str_replace', input: { path: P, old_str: 'x', new_str: 'y' } }];
    const got = await reconcile('conv-1', baseline, [], toolCalls);

    ok(got.length === 1, 'the edited file is recovered');
    ok(got[0] && got[0].fileText === NEW,
        'recovered content is the EDITED body, not the stale one' +
        (got[0] ? ' (got ' + JSON.stringify(got[0].fileText) + ')' : ''));
    ok(got[0] && got[0].stale === false, 'not flagged stale');
    ok(got[0] && got[0].viaListing === true, 'tagged as recovered via the listing');
    ok(listPolls >= 3, 'waited for two identical polls before trusting the listing (' + listPolls + ' polls)');

    // ── A turn that only read must cost nothing at all.
    const before = listPolls;
    const none = await reconcile('conv-1', baseline, [], [{ name: 'view', input: {} }]);
    ok(none.length === 0 && listPolls === before, 'a read-only turn does not touch the listing');

    // ── A file the stream already reported must not be downloaded twice.
    listPolls = 0; downloads = 0;
    const dup = await reconcile('conv-1', baseline, [{ path: P }], toolCalls);
    ok(dup.length === 0 && downloads === 0, 'a stream-reported file is not re-downloaded');

    // ── A new conversation has no baseline: everything present is this turn's.
    listPolls = 0; downloads = 0;
    const fresh = await reconcile('conv-2', null, [], toolCalls);
    ok(fresh.length === 1, 'with no baseline the file is still recovered');

    console.log(fails ? '\n' + fails + ' FAILURE(S)' : '\nall reconciliation assertions passed');
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('ERR ' + e.message); process.exit(1); });
