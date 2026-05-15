const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./lib/config.cjs');
const git = require('./lib/git-utils.cjs');
const parser = require('./lib/review-parser.cjs');
const { askProxima } = require('./lib/proxima-client.cjs');
const { 
    validatePatchText, 
    rejectDangerousPaths, 
    rejectScriptExecution, 
    rejectPackageJsonScripts 
} = require('./lib/safety.cjs');

// Import the existing review logic
const { runReview } = require('../cli/proxima-review.cjs');

let globalSessionDir = null;

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

    const sessionDir = path.join(config.reviewDir, shortSha);
    globalSessionDir = sessionDir;
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

    if (git.isProtectedBranch(sourceBranch, config.protectedBranches)) {
        const err = `Refusing to run on protected branch: ${sourceBranch}`;
        console.error(`❌ ${err}`);
        updateStatus({ status: "protected-branch", error: err });
        process.exit(1);
    }

    // Record pre-existing dirty files
    const initialDirtyFiles = git.getDirtyFiles();
    if (!allowDirty && initialDirtyFiles.length > 0) {
        const err = 'Working tree is dirty. Commit your changes or use --allow-dirty.';
        console.error(`❌ ${err}`);
        updateStatus({ status: "dirty-tree", error: err });
        process.exit(1);
    }

    if (git.isBotCommit(commitMsg, config.skipReviewCommitMarkers)) {
        console.log('⏭ Skipping bot commit.');
        updateStatus({ status: "skipped", reason: "bot-commit" });
        process.exit(0);
    }

    if (git.isBotBranch(sourceBranch, config.repairBranchPrefix)) {
        console.log('⏭ Skipping bot branch.');
        updateStatus({ status: "skipped", reason: "bot-branch" });
        process.exit(0);
    }

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
        
        if (!counts.parsed) {
            const err = 'Malformed review: ## Bugs & Failure Modes table not found.';
            console.error(`❌ ${err}`);
            updateStatus({ status: "review-parse-failed-needs-human-review", error: err });
            process.exit(1);
        }

        const score = parser.parseScore(reviewContent);
        console.log(`📊 Score: ${score}/10 | Critical: ${counts.critical} | High: ${counts.high}`);

        updateStatus({
            score,
            critical: counts.critical,
            high: counts.high,
            medium: counts.medium,
            low: counts.low
        });

        // 2. Check if clean
        console.log('🧪 Running tests...');
        let testsPassed = true;
        const testLogPath = path.join(iterReviewDir, 'tests.log');
        
        for (const testCmd of config.testCommands) {
            const cmdStr = typeof testCmd === 'string' ? testCmd : testCmd.cmd;
            const cmdArgs = typeof testCmd === 'string' ? [] : (testCmd.args || []);
            const timeout = typeof testCmd === 'string' ? 60000 : (testCmd.timeoutMs || 60000);
            
            // If it's a string with spaces and no args, it might need shell splitting or shell: true
            // To support complex strings, we'll use shell: true for string commands
            const options = { timeout, shell: typeof testCmd === 'string' };
            const res = git.runCommand(cmdStr, cmdArgs, options);
            
            const logEntry = `\n--- Command: ${cmdStr} ${cmdArgs.join(' ')} ---\n` + (res.stdout + res.stderr) || 'No output';
            fs.appendFileSync(testLogPath, logEntry, 'utf8');
            
            if (res.timedOut) {
                const msg = `Test timed out after ${timeout}ms: ${cmdStr}`;
                fs.appendFileSync(testLogPath, `\n❌ ${msg}\n`, 'utf8');
                testsPassed = false;
            } else if (!res.success) {
                testsPassed = false;
            }
            
            if (!testsPassed && config.stopOnTestFailure) break;
        }
        updateStatus({ testsPassed });

        if (testsPassed && counts.critical === 0 && counts.high === 0) {
            console.log('✅ Clean state reached (Tests pass, no Critical/High findings).');
            updateStatus({ status: "clean-local" });
            
            if (botBranchCreated && pushRequested) {
                console.log(`🚀 Pushing branch ${botBranchName}...`);
                const pushRes = git.pushBranch(botBranchName);
                if (pushRes.success) {
                    updateStatus({ status: "clean-pushed", branchPushed: true });
                } else {
                    console.error(`⚠️ Push failed: ${pushRes.stderr}`);
                    updateStatus({ status: "push-failed", error: pushRes.stderr });
                }
            }

            if (botBranchCreated && prRequested) {
                const prRes = await createPR(botBranchName, shortSha, originalHeadSha, sourceBranch, score, counts, sessionDir, config, updateStatus);
                if (prRes.success) {
                    updateStatus({ status: "clean-pr-created", prCreated: true });
                } else {
                    updateStatus({ status: "pr-failed", error: prRes.stderr });
                }
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
            const rawPatch = await askProxima(prompt, config.repairModel, config.baseUrl);
            fs.writeFileSync(path.join(repairDir, 'raw-output.txt'), rawPatch, 'utf8');

            try {
                validatePatchText(rawPatch);
                rejectDangerousPaths(rawPatch, config.gitRoot, config);
                rejectScriptExecution(rawPatch, config);
                rejectPackageJsonScripts(rawPatch, config);
            } catch (validationErr) {
                fs.writeFileSync(path.join(repairDir, 'rejected-output.txt'), rawPatch, 'utf8');
                fs.writeFileSync(path.join(repairDir, 'validation-error.txt'), validationErr.message, 'utf8');
                updateStatus({ 
                    status: "patch-validation-failed", 
                    error: validationErr.message,
                    rejectedOutputPath: path.join(repairDir, 'rejected-output.txt')
                });
                break;
            }

            const patchPath = path.join(repairDir, 'fix.patch');
            fs.writeFileSync(patchPath, rawPatch, 'utf8');

            // Touched files from patch
            const touchedFiles = git.getFilesFromPatch(patchPath);
            if (touchedFiles.length === 0) {
                throw new Error('Patch touches no files');
            }

            // Check for dirty overlap
            if (allowDirty && initialDirtyFiles.length > 0) {
                const overlap = touchedFiles.filter(f => initialDirtyFiles.includes(f));
                if (overlap.length > 0) {
                    const err = `Patch overlaps with pre-existing dirty files: ${overlap.join(', ')}`;
                    console.error(`❌ ${err}`);
                    updateStatus({ 
                        status: "dirty-overlap-needs-human-review", 
                        error: err,
                        recoveryInstructions: "Manual merge or cleanup required. The patch targets files you already have modified."
                    });
                    break;
                }
            }

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
            
            for (const testCmd of config.testCommands) {
                const cmdStr = typeof testCmd === 'string' ? testCmd : testCmd.cmd;
                const cmdArgs = typeof testCmd === 'string' ? [] : (testCmd.args || []);
                const timeout = typeof testCmd === 'string' ? 60000 : (testCmd.timeoutMs || 60000);
                
                const options = { timeout, shell: typeof testCmd === 'string' };
                const res = git.runCommand(cmdStr, cmdArgs, options);
                
                const logEntry = `\n--- Command: ${cmdStr} ${cmdArgs.join(' ')} ---\n` + (res.stdout + res.stderr) || 'No output';
                fs.appendFileSync(repairTestLogPath, logEntry, 'utf8');
                
                if (res.timedOut || !res.success) {
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
            const commitRes = git.commitPatchFiles(`fix: address Proxima review ${shortSha} [proxima-auto-fix]`, touchedFiles);
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
Review artifacts were saved locally by Proxima automation.
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
    return prRes;
}

if (require.main === module) {
    main().catch(err => {
        console.error('🔥 Unexpected error:', err);
        if (globalSessionDir) {
            const emergencyStatus = path.join(globalSessionDir, 'status.json');
            try {
                const current = JSON.parse(fs.readFileSync(emergencyStatus, 'utf8'));
                fs.writeFileSync(emergencyStatus, JSON.stringify({
                    ...current,
                    status: "unexpected-error",
                    error: err.message
                }, null, 2));
            } catch {
                // Best effort failed
            }
        }
        process.exit(1);
    });
}
