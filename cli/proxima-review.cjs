#!/usr/bin/env node
// =============================================================================
// Proxima Code Review Script
// Usage: node cli/proxima-review.cjs [commit-ref]
// Hook:  Runs in background as post-commit hook (non-blocking)
// =============================================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ─── Config ───────────────────────────────────────────────────────────────
const API_HOST = process.env.PROXIMA_HOST || '127.0.0.1';
const API_PORT = parseInt(process.env.PROXIMA_REST_PORT) || 3210;
const API_BASE = `http://${API_HOST}:${API_PORT}`;
const REVIEW_DIR = 'perplexity-reviews';  // In CWD where git commit runs
const MAX_DIFF_LINES = 800;
const LOCK_FILE = path.join(REVIEW_DIR, '.review-lock');
const STALE_LOCK_MS = 15 * 60 * 1000; // 15 min — stale if older

// ─── Lock (atomic, no TOCTOU race) ──────────────────────────────────────────
function tryAcquireLock(commitSha) {
    if (!fs.existsSync(REVIEW_DIR)) fs.mkdirSync(REVIEW_DIR, { recursive: true });

    // Clear stale lock — if lock is older than 15 min, last process likely crashed
    if (fs.existsSync(LOCK_FILE)) {
        try {
            const lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
            if (Date.now() - lock.time > STALE_LOCK_MS) {
                console.log('\x1b[33m⚠\x1b[0m Stale lock found (from ' + lock.shortSha + '), clearing');
                fs.unlinkSync(LOCK_FILE);
            }
        } catch {
            fs.unlinkSync(LOCK_FILE);
        }
    }

    // Atomic acquire: wx flag fails if file already exists (no TOCTOU)
    try {
        fs.writeFileSync(LOCK_FILE, JSON.stringify({ sha: commitSha, shortSha: commitSha.substring(0, 8), pid: process.pid, time: Date.now() }), { encoding: 'utf8', flag: 'wx' });
        return true;
    } catch {
        return false;
    }
}

function releaseLock() {
    try { fs.unlinkSync(LOCK_FILE); } catch {}
}

// ─── Colors ────────────────────────────────────────────────────────────────
const c = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m' };
const green = (t) => `${c.green}${t}${c.reset}`;
const yellow = (t) => `${c.yellow}${t}${c.reset}`;
const red = (t) => `${c.red}${t}${c.reset}`;
const cyan = (t) => `${c.cyan}${t}${c.reset}`;
const bold = (t) => `${c.bold}${t}${c.reset}`;
const dim = (t) => `${c.dim}${t}${c.reset}`;

// ─── API ───────────────────────────────────────────────────────────────────
function apiRequest(method, endpoint, body = null) {
    return new Promise((resolve, reject) => {
        const url = new URL(endpoint, API_BASE);
        const options = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method,
            headers: { 'Content-Type': 'application/json' },
            timeout: 600000
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
                catch { resolve({ status: res.statusCode, data: { error: data } }); }
            });
        });

        req.on('error', (e) => {
            reject(e.code === 'ECONNREFUSED'
                ? new Error('Cannot connect to Proxima. Is it running? (npm start)')
                : e);
        });
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out (10min)')); });
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

// ─── Git ───────────────────────────────────────────────────────────────────
function getCommitInfo(ref) {
    try {
        const sha = execSync('git rev-parse ' + ref, { encoding: 'utf8' }).trim();
        const shortSha = sha.substring(0, 8);
        const msg = execSync('git log -1 --pretty=%B ' + sha, { encoding: 'utf8' }).trim();
        const author = execSync('git log -1 --pretty=%an ' + sha, { encoding: 'utf8' }).trim();
        const date = execSync('git log -1 --pretty=%cd --date=short ' + sha, { encoding: 'utf8' }).trim();
        return { sha, shortSha, msg, author, date };
    } catch (e) {
        throw new Error('Invalid commit reference: ' + ref);
    }
}

function getDiff(sha, maxLines) {
    try {
        const diff = execSync('git show --no-color --unified=3 ' + sha, { encoding: 'utf8', maxBuffer: maxLines * 200 });
        const lines = diff.split('\n');
        if (lines.length > maxLines) {
            return lines.slice(0, maxLines).join('\n') + '\n\n... (truncated, ' + (lines.length - maxLines) + ' more lines)';
        }
        return diff;
    } catch {
        return '';
    }
}

