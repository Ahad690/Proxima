# Proxima Claude orchestration loop

A self-contained guide to using a Claude subscription as a **supervisor** while a local
coding agent does the tool work. Everything here is verified against the code in this
repository — mainly `tools/orchestrate/supervisor.cjs`, `src/mcp-server-v3.js`, and
`tools/orchestrate/preflight.cjs`. Where a flag or behaviour does not exist, this guide
says so instead of inventing one.

Proxima is a local Electron app that keeps logged-in AI provider sessions in real browser
tabs and exposes them as MCP tools. This guide uses only its Claude tab and the
`ask_claude` tool.

**Repository:** <https://github.com/Ahad690/Proxima> — clone it before starting if you
do not already have it. This fork carries the provider work documented here; the upstream
repository does not.

---

## TL;DR

The loop has two roles:

- **Executor** — the agent with tools. It reads files, edits code, runs tests, deploys,
  and collects evidence. OpenCode, Claude Code, or any other tool-using agent can do this.
- **Supervisor** — a long-lived claude.ai conversation. It plans, chooses between
  options, and reviews evidence. It has **no access to your machine** and cannot verify
  anything itself.

`tools/orchestrate/supervisor.cjs` sends one message to the supervisor and prints the
reply. The executor calls it only at **checkpoints** — after a phase is complete, when a
decision is needed, or when something failed — not once per tool call.

That shape is the saving: the executor can run for an hour of tool calls, and Claude is
invoked once or twice to steer it.

---

## Architecture

```
┌──────────────────────────────────────┐
│ Executor                             │
│ (OpenCode, Claude Code, any agent)   │
│ reads, edits, tests, deploys, collects│
└──────────────────┬───────────────────┘
                   │ 1. writes turn.md
                   │ 2. runs one supervisor command
                   ▼
┌──────────────────────────────────────┐         ┌────────────────────────────┐
│ tools/orchestrate/supervisor.cjs     │◀────────│ supervisor-state.json      │
│  --message-file turn.md              │         │ { conversationId, turns,   │
│  --attach report.md --attach ev.json │         │   updatedAt }              │
│  --state ./supervisor-state.json     │         └────────────────────────────┘
└──────────────────┬───────────────────┘
                   │ 3. spawns `node src/mcp-server-v3.js`
                   │    over stdio, calls the `ask_claude` tool
                   ▼
┌──────────────────────────────────────┐
│ MCP server (one process per call)    │
│   ask_claude(message, attachments,   │
│              conversation_id, ...)   │
└──────────────────┬───────────────────┘
                   │ 4. local IPC
                   ▼
┌──────────────────────────────────────┐
│ Proxima (Electron app)               │
│ drives the logged-in claude.ai tab   │
└──────────────────┬───────────────────┘
                   │ 5. real browser session
                   ▼
┌──────────────────────────────────────┐
│ Claude — the supervisor              │
│ no access to your machine            │
└──────────────────┬───────────────────┘
                   │ 6. reply, ending with
                   │    `_conversation_id: <uuid>_`
                   ▼
     stdout → executor          stderr → progress/diagnostics
     state file updated only when the turn succeeds
```

Attachments enter at step 2. `--attach` paths are resolved and existence-checked before
the call, then passed to `ask_claude` as real uploads.

---

## Why it is cheaper

Claude usage is consumed per turn, not by how much work the executor did between turns.

- **Per-tool-call supervision** — every read, edit, test run, and retry becomes a Claude
  message. Forty tool calls means forty Claude turns.
- **Checkpoint supervision** — you batch the same work into a handful of reports. Forty
  tool calls might become four Claude turns: plan, mid-phase correction, failure triage,
  final review.

A worked example (illustrative, not a benchmark):

| Step | Executor work | Claude turns |
|---|---|---|
| 1 | Read the repo, map the change, write a plan | 1 — approve or revise the plan |
| 2 | Implement across 12 files, run tests, fix 3 failures | 0 |
| 3 | Attach the diff, test output, and failure log | 1 — decide whether to continue or change approach |
| 4 | Finish, run the full suite, capture evidence | 1 — final review |
| **Total** | ~40 tool calls | **3** |

