# The Proxima orchestration loop

You are the **orchestrator**: a local coding agent. You drive a long-lived Claude
conversation on claude.ai — the **supervisor** — through **Proxima**, an Electron app
that keeps logged-in browser sessions and exposes them as MCP tools. The supervisor
plans and decides. You build and verify. One supervisor turn = one command.

Everything below is verified against the code. Paths are absolute so this works from any
project directory.

---

## 1. Roles

| Who | Runs where | Can | Cannot |
|---|---|---|---|
| **You** (orchestrator) | locally, e.g. Claude Code | run tools, read/write files, run tests, git | see the supervisor's thread except through replies |
| **Supervisor** | claude.ai, Opus 5.5 at high effort | spec, plan, choose between options, judge evidence you send | run code, read your disk, verify anything |
| **Proxima** | Electron app on this machine | relay turns, upload files, save the supervisor's files to disk | think — it is plumbing |

The supervisor **believes whatever you tell it.** It has no way to check. That is the
single most important fact about this loop.

---

## 2. Start-up (once per session)

1. **Start Proxima** from its repo root and leave it running:
   ```
   cd C:\Users\subha\Documents\PROJECTS\Proxima
   npm start
   ```
   First time only: log in to claude.ai in Proxima's Claude tab.

2. **Preflight** before any work, and again before leaving anything unattended:
   ```
   node C:/Users/subha/Documents/PROJECTS/Proxima/tools/orchestrate/preflight.cjs
   ```

   | Exit | Meaning | Action |
   |---|---|---|
   | `0` | READY | proceed |
   | `1` | NOT READY — at least one FAIL | fix the listed item first |
   | `2` | UNDETERMINED — a check could not be decided | treat as not ready; never act on a guess |

   Add `--json` for machine-readable output.

---

## 3. One supervisor turn

```
node C:/Users/subha/Documents/PROJECTS/Proxima/tools/orchestrate/supervisor.cjs --message-file turn.txt --state C:/path/to/your-project/supervisor-state.json
```

