#!/usr/bin/env node
// =============================================================================
// Proxima Code Review Script v2.1
// Usage:  node cli/proxima-review.cjs [commit-sha]   ← manual run
// Hook:   Triggered automatically by pre-push git hook (reads stdin)
// =============================================================================
//
// Transport: Direct IPC socket (port 19222) — no REST API needed.
// Hook mode: pre-push (fires on git push, reads commits from stdin).
// Storage:   <repo-root>/perplexity-reviews/<shortSha>.md
//
// =============================================================================

const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawn } = require('child_process');

// ─── Config ───────────────────────────────────────────────────────────────────
const IPC_PORT = parseInt(process.env.AGENT_HUB_PORT) || 19222;
const IPC_HOST = '127.0.0.1';

// Load automation config if available
let automationConfig = {};
try {
    const configModule = require('../scripts/lib/config.cjs');
    automationConfig = configModule.loadConfig();
} catch (e) {
    // Fallback if loop scripts aren't present
}

const SKIP_REVIEW = process.env.PROXIMA_SKIP_REVIEW === '1';
const SKIP_BRANCH_PREFIX = automationConfig.repairBranchPrefix || 'proxima/fix-';
const SKIP_COMMIT_MARKER = '[proxima-auto-fix]';

const REVIEW_MODEL = process.env.PROXIMA_REVIEW_MODEL || automationConfig.reviewModel || 'gpt-5-5-thinking';
const REVIEW_PROVIDER = process.env.PROXIMA_REVIEW_PROVIDER || resolveProvider(REVIEW_MODEL);
const REVIEW_DIR = process.env.PROXIMA_REVIEW_DIR || automationConfig.reviewDir || path.join(findGitRoot(), 'perplexity-reviews');

function resolveProvider(model) {
    const m = model.toLowerCase();
    if (m.startsWith('gpt') || m.startsWith('o1') || m.startsWith('o3')) return 'chatgpt';
    return 'perplexity';
}

const PROVIDER_DISPLAY = {
    'chatgpt': 'ChatGPT',
    'perplexity': 'Perplexity',
    'claude': 'Claude',
    'gemini': 'Gemini'
};
const PROVIDER_LABEL = PROVIDER_DISPLAY[REVIEW_PROVIDER] || REVIEW_PROVIDER;

// Universal lock file in the home directory to prevent cross-project Hub overloading
const LOCK_FILE = path.join(os.homedir(), '.proxima-review.lock');
const STALE_LOCK_MS = 15 * 60 * 1000; // 15 min

// ─── Git root detection ───────────────────────────────────────────────────────
function findGitRoot() {
    try {
        return execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
    } catch {
        return process.cwd();
    }
}

// ─── Lock (atomic wx flag — no TOCTOU race) ──────────────────────────────────
function tryAcquireLock(commitSha) {
    if (fs.existsSync(LOCK_FILE)) {
        try {
            const lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
            if (Date.now() - lock.time > STALE_LOCK_MS) {
                fs.unlinkSync(LOCK_FILE);
            } else {
                return false; // Another review is actively running
            }
        } catch {
            try { fs.unlinkSync(LOCK_FILE); } catch { }
        }
    }

    try {
        const shortSha = commitSha.substring(0, 8);
        fs.writeFileSync(
            LOCK_FILE,
            JSON.stringify({ sha: commitSha, shortSha, pid: process.pid, time: Date.now(), repo: findGitRoot() }),
            { encoding: 'utf8', flag: 'wx' }
        );
        return true;
    } catch {
        return false;
    }
}

async function acquireLockWithRetry(commitSha, log, maxWaitMs = 60 * 60 * 1000) {
    const start = Date.now();
    const shortSha = commitSha.substring(0, 8);
    let firstWait = true;

    while (Date.now() - start < maxWaitMs) {
        if (tryAcquireLock(commitSha)) {
            if (!firstWait) log(cyan('🔓') + ' Lock finally acquired for ' + yellow(shortSha));
            return true;
        }

        if (firstWait) {
            log(yellow('⏳') + ' Another review is running. Waiting in line for ' + yellow(shortSha) + '...');
            firstWait = false;
        }

        // Wait 10 seconds before polling again
        await new Promise(r => setTimeout(r, 10000));
    }

    throw new Error('Timed out waiting for lock after 60 minutes');
}

