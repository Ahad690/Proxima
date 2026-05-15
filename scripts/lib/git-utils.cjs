const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function runCommand(cmd, args = [], options = {}) {
    const res = spawnSync(cmd, args, { 
        encoding: 'utf8', 
        ...options 
    });
    
    if (res.error) {
        return { success: false, stdout: '', stderr: res.error.message };
    }
    
    return { 
        success: res.status === 0, 
        stdout: res.stdout ? res.stdout.trim() : '', 
        stderr: res.stderr ? res.stderr.trim() : '' 
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
    return runCommand('git', ['apply', '--check', patchPath]);
}

function applyPatch(patchPath) {
    return runCommand('git', ['apply', patchPath]);
}

function commitAll(message) {
    const addRes = runCommand('git', ['add', '.']);
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
    createBranch,
    checkoutBranch,
    isProtectedBranch,
    isBotBranch,
    isBotCommit,
    applyPatchCheck,
    applyPatch,
    commitAll,
    pushBranch,
    createPullRequest
};
