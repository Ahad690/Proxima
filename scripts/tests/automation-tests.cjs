const parser = require('../lib/review-parser.cjs');
const safety = require('../lib/safety.cjs');
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

try {
    testReviewParser();
    testSafetyValidator();
    testPRBody();
    console.log('\n✨ All automation tests passed!');
} catch (e) {
    console.error('\n❌ Test failed:');
    console.error(e);
    process.exit(1);
}