function releaseLock() {
    try { fs.unlinkSync(LOCK_FILE); } catch { }
}

// ─── Colors ───────────────────────────────────────────────────────────────────
const c = {
    reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
    green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m'
};
const green = (t) => `${c.green}${t}${c.reset}`;
const yellow = (t) => `${c.yellow}${t}${c.reset}`;
const red = (t) => `${c.red}${t}${c.reset}`;
const cyan = (t) => `${c.cyan}${t}${c.reset}`;
const dim = (t) => `${c.dim}${t}${c.reset}`;

// ─── IPC Client ───────────────────────────────────────────────────────────────
// Talks directly to Proxima Agent Hub over TCP (same protocol as MCP server).
// Routes to the correct provider (chatgpt or perplexity) based on REVIEW_PROVIDER.
// ChatGPT:    sendMessage with { message, model }
// Perplexity: sendMessage with { message, modelPreference, deepSearch: false }
function queryAI(message, model, provider) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ port: IPC_PORT, host: IPC_HOST });
        let buffer = '';
        let state = 'waitingSendAck';
        let reqId = 0;

        socket.setTimeout(600000); // 10 min max

        function ipcSend(action, data) {
            reqId++;
            socket.write(JSON.stringify({ requestId: reqId, action, provider, data }) + '\n');
            return reqId;
        }

        // Build the correct payload for each provider
        function buildSendPayload() {
            if (provider === 'chatgpt') {
                return { message, model };
            }
            // perplexity (and any future provider)
            return { message, modelPreference: model, deepSearch: false };
        }

        socket.on('connect', () => {
            ipcSend('sendMessage', buildSendPayload());
        });

        socket.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const resp = JSON.parse(line);

                    if (state === 'waitingSendAck' && resp.requestId === 1) {
                        if (!resp.success) {
                            socket.destroy();
                            reject(new Error(resp.error || 'sendMessage failed'));
                            return;
                        }
                        state = 'waitingResponse';
                        ipcSend('getResponseWithTyping', {});

                    } else if (state === 'waitingResponse' && resp.requestId === 2) {
                        state = 'done';
                        socket.end();
                        const text = resp.response || '';
                        if (!text) {
                            reject(new Error(provider + ' returned empty response'));
                        } else {
                            resolve(text);
                        }
                    }
                } catch { /* ignore parse errors */ }
            }
        });

        socket.on('error', (e) => {
            reject(e.code === 'ECONNREFUSED'
                ? new Error('Cannot connect to Proxima Agent Hub on port ' + IPC_PORT + '. Is it running?')
                : e);
        });

        socket.on('timeout', () => {
            socket.destroy();
            reject(new Error('IPC request timed out after 10 minutes'));
        });
    });
}

// ─── Git helpers ──────────────────────────────────────────────────────────────
function getCommitInfo(ref) {
    const sha = execSync('git rev-parse ' + ref, { encoding: 'utf8' }).trim();
    const shortSha = sha.substring(0, 8);
    const msg = execSync('git log -1 --pretty=%B ' + sha, { encoding: 'utf8' }).trim();
    const author = execSync('git log -1 --pretty=%an ' + sha, { encoding: 'utf8' }).trim();
    const date = execSync('git log -1 --pretty=%cd --date=short ' + sha, { encoding: 'utf8' }).trim();
    return { sha, shortSha, msg, author, date };
}

function getDiff(sha) {
    try {
        // Limit to 2MB to avoid clogging Perplexity or hitting memory limits
        // -M100% + --diff-filter=r: Detect 100% similarity moves as "Renames" and then EXCLUDE them from the diff.
        // This ensures moved files are ignored, but moved-and-modified files are still reviewed.
        const diff = execSync('git show --no-color --unified=3 -M100% --diff-filter=r ' + sha, {
            encoding: 'utf8',
            maxBuffer: 2 * 1024 * 1024
        });
        return diff;
    } catch (e) {
        if (e.message && e.message.includes('maxBuffer')) {
            return '__TOO_LARGE__';
        }
        logToFile('getDiff error: ' + e.message);
        return '';
    }
}