The saving is proportional to how much of the loop you keep local. There is no benchmark
in this repository that predicts a percentage; treat any specific number as an estimate.

Two properties make it work:

1. **The executor owns verification.** Tests, exit codes, diffs, and logs are collected
   locally. The supervisor only judges the evidence it is handed.
2. **The thread persists.** The conversation id is written to a state file, so a restart
   or tab reload does not throw away everything the supervisor knew.

---

## Prerequisites

| Requirement | Why | Verify with |
|---|---|---|
| A Claude subscription with claude.ai access | The supervisor is a real claude.ai conversation, not the API | Log in at claude.ai in a normal browser first |
| Proxima cloned | `supervisor.cjs` and the MCP server live here | `git rev-parse --show-toplevel` |
| Node.js 18 or newer | Runs the supervisor and the MCP server | `node -v` |
| Dependencies installed | `@modelcontextprotocol/sdk`, `zod`, `ws` | `npm install` in the repo root |
| Proxima running | It owns the logged-in browser tab | `npm start`, then leave the window running |
| Claude logged in **inside Proxima** | The session is the one Proxima drives | Open the Claude tab in Proxima |
| Orchestration preflight passes | Catches a stale process, a dead socket, a logged-out tab | `node tools/orchestrate/preflight.cjs` |

### Get the repository

```bash
git clone https://github.com/Ahad690/Proxima.git
cd Proxima
git checkout ahad/provider-work   # the branch that carries this work
npm install
```

The fork's default branch is behind; `ahad/provider-work` is the branch this guide was
written against. If the work has since been merged into `main`, the checkout can be
omitted. Every command in this guide is relative to the repository root.

### About the MCP configuration

You do **not** need to register Proxima as an MCP server in your editor to use
`supervisor.cjs`. The script spawns `src/mcp-server-v3.js` itself and speaks MCP over
stdio (`mcpCall` in `supervisor.cjs`). Registering Proxima in your editor is only needed
if you want the MCP tools available directly to the executor.

Because each supervisor invocation starts its own MCP server process, the MCP server's
in-process response cache does not carry across turns.

### Preflight

```bash
node tools/orchestrate/preflight.cjs
```

Exit codes are explicit in `preflight.cjs`: `0` means every check passed, `1` means at least
one FAIL, and `2` means at least one check could not be decided — treat `2` as not ready.
Add `--json` for machine-readable output. Preflight checks free memory, the Proxima IPC
socket and port discovery, whether the running process is older than the source on disk,
the Claude session and engine build, the Qwen engine and its signing/WAF state, the MCP
tool surface, ffmpeg/ffprobe and the `ws` module, the Chrome debug port, and
artifact-directory writability.

Run it before an unattended stretch, not only at the start. A source change that has not
been reloaded into the running Electron process behaves exactly like a broken feature.

---

## Quickstart

The smallest working sequence. Run these from the repository root, or use absolute paths.

### 1. Start Proxima and log in

```bash
npm start
```

Leave it running. Open the Claude tab in Proxima and log in to claude.ai.

### 2. Run preflight

```bash
node tools/orchestrate/preflight.cjs
```

Do not continue while it reports a FAIL.

### 3. Write the first checkpoint

Create a file named `turn1.md` in your project directory. At minimum:

```markdown
# Checkpoint 1 — plan

## Goal
Add rate limiting to the public API.

## Current state
Read the routes and middleware. No code changed yet.

## Evidence
- `src/server.js` (read)
- `src/middleware/` (read)

## Decision needed
Choose between a fixed-window in-memory limiter and a Redis-backed sliding window.
Constraints: single process today, but a second instance is planned this quarter.
```

### 4. Send the first turn

```bash
node tools/orchestrate/supervisor.cjs \
  --message-file turn1.md \
  --new \
  --state ./supervisor-state.json \
  > reply1.md
```

- `--new` starts a fresh thread.
- `--state` is where the conversation id is remembered.
- `>` captures the reply; progress lines still go to stderr.

