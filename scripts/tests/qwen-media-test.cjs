/**
 * Unit-tests the Qwen generated-media collector by lifting it out of the engine and
 * feeding it the two REAL frame shapes — one measured on the wire here, one recorded in
 * qwenprotocol.md §14 from an earlier capture pass.
 *
 * Two routes reach the same feature, and they look nothing alike:
 *
 *   explicit  chat_type t2i  -> phase `image_gen`, URL directly in delta.content, no prose
 *   implicit  plain t2t      -> phase `image_gen_tool`, content EMPTY throughout, URLs in
 *                              extra.image_list[] and extra.tool_result[], prose in `answer`
 *
 * The collector keys on the CDN host rather than the phase name, which is what lets an
 * undocumented phase (t2v's, still unknown) deliver a video without anyone discovering
 * its name first. These tests pin that behaviour.
 */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../../electron/providers/qwen-engine.js'), 'utf8');
const grab = (re, what) => {
    const m = src.match(re);
    if (!m) throw new Error('could not lift ' + what + ' — engine shape changed');
    return m[0];
};

const code = [
    grab(/var MEDIA_ORIGIN = '[^']+';/, 'MEDIA_ORIGIN'),
    grab(/function collectMedia\(state, d\)[\s\S]*?\n    \}/, 'collectMedia')
].join('\n');
const collectMedia = new Function(code + '\n return collectMedia;')();

const CDN = 'https://cdn.qwenlm.ai/output/49722067-a00f-4db1-8ab9-4ead369b3803';
const SIG = '?key=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyZXNvdXJjZV91c2VyX2lkIjoiNDk3MjIwNjcifQ.15Ex';

let fails = 0;
const ok = (c, l) => { console.log((c ? '  PASS  ' : '  FAIL  ') + l); if (!c) fails++; };
const fresh = () => ({ media: [] });

// ── 1. Explicit t2i, exactly as measured: URL in content, phase image_gen.
{
    const url = CDN + '/t2i/edfd0504-3e7f-427a-bed8-110c402ba4ff/17884420985b0f.png' + SIG;
    const st = fresh();
    collectMedia(st, { role: 'assistant', content: url, phase: 'image_gen', status: 'typing' });
    collectMedia(st, { role: 'assistant', content: '', phase: 'image_gen', status: 'finished' });
    ok(st.media.length === 1, 'explicit t2i yields exactly one asset');
    ok(st.media[0] && st.media[0].url === url, 'the full signed URL is kept intact');
    ok(st.media[0] && st.media[0].ext === 'png',
        'extension comes from the PATH, not the 400-char signature (got ' +
        (st.media[0] || {}).ext + ')');
    ok(st.media[0] && st.media[0].primary === true, 'marked primary, so it gets downloaded');
    ok(st.media[0] && st.media[0].from === 'image_gen.content', 'records where it came from');
}

// ── 2. Implicit route, per §14.2: content empty, two URLs for the SAME image under
// different paths. tool_result must not be downloaded as a second file.
{
    const shown = CDN + '/image_gen/dcd0e2bd-1111-2222-3333-444455556666/1788442098.png' + SIG;
    const dupe = CDN + '/t2i/78dfd5f5-8d79-422a-9534-3fab8c247ffc/abcdef01.png' + SIG;
    const st = fresh();
    collectMedia(st, {
        role: 'assistant', content: '', phase: 'image_gen_tool', status: 'finished',
        extra: { display_position: 'answer', image_list: [{ image: shown }], tool_result: [{ image: dupe }] }
    });
    ok(st.media.length === 2, 'both URLs are recorded (they are genuinely different paths)');
    const primaries = st.media.filter((m) => m.primary);
    ok(primaries.length === 1, 'only ONE is primary, so one image saves once (got ' + primaries.length + ')');
    ok(primaries[0] && primaries[0].url === shown,
        'the primary is image_list — the one the UI renders — not tool_result');
}

// ── 3. The point of keying on the host: an UNDOCUMENTED phase still delivers. t2v's
// phase name is unknown, so this must work without naming it.
{
    const vid = CDN + '/t2v/9c8b7a65-4321-0000-1111-222233334444/clip.mp4' + SIG;
    const st = fresh();
    collectMedia(st, { role: 'assistant', content: '', phase: 'some_future_video_phase',
        extra: { video_list: [{ video: vid }] } });
    ok(st.media.length === 1, 'an unknown phase still yields the asset');
    ok(st.media[0] && st.media[0].ext === 'mp4', 'video extension detected');
    ok(st.media[0] && st.media[0].primary === true, 'and it is downloadable');
}

// ── 4. Prose must never be mistaken for an asset. This is the guard that keeps a link
// inside an ordinary answer out of the media list.
{
    const st = fresh();
    collectMedia(st, { role: 'assistant', phase: 'answer',
        content: 'You can read more at https://cdn.qwenlm.ai/docs and elsewhere.' });
    ok(st.media.length === 0,
        'a CDN link mentioned mid-sentence is not collected (only content that STARTS with it)');
    collectMedia(st, { role: 'assistant', phase: 'answer', content: 'https://example.com/x.png' });
    ok(st.media.length === 0, 'a non-CDN URL is ignored');
}

// ── 4b. THE HALLUCINATION TRAP, captured live by the extension pass. After a real i2v
// clip earlier in the same conversation, the model emitted a perfectly-shaped CDN video
// URL in plain `answer` prose. Fetching it returned 404 text/html — it had imitated the
// shape from its own context. A URL in answer text is not evidence of an asset.
{
    const fake = CDN + '/i2v/deadbeef-0000-1111-2222-333344445555/faked.mp4' + SIG;
    const st = fresh();
    // Whole content is the URL, so the "starts with the CDN origin" rule alone would
    // happily take it. The phase is what disqualifies it.
    collectMedia(st, { role: 'assistant', phase: 'answer', content: fake });
    ok(st.media.length === 0, 'a hallucinated CDN URL in ANSWER prose is never collected');
    collectMedia(st, { role: 'assistant', phase: 'thinking_summary', content: fake });
    ok(st.media.length === 0, 'nor one in a thinking block');
    // ...and the same URL from a real generation phase still is.
    collectMedia(st, { role: 'assistant', phase: 'image_gen', content: fake });
    ok(st.media.length === 1, 'the same URL from a generation phase IS collected');
}

// ── 5. Repeated frames must not multiply the asset. The explicit route sends the URL
// once, but the tally showed two frames on the phase and re-broadcast is common here.
{
    const url = CDN + '/t2i/aaa/bbb.png' + SIG;
    const st = fresh();
    for (let i = 0; i < 5; i++) collectMedia(st, { content: url, phase: 'image_gen' });
    ok(st.media.length === 1, 'the same URL across five frames is deduped');
}

console.log(fails ? '\n' + fails + ' FAILURE(S)' : '\nall qwen media assertions passed');
process.exit(fails ? 1 : 0);