// ─── Review ───────────────────────────────────────────────────────────────
async function runReview(commitRef) {
    console.log(cyan('🤖') + ' Starting Perplexity code review for: ' + yellow(commitRef));

    const { sha, shortSha, msg, author, date } = getCommitInfo(commitRef);
    console.log(cyan('📋') + ' Commit: ' + shortSha + ' by ' + author);

    // Atomic lock — fails instantly if another review is running
    if (!tryAcquireLock(sha)) {
        console.log(yellow('⏳') + ' Another review is already running. Skipping this commit.');
        console.log(dim('   Run manually later: node cli/proxima-review.cjs ' + shortSha));
        return;
    }
    console.log(cyan('🔒') + ' Lock acquired');

    const diff = getDiff(sha, MAX_DIFF_LINES);
    if (!diff || diff.trim() === '') {
        console.log(yellow('⚠') + ' No changes detected.');
        releaseLock();
        return;
    }

    const reviewPrompt = `You are a principal software engineer performing a high-quality code review.

---
Commit: ${shortSha}
Author: ${author}
Date: ${date}
Message: ${msg}
---

Full diff:
${diff}

Provide a professional, constructive code review with the following structure:

## Summary
(One paragraph summary of what was changed)

## What's Good
- List strengths and good practices

## Issues & Suggestions
- List any bugs, code smells, performance issues, or improvements
- Be specific with line references when possible

## Security & Performance
- Any security concerns?
- Performance implications?
- Scalability notes?

## Overall Score: X/10
(Include a brief justification for the score)

## Recommendations
(Prioritized list of next steps)

Focus on correctness, maintainability, readability, and best practices.
Be constructive and specific.`;

    console.log(cyan('🚀') + ' Sending review request to Perplexity...');

    try {
        const { data } = await apiRequest('POST', '/v1/chat/completions', {
            model: 'perplexity',
            message: reviewPrompt
        });

        let response = '';
        if (data.choices && data.choices.length > 0) {
            response = data.choices[0].message?.content || '';
        } else if (data.error) {
            throw new Error(data.error.message || JSON.stringify(data.error));
        } else {
            throw new Error('Unknown response format');
        }

        if (!response) throw new Error('Empty response from AI');

        if (!fs.existsSync(REVIEW_DIR)) fs.mkdirSync(REVIEW_DIR, { recursive: true });

        const reviewFile = path.join(REVIEW_DIR, `perplexity-${shortSha}.md`);
        const metadata = `---
commit: ${sha}
short_sha: ${shortSha}
author: ${author}
date: ${date}
message: ${msg}
reviewed_at: ${new Date().toISOString()}
---

${response}`;

        fs.writeFileSync(reviewFile, metadata, 'utf8');

        console.log(green('✅') + ' Review completed!');
        console.log(cyan('📄') + ' Saved to: ' + yellow(reviewFile));
        const timeMs = data.proxima?.responseTimeMs || 0;
        console.log(dim(`   Response time: ${(timeMs / 1000).toFixed(1)}s`));

    } catch (e) {
        console.log(red('❌') + ' Review failed: ' + e.message);

        if (!fs.existsSync(REVIEW_DIR)) fs.mkdirSync(REVIEW_DIR, { recursive: true });
        const errorFile = path.join(REVIEW_DIR, `error-${shortSha}.md`);
        fs.writeFileSync(errorFile, `---\ncommit: ${sha}\nshort_sha: ${shortSha}\nauthor: ${author}\ndate: ${date}\nmessage: ${msg}\nerror: ${e.message}\nerror_at: ${new Date().toISOString()}\n---\n\n# Review Failed\n\n${e.message}\n`, 'utf8');
        console.log(cyan('📄') + ' Error saved to: ' + yellow(errorFile));
    } finally {
        releaseLock();
        console.log(cyan('🔓') + ' Lock released');
    }
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
    const commitRef = process.argv[2] || 'HEAD';

    // If running as git hook (--hook flag), spawn in background so git doesn't block
    if (process.argv.includes('--hook')) {
        const { spawn } = require('child_process');
        const child = spawn(process.execPath, [__filename, commitRef], {
            detached: true,
            stdio: 'ignore'
        });
        child.unref();
        console.log(cyan('🤖') + ' Review queued for ' + yellow(commitRef.substring(0, 8)) + ' (running in background)');
        return;
    }

    try {
        await runReview(commitRef);
    } catch (e) {
        console.error(red('Error: ') + e.message);
        process.exit(1);
    }
}

main();