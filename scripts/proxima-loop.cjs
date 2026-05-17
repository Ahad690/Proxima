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

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[22m`;

/**
 * Recounts all hunk headers in a unified diff so that the @@ -L,N +L,N @@ counts
 * match the actual content lines. The START line numbers are preserved as-is
 * (git apply --recount already handles those). This fixes the most common LLM error
 * of generating wrong line counts in hunk headers.
 */
function fixPatchHunkHeaders(patchText) {
    const lines = patchText.split('\n');
    const result = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];
        const hunkMatch = line.match(/^(@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@)(.*)/);

        if (!hunkMatch) {
            result.push(line);
            i++;
            continue;
        }

        // Collect all lines belonging to this hunk
        const oldStart = hunkMatch[2];
        const newStart = hunkMatch[3];
        const suffix = hunkMatch[4]; // e.g. " async function main() {"
        const hunkLines = [];
        i++;

        while (i < lines.length && !lines[i].match(/^(@@|diff |--- |\+\+\+)/)) {
            hunkLines.push(lines[i]);
            i++;
        }

        // Recount
        let oldCount = 0;
        let newCount = 0;
        for (const hl of hunkLines) {
            if (hl.startsWith('-')) { oldCount++; }
            else if (hl.startsWith('+')) { newCount++; }
            else { oldCount++; newCount++; } // context line
        }

        result.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${suffix}`);
        result.push(...hunkLines);
    }

    return result.join('\n');
}


