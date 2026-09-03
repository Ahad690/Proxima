/**
 * Drives reconcileClaudeArtifacts against a sandbox stubbed to lag the way the real one
 * was measured to lag — and specifically the way that defeated two earlier attempts.
 *
 * Observed on a live edit of a 49-byte file:
 *   - the listing bumped created_at immediately but kept reporting 49 bytes
 *   - it then sat STABLE on 49 across consecutive polls for several seconds
 *   - the download endpoint served the 49-byte pre-edit body throughout
 *
 * So "it changed", "it settled", and "the download matches the listing" were all true
 * while the file was stale. The only signal that cannot be fooled is the size the tool
 * call itself dictates: str_replace swaps old_str for new_str, so the result is exactly
 * previous + (new_str - old_str) bytes.
 */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../../electron/main-v2.cjs'), 'utf8');
const grab = (re, what) => {
    const m = src.match(re);
    if (!m) throw new Error('could not lift ' + what + ' — main-v2 shape changed');
    return m[0];
};

const P = '/mnt/user-data/outputs/PRD.md';
const OLD = '# Product Requirements\nSection A: initial scope.\n';               // 49 bytes
const NEW = '# Product Requirements\nSection A: initial scope.\nSection B.\n';   // 61 bytes
const OLD_B = Buffer.byteLength(OLD, 'utf8');
const NEW_B = Buffer.byteLength(NEW, 'utf8');
const T1 = '2026-09-01T09:39:35.000000Z';
const T2 = '2026-09-01T09:39:48.000000Z';

// str_replace('Section A: initial scope.\n' -> 'Section A: initial scope.\nSection B.\n')
const OLD_STR = 'Section A: initial scope.\n';
const NEW_STR = 'Section A: initial scope.\nSection B.\n';
const TOOLS = [{
    name: 'str_replace',
    input: { path: P, old_str: OLD_STR, new_str: NEW_STR },
    inputBytes: {
        path: Buffer.byteLength(P, 'utf8'),
        old_str: Buffer.byteLength(OLD_STR, 'utf8'),
        new_str: Buffer.byteLength(NEW_STR, 'utf8')
    }
}];

const entry = (bytes, createdAt) => [{
    path: P, kind: 'output', name: 'PRD.md', bytes, createdAt, contentType: 'text/markdown'
}];

let listPolls = 0;
let downloads = 0;
let LISTING = [];
let CONTENT = [];
const reset = (listing, content) => { LISTING = listing; CONTENT = content; listPolls = 0; downloads = 0; };

const browserManager = {
    executeScript: async (provider, script) => {
        if (script.indexOf('listArtifacts') !== -1) {
            const i = Math.min(listPolls, LISTING.length - 1);
            listPolls++;
            return JSON.stringify(LISTING[i]);
        }
        if (script.indexOf('downloadArtifact') !== -1) {
            const i = Math.min(downloads, CONTENT.length - 1);
            downloads++;
            return CONTENT[i];
        }
        throw new Error('unexpected script: ' + script.slice(0, 60));
    }
};
// Keep the suite fast; the logic under test cares about ordering, not wall-clock.
const sleep = (ms) => new Promise((r) => setTimeout(r, 1));

const code = [
    // Lifted through the cap constant, which sits after the read-only tool list, so both
    // arrive in one grab. Anchoring on the list's literal contents broke the moment tools
    // were added to it — a test that fails because the code improved is a bad test.
    grab(/const CLAUDE_RECONCILE_MS[\s\S]*?const CLAUDE_RECONCILE_MAX_FILES = \d+;/, 'consts'),
    grab(/async function claudeListOutputs\([\s\S]*?\n\}/, 'claudeListOutputs'),
    grab(/function claudeFingerprint\([\s\S]*?\n\}/, 'claudeFingerprint'),
    grab(/function claudeToolPaths\([\s\S]*?\n\}/, 'claudeToolPaths'),
    grab(/async function downloadClaudeFile\([\s\S]*?\n\}/, 'downloadClaudeFile'),
    grab(/function claudeTouchedFiles\([\s\S]*?\n\}/, 'claudeTouchedFiles'),
    grab(/function claudeExpectedBytes\([\s\S]*?\n\}/, 'claudeExpectedBytes'),
    grab(/async function reconcileClaudeArtifacts\([\s\S]*?\n\}/, 'reconcileClaudeArtifacts')
].join('\n');

