# Proxima orchestration — agent handoff

You are inheriting a working setup for **agent-to-agent orchestration**. A local coding
agent (you) builds and verifies; a Claude thread running in a real browser acts as
supervisor and makes design decisions; a second model reviews screen recordings of the
result. Nothing in this loop needs a human relay.

Read this whole file before acting. It carries facts that were expensive to learn and are
not discoverable from the code.

**Repo:** `C:\Users\subha\Documents\PROJECTS\Proxima` (branch `ahad/provider-work`)

---

## 0. Prerequisites — run this before anything, and before going AFK

```bash
node C:/Users/subha/Documents/PROJECTS/Proxima/tools/orchestrate/preflight.cjs
```

Exit 0 = ready. Exit 1 = at least one FAIL; do not start an unattended run. Add `--json`
for machine-readable output.

It checks twelve things: the Proxima IPC socket, whether the running process is older
than the source on disk, the Claude session and engine build, the Qwen engine, Qwen's
anti-bot signing and CAPTCHA state, the MCP tool surface, ffmpeg/ffprobe, the `ws`
module, the Chrome debug port, and that the artifact directory is writable.

### What the failures mean

| FAIL | What to do |
|---|---|
| **Proxima IPC not reachable** | Proxima isn't running. Start it. Nothing else works. |
| **running code is current** | Source changed after the process started. **Restart Proxima.** See §1. |
| **Claude session** | Not logged in. Open the Claude tab in Proxima and log in. |
| **Claude/Qwen engine build** | Injected engine is older than source — restart Proxima. |
| **Qwen WAF** | A CAPTCHA is pending. Open the Qwen tab, solve the slider, or reload it. Until then sends hang for *minutes*. |
| **Qwen signing** | The Alibaba SDK hasn't booted. Reload the Qwen tab and wait ~10s. Unsigned requests *cause* the CAPTCHA above. |
| **MCP tools** | The MCP server won't start or is missing tools. Run it by hand to see the error. |

WARNs never block. The Chrome one is expected unless you're about to record video.

### The failure that will waste your time if you skip this

**Anything in the Electron main process only takes effect on restart**, and a
not-yet-reloaded change behaves *identically* to a broken feature. This has burned hours
repeatedly. The preflight's staleness check exists solely to tell those two apart.

- `electron/**` and `src/mcp-server-v3.js` engine files → **need a Proxima restart**
- `src/mcp-server-v3.js` **tool definitions** → no restart; the MCP server is spawned per call
- `tools/**` scripts → no restart

---

## 1. Topology

```
  you (Claude Code, local)                         supervisor (claude.ai in a browser)
  tools, files, git                                design decisions, no tools
        │                                                        ▲
        │  tools/orchestrate/supervisor.cjs                      │
        ▼                                                        │
  MCP server (spawned per call)  ──stdio──▶  ask_claude  ──IPC──▶ Proxima ──▶ browser tab
        │
        ├── ask_qwen ─────────▶ Qwen 3.8 (video/image/doc analysis)
        └── claude_artifacts ─▶ files the supervisor wrote, pulled to disk
```

The supervisor **cannot verify anything** — it only sees what you send. That asymmetry is
the whole reason the loop needs an independent falsifier (§4).

---

## 2. Running a supervisor turn

```bash
S=C:/Users/subha/Documents/PROJECTS/Proxima/tools/orchestrate/supervisor.cjs

# first turn — creates the thread and records its id
node $S --message-file turn1.txt --new --state ./supervisor-state.json

# every turn after — resumes the remembered thread
node $S --message-file turn2.txt --state ./supervisor-state.json

# with files attached (real uploads; the model reads them)
node $S --message-file turn3.txt --attach ./report.md --attach ./review.json \
        --state ./supervisor-state.json

# call any other Proxima MCP tool
node $S --tool claude_artifacts --arg conversation_id=<uuid>
node $S --tool ask_qwen --arg "message=..." --arg session=orchestrator
```

Thread selection is layered: `--conversation-id` wins, then the state file, and `--new`
overrides both. Exit codes: `0` ok, `2` the tool reported an error, `1` transport failure.

**Keep the state file.** Claude's conversation id lives in memory in the page, so a tab
reload silently starts a fresh thread and the supervisor loses everything it knew. The
state file plus the explicit id is what survives that.

---

## 3. What the supervisor is good at, and what it is not

Good: writing a precise spec, choosing between options, revising a design when you bring
it evidence. In one run it produced a 12-point mechanic spec with a testable acceptance
checklist, then correctly rejected one of my proposed fixes as a logical no-op.

Not good: anything requiring verification. It has no tools and no filesystem. **Send it
artifacts, not claims** — test output, a diff, a review verdict. If you tell it something
worked, it will believe you.