async function main() {
    const config = loadConfig();
    const args = process.argv.slice(2);
    
    const pushRequested = args.includes('--push') || config.pushBotBranches;
    const prRequested = args.includes('--create-pr') || config.createPullRequest;
    const allowDirty = args.includes('--allow-dirty');
    const forceReview = args.includes('--force');

    // Allow targeting a specific SHA: node proxima-loop.cjs --sha <sha>
    const shaArgIdx = args.indexOf('--sha');
    let targetSha = null;
    if (shaArgIdx !== -1) {
        const candidate = args[shaArgIdx + 1];
        if (!candidate || candidate.startsWith('--')) {
            console.error('❌ --sha requires a commit SHA or ref argument');
            process.exit(1);
        }
        targetSha = candidate;
    }

    git.ensureInsideGitRepo();

    const originalHeadSha = targetSha
        ? git.runCommand('git', ['rev-parse', targetSha]).stdout.trim()
        : git.getHeadSha();
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

    const log = (msg) => {
        process.stdout.write(`[${new Date().toLocaleTimeString()}] ${msg}\n`);
        fs.appendFileSync(path.join(sessionDir, 'loop.log'), `[${new Date().toISOString()}] ${msg}\n`, 'utf8');
    };

    log(`🚀 Proxima Automation Loop Initiated for ${shortSha}`);
    log(`📂 Session directory: ${sessionDir}`);

    const updateStatus = (updates) => {
        status = { ...status, ...updates };
        fs.writeFileSync(path.join(sessionDir, 'status.json'), JSON.stringify(status, null, 2), 'utf8');
    };

    updateStatus({});

    if (git.isProtectedBranch(sourceBranch, config.protectedBranches)) {
        const err = `Refusing to run on protected branch: ${sourceBranch}`;
        log(`❌ ${err}`);
        updateStatus({ status: "protected-branch", error: err });
        process.exit(1);
    }

    // Record pre-existing dirty files
    const initialDirtyFiles = git.getDirtyFiles();
    if (!allowDirty && initialDirtyFiles.length > 0) {
        const err = 'Working tree is dirty. Commit your changes or use --allow-dirty.';
        log(`❌ ${err}`);
        updateStatus({ status: "dirty-tree", error: err });
        process.exit(1);
    }

    if (git.isBotCommit(commitMsg, config.skipReviewCommitMarkers)) {
        log('⏭ Skipping bot commit.');
        updateStatus({ status: "skipped", reason: "bot-commit" });
        process.exit(0);
    }

    if (git.isBotBranch(sourceBranch, config.repairBranchPrefix)) {
        log('⏭ Skipping bot branch.');
        updateStatus({ status: "skipped", reason: "bot-branch" });
        process.exit(0);
    }

    let currentSha = originalHeadSha;
    let iteration = 1;
    const maxIterations = config.maxIterations || 3;
    let botBranchCreated = false;
    let botBranchName = '';

    while (iteration <= maxIterations) {
        log(`\n🔄 Iteration ${iteration}/${maxIterations}...`);
        updateStatus({ iteration });
        
        // 1. Run Review
        const iterReviewDir = path.join(sessionDir, 'reviews', `iter-${iteration}`);
        if (!fs.existsSync(iterReviewDir)) fs.mkdirSync(iterReviewDir, { recursive: true });
        
        log(`🤖 Running Proxima review for ${git.getShortSha(currentSha)}...`);
        await runReview(currentSha, { outputDir: iterReviewDir, force: true, fileName: "review.md" });
        
        const reviewFile = path.join(iterReviewDir, 'review.md');
        if (!fs.existsSync(reviewFile)) {
            const err = 'Review file was not generated.';
            log(`❌ ${err}`);
            updateStatus({ status: "proxima-unavailable", error: err });
            process.exit(1);
        }

        const reviewContent = fs.readFileSync(reviewFile, 'utf8');
        const counts = parser.parseSeverityCounts(reviewContent);
        
        if (!counts.parsed) {
            const err = 'Malformed review: ## Bugs & Failure Modes table not found.';
            log(`❌ ${err}`);
            updateStatus({ status: "review-parse-failed-needs-human-review", error: err });
            process.exit(1);
        }

        const score = parser.parseScore(reviewContent);
        log(`📊 Score: ${score}/10 | Critical: ${counts.critical} | High: ${counts.high}`);

        updateStatus({
            score,
            critical: counts.critical,
            high: counts.high,
            medium: counts.medium,
            low: counts.low
        });

        // 2. Check if clean
        log('🧪 Running tests...');
        let testsPassed = true;
        const testLogPath = path.join(iterReviewDir, 'tests.log');
        
        for (const testCmd of config.testCommands) {
            const cmdStr = typeof testCmd === 'string' ? testCmd : testCmd.cmd;
            const cmdArgs = typeof testCmd === 'string' ? [] : (testCmd.args || []);
            const timeout = typeof testCmd === 'string' ? 60000 : (testCmd.timeoutMs || 60000);
            
            const options = { timeout, shell: typeof testCmd === 'string' };
            const res = git.runCommand(cmdStr, cmdArgs, options);
            
            if (res.stdout) log(dim(res.stdout));
            if (res.stderr) log(red(res.stderr));
            
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
            log('✅ Clean state reached (Tests pass, no Critical/High findings).');
            updateStatus({ status: "clean-local" });
            
            if (botBranchCreated && pushRequested) {
                log(`🚀 Pushing branch ${botBranchName}...`);
                const pushRes = git.pushBranch(botBranchName);
                if (pushRes.success) {
                    updateStatus({ status: "clean-pushed", branchPushed: true });
                } else {
                    log(`⚠️ Push failed: ${pushRes.stderr}`);
                    updateStatus({ status: "push-failed", error: pushRes.stderr });
                }
            }

            if (botBranchCreated && prRequested) {
                const prRes = await createPR(botBranchName, shortSha, originalHeadSha, sourceBranch, score, counts, sessionDir, config, updateStatus, log);
                if (prRes.success) {
                    updateStatus({ status: "clean-pr-created", prCreated: true });
                } else {
                    updateStatus({ status: "pr-failed", error: prRes.stderr });
                }
            }

            process.exit(0);
        }

        // 3. Generate Repair
        log(`🛠 Attempting repair (Iteration ${iteration})...`);
        const repairDir = path.join(iterReviewDir, 'repair');
        if (!fs.existsSync(repairDir)) fs.mkdirSync(repairDir, { recursive: true });

        // Build current file contents for each file touched by the original diff
        const diffRes = git.runCommand('git', ['show', '--no-color', currentSha]);
        const rawDiff = diffRes.stdout;
        // Write patch to temp file first
        const origPatchPath = path.join(repairDir, '_orig.patch');
        fs.writeFileSync(origPatchPath, rawDiff, 'utf8');
        const touchedInDiff = git.getFilesFromPatch(origPatchPath) || [];
        const repoRoot = process.cwd();

        let fileContentsSection = '';
        for (const relPath of touchedInDiff) {
            // Safety: ensure the path is relative and stays inside the repo
            const absPath = path.resolve(repoRoot, relPath);
            if (!absPath.startsWith(repoRoot + path.sep) && absPath !== repoRoot) continue;
            if (!fs.existsSync(absPath)) continue;

            // Normalize line endings and strip trailing newline before numbering
            const raw = fs.readFileSync(absPath, 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n$/, '');
            const numbered = raw.split('\n').map((l, i) => `${String(i + 1).padStart(4)}: ${l}`).join('\n');
            fileContentsSection += `\n--- CURRENT FILE: ${relPath} ---\n${numbered}\n`;
        }

        const prompt = `You are an expert software engineer. Based on the following code review and original diff, generate a unified diff patch to fix ONLY the Critical and High severity findings.

STRICT RULES:
1. Output ONLY a valid unified diff — no markdown fences, no prose, no explanations.
2. Use EXACTLY the file paths from the diff headers (e.g. "--- a/scripts/lib/safety.cjs").
3. Hunk headers (@@ -L,N +L,N @@) must reflect the CURRENT FILE line numbers shown below.
4. Include 3 lines of unchanged context around every change.
5. Fix ONLY Critical and High issues. Do NOT refactor or change unrelated code.
6. If a finding cannot be fixed with a code patch (e.g. "add documentation"), skip it.

--- REVIEW ---
${reviewContent}

--- ORIGINAL DIFF ---
${rawDiff}
${fileContentsSection}
Output your unified diff below. Start immediately with "diff --git" — no preamble, no explanation, no markdown:`;

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
            // Programmatically recount hunk headers so LLM count errors don't corrupt the patch
            const fixedPatch = fixPatchHunkHeaders(rawPatch);
            fs.writeFileSync(patchPath, fixedPatch, 'utf8');
            if (fixedPatch !== rawPatch) {
                log(dim('🔧 Hunk headers recounted (LLM had wrong counts).'));
                fs.writeFileSync(path.join(repairDir, 'raw-output-original.txt'), rawPatch, 'utf8');
            }

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
                    log(`❌ ${err}`);
                    updateStatus({ 
                        status: "dirty-overlap-needs-human-review", 
                        error: err,
                        overlappingFiles: overlap,
                        recoveryInstructions: "Manual merge or cleanup required. The patch targets files you already have modified."
                    });
                    break;
                }
            }

            // 4. Branch and Apply
            if (!botBranchCreated) {
                botBranchName = `${config.repairBranchPrefix}-${shortSha}-iter-${iteration}`;
                log(`🌿 Creating branch ${botBranchName}...`);
                const branchRes = git.createBranch(botBranchName);
                if (!branchRes.success) {
                    log(`❌ Failed to create branch: ${branchRes.stderr}`);
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

            log('🔍 Validating patch (git apply --check)...');
            const checkRes = git.applyPatchCheck(patchPath);
            if (!checkRes.success) {
                log(`❌ Patch validation failed: ${checkRes.stderr}`);
                fs.writeFileSync(path.join(repairDir, 'apply.log'), `Validation failed:\n${checkRes.stderr}`, 'utf8');
                updateStatus({ status: "patch-check-failed", error: checkRes.stderr });
                break;
            }

            log('🩹 Applying patch...');
            const applyRes = git.applyPatch(patchPath);
            fs.writeFileSync(path.join(repairDir, 'apply.log'), (applyRes.stdout + applyRes.stderr) || 'Applied successfully', 'utf8');
            
            if (!applyRes.success) {
                log(`❌ Patch application failed: ${applyRes.stderr}`);
                updateStatus({ status: "patch-apply-failed", error: applyRes.stderr });
                break;
            }
            updateStatus({ patchApplied: true });

            // 5. Test Repair before committing
            log('🧪 Running tests on repair...');
            let repairTestsPassed = true;
            const repairTestLogPath = path.join(repairDir, 'repair_tests.log');
            
            for (const testCmd of config.testCommands) {
                const cmdStr = typeof testCmd === 'string' ? testCmd : testCmd.cmd;
                const cmdArgs = typeof testCmd === 'string' ? [] : (testCmd.args || []);
                const timeout = typeof testCmd === 'string' ? 60000 : (testCmd.timeoutMs || 60000);
                
                const options = { timeout, shell: typeof testCmd === 'string' };
                const res = git.runCommand(cmdStr, cmdArgs, options);
                
                if (res.stdout) log(dim(res.stdout));
                if (res.stderr) log(red(res.stderr));

                const logEntry = `\n--- Command: ${cmdStr} ${cmdArgs.join(' ')} ---\n` + (res.stdout + res.stderr) || 'No output';
                fs.appendFileSync(repairTestLogPath, logEntry, 'utf8');
                
                if (res.timedOut || !res.success) {
                    repairTestsPassed = false;
                    if (config.stopOnTestFailure) break;
                }
            }

            if (!repairTestsPassed) {
                log('❌ Tests failed after repair.');
                updateStatus({ 
                    status: "repair-tests-failed", 
                    error: "Tests failed after applying patch. The failed patch remains uncommitted on the bot branch for inspection.",
                    recoveryInstructions: `Inspect with git diff. To discard: git checkout -- . && git clean -fd && git checkout ${sourceBranch}`
                });
                break; 
            }

            log('📝 Committing fix...');
            const commitRes = git.commitPatchFiles(`fix: address Proxima review ${shortSha} [proxima-auto-fix]`, touchedFiles);
            if (!commitRes.success) {
                log(`❌ Commit failed: ${commitRes.stderr}`);
                updateStatus({ status: "commit-failed", error: commitRes.stderr });
                break;
            }

            currentSha = git.getHeadSha();
            log(`✅ Repair committed: ${git.getShortSha(currentSha)}`);

        } catch (e) {
            // Provider not yet initialized — wait 30s and retry once
            if (e.message && e.message.includes('not initialized')) {
                log(`⏳ Provider not ready, retrying in 30s... (${e.message})`);
                await new Promise(r => setTimeout(r, 30000));
                iteration--; // don't consume an iteration slot
                continue;
            }
            log(`❌ Repair failed: ${e.message}`);
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

async function createPR(botBranch, shortSha, originalSha, sourceBranch, score, counts, sessionDir, config, updateStatus, log) {
    log('📝 Creating Pull Request...');
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
        log('✅ PR created.');
        updateStatus({ prCreated: true });
    } else {
        log(`⚠️ PR creation failed: ${prRes.stderr}`);
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
