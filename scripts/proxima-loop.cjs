const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./lib/config.cjs');
const git = require('./lib/git-utils.cjs');
const parser = require('./lib/review-parser.cjs');
const { askProxima } = require('./lib/proxima-client.cjs');
const { validatePatchText, rejectDangerousPaths, rejectScriptExecution } = require('./lib/safety.cjs');

// Import the existing review logic
const { runReview } = require('../cli/proxima-review.cjs');

async function main() {
    const config = loadConfig();
    const args = process.argv.slice(2);
    
    const pushRequested = args.includes('--push') || config.pushBotBranches;
    const prRequested = args.includes('--create-pr') || config.createPullRequest;
    const allowDirty = args.includes('--allow-dirty');

    git.ensureInsideGitRepo();
    
    const originalHeadSha = git.getHeadSha();
    const shortSha = git.getShortSha(originalHeadSha);
    const sourceBranch = git.getCurrentBranch();
    const commitMsg = git.getCommitMessage(originalHeadSha);

    if (git.isProtectedBranch(sourceBranch, config.protectedBranches)) {
        console.error(`❌ Refusing to run on protected branch: ${sourceBranch}`);
        process.exit(1);
    }

    if (!allowDirty && !git.ensureCleanWorkingTree()) {
        console.error('❌ Working tree is dirty. Commit your changes or use --allow-dirty.');
        process.exit(1);
    }

    if (git.isBotCommit(commitMsg, config.skipReviewCommitMarkers)) {
        console.log('⏭ Skipping bot commit.');
        process.exit(0);
    }

    if (git.isBotBranch(sourceBranch, config.repairBranchPrefix)) {
        console.log('⏭ Skipping bot branch.');
        process.exit(0);
    }

    const sessionDir = path.join(config.reviewDir, shortSha);
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

    let status = {
        commit: originalHeadSha,
        shortSha: shortSha,
        sourceBranch: sourceBranch,
        botBranch: null,
        status: "starting",
        iteration: 0,
        testsPassed: false,
        patchApplied: false,
        branchPushed: false,
        prCreated: false,
        error: null,
        recoveryInstructions: "To recover, checkout your source branch: git checkout " + sourceBranch
    };

    const updateStatus = (updates) => {
        status = { ...status, ...updates };
        fs.writeFileSync(path.join(sessionDir, 'status.json'), JSON.stringify(status, null, 2), 'utf8');
    };

    updateStatus({});

    let currentSha = originalHeadSha;
    let iteration = 1;
    const maxIterations = config.maxIterations || 3;
    let botBranchCreated = false;
    let botBranchName = '';

    while (iteration <= maxIterations) {
        console.log(`\n🔄 Iteration ${iteration}/${maxIterations}...`);
        updateStatus({ iteration });
        
        // 1. Run Review
        const iterReviewDir = path.join(sessionDir, 'reviews', `iter-${iteration}`);
        if (!fs.existsSync(iterReviewDir)) fs.mkdirSync(iterReviewDir, { recursive: true });
        
        console.log(`🤖 Running Proxima review for ${git.getShortSha(currentSha)}...`);
        // Use force: true to bypass bot skip rules during intentional re-reviews
        // Use fileName: "review.md" for deterministic output
        await runReview(currentSha, { outputDir: iterReviewDir, force: true, fileName: "review.md" });
        
        const reviewFile = path.join(iterReviewDir, 'review.md');
        if (!fs.existsSync(reviewFile)) {
            const err = 'Review file was not generated.';
            console.error(`❌ ${err}`);
            updateStatus({ status: "proxima-unavailable", error: err });
            process.exit(1);
        }

        const reviewContent = fs.readFileSync(reviewFile, 'utf8');
        const counts = parser.parseSeverityCounts(reviewContent);
        const score = parser.parseScore(reviewContent);

        console.log(`📊 Score: ${score}/10 | Critical: ${counts.critical} | High: ${counts.high}`);

        updateStatus({
            score,
            critical: counts.critical,
            high: counts.high,
            medium: counts.medium,
            low: counts.low
        });

        // 2. Check if clean (if tests passed in previous iteration and now review is clean)
        console.log('🧪 Running tests...');
        let testsPassed = true;
        const testLogPath = path.join(iterReviewDir, 'tests.log');
        
        for (const cmd of config.testCommands) {
            const [baseCmd, ...cmdArgs] = cmd.split(' ');
            const res = git.runCommand(baseCmd, cmdArgs);
            fs.appendFileSync(testLogPath, (res.stdout + res.stderr) || 'No output', 'utf8');
            if (!res.success) {
                testsPassed = false;
                if (config.stopOnTestFailure) break;
            }
        }
        updateStatus({ testsPassed });

        if (testsPassed && counts.critical === 0 && counts.high === 0) {
            console.log('✅ Clean state reached (Tests pass, no Critical/High findings).');
            updateStatus({ status: "clean" });
            
            if (botBranchCreated && pushRequested) {
                console.log(`🚀 Pushing branch ${botBranchName}...`);
                const pushRes = git.pushBranch(botBranchName);
                if (pushRes.success) {
                    updateStatus({ branchPushed: true });
                } else {
                    console.error(`⚠️ Push failed: ${pushRes.stderr}`);
                    updateStatus({ error: pushRes.stderr });
                }
            }

            if (botBranchCreated && prRequested) {
                await createPR(botBranchName, shortSha, originalHeadSha, sourceBranch, score, counts, sessionDir, config, updateStatus);
            }

            process.exit(0);
        }

        // 3. Generate Repair
        console.log(`🛠 Attempting repair (Iteration ${iteration})...`);
        const repairDir = path.join(iterReviewDir, 'repair');
        if (!fs.existsSync(repairDir)) fs.mkdirSync(repairDir, { recursive: true });

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
${git.runCommand('git', ['show', '--no-color', currentSha]).stdout}

PATCH:`;

        fs.writeFileSync(path.join(repairDir, 'repair.prompt.txt'), prompt, 'utf8');

        try {
            const patch = await askProxima(prompt, config.repairModel, config.baseUrl);
            validatePatchText(patch);
            rejectDangerousPaths(patch, config.gitRoot);
            rejectScriptExecution(patch);

            const patchPath = path.join(repairDir, 'fix.patch');
            fs.writeFileSync(patchPath, patch, 'utf8');

            // 4. Branch and Apply
            if (!botBranchCreated) {
                botBranchName = `${config.repairBranchPrefix}-${shortSha}-iter-${iteration}`;
                console.log(`🌿 Creating branch ${botBranchName}...`);
                const branchRes = git.createBranch(botBranchName);
                if (!branchRes.success) {
                    console.error(`❌ Failed to create branch: ${branchRes.stderr}`);
                    updateStatus({ 
                        status: "branch-creation-failed", 
                        error: branchRes.stderr,
                        recoveryInstructions: `Branch creation failed. You are likely still on '${sourceBranch}'. Check stderr for details.`
                    });
                    process.exit(1);
                }
                botBranchCreated = true;
                updateStatus({ botBranch: botBranchName, recoveryInstructions: `Repair in progress. To reset, git checkout ${sourceBranch} && git branch -D ${botBranchName}` });
            }

            console.log('🔍 Validating patch (git apply --check)...');
            const checkRes = git.applyPatchCheck(patchPath);
            if (!checkRes.success) {
                console.error(`❌ Patch validation failed: ${checkRes.stderr}`);
                fs.writeFileSync(path.join(repairDir, 'apply.log'), `Validation failed:\n${checkRes.stderr}`, 'utf8');
                updateStatus({ status: "patch-check-failed", error: checkRes.stderr });
                break;
            }

            console.log('🩹 Applying patch...');
            const applyRes = git.applyPatch(patchPath);
            fs.writeFileSync(path.join(repairDir, 'apply.log'), (applyRes.stdout + applyRes.stderr) || 'Applied successfully', 'utf8');
            
            if (!applyRes.success) {
                console.error(`❌ Patch application failed: ${applyRes.stderr}`);
                updateStatus({ status: "patch-apply-failed", error: applyRes.stderr });
                break;
            }
            updateStatus({ patchApplied: true });

            // 5. Test Repair before committing
            console.log('🧪 Running tests on repair...');
            let repairTestsPassed = true;
            const repairTestLogPath = path.join(repairDir, 'repair_tests.log');
            
            for (const cmd of config.testCommands) {
                const [baseCmd, ...cmdArgs] = cmd.split(' ');
                const res = git.runCommand(baseCmd, cmdArgs);
                fs.appendFileSync(repairTestLogPath, (res.stdout + res.stderr) || 'No output', 'utf8');
                if (!res.success) {
                    repairTestsPassed = false;
                    if (config.stopOnTestFailure) break;
                }
            }

            if (!repairTestsPassed) {
                console.error('❌ Tests failed after repair.');
                updateStatus({ 
                    status: "repair-tests-failed", 
                    error: "Tests failed after applying patch.",
                    recoveryInstructions: `The failed patch remains UNCOMMITTED on branch '${botBranchName}' for your inspection. Inspect changes with git diff. To discard: git checkout -- . && git clean -fd && git checkout ${sourceBranch}`
                });
                break; 
            }

            console.log('📝 Committing fix...');
            const commitRes = git.commitAll(`fix: address Proxima review ${shortSha} [proxima-auto-fix]`);
            if (!commitRes.success) {
                console.error(`❌ Commit failed: ${commitRes.stderr}`);
                updateStatus({ status: "commit-failed", error: commitRes.stderr });
                break;
            }

            currentSha = git.getHeadSha();
            console.log(`✅ Repair committed: ${git.getShortSha(currentSha)}`);

        } catch (e) {
            console.error(`❌ Repair failed: ${e.message}`);
            updateStatus({ status: "error", error: e.message });
            break;
        }

        iteration++;
    }

    if (iteration > maxIterations) {
        console.log('⏹ Max iterations reached.');
        updateStatus({ status: "max-iterations-reached" });
    }
}

async function createPR(botBranch, shortSha, originalSha, sourceBranch, score, counts, sessionDir, config, updateStatus) {
    console.log('📝 Creating Pull Request...');
    const prBody = `
Proxima auto-fix for ${shortSha}

- Reviewed commit: ${originalSha}
- Source branch: ${sourceBranch}
- Bot branch: ${botBranch}
- Score: ${score}/10
- Critical: ${counts.critical}
- High: ${counts.high}
- Test results: Passed

Note: This patch was AI-generated and applied after \`git apply --check\`.
Local review folder: ${sessionDir}
`;
    const bodyFile = path.join(sessionDir, 'pr-body.txt');
    fs.writeFileSync(bodyFile, prBody, 'utf8');

    const prRes = git.createPullRequest({
        title: `Proxima auto-fix for ${shortSha}`,
        bodyFile: bodyFile,
        labels: config.pullRequestLabels,
        draft: config.pullRequestDraft
    });

    if (prRes.success) {
        console.log('✅ PR created.');
        updateStatus({ prCreated: true });
    } else {
        console.error(`⚠️ PR creation failed: ${prRes.stderr}`);
    }
}

if (require.main === module) {
    main();
}