---

## 4. The independent falsifier — do not skip it

Two models agreeing is not evidence. Every real defect in this project's history was found
by *checking*, not by reasoning. Anchor each cycle to something machine-checkable:

```bash
npm run test:automation                   # offline suite, must stay green
node scripts/tests/claude-transport-live.cjs      # LIVE: edited files still transport
git diff --stat                           # did the change actually land
node tools/qa-video-review/qwen-review.cjs ...   # exit 0 PASS / 2 FAIL / 3 INCONCLUSIVE
```

**Full pipeline docs, including the recording setup:**
`C:\Users\subha\Documents\PROJECTS\Proxima\tools\qa-video-review\README.md`

Short version:

```bash
T=C:/Users/subha/Documents/PROJECTS/Proxima/tools/qa-video-review
node $T/start-browser.cjs --port 9333 --url "$APP"          # browser FIRST
node $T/record-cdp.cjs --port 9333 --navigate "$APP" \
     --out run.mp4 --last-frame run-last.jpg --stop-file .stop --max-seconds 180 &
# ...drive the app with a browser MCP...
node -e "require('fs').writeFileSync('.stop','x')"          # touch does not exist in cmd
node $T/qwen-review.cjs --video run.mp4 --image run-last.jpg \
     --checklist checks.txt --context "..." --json review.json
```

Three things that decide whether the review is trustworthy, all learned the hard way:

- **Always pass `--navigate`** so the recorder owns page load. Attaching to a loaded tab
  puts the *previous* run's final screen at the head of the video, and a reviewer reads it
  as the app's initial state. That produced a false FAIL once.
- **Always pass `--last-frame`** and attach it with `--image`. Video is sampled; a still is
  not. The end state usually decides pass/fail.
- **Encoding takes ~25s after you stop** on an animating page (thousands of frames). Wait
  for the recorder's JSON on stdout — do not assume it finished.

---

## 5. Hard-won facts you cannot infer from the code

**Everything below is measured, not assumed.**

### Claude (claude.ai)
- `rendering_mode: "messages"` on the completion body is the artifact gate **and** the
  modern-stream negotiator. Without it the server replaces every tool block with the
  literal string *"This block is not supported on your current device yet."* — silent
  data loss, no error anywhere.
- Artifacts are the generic sandbox tool sequence (`view` → `create_file` →
  `present_files`), not a block type. Filter on `type === 'tool_use'`, **not** on name:
  `tool_use` and `tool_result` share the name and the result's input is empty.
- `wiggle/list-files` + `wiggle/download-file` retrieve files from **any** conversation,
  including ones sent before the fix whose transcript shows only the placeholder. Note
  `/conversations/`, not `/chat_conversations/`. The listing is *eventually consistent* —
  a just-written file needs a retry.
- That listing mixes **model-generated outputs with everything the user ever uploaded**,
  distinguished only by path prefix. One real thread holds 49 outputs and 181 uploads.
- Enums, quoted from the server's own validation errors:
  `effort: low|medium|high|xhigh|max`, `thinking_mode: extended|standard|auto|off`.
  Per-request `effort` writes through to the conversation; `thinking_mode` does not.
- Wire model ids: `claude-opus-5`, `claude-sonnet-5`, `claude-fable-5`, `claude-opus-4-8`,
  and `claude-haiku-4-5-20251001` — that last one breaks the pattern, so **never guess an
  id from a picker label**. Default here is `claude-opus-5` at `high` effort.
- Uploads go to `wiggle/upload-file` (multipart, field name exactly `file`). The response's
  `file_kind` is decided by **server-side content sniffing** and picks the slot: images and
  PDFs → `files: [uuid]`, text → `attachments: [{extracted_content}]`.

### Qwen (chat.qwen.ai)
- **Every failure is HTTP 200** — validation errors, WAF blocks and logged-out all. Branch
  on content-type, never on status.
- Requests must be *signed* the way the app signs them (`chats/new` and the `chats/*` GETs,
  **not** `chat/completions`). Unsigned traffic accrues WAF risk and eventually plants a
  CAPTCHA that breaks everything until solved.
- `deep_research` is a **two-turn** protocol: turn 1 (`sub_chat_type: deep_thinking`)
  returns a *clarifying question*, turn 2 does the 7-minute work. Handled automatically.
- Attachments: image ≤20MB ×5, video ≤500MB ×1, audio ≤100MB ×1, doc ≤20MB ×5. A
  text-only model (`qwen3.7-max`) accepts the upload and silently ignores it — guarded.
