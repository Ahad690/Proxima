# Proxima Code Review Pipeline

## Overview

The Proxima review pipeline automatically reviews git commits using an LLM (ChatGPT or Perplexity). It can be triggered manually or automatically via a pre-push git hook.

## Triggering Reviews

### Manual Run
```bash
node C:\Users\subha\Documents\PROJECTS\Proxima\cli\proxima-review.cjs HEAD
node C:\Users\subha\Documents\PROJECTS\Proxima\cli\proxima-review.cjs <commit-sha>
```

### Automatic (Pre-push Hook)
The script reads commit SHAs from stdin when triggered by git's pre-push hook. It spawns background processes to review each new commit without blocking the push.

## Pipeline Flow

```
1. Get commit info (sha, shortSha, msg, author, date)
2. Skip maintenance/chore commits (save quota)
3. Check if review already exists (root or resolved folder)
4. Acquire lock (prevent concurrent reviews)
5. Get git diff (limited to 2MB)
6. Send diff + adversarial prompt to LLM via IPC
7. Save review to perplexity-reviews/<shortSha>.md
8. Release lock
```

## IPC Communication

- **Protocol**: TCP socket on port 19222 (direct IPC to Proxima Agent Hub)
- **ChatGPT**: `sendMessage` with `{ message, model }`
- **Perplexity**: `sendMessage` with `{ message, modelPreference, deepSearch: false }`

## Review Model Configuration

Set via environment variable `PROXIMA_REVIEW_MODEL`:
- `gpt-*` → routes to ChatGPT
- `claude *` → routes to Perplexity (via Claude)
- anything else → routes to Perplexity

Default: `gpt-5-5-thinking`

## The Adversarial Prompt

The LLM is instructed to act as a **hostile, adversarial code auditor** with these rules:

1. **Never trust the commit message** — treat it as a hypothesis to be tested
2. **Do NOT mirror the commit message** — summarize what the code actually does
3. **Assume the author is wrong** until code proves otherwise
4. **Generic advice is forbidden** — every point must cite specific lines
5. **Use web search** to verify API contracts and security advisories

### Required Sections in Review:
- **Verdict**: PASS / FAIL / NEEDS WORK
- **Implementation vs Intent Gap**: Divergences between stated intent and actual code
- **Bugs & Failure Modes**: Table with file:line, severity, finding, evidence
- **Missing Changes**: Related code that should have been updated
- **Security & Data Integrity**: Worst-case impact if code is wrong
- **Score**: X/10 with justification

## Output

Reviews are saved to:
- `<repo-root>/perplexity-reviews/<shortSha>.md` — new reviews
- `<repo-root>/perplexity-reviews/resolved/<shortSha>.md` — resolved/archived reviews
- `<repo-root>/perplexity-reviews/error-<shortSha>.md` — failed reviews
- `<repo-root>/perplexity-reviews/background.log` — background process logs

## Lock Mechanism

- Universal lock file in `~/.proxima-review.lock`
- Prevents cross-project Hub overloading
- 15-minute stale timeout
- Retries for up to 60 minutes if lock is held