const parser = require('../lib/review-parser.cjs');
const safety = require('../lib/safety.cjs');
const loop = require('../proxima-loop.cjs');
const path = require('path');
const fs = require('fs');

function testReviewParser() {
    console.log('Testing Review Parser...');
    
    // 1. Standard parsing
    const standardReview = `
## Score: 7/10
## Bugs & Failure Modes
| File:Line | Severity | Finding | Evidence |
|-----------|----------|---------|----------|
| main.js:10 | Critical | Bug 1 | ... |
| utils.js:5 | High | Bug 2 | ... |
`;
    const c1 = parser.parseSeverityCounts(standardReview);
    if (!c1.parsed || c1.critical !== 1 || c1.high !== 1) throw new Error('Standard parsing failed');
    if (parser.parseScore(standardReview) !== 7) throw new Error('Score parsing failed');

    // 2. Emoji severities
    const emojiReview = `
## Bugs & Failure Modes
| File:Line | Severity | Finding |
|-----------|----------|---------|
| a.js:1 | 🔴 | Critical bug |
| b.js:2 | 🟠 | High bug |
| c.js:3 | 🟡 | Medium bug |
| d.js:4 | 🟢 | Low bug |
`;
    const c2 = parser.parseSeverityCounts(emojiReview);
    if (!c2.parsed || c2.critical !== 1 || c2.high !== 1 || c2.medium !== 1 || c2.low !== 1) {
        throw new Error('Emoji severity parsing failed');
    }

    // 3. Decimal and bold scores
    const scoreReview1 = `## Score: 7.5/10`;
    const scoreReview2 = `## Score: **8/10**`;
    if (parser.parseScore(scoreReview1) !== 7.5) throw new Error('Decimal score parsing failed');
    if (parser.parseScore(scoreReview2) !== 8) throw new Error('Bold score parsing failed');

    // 4. Malformed review (missing table)
    const malformedReview = `## Score: 5/10\nSome random text but no bugs table.`;
    const c3 = parser.parseSeverityCounts(malformedReview);
    if (c3.parsed !== false) throw new Error('Malformed review should return parsed: false');

    // 5. Empty table
    const emptyTableReview = `## Bugs & Failure Modes\n\n`;
    const c4 = parser.parseSeverityCounts(emptyTableReview);
    if (c4.parsed !== false) throw new Error('Empty table should return parsed: false');

    console.log('✅ Review Parser tests passed.');
}

function testSafetyValidator() {
    console.log('Testing Safety Validator...');
    const gitRoot = 'C:\\repo';
    const config = {
        allowGeneratedScripts: false,
        allowWorkflowModification: false,
        allowReviewHistoryModification: false
    };

    // 1. Block dangerous extensions
    try {
        safety.rejectDangerousPaths('--- a/test.js\n+++ b/test.sh', gitRoot, config);
        throw new Error('Should have blocked .sh');
    } catch (e) {
        if (!e.message.includes('Generated scripts are disabled')) throw e;
    }

    // 2. Block GitHub workflows
    try {
        safety.rejectDangerousPaths('--- a/test.js\n+++ b/.github/workflows/deploy.yml', gitRoot, config);
        throw new Error('Should have blocked workflow modification');
    } catch (e) {
        if (!e.message.includes('Workflow modification is disabled')) throw e;
    }

    // 3. Block package lifecycle scripts
    const packageJsonPatch = `
--- a/package.json
+++ b/package.json
@@ -5,1 +5,2 @@
-  "scripts": {
+  "scripts": {
+    "postinstall": "malicious script",
`;
    try {
        safety.rejectPackageJsonScripts(packageJsonPatch, config);
        throw new Error('Should have blocked postinstall modification');
    } catch (e) {
        if (!e.message.includes('Package lifecycle script modification detected')) throw e;
    }

    // 4. Reject actual OpenAI Begin Patch wrapper format
    const beginPatchFormat = `
*** Begin Patch
*** Update File: scripts/lib/safety.cjs
@@ -1,1 +1,1 @@
-old
+new
*** End Patch
`;
    try {
        safety.validatePatchText(beginPatchFormat);
        throw new Error('Should have blocked OpenAI Begin Patch wrapper format');
    } catch (e) {
        if (!e.message.includes('Response uses OpenAI *** Begin Patch format')) throw e;
    }

    // 5. Do not false-positive when a diff line merely contains the marker text
    const quotedMarkerInDiff = `
diff --git a/scripts/lib/safety.cjs b/scripts/lib/safety.cjs
--- a/scripts/lib/safety.cjs
+++ b/scripts/lib/safety.cjs
@@ -1,1 +1,1 @@
-const msg = "old";
+const msg = "Response uses OpenAI *** Begin Patch format.";
`;
    safety.validatePatchText(quotedMarkerInDiff);

    // 6. Reject diff-like text that lacks real hunk headers/body structure
    const malformedDiffLike = `
diff --git a/file.js b/file.js
index 1111111..2222222 100644
--- a/file.js
+++ b/file.js
-const A = 1;
+const A = 2;
Hunk headers (@@ -L,N +L,N @@) must match.
`;
    try {
        safety.validatePatchText(malformedDiffLike);
        throw new Error('Should have rejected malformed diff-like patch');
    } catch (e) {
        const ok =
            e.message.includes('valid unified diff') ||
            e.message.includes('malformed hunk header') ||
            e.message.includes('invalid hunk body line');
        if (!ok) throw e;
    }

    console.log('✅ Safety Validator tests passed.');
}