- **Image generation works; video does not.** `ask_qwen` takes `mode: "t2i"` to generate an
  image and `mode: "image_edit"` to edit one passed in `attachments`. There is **no CLI** for
  either — the MCP tool is the only entry point. Assets are downloaded to
  `%APPDATA%\proxima\qwen-media\<chatId>\` and the reply announces the local paths, because
  the CDN URLs are signed (268–384 chars of query) and **expire** — a URL handed to an agent
  that comes back later is worthless, and the path cannot be reconstructed without the query.
- Two routes reach image generation and they look nothing alike. Ask in plain language on a
  normal `t2t` turn and the model calls a function: phase `image_gen_tool`, `delta.content`
  empty throughout, assets in `extra.image_list[]`, prose in `answer`. Set `chat_type: t2i`
  and you get a simpler path: phase `image_gen`, URL **directly in `delta.content`**, no prose
  at all. Both are handled; the collector keys on the CDN *host* rather than phase names, so
  an undocumented phase still yields its asset.
- **A CDN URL in `answer` prose is not evidence of an asset.** Captured: after a real video
  earlier in the same conversation, the model emitted a perfectly-shaped
  `cdn.qwenlm.ai/.../t2v/....mp4` link in plain text — imitated from its own context, and a
  fetch returned 404 `text/html`. Only generation phases carry real assets, and the download
  step is the check that matters: a non-200 is recorded as an error, never as a saved file.
- **No promptable video mode.** `qwen3.8-max` *declares* `t2v` in `GET /api/v2/models`, and
  that is not the same as serving it — asked for a video in plain language it refuses flatly
  and names Runway/Pika/Sora, with zero function calls in the stream. `t2v` was briefly on the
  `mode` enum on the strength of that declaration and has been removed. Real video is
  image-anchored **`i2v`** and **not implemented**: `stream: false`, the response is a job ack
  carrying `extra.wanx.task_id`, then poll `GET /api/v2/chats/{chat_id}` until a NEW assistant
  message appears whose `content` *is* the mp4 URL. 4–6+ minutes for a five-second clip, and
  the UI's own progress bar runs ahead of the backend — it sat at 99% while the endpoint still
  showed no new message, so poll the endpoint, never trust a percentage. `size` (1:1, 3:4, 4:3,
  16:9 default, 9:16) is honoured for video and ignored for images. Full wire shape:
  `C:\Users\subha\Downloads\qwenimagevideogeneration.md`.
- **Thinking is off unless you ask, and asking is not proof.** The engine reads a missing
  `thinking` flag as *off*, so `qwen3.8-max` answers with no reasoning pass and the reply
  is indistinguishable from a reasoned one. Three separate callers shipped that way (the
  code-review loop, the repair loop, the QA video reviewer) and nobody could tell.
  Measured: `thinking` omitted → phases `["answer"]`, no `reasoning_tokens`;
  `thinking: true` → phases `["thinking_summary","answer"]`, 2522 reasoning tokens on a
  20-second clip. `ask_qwen` and the video reviewer now default it **on**, and the reply
  carries the phase tally so a caller can *verify* rather than trust its own request.
  Anything new that talks to Qwen: pass `thinking`, then check `thinkingUsed`.
- **`conversation_id` resume genuinely works** — verified with a falsifier, not a smoke
  test. Codeword planted in one session, read back from a *different* session pinned to
  that id: same chat id, no fork, codeword recalled. This needs server-side parent
  recovery, because Qwen threads by `parent_id` and does not resolve the leaf itself — a
  naive resume branches from the root and loses the whole history while looking fine.
- **Sessions matter.** One engine serves every caller. Pass `session: "<name>"` or you
  share the `default` conversation pointer with whatever else is running. The automation
  review loop uses `automation`; the QA reviewer uses `qa-review`.

### Global
- Every outgoing prompt gets `Current time: <ISO>` appended, all providers. Models have no
  clock, which matters most when resuming a thread hours later.
- Messages to claude.ai are prefixed `[PROXIMA]` + newline so a human can tell orchestrated
  turns from their own. Claude-only. Opt out with `tag: false`.

---

## 6. Failure modes to recognise

**Every bug found in this project wore success's clothing.** None of them threw. If
something looks fine, that is not evidence.

| Symptom | Cause |
|---|---|
| Answer is oddly shallow or generic | Wrong thread, or thinking disabled — check `thinkingUsed` on the reply |
| Artifact "missing" but the model says it wrote one | Placeholder substitution — check `rendering_mode` |
| Qwen send hangs for minutes | CAPTCHA pending. Run preflight. |
| A change "doesn't work" | Proxima not restarted. Run preflight. |
| Reviewer reports a stale UI state | Recorder attached before navigation — use `--navigate` |
| Two callers clobbering each other's chat | Missing `session` on Qwen calls |

---

### Do not act on a review finding without checking it

The automation loop posts a Qwen code review to `perplexity-reviews/<sha>.md` on every
push. Those findings are **useful but not reliable**. An audit of all 14 reviews from
2026-08-31/09-01, verifying every finding against the file at the reviewed commit:

- **9 of 13 findings were real** — including two excellent catches no human noticed (a
  `[^w.-]` regex missing its backslash, mangling every artifact filename; and a
  `newConversation` that wiped every *other* session's persisted conversation).
- **2 were flatly false**, each quoting code that does not exist in the file, and one of
  them drove a FAIL / 4-of-10 verdict.
- **1 had a correct conclusion with fabricated supporting evidence** — plausible code
  reconstructed from memory rather than read.
- **1 was speculative**, blaming a function from a different layer than the call path.

Thinking being enabled did *not* fix this: both flatly-false findings came after the
reasoning fix landed. What thinking changed was structure, not accuracy.

So: treat every finding as a lead, and confirm it with
`git show <sha>:<path>` before changing anything. A review's own quoted "evidence" is not
evidence. This matters most unattended — a repair loop acting on a hallucinated finding
edits working code to satisfy a bug that was never there.

---

## 7. Known gaps — do not assume these are handled

- **Rate limits are unmapped.** `within_limit` is the only status ever observed; the
  exhausted-window shape and the 429 body are unknown. A long unattended run will hit a
  quota wall and **cannot currently tell that from a crash.** This is the biggest open risk
  for AFK operation.
- **Claude conversation state is still a single pointer.** Qwen has per-caller sessions;
  Claude does not. It is safe *only because* the orchestrator pins `conversation_id` on
  every turn. A second unpinned Claude consumer would collide.
- **Automation reviews chain to each other** within the `automation` session, so review #5
  carries #1–4 in context.
- **The artifacts library** (`/code/artifact/{uuid}`, internal name `epitaxy`) is untraced.
  Per-conversation retrieval works; account-wide browsing does not.
- **Sub-second UI events** can be missed by video review. The end state is held for 4s;
  mid-run flashes are not.

---

## 8. File index (absolute paths)

| Path | What |
|---|---|
| `C:\Users\subha\Documents\PROJECTS\Proxima\tools\orchestrate\preflight.cjs` | **Run first.** Readiness check |
| `C:\Users\subha\Documents\PROJECTS\Proxima\tools\orchestrate\supervisor.cjs` | Supervisor turns + any MCP tool |
| `C:\Users\subha\Documents\PROJECTS\Proxima\tools\qa-video-review\README.md` | **Qwen video-review pipeline docs** |
| `C:\Users\subha\Documents\PROJECTS\Proxima\tools\qa-video-review\start-browser.cjs` | Chrome on a shared debug port |
| `C:\Users\subha\Documents\PROJECTS\Proxima\tools\qa-video-review\record-cdp.cjs` | Tab → mp4 |
| `C:\Users\subha\Documents\PROJECTS\Proxima\tools\qa-video-review\qwen-review.cjs` | Video → verdict + exit code |
| `C:\Users\subha\Documents\PROJECTS\Proxima\scripts\tests\claude-transport-live.cjs` | **Live** check that edited files still transport. Run when claude.ai changes |
| `C:\Users\subha\Documents\PROJECTS\Proxima\src\mcp-server-v3.js` | MCP tool definitions |
| `C:\Users\subha\Documents\PROJECTS\Proxima\electron\providers\qwen-engine.js` | Qwen protocol |
| `C:\Users\subha\Documents\PROJECTS\Proxima\electron\providers\claude-engine.js` | Claude protocol |
| `C:\Users\subha\Downloads\qwenprotocol.md` | Full Qwen wire-protocol notes (§14 = image generation) |
| `C:\Users\subha\Downloads\qwenimagevideogeneration.md` | Qwen image + video generation wire shapes, incl. unimplemented `i2v` |
| `C:\Users\subha\Downloads\claudeartifactsprotocol.md` | Claude artifacts protocol |
| `C:\Users\subha\Downloads\claudeuploadsandlimits.md` | Claude uploads, models, limits |

## 9. Working agreements

- **Run `npm run test:automation` before and after.** 7 tests; they must stay green.
- **Never work on `main`.** Branch, commit per cycle, so a bad run is one `git reset` away.
- **When patching `src/mcp-server-v3.js`, scope edits to one tool's block.** `ask_claude`
  and `ask_qwen` share lines verbatim; a file-wide replace has silently edited the wrong
  tool twice, once overwriting an entire handler.
- **Avoid heredocs for code containing backslashes.** In this environment they get eaten:
  `\w` became `w` in a regex and `\n` became a literal newline, both silently. Use the
  Write tool or a fragment file.
- **Report what you verified and what you did not.** "Verified" has meant "I tested a
  lower layer" here more than once, and it cost real time.
