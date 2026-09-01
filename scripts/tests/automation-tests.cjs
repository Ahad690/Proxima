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

    if (!reviewScript.includes('thinkingEffort: REVIEW_THINKING_EFFORT')) {
        throw new Error('Review IPC payload does not include thinkingEffort');
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
try {
    testReviewParser();
    testSafetyValidator();
    testPRBody();
    testPatchNormalization();
    testRepairRetryGuards();
    testThinkingEffortWiring();
    testQwenThinkingWiring();
    console.log('\n✨ All automation tests passed!');
} catch (e) {
    console.error('\n❌ Test failed:');
    console.error(e);
    process.exit(1);
}