function testPRBody() {
    console.log('Testing PR Body constraints...');
    // This is a logic check - ensure createPR in loop doesn't leak paths.
    // Since we've hardcoded the string in scripts/proxima-loop.cjs, 
    // we'll just check if the logic in the script is correct via visual inspection 
    // or by checking if we still use ${sessionDir} in the code.
    const loopPath = path.join(__dirname, '../proxima-loop.cjs');
    const content = fs.readFileSync(loopPath, 'utf8');
    if (content.includes('Local review folder: ${sessionDir}')) {
        throw new Error('PR body still contains local sessionDir leak!');
    }
    console.log('✅ PR Body leak check passed.');
}

function testPatchNormalization() {
    console.log('Testing Patch Normalization...');

    const noFinalNewline = [
        'diff --git a/a.txt b/a.txt',
        '--- a/a.txt',
        '+++ b/a.txt',
        '@@ -1,99 +1,99 @@',
        '-old',
        '+new'
    ].join('\n');

    const normalized = loop.normalizePatchText(noFinalNewline);
    if (!normalized.endsWith('\n')) throw new Error('Patch normalization should add final newline');

    const fixed = loop.fixPatchHunkHeaders(noFinalNewline);
    if (!fixed.endsWith('\n')) throw new Error('Hunk fixer should preserve final newline');
    if (!fixed.includes('@@ -1,1 +1,1 @@')) throw new Error('Hunk fixer should recount patch lines');

    const noNewlineMarker = [
        'diff --git a/a.txt b/a.txt',
        '--- a/a.txt',
        '+++ b/a.txt',
        '@@ -1,99 +1,99 @@',
        '-old',
        '\\ No newline at end of file',
        '+new',
        '\\ No newline at end of file'
    ].join('\n');

    const fixedWithMarker = loop.fixPatchHunkHeaders(noNewlineMarker);
    if (!fixedWithMarker.includes('@@ -1,1 +1,1 @@')) {
        throw new Error('Hunk fixer should not count no-newline markers as patch lines');
    }

    const markdownWrappedDiff = [
        'diff --git a/a.txt b/a.txt',
        'index 1111111..2222222 100644',
        '--- a/a.txt',
        '+++ b/a.txt',
        '@@ -1,3 +1,3 @@',
        '* line one',
        '- old',
        '+ new',
        '* ```',
        '* trailing fence should be ignored',
        '* ```'
    ].join('\n');

    const recovered = loop.recoverUnifiedDiffFromMarkdown(markdownWrappedDiff);
    safety.validatePatchText(recovered);
    if (!recovered.includes('@@ -1,3 +1,3 @@')) {
        throw new Error('Recovered patch should keep hunk headers');
    }
    if (!recovered.includes(' line one')) {
        throw new Error('Recovered patch should unwrap markdown bullet context lines');
    }

    console.log('✅ Patch Normalization tests passed.');
}

