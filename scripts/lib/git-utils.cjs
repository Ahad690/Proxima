const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function runCommand(cmd, args = [], options = {}) {
    const timeout = options.timeout || 60000; // Default 1 minute
    
    const res = spawnSync(cmd, args, { 
        encoding: 'utf8', 
        timeout,
        ...options 
    });
    
    if (res.error) {
        return { 
            success: false, 
            stdout: '', 
            stderr: res.error.message,
            timedOut: res.error.code === 'ETIMEDOUT' || res.status === null 
        };
    }
    
    return { 
        success: res.status === 0, 
        stdout: res.stdout ? res.stdout.trim() : '', 
        stderr: res.stderr ? res.stderr.trim() : '',
        status: res.status
    };
}

function getHeadSha() {
    return runCommand('git', ['rev-parse', 'HEAD']).stdout;
}

function getShortSha(sha) {
    return runCommand('git', ['rev-parse', '--short', sha || 'HEAD']).stdout;
}

function getCurrentBranch() {
    return runCommand('git', ['rev-parse', '--abbrev-ref', 'HEAD']).stdout;
}

function getCommitMessage(sha) {
    return runCommand('git', ['log', '-1', '--pretty=%B', sha || 'HEAD']).stdout;
}

function ensureInsideGitRepo() {
    const res = runCommand('git', ['rev-parse', '--is-inside-work-tree']);
    if (!res.success) throw new Error('Not inside a git repository');
}

function ensureCleanWorkingTree() {
    const res = runCommand('git', ['status', '--porcelain']);
    return res.success && res.stdout === '';
}

function getDirtyFiles() {
    const res = runCommand('git', ['status', '--porcelain']);
    if (!res.success) return [];
    return res.stdout.split('\n')
        .map(line => line.slice(3).trim())
        .filter(Boolean);
}

function createBranch(branchName) {
    return runCommand('git', ['checkout', '-b', branchName]);
}

function checkoutBranch(branchName) {
    return runCommand('git', ['checkout', branchName]);
}

function isProtectedBranch(branch, protectedBranches) {
    return protectedBranches.some(pattern => {
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
        return regex.test(branch);
    });
}

function isBotBranch(branch, prefix) {
    return branch.startsWith(prefix);
}

function isBotCommit(message, markers) {
    return markers.some(marker => message.includes(marker));
}

function applyPatchCheck(patchPath) {
    return runCommand('git', ['apply', '--check', '--recount', '--ignore-whitespace', patchPath]);
}

function applyPatch(patchPath) {
    return runCommand('git', ['apply', '--recount', '--ignore-whitespace', patchPath]);
}

/**
 * Parses touched file paths from a unified diff patch.
 */
function getFilesFromPatch(patchPath) {
    try {
        const content = fs.readFileSync(patchPath, 'utf8');
        const files = new Set();
        const lines = content.split('\n');
        for (const line of lines) {
            if (line.startsWith('+++ b/')) {
                files.add(line.slice(6).trim());
            } else if (line.startsWith('--- a/')) {
                // Also track deletions/modifications
                const file = line.slice(6).trim();
                if (file !== '/dev/null') files.add(file);
            }
        }
        return Array.from(files);
    } catch (e) {
        return [];
    }
}

/**
 * Stages only specific files and commits them.
 */
function commitPatchFiles(message, files) {
    if (!files || files.length === 0) {
        return { success: false, stderr: 'No files to commit' };
    }
    
    const addRes = runCommand('git', ['add', ...files]);
    if (!addRes.success) return addRes;
    
    return runCommand('git', ['commit', '-m', message]);
}

function pushBranch(branchName) {
    return runCommand('git', ['push', 'origin', branchName]);
}

function createPullRequest({ title, body, labels, draft, bodyFile }) {
    const args = ['pr', 'create', '--title', title];
    
    if (bodyFile) {
        args.push('--body-file', bodyFile);
    } else {
        args.push('--body', body);
    }
    
    if (draft) args.push('--draft');
    if (labels && labels.length > 0) {
        args.push('--label', labels.join(','));
    }
    
    return runCommand('gh', args);
}

module.exports = {
    runCommand,
    getHeadSha,
    getShortSha,
    getCurrentBranch,
    getCommitMessage,
    ensureInsideGitRepo,
    ensureCleanWorkingTree,
    getDirtyFiles,
    createBranch,
    checkoutBranch,
    isProtectedBranch,
    isBotBranch,
    isBotCommit,
    applyPatchCheck,
    applyPatch,
    getFilesFromPatch,
    commitPatchFiles,
    pushBranch,
    createPullRequest
};