function logToFile(msg, dir) {
    try {
        const targetDir = dir || REVIEW_DIR;
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
        const logFile = path.join(targetDir, 'background.log');
        fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`, 'utf8');
    } catch { }
}

function writeSkipStatus(shortSha, reason, dir) {
    try {
        const targetDir = dir || REVIEW_DIR;
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
        const skipFile = path.join(targetDir, `skip-${shortSha}.json`);
        fs.writeFileSync(skipFile, JSON.stringify({ status: "skipped", reason }, null, 2), 'utf8');
    } catch { }
}



// ─── Review runner ────────────────────────────────────────────────────────────
async function runReview(commitRef, options = {}) {
    const isBg = process.env.PROXIMA_BACKGROUND_REVIEW === '1';
    const outputDir = options.outputDir || REVIEW_DIR;
    const force = options.force === true;
    
    const log = (msg) => {
        console.log(msg);
        if (isBg) logToFile(msg, outputDir);
    };

    if (SKIP_REVIEW && !force) {
        log(yellow('⏭') + ' Skipping review (PROXIMA_SKIP_REVIEW=1)');
        writeSkipStatus(commitRef, 'PROXIMA_SKIP_REVIEW=1', outputDir);
        return;
    }



    let info;
    try {
        info = getCommitInfo(commitRef);
    } catch (e) {
        log(red('❌') + ' Invalid commit: ' + e.message);
        return;
    }

    const { sha, shortSha, msg, author, date } = info;

    // Skip rules
    try {
        const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
        if (branch.startsWith(SKIP_BRANCH_PREFIX) && !force) {
            log(yellow('⏭') + ' Skipping bot branch: ' + branch);
            writeSkipStatus(shortSha, 'bot-branch', outputDir);
            return;
        }
    } catch { }

    if (msg.includes(SKIP_COMMIT_MARKER) && !force) {
        log(yellow('⏭') + ' Skipping auto-fix commit: ' + shortSha);
        writeSkipStatus(shortSha, 'auto-fix-commit', outputDir);
        return;
    }



    log(cyan('📋') + ' Commit: ' + shortSha + ' — ' + dim(msg.split('\n')[0]));

    // Skip maintenance/chore commits to save Perplexity quota (bypassed when force=true)
    if (!options.force && (msg.toLowerCase().startsWith('chore:') || msg.toLowerCase().startsWith('docs:'))) {
        log(yellow('⏭') + ' Skipping maintenance commit: ' + shortSha);
        return;
    }

    // Check if review already exists (in root or resolved folder)
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    
    // Determine filename
    const isCanonical = outputDir.endsWith(shortSha) || outputDir.endsWith(shortSha + '/');
    let reviewFile;
    if (options.fileName) {
        reviewFile = path.join(outputDir, options.fileName);
    } else {
        // If outputDir is the canonical /root/review/<shortSha>/, use review.md
        reviewFile = isCanonical 
            ? path.join(outputDir, 'review.md')
            : path.join(outputDir, shortSha + '.md');
    }


    const resolvedFile = path.join(outputDir, 'resolved', shortSha + '.md');
    
    if ((fs.existsSync(reviewFile) || fs.existsSync(resolvedFile)) && !force) {
        log(yellow('⏭') + '  Review already exists for ' + shortSha + ', skipping');
        return;
    }




    try {
        await acquireLockWithRetry(sha, log);
    } catch (e) {
        log(red('❌') + ' ' + e.message);
        return;
    }
    log(cyan('🔒') + ' Lock acquired');

    const diff = getDiff(sha);

    if (diff === '__TOO_LARGE__') {
        log(yellow('⏭') + ' Skipping ' + shortSha + ': diff is too large (> 2MB)');
        releaseLock();
        return;
    }
    if (!diff || diff.trim() === '') {
        log(yellow('⚠') + ' No diff found for ' + shortSha);
        releaseLock();
        return;
    }

    const prompt = `You are a hostile, adversarial code auditor with a mandate to find real bugs, not validate the author's intent.

CRITICAL RULES — violating any of these makes your review useless:
1. **NEVER trust the commit message.** The message says what the author INTENDED. Your job is to verify whether the code ACTUALLY does that. Treat the message as a hypothesis to be tested, not a fact to be summarized.
2. **Do NOT mirror or paraphrase the commit message in your summary.** If your summary reads like a reworded version of the commit message, you have failed.
3. **Assume the author is wrong** until the code proves otherwise. Look for cases where the implementation contradicts the stated intent.
4. **Generic advice is forbidden.** Every point must cite a specific line in the diff. "Add input validation" with no line reference is worthless.
5. **Use web search** to verify API contracts, library behavior, or security advisories for any external dependency touched in the diff.

---
Commit: ${shortSha}
Author: ${author}
Date:   ${date}
Stated Intent (treat as unverified): "${msg}"
---

Diff to audit:
${diff}

Answer these adversarial questions from the diff alone, ignoring the commit message:

**Q1 — Does the code actually do what the commit message claims?**
Verify line by line. Call out any gap between stated intent and actual implementation.

**Q2 — What are the realistic failure modes?**
Think: race conditions, null/undefined paths, unhandled exceptions, wrong assumptions about input shape or order of operations.

**Q3 — What did the author NOT change that they should have?**
Look for related code paths, sibling functions, or symmetric operations that were left inconsistent with this change.

**Q4 — What is the worst-case security or data-integrity impact if this code has a bug?**
Be specific about attack vectors or corruption scenarios, not generic.

Produce your audit in this exact structure:

## Verdict
**PASS / FAIL / NEEDS WORK** — one sentence on whether the implementation correctly achieves its stated purpose.

## Implementation vs Intent Gap
(Specific divergences between what the commit message claims and what the code does. If none, say "None found" — do NOT leave this blank.)

## Bugs & Failure Modes
| File:Line | Severity | Finding | Evidence |
|-----------|----------|---------|----------|
| src/file.js:L42 | 🔴 Critical | Race condition on token refresh | Two concurrent calls both pass the \`!token\` check before either sets it |

## Missing Changes
- List related code that was NOT updated but should have been, with file:line references.

## Security & Data Integrity
- Worst-case impact if this code is wrong (be specific, not generic).

## Score: X/10
Justification must reference specific evidence from the diff, not the commit message.

REMEMBER: A review that mostly agrees with the commit message is a failed review.`;


    log(cyan('🚀') + ' Sending to ' + PROVIDER_LABEL + ' (' + REVIEW_MODEL + ')...');

    try {
        const response = await queryAI(prompt, REVIEW_MODEL, REVIEW_PROVIDER);

        const content = `---
commit: ${sha}
short_sha: ${shortSha}
author: ${author}
date: ${date}
message: ${JSON.stringify(msg)}
model: ${REVIEW_MODEL}
provider: ${REVIEW_PROVIDER}
reviewed_at: ${new Date().toISOString()}
---

# Code Review: ${shortSha}

> ${msg.split('\n')[0]}

${response}`;

        fs.writeFileSync(reviewFile, content, 'utf8');
        log(green('✅') + ' Review saved → ' + yellow(reviewFile));

    } catch (e) {
        log(red('❌') + ' Review failed: ' + e.message);

        let errorFile;
        if (options.fileName) {
            errorFile = path.join(outputDir, 'error-' + options.fileName);
        } else {
            errorFile = isCanonical
                ? path.join(outputDir, 'review-error.md')
                : path.join(outputDir, 'error-' + shortSha + '.md');
        }

            
        fs.writeFileSync(errorFile,
            `---\ncommit: ${sha}\nshort_sha: ${shortSha}\nauthor: ${author}\ndate: ${date}\nmessage: ${JSON.stringify(msg)}\nerror: ${e.message}\nerror_at: ${new Date().toISOString()}\n---\n\n# Review Failed\n\n**Error:** ${e.message}\n`,
            'utf8'
        );
        log(cyan('📄') + ' Error saved → ' + yellow(errorFile));
    } finally {

        releaseLock();
        log(cyan('🔓') + ' Lock released');
    }
}

// ─── Pre-push stdin parser ────────────────────────────────────────────────────
// Git passes pushed refs on stdin:
//   <local-ref> <local-sha> <remote-ref> <remote-sha>
// remote-sha is 000...000 when the branch is brand new.
async function getNewCommitsFromStdin() {
    return new Promise((resolve) => {
        let input = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (d) => { input += d; });
        process.stdin.on('end', () => {
            const commits = [];
            const NULL_SHA = '0000000000000000000000000000000000000000';

            for (const line of input.trim().split('\n')) {
                const parts = line.trim().split(/\s+/);
                if (parts.length < 4) continue;

                const [, localSha, , remoteSha] = parts;
                if (!localSha || localSha === NULL_SHA) continue; // deleted branch

                try {
                    const range = remoteSha === NULL_SHA
                        ? '-n 1 ' + localSha                          // new branch — review HEAD only
                        : remoteSha + '..' + localSha;     // incremental push

                    const shas = execSync('git rev-list --reverse ' + range, { encoding: 'utf8' })
                        .trim().split('\n').filter(Boolean);
                    commits.push(...shas);
                } catch { /* empty push or detached HEAD, skip */ }
            }

            resolve([...new Set(commits)]); // deduplicate
        });
        process.stdin.on('error', () => resolve([]));
    });
}