const api = new Function('browserManager', 'sleep', 'Buffer', 'console',
    code + '\n return { reconcileClaudeArtifacts, claudeExpectedBytes };')(
    browserManager, sleep, Buffer, console);

let fails = 0;
const ok = (cond, label) => {
    console.log((cond ? '  PASS  ' : '  FAIL  ') + label);
    if (!cond) fails++;
};

(async () => {
    const baseline = entry(OLD_B, T1);

    // ── The prediction itself.
    ok(api.claudeExpectedBytes(P, OLD_B, TOOLS) === NEW_B,
        'expected size is derived from old_str/new_str (' + OLD_B + ' -> ' + NEW_B + ')');
    ok(api.claudeExpectedBytes(P, OLD_B, [{ name: 'mystery_tool', input: { path: P } }]) === null,
        'an unrecognised tool refuses to predict rather than predicting wrongly');

    // A read carries the SAME path as the edit, and the model views before editing as a
    // matter of course — so a read must not veto the prediction. Measured live: tools were
    // ["view","str_replace","create_file"] and prediction silently bailed.
    const viewThenEdit = [
        { name: 'view', input: { path: P, description: 'check contents' },
          inputBytes: { path: Buffer.byteLength(P, 'utf8'), description: 14 } }
    ].concat(TOOLS);
    ok(api.claudeExpectedBytes(P, OLD_B, viewThenEdit) === NEW_B,
        'a preceding view does not disable the prediction (still ' + NEW_B + 'B)');
    ok(api.claudeExpectedBytes(P, 49, [
        { name: 'view', input: { path: P }, inputBytes: { path: 1 } },
        { name: 'str_replace', input: { path: P }, inputBytes: { path: 1, old_str: 25, new_str: 52 } }
    ]) === 76, 'the live numbers reproduce: 49 + (52 - 25) = 76');

    // ── THE REGRESSION. The listing sits stably on the stale size, then catches up.
    // Stability, difference and listing/download agreement are all satisfied while stale.
    reset(
        [entry(OLD_B, T2), entry(OLD_B, T2), entry(OLD_B, T2), entry(NEW_B, T2)],
        [OLD, OLD, OLD, NEW]
    );
    const got = await api.reconcileClaudeArtifacts('c1', baseline, [], TOOLS);
    ok(got.length === 1, 'the edited file is recovered');
    ok(got[0] && got[0].fileText === NEW,
        'recovered body is the EDITED one, despite a stably-stale listing' +
        (got[0] ? ' (got ' + JSON.stringify(got[0].fileText.slice(0, 40)) + ')' : ''));
    ok(got[0] && got[0].stale === false, 'not flagged stale');
    ok(got[0] && got[0].viaListing === true, 'tagged as recovered via the listing');

    // ── A turn that only read must cost nothing.
    reset([entry(OLD_B, T1)], [OLD]);
    const none = await api.reconcileClaudeArtifacts('c1', baseline, [], [{ name: 'view', input: {} }]);
    ok(none.length === 0 && listPolls === 0, 'a read-only turn never touches the listing');

    // ── A file the stream already delivered AT THE RIGHT SIZE is not fetched again. The
    // size is the whole test: a plain create_file with no follow-up edit leaves the
    // stream's copy authoritative, and re-downloading it would be pure waste.
    const createOnly = [{
        name: 'create_file',
        input: { path: P, file_text: NEW },
        inputBytes: { path: Buffer.byteLength(P, 'utf8'), file_text: NEW_B }
    }];
    reset([entry(NEW_B, T2)], [NEW]);
    const dup = await api.reconcileClaudeArtifacts('c1', baseline,
        [{ path: P, fileText: NEW }], createOnly);
    ok(dup.length === 0 && downloads === 0, 'a stream-reported file is not re-downloaded');

    // ── A download that never catches up is saved but flagged, never reported as clean.
    reset([entry(NEW_B, T2)], [OLD, OLD, OLD, OLD, OLD]);
    const st = await api.reconcileClaudeArtifacts('c1', baseline, [], TOOLS);
    ok(st.length === 1 && st[0].stale === true,
        'a download that never converges is flagged stale rather than trusted');

    // == create_file then str_replace on the SAME path, in one turn. The stream holds the
    // pre-edit body, so "the stream mentioned it" must not count as delivered.
    const CREATED = 'draft\n';
    const createThenEdit = [
        { name: 'create_file', input: { path: P, file_text: CREATED },
          inputBytes: { path: 1, file_text: Buffer.byteLength(CREATED, 'utf8') } },
        { name: 'str_replace', input: { path: P, old_str: 'draft', new_str: 'final version' },
          inputBytes: { path: 1, old_str: 5, new_str: 13 } }
    ];
    const FINAL = 'final version\n';
    const FINAL_B = Buffer.byteLength(FINAL, 'utf8');
    ok(api.claudeExpectedBytes(P, null, createThenEdit) === FINAL_B,
        'create-then-edit predicts the POST-edit size (' + FINAL_B + 'B)');
    reset([entry(FINAL_B, T2)], [FINAL]);
    const cte = await api.reconcileClaudeArtifacts('c1', [],
        [{ path: P, fileText: CREATED }], createThenEdit);
    ok(cte.length === 1 && cte[0].fileText === FINAL,
        'a file created AND edited in one turn is re-fetched, not left at the streamed body');
    // == memory_read and present_files must not trigger a reconciliation. Both were seen
    // on the wire, neither can change a file, and an unlisted non-writing tool makes an
    // ordinary turn pay the whole reconciliation window.
    reset([entry(OLD_B, T1)], [OLD]);
    const readish = await api.reconcileClaudeArtifacts('c1', baseline, [],
        [{ name: 'memory_read', input: {} }, { name: 'present_files', input: {} }]);
    ok(readish.length === 0 && listPolls === 0,
        'memory_read + present_files do not touch the listing');

    // == The cap. A writing tool that names no path falls back to a full diff, and with
    // no baseline that means every output looks changed — the 60-file bulk download this
    // feature exists to avoid.
    const many = [];
    for (let i = 0; i < 12; i++) {
        many.push({ path: '/mnt/user-data/outputs/f' + i + '.md', kind: 'output',
            name: 'f' + i + '.md', bytes: 10, createdAt: '2026-09-01T09:39:' +
            String(10 + i) + '.000000Z', contentType: 'text/plain' });
    }
    listPolls = 0; downloads = 0; LISTING = [many]; CONTENT = ['xxxxxxxxxx'];
    const capped = await api.reconcileClaudeArtifacts('c1', [], [],
        [{ name: 'bash_tool', input: {} }]);
    ok(capped.length <= 5, 'a no-path writing tool cannot pull more than the cap (' + capped.length + ')');
    ok(downloads <= 5, 'and does not download more than the cap either (' + downloads + ')');
    // == THE REGRESSION FOUND AFTER THE CLAUDE UI CHANGE. Turn 1 created an 18B file and
    // was served from the stream, so nothing ever waited for the listing; turn 2's
    // baseline snapshot therefore came back EMPTY. With no previous size the prediction
    // cannot run, and the weak path used to accept the very first listing read on the
    // grounds that there was no baseline to compare against — handing over the pre-edit
    // body, unflagged, because the stale listing and the stale download agreed.
    //
    // An empty baseline must NOT shortcut the wait: a listing that has not caught up
    // looks identical to one with nothing in it.
    reset(
        [entry(OLD_B, T2), entry(OLD_B, T2), entry(NEW_B, T2), entry(NEW_B, T2)],
        [OLD, OLD, NEW, NEW]
    );
    const noBase = await api.reconcileClaudeArtifacts('c1', [], [], TOOLS);
    ok(noBase.length === 1, 'a file is still recovered with no baseline');
    ok(noBase[0] && noBase[0].fileText === NEW,
        'with NO baseline it still waits for the listing to settle rather than taking the' +
        ' first read' + (noBase[0] ? ' (got ' + JSON.stringify(noBase[0].fileText.slice(0,30)) + ')' : ''));
    ok(listPolls > 1, 'it polled more than once instead of short-circuiting (' + listPolls + ')');
    console.log(fails ? '\n' + fails + ' FAILURE(S)' : '\nall reconciliation assertions passed');
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('ERR ' + e.message); process.exit(1); });