function testRepairRetryGuards() {
    console.log('Testing Repair Retry Guards...');

    const loopPath = path.join(__dirname, '../proxima-loop.cjs');
    const content = fs.readFileSync(loopPath, 'utf8');

    if (!content.includes('function sanitizeFeedbackForPrompt')) {
        throw new Error('Repair retry feedback should be sanitized before prompting');
    }
    if (!content.includes('isRetryablePatchValidationError(validationResult.error)')) {
        throw new Error('Validator retry should be limited to retryable patch format errors');
    }
    if (!content.includes('const applyRetryValidation = validateCandidatePatch(rawPatch);')) {
        throw new Error('Apply-check retry should validate/recover via candidate patch validator');
    }

    console.log('✅ Repair Retry Guards tests passed.');
}

function testThinkingEffortWiring() {
    console.log('Testing Thinking Effort Wiring...');

    const reviewScript = fs.readFileSync(path.join(__dirname, '../../cli/proxima-review.cjs'), 'utf8');
    const repairClient = fs.readFileSync(path.join(__dirname, '../lib/proxima-client.cjs'), 'utf8');
    const mainProcess = fs.readFileSync(path.join(__dirname, '../../electron/main-v2.cjs'), 'utf8');
    const chatgptEngine = fs.readFileSync(path.join(__dirname, '../../electron/providers/chatgpt-engine.js'), 'utf8');

    // Behaviour, not spelling: the effort must reach the payload when there IS one.
    // It is deliberately omitted when resolveThinkingEffort() has no opinion, so that
    // the engine's own default governs rather than a second copy here.
    if (!/payload\.thinkingEffort = REVIEW_THINKING_EFFORT/.test(reviewScript)) {
        throw new Error('Review IPC payload does not carry thinkingEffort');
    }
    if (!repairClient.includes('return { message, model, thinkingEffort };')) {
        throw new Error('Repair IPC payload does not include thinkingEffort');
    }
    if (!mainProcess.includes('thinkingEffort: data.thinkingEffort')) {
        throw new Error('Main process does not forward thinkingEffort option');
    }
    // The engine serializes the effort into the oai-last-model-config payload.
    // It used to be `thinking_effort: conversationMeta.thinking_effort`; commit
    // e581df0 (2026-05-18, "revert chatgpt core flow to 1f59759 baseline")
    // changed the shape and this assertion was left pinning the old one, so the
    // suite has failed ever since. Assert the behaviour — that thinkingEffort
    // reaches the payload — rather than one spelling of it.
    if (!chatgptEngine.includes('options.thinkingEffort')) {
        throw new Error('ChatGPT engine payload is missing thinkingEffort serialization');
    }

    // The gate used to read `options.model && options.model.includes('thinking')`, so
    // it only fired when the CALLER named a model. Every default call skipped it and
    // sent the reasoning model with no oai-last-model-config — nothing errors, the
    // answers just come back unreasoned. Assert it keys off the RESOLVED model.
    if (/options\.model\s*&&\s*options\.model\.includes\('thinking'\)/.test(chatgptEngine)) {
        throw new Error('ChatGPT effort gate keys off options.model again — a default ' +
            'call will send no oai-last-model-config and run unreasoned');
    }
    // Effort must ride TOP-LEVEL and unconditionally. Captured from the real app:
    // it sends thinking_effort beside the model and no oai-last-model-config at all.
    // The previous assertion here demanded a slug containing 'thinking', which was
    // true of the old name-gated block and became wrong the moment the default moved
    // to gpt-6-astra-wm — a slug with no 'thinking' in it that still takes an effort.
    if (!/payload\.thinking_effort\s*=/.test(chatgptEngine)) {
        throw new Error('ChatGPT payload does not set a top-level thinking_effort');
    }
    // Match the CODE form, not the name: the comments above the payload explain why
    // the field was dropped, and an indexOf on the bare name matches that prose.
    if (/payload[['"]oai-last-model-config/.test(chatgptEngine)) {
        throw new Error('ChatGPT engine still sends oai-last-model-config — the app ' +
            'stopped sending it, and it does not carry effort for the current models');
    }
    const cgEffort = (chatgptEngine.match(/var DEFAULT_EFFORT = '([^']+)'/) || [])[1];
    const cgSeen = (chatgptEngine.match(/var EFFORTS_SEEN = \[([^\]]*)\]/) || [])[1] || '';
    if (!cgEffort || cgSeen.indexOf("'" + cgEffort + "'") === -1) {
        throw new Error('ChatGPT DEFAULT_EFFORT "' + cgEffort + '" is not among the ' +
            'efforts observed on the wire (' + cgSeen + ')');
    }
    // Same trap one layer out: reviews must actually reason. This reads the EFFECTIVE
    // config — loadConfig() lets a repo-root proxima-automation.config.json override the
    // shipped default, and this repo's does (reviewModel 'qwen'). An earlier version of
    // this check read the default and passed while the real setting was something else,
    // which is worse than no check: it reports on a value nothing uses.
    const effective = require('../lib/config.cjs').loadConfig();
    const revModel = String(effective.reviewModel || '');
    const isQwen = /^qwen|^tongyi/.test(revModel.toLowerCase());
    if (isQwen) {
        // Qwen reasons on a boolean, not on the model name.
        if (effective.reviewThinking === false) {
            throw new Error('reviewModel is qwen but reviewThinking is false — every ' +
                'review would run unreasoned');
        }
    } else if (revModel.toLowerCase() === 'chatgpt') {
        // Defers to the engine, whose own default effort is asserted above.
    } else if (revModel.indexOf('thinking') === -1) {
        // A named chatgpt slug without 'thinking' gets no effort from
        // resolveThinkingEffort(), so it would inherit the engine default silently.
        // That may be fine, but it should be stated, not stumbled into: use 'chatgpt'
        // to defer on purpose, or name a thinking-lane slug.
        throw new Error('reviewModel "' + revModel + '" pins a chatgpt slug with no ' +
            'effort mapping — use "chatgpt" to defer to the engine default, or a ' +
            'thinking-lane slug');
    }

    console.log('✅ Thinking Effort Wiring tests passed.');
}

function testQwenThinkingWiring() {
    console.log('Testing Qwen Thinking Wiring...');

    const reviewScript = fs.readFileSync(path.join(__dirname, '../../cli/proxima-review.cjs'), 'utf8');
    const repairClient = fs.readFileSync(path.join(__dirname, '../lib/proxima-client.cjs'), 'utf8');
    const mainProcess = fs.readFileSync(path.join(__dirname, '../../electron/main-v2.cjs'), 'utf8');
    const qwenEngine = fs.readFileSync(path.join(__dirname, '../../electron/providers/qwen-engine.js'), 'utf8');

    // Qwen reasons only when asked. The engine does `!!o.thinking`, so a payload that
    // omits the flag runs qwen3.8-max with thinking_enabled:false and says nothing.
    // Measured before the fix: phases ["answer"], zero thinking blocks. Every review
    // and every repair had been running unreasoned since the provider was added.
    if (!reviewScript.includes('thinking: REVIEW_THINKING')) {
        throw new Error('Review qwen payload does not pass thinking');
    }
    if (!/provider === 'qwen'/.test(repairClient) || !/thinking: true/.test(repairClient)) {
        throw new Error('Repair client has no qwen branch passing thinking');
    }
    // The allowlist in main-v2 drops any option not named in it, with no error.
    if (!mainProcess.includes('thinking: data.thinking')) {
        throw new Error('Main process does not forward the thinking option');
    }
    // Assert the behaviour, not a spelling: thinking has to reach feature_config.
    if (!qwenEngine.includes('thinking_enabled')) {
        throw new Error('Qwen engine does not serialize thinking_enabled');
    }

    // The QA video reviewer was the third caller running unreasoned, and it survived the
    // first fix because that fix only checked the two callers already known about. So
    // this asserts every Qwen entry point, not a list of the ones that broke.
    const videoReview = fs.readFileSync(path.join(__dirname, '../../tools/qa-video-review/qwen-review.cjs'), 'utf8');
    if (!/thinking: args\.thinking/.test(videoReview) || !/thinking: true/.test(videoReview)) {
        throw new Error('QA video reviewer does not pass thinking (default on)');
    }
    const mcp = fs.readFileSync(path.join(__dirname, '../../src/mcp-server-v3.js'), 'utf8');
    if (!/opts\.thinking = thinking !== false/.test(mcp)) {
        throw new Error('ask_qwen does not default thinking on');
    }

    // Passing the flag is not the same as the model having reasoned. The engine tallies
    // SSE phases, and thinking_summary appears only when reasoning frames arrived, so
    // that tally is the falsifier — without it back on the response, "I asked for
    // thinking" is the only evidence anyone has, which is how this bug lasted so long.
    if (!mainProcess.includes('function qwenDidThink') || !mainProcess.includes('thinkingUsed:')) {
        throw new Error('Main process does not report whether Qwen actually reasoned');
    }
    if (!qwenEngine.includes('phases: r.state.phases')) {
        throw new Error('Qwen engine does not expose the phase tally that proves reasoning');
    }
    if (!/thinkingStatus === 'contradicted'/.test(videoReview)) {
        throw new Error('QA video reviewer does not act on an unreasoned verdict');
    }

    console.log('✅ Qwen Thinking Wiring tests passed.');
}
// Lifts the real state functions out of the engine and exercises them against a stub
// localStorage. Worth a unit test rather than an assertion on source text, because the
// bug it guards was a *behavioural* one that read perfectly: newConversation() cleared
// its own session and then called removeItem(STORE_KEY), destroying the persisted
// conversation of every OTHER session. Any caller starting a fresh chat silently
// unpinned the orchestrator's thread. Found in code review of fbf501c9.
function testQwenSessionState() {
    console.log('Testing Qwen Session State...');
    const src = fs.readFileSync(path.join(__dirname, '../../electron/providers/qwen-engine.js'), 'utf8');
    const store = {};
    global.window = {
        localStorage: {
            getItem: (k) => (k in store ? store[k] : null),
            setItem: (k, v) => { store[k] = String(v); },
            removeItem: (k) => { delete store[k]; }
        }
    };
    const grab = (re, what) => {
        const m = src.match(re);
        if (!m) throw new Error('engine shape changed, cannot lift: ' + what);
        return m[0];
    };
    const code = [
        grab(/var STORE_KEY = [\s\S]*?var _sessions = \{\};/, 'state vars'),
        grab(/function newSession\(\)[\s\S]*?\n    \}/, 'newSession'),
        grab(/function sess\(key\)[\s\S]*?\n    \}/, 'sess'),
        grab(/function loadState\(\)[\s\S]*?\n    \}/, 'loadState'),
        grab(/function saveState\(\)[\s\S]*?\n    \}/, 'saveState'),
        grab(/function newConversation\(S\)[\s\S]*?\n    \}/, 'newConversation')
    ].join('\n');
    const mk = () => new Function(code +
        '\n return { sess, loadState, saveState, newConversation };')();

    const api = mk();
    api.sess('orchestrator').chatId = 'aaaa-orch';
    api.sess('automation').chatId = 'bbbb-auto';
    api.sess('qa-review').chatId = 'cccc-qa';
    api.saveState();

    api.newConversation(api.sess('automation'));
    const after = JSON.parse(store.__proxima_qwen_state).sessions;
    if (!after.orchestrator || after.orchestrator.chatId !== 'aaaa-orch') {
        throw new Error('newConversation on one session destroyed another session (orchestrator)');
    }
    if (!after['qa-review'] || after['qa-review'].chatId !== 'cccc-qa') {
        throw new Error('newConversation on one session destroyed another session (qa-review)');
    }
    if (after.automation) throw new Error('reset session was not dropped from storage');
    if (api.sess('automation').chatId !== null) throw new Error('reset session not cleared in memory');

    // Re-injection after a CAPTCHA or navigation must restore exactly the survivors.
    const fresh = mk();
    fresh.loadState();
    if (fresh.sess('orchestrator').chatId !== 'aaaa-orch') throw new Error('orchestrator lost on re-injection');
    if (fresh.sess('qa-review').chatId !== 'cccc-qa') throw new Error('qa-review lost on re-injection');
    if (fresh.sess('automation').chatId !== null) throw new Error('reset session came back on re-injection');

    delete global.window;
    console.log('✅ Qwen Session State tests passed.');
}

