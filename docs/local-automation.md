# Proxima Local Automation Workflow

This document describes the automated code review and repair workflow that runs locally on your machine.

## Overview

Proxima's local automation workflow is designed to be local-first, avoiding external API keys and using your existing browser sessions. It automates the process of reviewing commits, generating fixes (as patches), and validating them on a local bot branch.

### Key Principles

- **Local-Only**: No GitHub Actions or external cloud runners required.
- **No API Keys**: Uses Proxima's local REST API (which utilizes your logged-in browser sessions).
- **Safe Execution**: AI-generated fixes are applied only as unified diff patches after a `git apply --check` validation.
- **Iterative**: The workflow can run multiple iterations (default 3) until tests pass and no critical/high issues remain.
- **Human-in-the-loop**: Bot branches are pushed to GitHub for final review and merge by a human or Cursor.

## Architecture

The automation consists of three main components:

1.  **Reviewer (`cli/proxima-review.cjs`)**: Performs the initial code audit.
2.  **Repairer (`scripts/proxima-repair.cjs`)**: Generates a unified diff patch based on the review findings.
3.  **Orchestrator (`scripts/proxima-loop.cjs`)**: Manages the end-to-end loop (test -> review -> repair -> apply -> test -> commit -> push).

## Setup

1.  **Ensure Proxima is running**: The automation requires the Proxima Agent Hub to be active.
2.  **Enable REST API**: The repairer communicates with Proxima via `http://localhost:3210`.
3.  **Install Dependencies**: Ensure you have run `npm install`.
4.  **Configuration**: Customize the behavior in `proxima-automation.config.json`.
    - Set `"enableAutoFix": false` for review-only mode (default).
    - Set `"enableAutoFix": true` to enable repair/retry automation.

## Usage

Run the automation from the root of your repository:

```bash
# Run local review (default: review-only, no auto-fix)
npm run loop:local

# Run loop and push the bot branch to GitHub (only relevant when auto-fix is enabled)
npm run loop:local:push

# Run loop, push branch, and create a draft Pull Request (requires 'gh' CLI)
# (only relevant when auto-fix is enabled)
npm run loop:local:pr

# Force auto-fix for this run even if config has enableAutoFix=false
node scripts/proxima-loop.cjs --auto-fix
```

## Bot Branches and Commits

- **Branch format**: `proxima/fix-<shortSha>-iter-<n>`
- **Commit message**: `fix: address Proxima review <shortSha> [proxima-auto-fix]`

**Note**: Automatic reviews are automatically skipped for branches matching `proxima/fix-*` and commits containing `[proxima-auto-fix]`.

## Recovery and Troubleshooting

- **Proxima Unavailable**: If the Agent Hub is not running, the script will exit with an error and update `status.json`.
- **Patch Failed**: If a generated patch cannot be applied cleanly, the script stops and saves the error to `repair/apply.log`.
- **Tests Failed**: If tests fail after a patch is applied, the script will record the failure in `repair/test.log` and stop the current iteration.
- **Max Iterations**: If the issues are not resolved after the configured `maxIterations`, the script exits with `max-iterations-reached` status.

Check the `status.json` file in `/root/review/<shortSha>/` for detailed execution state.
