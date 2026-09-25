/**
 * The image poll decides when a ChatGPT turn is done. It got that wrong twice, both times
 * by settling on a message from an EARLIER turn, and both times the mistake only showed up
 * on a live run that happened to reuse a conversation. So the decision logic is pinned
 * here against the message shapes actually observed on the wire.
 *
 * Tail captured at the moment of the second failure, oldest first:
 *   [2] assistant  text             final   <- previous turn's reply
 *   [3] user       text             null    <- the request being waited on
 *   [4] tool       multimodal_text  final   <- the image; did NOT exist yet while polling
 *   [5] assistant  reasoning_recap  null
 */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../../electron/providers/chatgpt-engine.js'), 'utf8');
const grab = (re, what) => {
    const m = src.match(re);
    if (!m) throw new Error('could not lift ' + what + ' — engine shape changed');
    return m[0];
};

// Lift the real functions, with fetch/auth stubbed so no network is touched.
const code = [
    grab(/var IMAGE_PART = '[^']+';/, 'IMAGE_PART'),
    // Lifted too: the collector consults it to skip images WE uploaded, which the
    // stream echoes back inside the user message.
    grab(/var _turnUploadIds = \[\];/, '_turnUploadIds'),
    grab(/function collectImageParts\(msg, into\)[\s\S]*?\n    \}/, 'collectImageParts'),
    grab(/async function fetchConversationImages\(convId\)[\s\S]*?\n    \}/, 'fetchConversationImages')
].join('\n');

let stubbedMessages = [];
const makeApi = () => new Function('fetch', '_getToken', '_accountId', 'encodeURIComponent',
    code + '\n return { fetchConversationImages: fetchConversationImages, collectImageParts: collectImageParts, setUploadIds: function (ids) { _turnUploadIds = ids; } };')(
    // fetch: first call is the conversation read
    async () => ({ ok: true, json: async () => ({ messages: stubbedMessages }) }),
    async () => 'stub-token',
    'stub-account',
    encodeURIComponent
);

const msg = (role, ctype, channel, parts) => ({
    author: { role: role }, channel: channel, status: 'finished_successfully',
    content: { content_type: ctype, parts: parts || [] }
});
const POINTER = {
    content_type: 'image_asset_pointer',
    asset_pointer: 'sediment://file_0000000006f8820ba0a29ec02b00c501',
    mime_type: 'image/png', size_bytes: 1069888, width: 1254, height: 1254, metadata: {}
};
const HISTORY = [
    msg('system', 'text', null, ['sys']),
    msg('assistant', 'text', 'final', ['PONG'])   // the previous turn — the trap
];

let fails = 0;
const ok = (c, l) => { console.log((c ? '  PASS  ' : '  FAIL  ') + l); if (!c) fails++; };

(async () => {
    const api = makeApi();

    // 1. MID-GENERATION. The request is in, nothing has come back. The newest final
    //    message is still the PREVIOUS turn's reply — settling on it is the bug.
    stubbedMessages = HISTORY.concat([msg('user', 'text', null, ['draw an apple'])]);
    let r = await api.fetchConversationImages('c1');
    ok(r.settled === false, 'mid-generation is NOT settled by the previous turn\'s text reply');
    ok(r.images.length === 0, 'and reports no images yet');

    // 2. IMAGE LANDED.
    stubbedMessages = HISTORY.concat([
        msg('user', 'text', null, ['draw an apple']),
        msg('tool', 'multimodal_text', 'final', [POINTER]),
        msg('assistant', 'reasoning_recap', null, [])
    ]);
    r = await api.fetchConversationImages('c1');
    ok(r.images.length === 1, 'the image is found once it exists');
    ok(r.images[0].id === 'file_0000000006f8820ba0a29ec02b00c501',
        'the sediment:// scheme is stripped to the bare file id');
    ok(r.settled === false, 'an image turn does not report itself as a settled text answer');

    // 3. TEXT ANSWER in the same thread — must stop promptly, not wait out the deadline.
    stubbedMessages = HISTORY.concat([
        msg('user', 'text', null, ['what is 2+2?']),
        msg('assistant', 'text', 'final', ['4'])
    ]);
    r = await api.fetchConversationImages('c1');
    ok(r.settled === true, 'a text answer settles, so an ordinary question does not wait');
    ok(r.images.length === 0, 'and carries no images');

    // 4. THE OTHER HALF of the earlier bug: an image generated in a PREVIOUS turn must not
    //    be re-collected and handed back as though this turn produced it.
    stubbedMessages = [
        msg('user', 'text', null, ['draw an apple']),
        msg('tool', 'multimodal_text', 'final', [POINTER]),
        msg('user', 'text', null, ['what is 2+2?']),
        msg('assistant', 'text', 'final', ['4'])
    ];
    r = await api.fetchConversationImages('c1');
    ok(r.images.length === 0, 'an image from an earlier turn is NOT re-collected');
    ok(r.settled === true, 'and the later text turn still settles');

    // 5. THE UPLOAD ECHO. Once Proxima could attach files, an image WE uploaded came
    //    back on the stream inside the echoed user message and was collected as though
    //    the model had produced it. Measured: the png written to chatgpt-media had the
    //    same sha256 as the file just uploaded. Excluded by id, not by role — the role
    //    filter is exactly what got this wrong the first time round.
    const MINE = 'file_0000000006f8820ba0a29ec02b00c501';
    api.setUploadIds([MINE]);
    let collected = [];
    api.collectImageParts(msg('user', 'multimodal_text', null, [POINTER]), collected);
    ok(collected.length === 0, 'an image WE uploaded is not collected as generated');

    // And the exclusion must not persist: a later turn generating an image with the
    // same id would otherwise be silently dropped.
    api.setUploadIds([]);
    collected = [];
    api.collectImageParts(msg('tool', 'multimodal_text', 'final', [POINTER]), collected);
    ok(collected.length === 1, 'clearing the upload list restores normal collection');

    console.log(fails ? '\n' + fails + ' FAILURE(S)' : '\nall image-turn assertions passed');
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('ERR ' + e.message); process.exit(1); });
