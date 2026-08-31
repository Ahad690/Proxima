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
// Qwen reasons only when asked. The engine does `!!o.thinking`, so a payload that
// omits the flag silently runs qwen3.8-max with thinking_enabled:false — measured:
// phases ["answer"] and zero thinking blocks, versus ["thinking_summary","answer"]
// with it. Every review before this ran unreasoned.
const REVIEW_THINKING = automationConfig.reviewThinking !== false;
const REVIEW_PROVIDER = process.env.PROXIMA_REVIEW_PROVIDER || resolveProvider(REVIEW_MODEL);
const REVIEW_DIR = process.env.PROXIMA_REVIEW_DIR || automationConfig.reviewDir || path.join(findGitRoot(), 'perplexity-reviews');
const REVIEW_THINKING_EFFORT = process.env.PROXIMA_REVIEW_THINKING_EFFORT || resolveThinkingEffort(REVIEW_MODEL);

function resolveProvider(model) {
    const m = model.toLowerCase();
    if (m === 'chatgpt' || m.startsWith('gpt') || m.startsWith('o1') || m.startsWith('o3')) return 'chatgpt';
    if (m === 'qwen' || m.startsWith('qwen') || m.startsWith('tongyi')) return 'qwen';
    if (m === 'claude' || m.startsWith('claude')) return 'claude';
    if (m === 'gemini' || m.startsWith('gemini')) return 'gemini';
    // Anything unrecognised falls through to perplexity. Name a provider
    // explicitly above before configuring it, or reviews silently run on the
    // wrong model.
    return 'perplexity';
}

function resolveThinkingEffort(model) {
    if (!model) return 'standard';
    const m = model.toLowerCase();
    return m.includes('thinking') ? 'extended' : 'standard';
}

function normalizePromptText(text) {
    return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function isPlaceholderResponse(text) {
    const t = String(text || '').trim().toLowerCase();
    return !t || t === 'no response captured' || t === 'no response received';
}

const PROVIDER_DISPLAY = {
    'chatgpt': 'ChatGPT',
    'perplexity': 'Perplexity',
    'claude': 'Claude',
    'gemini': 'Gemini',
    'qwen': 'Qwen'
};
const PROVIDER_LABEL = PROVIDER_DISPLAY[REVIEW_PROVIDER] || REVIEW_PROVIDER;

// Universal lock file in the home directory to prevent cross-project Hub overloading
const LOCK_FILE = path.join(os.homedir(), '.proxima-review.lock');
const STALE_LOCK_MS = 15 * 60 * 1000; // 15 min
const SOCKET_TIMEOUT_MS = parseInt(process.env.PROXIMA_IPC_TIMEOUT_MS || '', 10) || (15 * 60 * 1000);
const CAPTURE_RETRY_DELAY_MS = parseInt(process.env.PROXIMA_CAPTURE_RETRY_DELAY_MS || '', 10) || 2500;
const CAPTURE_MAX_ATTEMPTS = parseInt(process.env.PROXIMA_CAPTURE_MAX_ATTEMPTS || '', 10) || 120;

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
            if (shouldReapLock(lock)) {
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
// ChatGPT:    sendMessage with { message, model, thinkingEffort }
// Perplexity: sendMessage with { message, modelPreference, deepSearch: false }
function queryAI(message, model, provider) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ port: IPC_PORT, host: IPC_HOST });
        let buffer = '';
        let state = 'waitingSendAck';
        let reqId = 0;
        let captureRequestId = null;
        let captureAttempts = 0;

        socket.setTimeout(SOCKET_TIMEOUT_MS);

        function ipcSend(action, data) {
            reqId++;
            socket.write(JSON.stringify({ requestId: reqId, action, provider, data }) + '\n');
            return reqId;
        }

        function requestCapture() {
            captureAttempts++;
            captureRequestId = ipcSend('getResponseWithTyping', {});
        }

        // Build the correct payload for each provider
        function buildSendPayload() {
            if (provider === 'chatgpt') {
                return { message, model, thinkingEffort: REVIEW_THINKING_EFFORT };
            }
            if (provider === 'qwen') {
                // The Qwen engine picks its own default model (qwen3.8-max); chat_type
                // rides the provider:engine channel, not the payload. `thinking` does
                // have to be passed — see REVIEW_THINKING above.
                return { message, thinking: REVIEW_THINKING };
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
                        requestCapture();

                    } else if (state === 'waitingResponse' && resp.requestId === captureRequestId) {
                        const text = resp.response || '';

                        if (isPlaceholderResponse(text)) {
                            if (captureAttempts >= CAPTURE_MAX_ATTEMPTS) {
                                state = 'done';
                                socket.end();
                                reject(new Error(provider + ' response capture failed after ' + captureAttempts + ' attempts'));
                                return;
                            }
                            setTimeout(() => {
                                requestCapture();
                            }, CAPTURE_RETRY_DELAY_MS);
                            continue;
                        }

                        state = 'done';
                        socket.end();
                        if (isPlaceholderResponse(text)) {
                            reject(new Error(provider + ' response capture failed'));
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
            reject(new Error('IPC request timed out after ' + Math.round(SOCKET_TIMEOUT_MS / 60000) + ' minutes'));
        });
    });
}