// The sandbox reconciliation is async and needs stubs, so it lives in its own file and
// runs as a child. It guards the subtler half of the edited-file bug: the listing and
// the download endpoint lag independently, so a download taken the moment the listing
// first moved returned the PRE-edit body while agreeing with the PRE-edit size. Two
// stale sources corroborating each other is why byte-matching alone was not enough.
function testClaudeReconcile() {
    console.log('Testing Claude Sandbox Reconciliation...');
    const r = require('child_process').spawnSync(process.execPath,
        [path.join(__dirname, 'claude-reconcile-test.cjs')], { encoding: 'utf8' });
    if (r.status !== 0) {
        throw new Error('claude-reconcile-test failed:\n' + (r.stdout || '') + (r.stderr || ''));
    }
    console.log('✅ Claude Sandbox Reconciliation tests passed.');
}

// Generated-media extraction has two wire shapes that look nothing alike, and the
// collector keys on the CDN host rather than the phase name so an undocumented phase
// (t2v's, still unknown) delivers without discovery. Own file, run as a child.
function testQwenMedia() {
    console.log('Testing Qwen Generated Media...');
    const r = require('child_process').spawnSync(process.execPath,
        [path.join(__dirname, 'qwen-media-test.cjs')], { encoding: 'utf8' });
    if (r.status !== 0) {
        throw new Error('qwen-media-test failed:\n' + (r.stdout || '') + (r.stderr || ''));
    }
    console.log('✅ Qwen Generated Media tests passed.');
}