On Windows PowerShell, keep the command on one line — `\` is not a continuation
character there.

### 5. Read the reply

```bash
cat reply1.md
```

The reply contains the thread id near the end (a generated-media block, if any, can follow
it):

```
_conversation_id: 00000000-0000-0000-0000-000000000000_
```

You do not need to copy it. It is already in `supervisor-state.json`.

### 6. Continue the thread

Write `turn2.md`, then omit `--new`:

```bash
node tools/orchestrate/supervisor.cjs \
  --message-file turn2.md \
  --state ./supervisor-state.json \
  > reply2.md
```

The state file supplies the conversation id. Repeating `--new` would start over and lose
the supervisor's context.

### 7. Attach evidence

```bash
node tools/orchestrate/supervisor.cjs \
  --message-file turn3.md \
  --attach ./artifacts/diff.patch \
  --attach ./artifacts/test-output.txt \
  --state ./supervisor-state.json \
  > reply3.md
```

That is the whole loop. Everything below is refinement.

---

## The message contract

A checkpoint is a report, not a conversation. The supervisor cannot inspect your disk, so
anything you leave out is simply unknown to it.

Include, in this order:

1. **Goal** — the outcome the whole task is serving.
2. **What changed** — files, behaviour, and anything you deliberately did not do.
3. **Exact evidence paths** — the files you attached, by path. Not "tests pass".
4. **Tests and deploys** — the command, the exit code, and the relevant tail of output.
5. **Open questions** — what you are uncertain about, ranked.
6. **The decision you want** — one clear question, with the options and constraints.

### Template

```markdown
# Checkpoint <n> — <phase name>

## Goal
<one paragraph: the outcome this phase serves>

## What changed
- <file>: <behaviour change>
- <file>: <behaviour change>
- Not changed: <anything intentionally left alone>

## Evidence
- `./artifacts/diff.patch` — `git diff` for this phase
- `./artifacts/test-output.txt` — full test run, exit code <n>
- `./artifacts/build.log` — build output, exit code <n>
- `./artifacts/screenshot.png` — <what it shows>

## Verification
- Command: `<exact command>`
- Result: <exit code>, <pass/fail counts>
- Deploy: <not deployed | deployed to staging | deployed to production>

## Open questions
1. <question>
2. <question>

## Decision needed
<one question>. Options: <A> or <B>. Constraints: <what must not break>.
```

Two rules make this work:

- **Put the evidence in files and attach them.** A path in prose is a claim; an attached
  file is something the supervisor can read.
- **Ask for one decision per checkpoint.** A report with five unrelated questions gets a
  reply that answers two of them.

---

## Attachments

`--attach` is the only supported way to give the supervisor real evidence.

```bash
node tools/orchestrate/supervisor.cjs \
  --message-file turn.md \
  --attach ./report.md \
  --attach ./evidence.json \
  --attach ./screenshot.png \
  --state ./supervisor-state.json