Keep commands on one line. Line continuation differs between cmd (`^`), PowerShell
(`` ` ``) and bash (`\`), and the wrong one silently splits the command.

What happens: the script spawns Proxima's MCP server, calls its `ask_claude` tool, which
sends your message to the claude.ai tab and waits for the full reply.

**Output contract**

| Channel | Contains |
|---|---|
| **stdout** | the supervisor's reply, verbatim. Last line: `_conversation_id: <uuid>_` |
| **stderr** | progress lines prefixed `[supervisor]` — thread id, turn number, seconds |
| **exit code** | `0` ok · `2` the tool reported an error (read stdout for it) · `1` transport or argument failure |

**Flags**

| Flag | Purpose |
|---|---|
| `--message-file <path>` | the turn's text. Prefer this over `--message`: no shell quoting problems |
| `--message "<text>"` | short one-line turns only |
| `--state <path>` | where the thread id is remembered. **Always pass an absolute path.** Default is `supervisor-state.json` in the current directory, which silently forks state if you change directory |
| `--new` | start a fresh thread and remember it |
| `--conversation-id <uuid or claude.ai/chat URL>` | target a specific thread; beats the state file |
| `--attach <path>` | upload a real file; repeat for several. A missing file exits `1` before anything is sent |
| `--model <id>` | default `claude-opus-5-5` |
| `--effort <low\|medium\|high\|xhigh\|max>` | default `high` |
| `--no-tag` | drop the `[PROXIMA]` prefix (see §6) |
| `--timeout-ms <n>` | default `1800000` (30 minutes) |
| `--tool <name> --arg key=value …` | call any other Proxima MCP tool instead (see §7) |

---

## 4. The cycle

```
 ┌─► 1. write turn.txt: context + EVIDENCE + one clear question
 │   2. run a supervisor turn                       (§3)
 │   3. read the reply; extract decisions and any saved files (§5)
 │   4. do the work
 │   5. VERIFY with something machine-checkable — tests, build, exit codes, a diff
 └── 6. next turn reports the RESULT of step 5, not your opinion of it
```

The first turn of a project uses `--new`. Every later turn omits it and the state file
supplies the thread.

---

## 5. Files in and out

**In — attachments.** `--attach` uploads the actual file; the supervisor reads it, not a
paraphrase. Images and PDFs are referenced by id, text and code are carried as extracted
text. Attach large or exact material (test output, diffs, specs) rather than pasting it.

**Out — artifacts.** When the supervisor writes a file, Proxima saves it to disk and the
reply gains a block like:

```
**2 artifact(s) saved to disk:**
- C:\Users\…\AppData\Roaming\proxima\claude-artifacts\…\spec.md (4210 bytes)
- C:\Users\…\AppData\Roaming\proxima\claude-artifacts\…\PRD.md (9120 bytes) [edited file, recovered from sandbox]
```

Open those paths with ordinary file tools. `[edited file, recovered from sandbox]` marks a
file the supervisor *edited* rather than created — it is the current version. To pull
files from a thread later:

```
node C:/Users/subha/Documents/PROJECTS/Proxima/tools/orchestrate/supervisor.cjs --tool claude_artifacts --arg conversation_id=<uuid>
```

---

## 6. Things that happen to every message

- **Prefixed `[PROXIMA]`** so a human reading the thread can tell your turns from theirs.
- **Suffixed** with `Current time: <ISO timestamp>`.
- **Thread continuity:** the id is saved to the state file **only when a turn succeeds**,
  so a failing turn never overwrites a good thread with a bad one.
- **A dead thread fails loudly.** If the remembered conversation no longer exists, the
  turn exits `2` saying the pinned conversation is gone. It never silently starts a new,
  empty thread. Recovering is your decision: run the next turn with `--new` and re-brief
  the supervisor.

---

## 7. Other tools (via `--tool`)

| Tool | Use |
|---|---|
| `claude_artifacts` | download files from a thread (`conversation_id`, `limit`, `include_uploads`) |
| `claude_conversation` | inspect a thread's metadata (`conversation_id`) |
| `ask_chatgpt` | second opinion from ChatGPT (`message`) |
| `ask_qwen` | Qwen 3.8, including **video** and image review (`message`, `session`) |

Exit codes match §3: `0` ok, `2` tool error, `1` transport.

**Standalone scripts** (not `--tool`; run them directly):

| Script | Use |
|---|---|
| `tools/orchestrate/chatgpt-audio.cjs --file <clip.mp3> --message "<q>"` | ChatGPT **listens** to an audio file. `ask_chatgpt` cannot: its endpoint shows the model the file but not the sound, and it answers `CANNOT_HEAR`. This script drives the real ChatGPT tab instead, so run it alone. Only mp3 has been verified. |
| `tools/orchestrate/capture.cjs --provider <name> --seconds 90` | Records what a site's app sends, as a **sanitized HAR**, from any loaded Proxima tab: chatgpt, claude, qwen, gemini, perplexity. Trigger the flow during the window. Use `--stop-file <path>` to stop it from another process. If the output still looks like it holds a secret, it writes nothing and exits `3`. |

**Response cache — only if you call these tools directly.** If your agent has Proxima
registered as its own MCP server (tools named like `mcp__proxima__ask_chatgpt`), that
server stays running, and an identical prompt sent within **5 minutes** can come back as
the cached first answer instead of a new one. `ask_claude` skips the cache whenever a
thread id, `new_chat`, model, effort or attachment is given; `ask_chatgpt` always uses
it. Change the prompt when you need a fresh answer. Calls made through `supervisor.cjs`
are never cached: it starts a fresh MCP server for every call.

---

## 8. Rules

**MUST**

- Run preflight before starting, and before any unattended stretch.
- Send **evidence, not claims**: test output, error text, diffs, exit codes. "It works" is
  not evidence, and the supervisor cannot tell the difference.
- Verify every supervisor decision independently before building on it. Two models
  agreeing is not proof.
- Keep **one state file per project**, at an absolute path, for the project's lifetime.
- Treat a reply that reads `No response received` or `No response captured` as a **failed
  turn**, even when the exit code is `0`. An empty capture is returned as that text, not
  as an error.
- Use `--new` on the very first turn; every later turn gets its thread from the state file.

**MUST NOT**

- Run two supervisor turns at the same time. Proxima drives one browser tab, so concurrent
  turns interleave and both replies come back wrong while both report success.
- Change files under Proxima's `electron/` without restarting Proxima. Until the restart,
  the old code is still running and the change looks exactly like a bug. Preflight's
  "running code is current" check catches this.
- Delete or hand-edit the state file mid-project.
- Pass relative `--state` paths.

---

## 9. When something fails

| Symptom | Cause | Do |
|---|---|---|
| exit `1`, "MCP server exited" or a connection error | Proxima not running, or crashed | start Proxima, rerun preflight |
| exit `2`, "pinned conversation … is gone" | the remembered thread was deleted | `--new`, then re-brief the supervisor |
| exit `2`, any other error | the tool rejected the call | stdout starts with `Error:` and says why |
| preflight FAIL "running code is current" | Proxima older than its source | restart Proxima |
| preflight FAIL "Claude session" | logged out of claude.ai | log in via Proxima's Claude tab |
| preflight FAIL "free memory" | under 1 GB free (8 GB machine) | close something. Below this, failures look like a dead service when they are not |
| turn hangs until the 30-minute timeout | provider stuck or machine starved | check memory, then rerun preflight |

---

## 10. Limits

- The supervisor has **no tools**. Everything it knows came from your turns.
- **One turn at a time**, strictly serial.
- "Proxima" here means the **Electron app** started with `npm start`. The headless gateway
  on the `feat/cleanroom-gateway` branch is a different runtime and cannot send messages
  yet: its provider engines are unverified scaffolds. The Electron app works on that
  branch too, since its code is identical there.
- Deeper history and provider-specific traps: `C:\Users\subha\Documents\PROJECTS\Proxima\ORCHESTRATION_HANDOFF.md`.
