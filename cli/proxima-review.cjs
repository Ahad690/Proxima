#!/usr/bin/env node
// =============================================================================
// Proxima Code Review Script v2
// Usage:  node cli/proxima-review.cjs [commit-sha]   ← manual run
// Hook:   Triggered automatically by pre-push git hook (reads stdin)
// =============================================================================
//
// Transport: Direct IPC socket (port 19222) — no REST API needed.
// Hook mode: pre-push (fires on git push, not on every local commit).
// Storage:   perplexity-reviews/<shortSha>.md in the repo root.
//
// =============================================================================

const net = require('net');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

// ─── Config ───────────────────────────────────────────────────────────────────
const IPC_PORT = parseInt(process.env.AGENT_HUB_PORT) || 19222;
const IPC_HOST = '127.0.0.1';
const REVIEW_MODEL = process.env.PROXIMA_REVIEW_MODEL || 'claude sonnet 4.6 thinking';
const MAX_DIFF_LINES = parseInt(process.env.PROXIMA_REVIEW_MAX_DIFF) || 800;
const REVIEW_DIR = process.env.PROXIMA_REVIEW_DIR || path.join(findGitRoot(), 'perplexity-reviews');
const LOCK_FILE = path.join(REVIEW_DIR, '.review-lock');
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
    if (!fs.existsSync(REVIEW_DIR)) fs.mkdirSync(REVIEW_DIR, { recursive: true });

    if (fs.existsSync(LOCK_FILE)) {
        try {
            const lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
            if (Date.now() - lock.time > STALE_LOCK_MS) {
                console.log(yellow('⚠') + ' Stale lock found (from ' + lock.shortSha + '), clearing');
                fs.unlinkSync(LOCK_FILE);
            } else {
                return false; // Another review is actively running
            }
        } catch {
            fs.unlinkSync(LOCK_FILE);
        }
    }

    try {
        const shortSha = commitSha.substring(0, 8);
        fs.writeFileSync(
            LOCK_FILE,
            JSON.stringify({ sha: commitSha, shortSha, pid: process.pid, time: Date.now() }),
            { encoding: 'utf8', flag: 'wx' }
        );
        return true;
    } catch {
        return false;
    }
}

function releaseLock() {
    try { fs.unlinkSync(LOCK_FILE); } catch {}
}

// ─── Colors ───────────────────────────────────────────────────────────────────
const c = {
    reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
    green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m'
};
const green  = (t) => `${c.green}${t}${c.reset}`;
const yellow = (t) => `${c.yellow}${t}${c.reset}`;
const red    = (t) => `${c.red}${t}${c.reset}`;
const cyan   = (t) => `${c.cyan}${t}${c.reset}`;
const dim    = (t) => `${c.dim}${t}${c.reset}`;