// The ChatGPT image poll decides when a turn is finished, and it got that wrong twice
// — both times settling on a message from an EARLIER turn, both times invisible until
// a live run happened to reuse a conversation. Own file, run as a child.
function testChatGPTImageTurn() {
    console.log('Testing ChatGPT Image Turn...');
    const r = require('child_process').spawnSync(process.execPath,
        [path.join(__dirname, 'chatgpt-image-turn-test.cjs')], { encoding: 'utf8' });
    if (r.status !== 0) {
        throw new Error('chatgpt-image-turn-test failed:\n' + (r.stdout || '') + (r.stderr || ''));
    }
    console.log('✅ ChatGPT Image Turn tests passed.');
}


// The Claude default model is stated in THREE places that nothing forces to agree:
// the engine constant, the wire-confirmed id list beside it, and the ask_claude tool
// description that every agent reads to learn what the default is. Bumping the engine
// and leaving the description behind does not break a single call — it just tells
// every caller the wrong thing, which is the quietest kind of wrong. So pin them
// together rather than pinning one id.
function testClaudeModelDefault() {
    console.log('Testing Claude Model Default...');

    const engine = fs.readFileSync(path.join(__dirname, '../../electron/providers/claude-engine.js'), 'utf8');
    const mcp = fs.readFileSync(path.join(__dirname, '../../src/mcp-server-v3.js'), 'utf8');

    const model = (engine.match(/var DEFAULT_MODEL = '([^']+)'/) || [])[1];
    const effort = (engine.match(/var DEFAULT_EFFORT = '([^']+)'/) || [])[1];
    if (!model) throw new Error('could not read DEFAULT_MODEL out of claude-engine.js');
    if (!effort) throw new Error('could not read DEFAULT_EFFORT out of claude-engine.js');

    // The default has to be an id someone actually saw echoed off message_start.
    // An unavailable id costs a 403 on EVERY call, so a typo here is total outage.
    const block = engine.slice(engine.indexOf('Wire-confirmed ids'), engine.indexOf('That last one is why'));
    if (block.indexOf(model) === -1) {
        throw new Error('DEFAULT_MODEL "' + model + '" is not in the wire-confirmed id list');
    }
    if (engine.indexOf("EFFORTS = [") === -1 || engine.indexOf("'" + effort + "'") === -1) {
        throw new Error('DEFAULT_EFFORT "' + effort + '" is not one of the server-quoted efforts');
    }

    // What ask_claude advertises must be what the engine actually sends.
    if (mcp.indexOf('Defaults to ' + model + '.') === -1) {
        throw new Error('ask_claude model description does not advertise the engine default (' +
            model + ') — engine and tool description have drifted');
    }
    if (mcp.indexOf('Reasoning effort. Defaults to ' + effort + '.') === -1) {
        throw new Error('ask_claude effort description does not advertise the engine default (' +
            effort + ')');
    }

    console.log('✅ Claude Model Default tests passed (' + model + ' @ ' + effort + ').');
}
try {
    testReviewParser();
    testSafetyValidator();
    testPRBody();
    testPatchNormalization();
    testRepairRetryGuards();
    testThinkingEffortWiring();
    testQwenThinkingWiring();
    testQwenSessionState();
    testClaudeReconcile();
    testQwenMedia();
    testChatGPTImageTurn();
    testClaudeModelDefault();
    console.log('\n✨ All automation tests passed!');
} catch (e) {
    console.error('\n❌ Test failed:');
    console.error(e);
    process.exit(1);
}
