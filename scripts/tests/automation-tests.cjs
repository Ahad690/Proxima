const assert = require('assert');
const parser = require('../lib/review-parser.cjs');
const safety = require('../lib/safety.cjs');

function testReviewParser() {
    console.log('Testing Review Parser...');
    
    const mockReview = `
## Bugs & Failure Modes
| File:Line | Severity | Finding | Evidence |
|-----------|----------|---------|----------|
| src/file.js:L42 | 🔴 Critical | Race condition | Evidence 1 |
| src/util.js:L10 | 🟠 High | Missing check | Evidence 2 |
| src/main.js:L5 | 🟡 Medium | Optimization | Evidence 3 |

## Score: 7/10
`;

    const counts = parser.parseSeverityCounts(mockReview);
    assert.strictEqual(counts.critical, 1, 'Critical count should be 1');
    assert.strictEqual(counts.high, 1, 'High count should be 1');
    assert.strictEqual(counts.medium, 1, 'Medium count should be 1');
    
    const score = parser.parseScore(mockReview);
    assert.strictEqual(score, 7, 'Score should be 7');
    
    assert.strictEqual(parser.hasCriticalOrHigh(mockReview), true, 'Should have critical or high findings');
    console.log('✅ Review Parser tests passed.');
}

function testSafetyValidator() {
    console.log('Testing Safety Validator...');
    
    const validPatch = `--- a/src/file.js
+++ b/src/file.js
@@ -1,3 +1,3 @@
-old line
+new line
`;
    
    assert.doesNotThrow(() => safety.validatePatchText(validPatch));
    
    const patchWithFences = `\`\`\`diff\n${validPatch}\n\`\`\``;
    assert.throws(() => safety.validatePatchText(patchWithFences), /markdown fences/);
    
    const patchWithProse = `Here is the fix:\n${validPatch}`;
    assert.throws(() => safety.validatePatchText(patchWithProse), /prose before the diff/);
    
    const dangerousScript = `#!/bin/bash\nrm -rf /`;
    assert.throws(() => safety.rejectScriptExecution(dangerousScript), /forbidden script pattern/);
    
    console.log('✅ Safety Validator tests passed.');
}

function runTests() {
    try {
        testReviewParser();
        testSafetyValidator();
        console.log('\n✨ All automation tests passed!');
    } catch (e) {
        console.error(`\n❌ Tests failed: ${e.message}`);
        process.exit(1);
    }
}

runTests();