// ─── IPC Client ───────────────────────────────────────────────────────────────
// Talks directly to Proxima Agent Hub over TCP (same protocol as MCP server).
// Sends: sendMessage → getResponseWithTyping, both newline-delimited JSON.
function queryPerplexity(message, modelPreference) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ port: IPC_PORT, host: IPC_HOST });
        let buffer = '';
        let state = 'waitingSendAck';
        let reqId = 0;

        socket.setTimeout(600000); // 10 min max

        function send(action, data) {
            reqId++;
            socket.write(JSON.stringify({ requestId: reqId, action, provider: 'perplexity', data }) + '\n');
            return reqId;
        }

        socket.on('connect', () => {
            // Step 1: send the message with model preference
            send('sendMessage', { message, modelPreference, deepSearch: false });
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
                        // Step 2: wait for the response
                        state = 'waitingResponse';
                        send('getResponseWithTyping', {});

                    } else if (state === 'waitingResponse' && resp.requestId === 2) {
                        state = 'done';
                        socket.end();
                        const text = resp.response || '';
                        if (!text) {
                            reject(new Error('Perplexity returned empty response'));
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
    const sha      = execSync('git rev-parse ' + ref, { encoding: 'utf8' }).trim();
    const shortSha = sha.substring(0, 8);
    const msg      = execSync('git log -1 --pretty=%B ' + sha, { encoding: 'utf8' }).trim();
    const author   = execSync('git log -1 --pretty=%an ' + sha, { encoding: 'utf8' }).trim();
    const date     = execSync('git log -1 --pretty=%cd --date=short ' + sha, { encoding: 'utf8' }).trim();
    return { sha, shortSha, msg, author, date };
}

function getDiff(sha) {
    try {
        const diff  = execSync('git show --no-color --unified=3 ' + sha, { encoding: 'utf8', maxBuffer: MAX_DIFF_LINES * 300 });
        const lines = diff.split('\n');
        if (lines.length > MAX_DIFF_LINES) {
            return lines.slice(0, MAX_DIFF_LINES).join('\n')
                + '\n\n... (truncated, ' + (lines.length - MAX_DIFF_LINES) + ' more lines)';
        }
        return diff;
    } catch {
        return '';
    }
}

function logToFile(msg) {
    try {
        if (!fs.existsSync(REVIEW_DIR)) fs.mkdirSync(REVIEW_DIR, { recursive: true });
        const logFile = path.join(REVIEW_DIR, 'background.log');
        fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`, 'utf8');
    } catch {}
}

// ─── Review runner ────────────────────────────────────────────────────────────
async function runReview(commitRef) {
    const isBg = process.env.PROXIMA_BACKGROUND_REVIEW === '1';
    const log = (msg) => {
        console.log(msg);
        if (isBg) logToFile(msg);
    };

    log(cyan('🤖') + ' Starting Perplexity code review for: ' + yellow(commitRef));

    let info;
    try {
        info = getCommitInfo(commitRef);
    } catch (e) {
        log(red('❌') + ' Invalid commit: ' + e.message);
        return;
    }

    const { sha, shortSha, msg, author, date } = info;
    log(cyan('📋') + ' Commit: ' + shortSha + ' — ' + dim(msg.split('\n')[0]));

    if (!tryAcquireLock(sha)) {
        log(yellow('⏳') + ' Another review is already running. Skipping ' + shortSha);
        log(dim('   Run manually later: node cli/proxima-review.cjs ' + shortSha));
        return;
    }
    log(cyan('🔒') + ' Lock acquired');

    // Check if review already exists
    if (!fs.existsSync(REVIEW_DIR)) fs.mkdirSync(REVIEW_DIR, { recursive: true });
    const reviewFile = path.join(REVIEW_DIR, shortSha + '.md');
    if (fs.existsSync(reviewFile)) {
        log(yellow('⏭') + '  Review already exists for ' + shortSha + ', skipping');
        releaseLock();
        return;
    }

    const diff = getDiff(sha);
    if (!diff || diff.trim() === '') {
        log(yellow('⚠') + ' No diff found for ' + shortSha);
        releaseLock();
        return;
    }

    const prompt = `You are a principal software engineer performing a high-quality code review.

---
Commit: ${shortSha}
Author: ${author}
Date:   ${date}
Message: ${msg}
---

Full diff:
${diff}

Provide a professional, constructive code review with this structure:

## Summary
(One paragraph — what changed and why)

## What's Good
- Strengths and good practices observed

## Issues & Suggestions
- Bugs, code smells, performance issues, or improvements
- Be specific with file/line references when possible

## Security & Performance
- Security concerns?
- Performance or scalability implications?

## Overall Score: X/10
(Brief justification)

## Recommendations
(Prioritized next steps — most important first)

Be constructive, specific, and actionable. Focus on correctness, maintainability, and best practices.`;

    log(cyan('🚀') + ' Sending to Perplexity (' + REVIEW_MODEL + ')...');

    try {
        const response = await queryPerplexity(prompt, REVIEW_MODEL);

        const content = `---
commit: ${sha}
short_sha: ${shortSha}
author: ${author}
date: ${date}
message: ${JSON.stringify(msg)}
model: ${REVIEW_MODEL}
reviewed_at: ${new Date().toISOString()}
---

# Code Review: ${shortSha}

> ${msg.split('\n')[0]}

${response}`;

        fs.writeFileSync(reviewFile, content, 'utf8');
        log(green('✅') + ' Review saved → ' + yellow(reviewFile));

    } catch (e) {
        log(red('❌') + ' Review failed: ' + e.message);

        const errorFile = path.join(REVIEW_DIR, 'error-' + shortSha + '.md');
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

    // Strip GIT_* environment variables to prevent git commands from failing
    const cleanEnv = {};
    for (const key in process.env) {
        if (!key.startsWith('GIT_')) {
            cleanEnv[key] = process.env[key];
        }
    }
    cleanEnv['PROXIMA_BACKGROUND_REVIEW'] = '1';

    // Prepare custom stdout/stderr append to log file inside background.log
    if (!fs.existsSync(REVIEW_DIR)) fs.mkdirSync(REVIEW_DIR, { recursive: true });
    const logFile = path.join(REVIEW_DIR, 'background.log');
    const out = fs.openSync(logFile, 'a');

    // On Windows, use cmd.exe to start /b so that it completely detaches
    const child = spawn(
        isWin ? 'cmd.exe' : process.execPath,
        isWin ? ['/c', 'start', '""', '/b', process.execPath, __filename, sha] : [__filename, sha],
        {
            detached: true,
            stdio: ['ignore', out, out],
            cwd: findGitRoot(),
            env: cleanEnv,
            windowsHide: true
        }
    );
    child.unref();
    console.log(cyan('🤖') + ' Review queued for ' + yellow(sha.substring(0, 8)) + ' (background)');
    console.log(cyan('💡') + ' Background reviews may take 1-2 minutes to complete.');
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

main();