// ─── Spawn background child ───────────────────────────────────────────────────
function spawnBackground(sha) {
    const isWin = process.platform === 'win32';
    const gitRoot = findGitRoot();
    const cleanEnv = {};
    for (const key in process.env) {
        if (!key.startsWith('GIT_')) cleanEnv[key] = process.env[key];
    }
    cleanEnv['PROXIMA_BACKGROUND_REVIEW'] = '1';
    if (!fs.existsSync(REVIEW_DIR)) fs.mkdirSync(REVIEW_DIR, { recursive: true });
    const logFile = path.join(REVIEW_DIR, 'background.log');
    const out = fs.openSync(logFile, 'a');

    // Loop script is always relative to this review script, not the target project
    const loopScript = path.resolve(__dirname, '../scripts/proxima-loop.cjs');

    let child;
    if (isWin) {
        // Write a temp .ps1 to avoid all nested-quote escaping issues
        const tmpScript = path.join(os.tmpdir(), 'proxima-loop-' + Date.now() + '.ps1');
        const safeRoot = gitRoot.replace(/'/g, "''");
        const safeLoop = loopScript.replace(/'/g, "''");
        const ps1Lines = [
            "Set-Location '" + safeRoot + "'",
            "node '" + safeLoop + "'",
            "Write-Host ''",
            "Write-Host '--- Automation finished. Auto-closing in 5 minutes ---'",
            "Start-Sleep -Seconds 300",
            "Exit 0",
        ];
        fs.writeFileSync(tmpScript, ps1Lines.join('\r\n'), 'utf8');
        child = spawn('cmd.exe', [
            '/c', 'start', 'Proxima Automation',
            'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmpScript
        ], { detached: true, stdio: 'ignore' });
    } else {
        child = spawn(process.execPath, [loopScript], {
            detached: true,
            stdio: ['ignore', out, out],
            cwd: gitRoot,
            env: cleanEnv
        });
    }

    child.unref();
    const shortSha = sha.substring(0, 8);
    console.log(cyan('\u{1F916}') + ' Automation loop starting for ' + yellow(shortSha) + ' (new window)');
    fs.appendFileSync(logFile, '[' + new Date().toISOString() + '] [SPAWN] Loop started for ' + shortSha + ' (PID: ' + child.pid + ')\n', 'utf8');
}


// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    const args = process.argv.slice(2);

    // pre-push hook mode: no args, read stdin from git
    if (args.length === 0 || args[0] === '--pre-push') {
        const commits = await getNewCommitsFromStdin();
        if (commits.length === 0) {
            console.log(dim('proxima-review: no new commits to review'));
            process.exit(0);
        }
        console.log(cyan('📦') + ' ' + commits.length + ' new commit(s) to review');
        for (const sha of commits) {
            spawnBackground(sha);
        }
        process.exit(0); // never block git push
    }

    // Manual run: node cli/proxima-review.cjs <sha>
    const commitRef = args[0];
    try {
        await runReview(commitRef);
    } catch (e) {
        console.error(red('Error: ') + e.message);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    runReview,
    getCommitInfo,
    getDiff,
    queryAI
};