const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function findGitRoot() {
    try {
        return execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
    } catch {
        return process.cwd();
    }
}

const DEFAULT_CONFIG = {
    reviewDir: "/root/review",
    baseUrl: "http://localhost:3210",


    reviewModel: "chatgpt",
    repairModel: "claude",
    maxIterations: 3,
    pushBotBranches: false,
    createPullRequest: false,
    pullRequestDraft: true,
    pullRequestLabels: ["proxima-auto-fix"],
    protectedBranches: ["main", "master", "develop"],
    skipReviewBranches: ["proxima/fix-*"],
    skipReviewCommitMarkers: ["[proxima-auto-fix]"],
    testCommands: ["npm test"],
    stopOnTestFailure: true,
    allowGeneratedScripts: false,
    allowWorkflowModification: false,
    allowReviewHistoryModification: false,
    repairBranchPrefix: "proxima/fix",
    autoMerge: false
};

function loadConfig() {
    const gitRoot = findGitRoot();
    const configPath = path.join(gitRoot, 'proxima-automation.config.json');
    let userConfig = {};

    if (fs.existsSync(configPath)) {
        try {
            userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        } catch (e) {
            console.error(`Error parsing config file: ${e.message}`);
        }
    }

    // Merge env vars
    const envConfig = {
        baseUrl: process.env.PROXIMA_BASE_URL,
        reviewModel: process.env.PROXIMA_REVIEW_MODEL,
        repairModel: process.env.PROXIMA_REPAIR_MODEL,
        reviewDir: process.env.PROXIMA_REVIEW_DIR,
    };

    // Remove undefined values from envConfig
    Object.keys(envConfig).forEach(key => envConfig[key] === undefined && delete envConfig[key]);

    // Resolve reviewDir
    const config = {
        ...DEFAULT_CONFIG,
        ...userConfig,
        ...envConfig,
        gitRoot
    };

    if (!path.isAbsolute(config.reviewDir)) {
        config.reviewDir = path.resolve(gitRoot, config.reviewDir);
    }

    return config;
}


module.exports = { loadConfig, findGitRoot };