```

What the code does:

- Each `--attach` value is passed through `path.resolve`, so a relative path is resolved
  against the **current working directory**, not against the message file.
- Before anything is sent, every path is checked with `fs.existsSync`. A missing file
  prints `attachment not found: …` to stderr and exits `1`.
- The surviving paths are passed to the MCP `ask_claude` tool as `attachments`.
- `ask_claude` uploads them as real attachments before sending the message. Images and
  PDFs are referenced by id; plain-text and code files are carried inline as extracted
  text. A failed upload fails the call rather than quietly sending a text-only turn.

### Why inline summaries are not enough

The supervisor has no access to your machine. If you write "the tests pass", it can only
believe you. If you attach `test-output.txt`, it can see the command, the exit code, and
the failure names. The difference is not politeness — it is the only channel through which
the supervisor can check anything.

Attach:

- `git diff` output as a `.patch` or `.diff` file
- test / build / lint output with the command and exit code visible
- stack traces and logs
- screenshots or recordings of UI behaviour
- spec and design documents the work is measured against

Do not attach a file and then paraphrase it in the message. Let the file speak.

---

## State and threads

The state file is a small JSON document:

```json
{
  "conversationId": "00000000-0000-0000-0000-000000000000",
  "turns": 4,
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

`supervisor.cjs` sets `--state` to `supervisor-state.json` in the **current working
directory** when you omit it. That default silently forks your thread if you change
directory between calls, so pass an absolute path or always run from the same project
root.

### Thread selection

The order is explicit in the code:

1. `--new` wins over everything. It sends `new_chat: true` and ignores the remembered id;
   on success it replaces the stored id with the new thread's.
2. `--conversation-id <uuid|url>` is used next if given.
3. Otherwise the `conversationId` from the state file is used.

`ask_claude` accepts a bare uuid or a full `https://claude.ai/chat/<uuid>` URL, and the
supervisor passes the value through unchanged. A conversation can be resumed cold, after
a Proxima restart, and keeps its history.

### What each flag does

| Flag | Behaviour |
|---|---|
| `--message-file <path>` | Reads the turn text from a file. Preferred: no shell quoting problems. |
| `--message "<text>"` | Uses the literal string. Fine for one-liners, fragile for reports. |
| `--attach <path>` | Uploads a file. Repeat for multiple. Missing file exits `1` before sending. |
| `--conversation-id <uuid\|url>` | Targets a specific thread. Beats the state file. |
| `--new` | Starts a fresh thread and records its id when the turn succeeds. |
| `--state <path>` | Where the thread id is stored. Default: `./supervisor-state.json`. |
| `--model <id>` | Explicit model, forwarded to `ask_claude`. Disables the configured fallback. Omit to use `models.json`. |
| `--effort <low\|medium\|high\|xhigh\|max>` | Forwarded to `ask_claude`. Defaults to the effort in `models.json` (currently `high`). |
| `--timeout-ms <n>` | MCP call timeout. Default `1800000` (30 minutes). |
| `--no-tag` | Suppresses the `[PROXIMA]` prefix that is otherwise added to the message. |
| `--tool <name> --arg key=value` | Calls another Proxima MCP tool instead of `ask_claude`. |

### Model selection

All provider chains live in `models.json` at the repository root. Claude's section is:

```json
{
  "claude": {
    "effort": "high",
    "autoLatest": true,
    "models": ["claude-mythos-5-2", "claude-opus-5-5"]
  }
}
```

Within a family, the highest `major.minor` is tried first. In Proxima's **Settings**
page, choose the Claude primary and fallback; the default is Mythos 5.2 with Opus 5.5
as the fallback. Selecting **Auto** makes the first family in `models.json` the default.
The engine advances to the next entry only when the API returns
`403 permission_error/model_not_available`; a
generic 403 (auth or session) is surfaced immediately, and an explicit `--model` disables
the chain entirely. The `chatgpt` and `qwen` sections use the same ordering and the same
last-known-working fallback; Gemini and Perplexity do not accept a model chain.

`autoLatest` uses the official Anthropic Models API (`GET /v1/models`) when
`ANTHROPIC_API_KEY` is set, replacing each family's configured id with the newest active
one. That is a Console API key, not the claude.ai session. The claude.ai web session has
**no models-list endpoint** — a capture of the Mythos 5.2 picker contains no models
request — which is why the file remains the source of truth when no key is present.
`claude-mythos-5-2` is wire-confirmed from that capture: both the completion request and
`message_start` carried it.

Check the resolved chain, or write the API result back to the `claude` section only:

```bash
npm run claude:models
npm run claude:models -- --write
```

`PROXIMA_MODELS` overrides the path, and a `models.json` in Proxima's user-data directory
wins over the repo copy. Changes are read at startup and on the six-hour refresh; restart
Proxima to apply them immediately.

### Flags that do **not** exist

- **`--tag`** — not implemented. Only `--no-tag` exists. The MCP tool itself accepts
  `tag: false`; the supervisor exposes that as `--no-tag`.
- **`--thinking-mode`** — not implemented in `supervisor.cjs`, even though `ask_claude`
  accepts a `thinking_mode` argument. Use
  `--tool ask_claude --arg message="..." --arg thinking_mode=extended` if you need it.
- **`--json`** — not implemented. The reply is plain text on stdout.
- **`--resume`** — not implemented. Resuming is the default; `--conversation-id` overrides
  the state file.

### When the state is written

The id is persisted **only when the turn succeeds** — `learned && !res.isError`. This is
deliberate: a failed call must not overwrite a good thread with a dead id. A failed turn
does not increment `turns` either.

The id is learned from the `_conversation_id` marker in the reply:

```
_conversation_id: <uuid>_
```

`ask_claude` appends that marker when it has a conversation id to report. If a first turn
with `--new` returns a reply without the marker, nothing is written: the next call has no
remembered id and sends without pinning a thread.

### Recovering a thread

- **You know the uuid or URL** — pass `--conversation-id`. It wins over the state file.
- **You lost the state file** — open the conversation on claude.ai, copy the uuid from the
  URL, and pass it once. The next successful turn writes it back to the state file.
- **The thread was deleted** — the call fails with exit `2` rather than silently starting a
  blank thread. Run with `--new` and re-brief the supervisor; it no longer knows anything.

---

## The supervision protocol

These are conventions, not code enforcement. The script will happily send a bad report.

### Report at phase boundaries

Send a checkpoint when:

- a plan is ready and implementation has not started
- a phase is complete and verified
- a decision blocks progress
- something failed in a way you cannot classify
- you are about to touch production

Do not send a checkpoint for every file read. That recreates the cost you are trying to
avoid.

### Never claim success without evidence

"Done" and "tests pass" are claims. Attach the command output and the exit code. If you
cannot produce evidence, say what you could not verify.

### Treat "stop work" as binding

If the supervisor says stop, stop. Do not reinterpret it as "stop after this one more
thing." The supervisor is the decision-maker in this loop; the executor is not entitled to
overrule it because the next step looks obvious.

### Keep a decision log

Write each supervisor decision to a file the executor reads at the start of every phase:

```markdown
## Decision log

| # | Date | Decision | Evidence used | Status |
|---|---|---|---|---|
| 1 | 2026-01-01 | Use Redis sliding window | `artifacts/load-test.txt` | implemented |
| 2 | 2026-01-01 | Do not add a second instance yet | `artifacts/plan.md` | open |
```

This survives context loss, makes the next checkpoint cheaper, and gives you something to
check when two decisions later conflict.

### Verify the supervisor independently

The supervisor cannot run code. If it says "this should work", the executor still has to
run it. Two models agreeing is not evidence.

---

## Safety

The supervisor reads everything you attach, and attachments leave your machine for
Anthropic's service. Treat every attachment as a publication.

**Never attach:**

- `.env` files, API keys, tokens, cookies, session ids
- private keys, certificates, credential stores
- customer or personal data, email addresses, phone numbers
- production database dumps or raw logs containing any of the above
- internal URLs that embed credentials

**Redact before attaching.** Prefer a purpose-built evidence file:

```bash
git diff > artifacts/diff.patch

# example: substitute your project's test command
npm test > artifacts/test-output.txt 2>&1
echo "exit=$?" >> artifacts/test-output.txt
```

If a log contains a secret, copy the relevant lines into a new file and replace the value
with `<redacted>` before attaching.

**Production changes need explicit approval.** State the target, the command, the rollback,
and the blast radius in the checkpoint. Do not deploy because a previous checkpoint
approved a different change.

**Keep the state file out of version control** if it contains a real conversation id.
`supervisor-state.json` is not a secret in the credential sense, but it is a handle to a
private thread.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `MCP server exited (1) before answering` | The MCP server could not start, or Proxima is not reachable | Run `node tools/orchestrate/preflight.cjs`; fix the first FAIL |
| `MCP call timed out after 1800000ms` | Provider stuck, tab wedged, or machine starved | Check memory and the Proxima tab; raise `--timeout-ms` only after diagnosing |
| `attachment not found: <path>` | Relative paths resolve against the current directory | Use an absolute path, or `cd` to the project root first |
| Exit `2`, stdout starts with `Error:` | The MCP tool rejected the call | Read stdout; it names the failure |
| Exit `2`, "pinned conversation … is gone" | The remembered thread was deleted | Re-run with `--new` and re-brief |
| Exit `0` but the reply says `No response received` or `No response captured` | The capture was empty | Treat the turn as failed; re-run after checking the Claude tab |
| First turn works but the state file stays empty | The reply had no `_conversation_id` marker | Check the reply tail; verify the Claude tab is logged in and the turn succeeded |
| Long reply is cut off | stdout stalled on a full pipe | Look for `[supervisor] stdout stalled after …` on stderr; redirect to a file instead of a terminal buffer |
| Two turns produce interleaved or wrong replies | Two supervisor calls ran at once against one browser tab | Serialize them; there is no lock in `supervisor.cjs` |
| Message arrives without the `[PROXIMA]` prefix | `--no-tag` was used, or the tool default changed | Expected when `--no-tag` is set |

### Capturing the reply to a file

```bash
node tools/orchestrate/supervisor.cjs \
  --message-file turn.md \
  --state ./supervisor-state.json \
  > reply.md 2> supervisor.log
```

- `reply.md` is the supervisor's text, verbatim.
- `supervisor.log` holds the `[supervisor]` progress lines: thread id, turn number,
  elapsed seconds, and any error.

On Windows PowerShell, `>` may write UTF-16 depending on the shell version. If the file
looks wrong, use:

```powershell
node tools/orchestrate/supervisor.cjs --message-file turn.md --state .\supervisor-state.json |
  Out-File -Encoding utf8 reply.md
```

The script writes stdout synchronously with a bounded retry on `EAGAIN`, specifically so a
long reply is not truncated by `process.exit`. If the pipe is still stalled after five
seconds it says so on stderr rather than losing the tail silently.

---

## Copy-paste templates

### Executor checkpoint

```markdown
# Checkpoint <n> — <phase>

## Goal
<the outcome this phase serves>

## What changed
- <path>: <change>
- <path>: <change>
- Not changed: <intentional omissions>

## Evidence (attached)
- `./artifacts/diff.patch` — diff for this phase
- `./artifacts/test-output.txt` — `<command>`, exit <n>
- `./artifacts/build.log` — `<command>`, exit <n>

## Verification
- Tests: <pass/fail counts>, exit <n>
- Build: exit <n>
- Deploy: <none | staging | production>

## Open questions
1. <question>

## Decision needed
<one question>. Options: <A>, <B>. Constraints: <what must not break>.
```

### Supervisor assignment

```markdown
# Assignment <n> — <phase>

## Context
<what the executor is building, and why>

## Evidence received
<list the attachments and what each one shows>

## Your decision
<approve | revise | stop>

## Rules for the next phase
- <constraint>
- <constraint>

## What to send back
A short decision, the reasoning, and the exact next checkpoint you want.
```

---

## FAQ

**Do I need Claude Code running?**
No. The supervisor is a claude.ai conversation driven through Proxima's browser tab. The
executor can be OpenCode, Claude Code, a shell script, or anything else that can write a
message file and run one command.

**Does the supervisor execute code?**
No. It has no access to your machine: no shell, no filesystem, no repository. It sees the
message and the attachments and nothing else. Every claim about the repository is
something the executor told it.

**Does this need an API key?**
No. Proxima uses the browser session you already logged in with. That is also why the
Claude tab must stay logged in.

**How much usage does this save?**
There is no measured benchmark in this repository. The saving comes from the shape: one
Claude turn per checkpoint instead of one per tool call. If a task takes forty tool calls
and four checkpoints, you have removed thirty-six Claude turns. The exact number depends
on how much verification you keep local.

**Can I use another executor?**
Yes. The contract is files and exit codes: write a message file, run `supervisor.cjs`,
read stdout. Any agent or script that can do those three things can drive the loop.

**Can I run two supervisors at once?**
Not against the same Proxima instance. There is one browser tab and no lock in the
supervisor script; concurrent turns interleave and both replies can be wrong while both
report success. Serialize them.

**Can the supervisor write files?**
`ask_claude` saves artifacts the model produces and appends their local paths to the
reply. Pull them later with:

```bash
node tools/orchestrate/supervisor.cjs \
  --tool claude_artifacts \
  --arg conversation_id=<uuid>
```

**Where do I read more?**
- `ORCHESTRATION_HANDOFF.md` — provider-specific traps and the QA video-review loop
- `tools/orchestrate/preflight.cjs` — exactly what readiness is checked
