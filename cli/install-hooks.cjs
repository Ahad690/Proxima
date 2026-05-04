#!/usr/bin/env node
// =============================================================================
// Proxima Git Hook Installer
// Usage: node cli/install-hooks.cjs [--repo /path/to/repo]
//
// Installs a pre-push hook that automatically queues a Perplexity code review
// for every new commit pushed to any remote.
//
// The hook:
//   - Runs in background (never blocks git push)
//   - Skips commits that already have a review
//   - Supports multiple commits pushed at once
//   - Works on Windows (Git for Windows / Git Bash)
// =============================================================================

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ─── Colors ──────────────────────────────────────────────────────────────────
const c = { reset: '\x1b[0m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m', dim: '\x1b[2m' };
const green  = (t) => `${c.green}${t}${c.reset}`;
const yellow = (t) => `${c.yellow}${t}${c.reset}`;
const red    = (t) => `${c.red}${t}${c.reset}`;
const cyan   = (t) => `${c.cyan}${t}${c.reset}`;
const dim    = (t) => `${c.dim}${t}${c.reset}`;
const bold   = (t) => `\x1b[1m${t}${c.reset}`;

// ─── Find git root ────────────────────────────────────────────────────────────
function findGitRoot(startDir) {
    try {
        return execSync('git rev-parse --show-toplevel', {
            encoding: 'utf8',
            cwd: startDir || process.cwd()
        }).trim();
    } catch {
        return null;
    }
}

// ─── Resolve script path (absolute, forward slashes for bash) ─────────────────
function toUnixPath(p) {
    // Convert Windows drive letter path to Git Bash path: C:\foo → /c/foo
    return p
        .replace(/\\/g, '/')
        .replace(/^([A-Za-z]):/, (_, d) => '/' + d.toLowerCase());
}

// ─── Hook content ─────────────────────────────────────────────────────────────
function buildHookScript(reviewScriptPath) {
    const unixPath = toUnixPath(reviewScriptPath);
    const unixNodePath = toUnixPath(process.execPath);
    return `#!/bin/sh
# =============================================================================
# Proxima pre-push hook — auto code review via Perplexity AI
# Installed by: node cli/install-hooks.cjs
# =============================================================================
#
# Reads pushed refs from git stdin and queues a background Perplexity review
# for each new commit. Never blocks the push (always exits 0).
#
# To uninstall: delete this file or run node cli/install-hooks.cjs --remove
# =============================================================================

REVIEW_SCRIPT="${unixPath}"
NODE_EXE="${unixNodePath}"

if [ ! -f "$REVIEW_SCRIPT" ]; then
  echo "⚠ proxima-review: script not found at \$REVIEW_SCRIPT — skipping"
  exit 0
fi

# Pass stdin (pushed refs) to the review script
# Node reads stdin to know which commits were pushed
cat - | "\$NODE_EXE" "\$REVIEW_SCRIPT" --pre-push

# Always exit 0 — never block git push
exit 0
`;
}

// ─── Install ──────────────────────────────────────────────────────────────────
function install(repoRoot) {
    const hooksDir  = path.join(repoRoot, '.git', 'hooks');
    const hookFile  = path.join(hooksDir, 'pre-push');
    const reviewScript = path.resolve(__dirname, 'proxima-review.cjs');

    if (!fs.existsSync(hooksDir)) {
        console.error(red('❌') + ' .git/hooks directory not found at: ' + hooksDir);
        console.error('   Make sure you are inside a git repository.');
        process.exit(1);
    }

    if (!fs.existsSync(reviewScript)) {
        console.error(red('❌') + ' proxima-review.cjs not found at: ' + reviewScript);
        process.exit(1);
    }

    // Back up existing hook if present and not ours
    if (fs.existsSync(hookFile)) {
        const existing = fs.readFileSync(hookFile, 'utf8');
        if (!existing.includes('proxima-review')) {
            const backupFile = hookFile + '.bak';
            fs.copyFileSync(hookFile, backupFile);
            console.log(yellow('⚠') + '  Existing pre-push hook backed up to: ' + dim(backupFile));
        } else {
            console.log(yellow('🔄') + ' Updating existing Proxima hook...');
        }
    }

    const hookContent = buildHookScript(reviewScript);
    fs.writeFileSync(hookFile, hookContent, { encoding: 'utf8' });

    // Make executable on Unix/Mac (no-op on Windows but harmless)
    try {
        fs.chmodSync(hookFile, 0o755);
    } catch { /* Windows — ignored */ }

    console.log('');
    console.log(bold('  ✅ Proxima pre-push hook installed!'));
    console.log('');
    console.log('  ' + dim('Hook location:  ') + yellow(hookFile));
    console.log('  ' + dim('Review script:  ') + yellow(reviewScript));
    console.log('  ' + dim('Review model:   ') + cyan(process.env.PROXIMA_REVIEW_MODEL || 'claude sonnet 4.6'));
    console.log('  ' + dim('Reviews saved:  ') + cyan(path.join(repoRoot, 'perplexity-reviews/')));
    console.log('');
    console.log('  ' + green('How it works:'));
    console.log('  ' + dim('  git push → hook fires → reviews queued in background'));
    console.log('  ' + dim('  Reviews appear in perplexity-reviews/<sha>.md'));
    console.log('');
    console.log('  ' + yellow('Tips:'));
    console.log('  ' + dim('  Set PROXIMA_REVIEW_MODEL env var to change the model'));
    console.log('  ' + dim('  Run manually: node cli/proxima-review.cjs <sha>'));
    console.log('  ' + dim('  Uninstall:    node cli/install-hooks.cjs --remove'));
    console.log('');
}

// ─── Remove ───────────────────────────────────────────────────────────────────
function remove(repoRoot) {
    const hookFile = path.join(repoRoot, '.git', 'hooks', 'pre-push');

    if (!fs.existsSync(hookFile)) {
        console.log(yellow('⚠') + '  No pre-push hook found at: ' + hookFile);
        return;
    }

    const content = fs.readFileSync(hookFile, 'utf8');
    if (!content.includes('proxima-review')) {
        console.log(red('❌') + ' pre-push hook exists but is not a Proxima hook — not removing.');
        console.log(dim('   Delete manually: ' + hookFile));
        return;
    }

    // Restore backup if exists
    const backupFile = hookFile + '.bak';
    if (fs.existsSync(backupFile)) {
        fs.copyFileSync(backupFile, hookFile);
        fs.unlinkSync(backupFile);
        console.log(green('✅') + ' Proxima hook removed. Previous hook restored from backup.');
    } else {
        fs.unlinkSync(hookFile);
        console.log(green('✅') + ' Proxima pre-push hook removed.');
    }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
function main() {
    const args = process.argv.slice(2);
    const isRemove = args.includes('--remove') || args.includes('-r');

    // Allow specifying a different repo with --repo /path
    const repoArgIdx = args.findIndex(a => a === '--repo');
    const repoPath   = repoArgIdx >= 0 ? args[repoArgIdx + 1] : null;
    const repoRoot   = repoPath ? findGitRoot(repoPath) : findGitRoot();

    if (!repoRoot) {
        console.error(red('❌') + ' Not inside a git repository. Run from your project folder.');
        process.exit(1);
    }

    console.log('');
    console.log(cyan('⚡') + ' Proxima Hook Installer');
    console.log(dim('   Repo: ' + repoRoot));
    console.log('');

    if (isRemove) {
        remove(repoRoot);
    } else {
        install(repoRoot);
    }
}

main();
