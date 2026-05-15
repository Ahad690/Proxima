const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./lib/config.cjs');
const { askProxima } = require('./lib/proxima-client.cjs');
const { validatePatchText, rejectDangerousPaths, rejectScriptExecution } = require('./lib/safety.cjs');
const { runCommand } = require('./lib/git-utils.cjs');

async function main() {
    const config = loadConfig();
    const args = process.argv.slice(2);
    
    if (args.length < 1) {
        console.error('Usage: node scripts/proxima-repair.cjs <shortSha>');
        process.exit(1);
    }
    
    const shortSha = args[0];
    const reviewDir = path.join(config.reviewDir, shortSha);
    
    // Check for review.md in the shortSha directory or shortSha.md in the root
    let reviewFile = path.join(reviewDir, 'review.md');
    if (!fs.existsSync(reviewFile)) {
        reviewFile = path.join(config.reviewDir, `${shortSha}.md`);
    }

    
    if (!fs.existsSync(reviewFile)) {
        console.error(`Review file not found: ${reviewFile}`);
        process.exit(1);
    }
    
    const reviewContent = fs.readFileSync(reviewFile, 'utf8');
    const repairDir = path.join(reviewDir, 'repair', 'manual');
    if (!fs.existsSync(repairDir)) fs.mkdirSync(repairDir, { recursive: true });
    
    console.log(`🤖 Generating repair for ${shortSha}...`);
    
    const diffRes = runCommand('git', ['show', '--no-color', shortSha]);
    if (!diffRes.success) {
        console.error(`❌ Failed to get diff: ${diffRes.stderr}`);
        process.exit(1);
    }
    
    const prompt = `You are an expert software engineer. Based on the following code review and the original diff, generate a unified diff patch to fix the Critical and High findings.

RULES:
1. Output ONLY a valid git-compatible unified diff.
2. NO markdown fences (e.g., \`\`\`diff).
3. NO prose, explanations, or introductory text.
4. NO shell scripts, PowerShell, or Bash commands.
5. Fix ONLY the issues identified in the review.
6. Ensure the patch is compatible with 'git apply'.

--- REVIEW ---
${reviewContent}

--- ORIGINAL DIFF ---
${diffRes.stdout}

PATCH:`;

    try {
        const patch = await askProxima(prompt, config.repairModel, config.baseUrl);
        
        // Safety checks
        validatePatchText(patch);
        rejectDangerousPaths(patch, config.gitRoot);
        rejectScriptExecution(patch);
        
        const patchPath = path.join(repairDir, 'fix.patch');
        fs.writeFileSync(patchPath, patch, 'utf8');
        fs.writeFileSync(path.join(repairDir, 'repair.prompt.txt'), prompt, 'utf8');
        
        console.log(`✅ Patch generated and saved to ${patchPath}`);
    } catch (e) {
        console.error(`❌ Repair generation failed: ${e.message}`);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = { main };