function isProcessRunning(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return e && e.code === 'EPERM';
    }
}

function shouldReapLock(lock) {
    const lockTime = Number(lock && lock.time);
    const lockAge = Number.isFinite(lockTime) ? Date.now() - lockTime : Infinity;
    if (lock && Number.isInteger(lock.pid)) {
        return !isProcessRunning(lock.pid);
    }
    return lockAge > STALE_LOCK_MS;
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

    const normalizedMsg = normalizePromptText(msg);
    const normalizedDiff = normalizePromptText(diff);
    const nl = '\n';
    const prompt = [
        `You are a senior code auditor. Your only job is to find REAL bugs in this diff. False positives — bugs that aren't actually bugs — discredit the entire review and waste the reader's time. Fewer correct findings beats many padded ones, every time.`,
        ``,
        `GROUND RULES — violating any of these invalidates your review:`,
        ``,
        `1. **QUOTE-OR-DROP.** Every finding MUST quote the exact diff line(s) it refers to in a fenced code block. Not "the code does X" — show the literal code. If you can't quote it, you don't have a finding. Cut it.`,
        ``,
        `2. **FIX-OR-DROP.** Every finding MUST include a "Suggested fix" in a fenced code block showing the corrected code. Prose like "add validation here" is not a fix. If you cannot write the fix as code, you don't understand the problem well enough to flag it. Cut it.`,
        ``,
        `3. **VERIFY BEHAVIORAL CLAIMS WITH WEB SEARCH.** Before claiming what a stdlib/framework/API does ("Python's splitlines() mishandles CRLF", "React.memo doesn't deep-compare", "the From header affects SPF", "useMemo with array deps misfires"), look it up. Unverified behavioral claims are the #1 source of bogus review findings. When in doubt, do not claim.`,
        ``,
        `4. **NO HEDGED FINDINGS.** "May fail under certain conditions", "could cause issues", "potential race", "might not prevent rerenders" — without a concrete reproduction (specific input, sequence of calls, or state) these are noise. Cut them. If you cannot describe how to trigger the bug in one sentence, you don't have a bug.`,
        ``,
        `5. **NO GENERIC DEFENSIVE-CODING SUGGESTIONS.** "Add input validation", "consider error handling", "should validate types" with no concrete failure path are not findings. They are filler.`,
        ``,
        `6. **NEVER MIRROR THE COMMIT MESSAGE.** The message states the author's *intent*. Your job is to check the *code* against it, not paraphrase the message back.`,
        ``,
        `7. **NONE IS A VALID ANSWER.** If a section has no real findings, write "None found." Do NOT invent findings to fill space. A short correct review is the goal. The author shipped clean code is a legitimate, common outcome.`,
        ``,
        `8. **DEFAULT SCORE OF 6 IS A SMELL.** If your finding list is short, score high (8-10). Reserve 4-6 for actual correctness bugs. Do not anchor on the middle.`,
        ``,
        `9. **RESPECT LINE BREAKS.** Treat every newline in the diff as significant; do not collapse or rewrite multi-line sections.`,
        ``,
        `---`,
        `Commit: ${shortSha}`,
        `Author: ${author}`,
        `Date:   ${date}`,
        `Stated Intent (verify, do not summarize): "${normalizedMsg}"`,
        `---`,
        ``,
        `Diff to audit (line breaks are significant — preserve each \\n exactly):`,
        `${normalizedDiff}`,
        ``,
        `Work these adversarial questions in your head before writing the report. Skip a question if it yields no concrete finding.`,
        ``,
        `Q1 — Does the code actually do what the commit message claims? Find concrete divergences. Cite the exact line.`,
        `Q2 — What are the *reproducible* failure modes? For each, name the input or sequence that triggers it.`,
        `Q3 — What did the author NOT change that they should have? Look for callers, sibling files, parallel branches left inconsistent.`,
        `Q4 — Is there a *concrete* security or data-integrity impact (not abstract worry)? Describe the attack or corruption scenario.`,
        ``,
        `---`,
        ``,
        `Produce the audit in this exact structure. Each section accepts "None found." as a valid answer.`,
        ``,
        `## Verdict`,
        `**PASS / FAIL / NEEDS WORK** — one sentence on whether the implementation correctly achieves its stated purpose. PASS is appropriate when no real findings exist.`,
        ``,
        `## Implementation vs Intent Gap`,
        `Specific divergences between message and code, with file:line. If the implementation matches the intent, write "None found."`,
        ``,
        `## Bugs & Failure Modes`,
        `If none, write "None found." and skip to the next section.`,
        ``,
        `Otherwise, for EACH finding use this exact template (do not use a table — code blocks render badly in table cells):`,
        ``,
        `### Finding N — \`file/path.ext:L<start>-L<end>\` — 🔴 Critical / ⚠️ High / 🟡 Medium / 🟢 Low`,
        ``,
        `**Claim:** one sentence stating what is wrong.`,
        ``,
        `**Evidence (literal lines from the diff):**`,
        `\`\`\`<language>`,
        `<paste the exact offending lines here — must appear verbatim in the diff>`,
        `\`\`\``,
        ``,
        `**Trigger:** the input/state/sequence that reproduces the bug, in one sentence. If you cannot write this, drop the finding.`,
        ``,
        `**Suggested fix:**`,
        `\`\`\`<language>`,
        `<corrected code — what the lines SHOULD be>`,
        `\`\`\``,
        ``,
        `(Repeat the template for each finding. Stop when you have no more real findings.)`,
        ``,
        `## Missing Changes`,
        `Related code that was NOT updated but should have been. Each entry needs a file:line reference and a one-sentence "why this matters". If none, write "None found."`,
        ``,
        `## Security & Data Integrity`,
        `Concrete worst-case impact with a real attack or corruption scenario. Do NOT repeat findings already listed above. If no security/data-integrity concern exists beyond those, write "None beyond findings above."`,
        ``,
        `## Score: X/10`,
        `Score rubric (pick a precise number — do not default to 6):`,
        `- **10**: zero real findings; code matches intent cleanly.`,
        `- **8-9**: at most one minor (🟢/🟡) finding; no correctness bugs.`,
        `- **6-7**: one ⚠️ High finding OR several 🟡 Medium findings.`,
        `- **4-5**: at least one 🔴 Critical finding.`,
        `- **1-3**: multiple 🔴 Critical findings or active security issue.`,
        ``,
        `Justification must cite specific Findings by number (e.g., "Score 8 — only Finding 1 is real and it's 🟡 Medium").`,
        ``,
        `---`,
        ``,
        `REMINDER: A short review with two real findings is more valuable than a long review with eight padded ones. If the diff is clean, say so.`
    ].join(nl);


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
thinking_effort: ${REVIEW_THINKING_EFFORT}
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
        const safeSha = String(sha || '').replace(/'/g, "''");
        const ps1Lines = [
            "Set-Location '" + safeRoot + "'",
            "node '" + safeLoop + "' --sha '" + safeSha + "'",
            "Exit 0",
        ];
        fs.writeFileSync(tmpScript, ps1Lines.join('\r\n'), 'utf8');
        child = spawn('cmd.exe', [
            '/c', 'start', 'Proxima Automation',
            'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmpScript
        ], { detached: true, stdio: 'ignore' });
    } else {
        child = spawn(process.execPath, [loopScript, '--sha', sha], {
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
    // Behaves identically to the git hook — spawns the full repair loop in a new window.
    // Use --review-only to skip the loop and just generate a review file.
    const commitRef = args[0];
    const reviewOnly = args.includes('--review-only');

    if (reviewOnly) {
        try {
            await runReview(commitRef, { force: args.includes('--force') });
        } catch (e) {
            console.error(red('Error: ') + e.message);
            process.exit(1);
        }
    } else {
        // Resolve to full SHA first
        const { execSync } = require('child_process');
        let sha;
        try {
            sha = execSync(`git rev-parse ${commitRef}`, { encoding: 'utf8' }).trim();
        } catch (e) {
            console.error(red('Error: ') + `Cannot resolve ref '${commitRef}': ${e.message}`);
            process.exit(1);
        }
        spawnBackground(sha);
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
