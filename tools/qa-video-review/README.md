# Video-reviewed UI testing: browser MCP → screen recording → Qwen 3.8

A QA loop where an agent drives your app in a real browser, the run is recorded, and
**Qwen 3.8 watches the video and returns a machine-readable verdict**. The agent gets
an exit code it can branch on, not a wall of prose.

This is for the class of bug assertions miss: a control that renders but sits under a
modal, a spinner that never resolves, a layout that collapses at the wrong width, a
toast that flashes the wrong message. A human spots those in two seconds of video. A
`expect(x).toBe(y)` never will.

Verified end to end on 2026-08-31 against the AttendEase frontend (React + Vite).
Results and the failure this shook out are in [Verification](#verification).

---

## The parts

```
  ┌─ your agent ──────────────┐
  │  chrome-devtools MCP      │  drives the app
  │  or playwright MCP        │
  └───────────┬───────────────┘
              │  both attach to Chrome over CDP
  ┌───────────▼───────────────┐
  │  Chrome --remote-debugging-port=9333
  └───────────┬───────────────┘
              │  Page.startScreencast (same tab)
  ┌───────────▼───────────────┐
  │  record-cdp.cjs           │  → run.mp4 + run-last.jpg
  └───────────┬───────────────┘
              │
  ┌───────────▼───────────────┐
  │  qwen-review.cjs          │  → Proxima IPC → getstsToken → OSS → messages[0].files
  └───────────┬───────────────┘
              │
       verdict + exit code      0 = PASS · 2 = FAIL · 3 = INCONCLUSIVE · 1 = error
```

The recorder attaches to a **debug port**, not to a library. That is the design
decision that makes this work with whatever browser MCP you happen to have — the
agent drives, the recorder observes the same tab, and neither knows about the other.

### Why CDP screencast and not a desktop grab

`ffmpeg gdigrab` would capture your whole screen. That means notification toasts,
other windows and your wallpaper all land in a video an LLM is about to reason over,
it cannot run on CI, and it cannot record a headless browser. Screencast captures the
tab only, works headless, and its frames carry timestamps — which turns out to matter
more than anything else here.

---

## Setup

**Prerequisites:** Proxima running with Qwen logged in, `ffmpeg` + `ffprobe` on PATH,
and Node. The recorder needs `ws`, which Proxima already has.

Neither browser MCP is installed on this machine yet. Chrome DevTools MCP is the one
to add for this loop:

```bash
claude mcp add chrome-devtools --scope user -- npx chrome-devtools-mcp@latest
```

`--scope user` matters. Without it the server is registered only for the directory you
ran the command in — which is exactly why `proxima` is registered under
`C:/Users/subha/Documents/PROJECTS` and therefore invisible to a session started in
`PROJECTS/Proxima`.

Start one Chrome that both the MCP and the recorder share:

```bash
chrome.exe --remote-debugging-port=9333 \
           --remote-debugging-address=127.0.0.1 \
           --user-data-dir=/tmp/qa-profile \
           --window-size=1280,800 --hide-scrollbars \
           --headless=new                       # drop for a visible browser
```

Then point the MCP at it rather than letting it launch its own:

```bash
claude mcp add chrome-devtools --scope user -- \
  npx chrome-devtools-mcp@latest --browserUrl http://127.0.0.1:9333
```

> **Pass `--remote-debugging-address=127.0.0.1`.** If something already holds
> `127.0.0.1:PORT`, Chrome silently falls back to binding `[::1]:PORT` and logs a
> `bind() returned an error` you never see. A probe of `127.0.0.1` then finds a
> *different* browser, or nothing. Hit during verification, with two Chromes on 9222 —
> one per loopback family. `record-cdp.cjs` now tries both, but pinning the address is
> better.

---

## Usage

### 1. Record

```bash
node record-cdp.cjs --port 9333 --url-filter localhost:4173 \
                    --out run.mp4 --last-frame run-last.jpg \
                    --stop-file .stop --max-seconds 120
```

Runs until `--stop-file` appears, `--max-seconds` elapses, or SIGINT. Start it, have
the agent drive the app, then `touch .stop`. Prints one line of JSON:

```json
{"ok":true,"out":"...run.mp4","frames":151,"seconds":20.72,"capturedSeconds":12.25,
 "tailSeconds":4,"lastFrame":"...run-last.jpg","mb":0.2,"reason":"stop-file"}
```

| flag | default | notes |
|---|---|---|
| `--port` | `9222` | Chrome debug port |
| `--host` | `127.0.0.1` | falls back to `[::1]` automatically |
| `--url-filter` | — | substring match to pick the tab; falls back to the first page |
| `--out` | `run.mp4` | H.264 / yuv420p, even dimensions |
| `--last-frame` | — | writes the final frame as a still. **Use it** |
| `--tail-max` | `4` | seconds the final state is held on screen |
| `--quality` | `70` | JPEG quality per frame |
| `--max-width/height` | `1280`/`800` | frames are scaled down to fit |
| `--stop-file` | — | recorder exits when this path exists |
| `--keep-frames` | off | keep the raw JPEGs for debugging |

### 2. Review

```bash
node qwen-review.cjs --video run.mp4 --image run-last.jpg \
                     --checklist checks.txt \
                     --context "AttendEase login route, production build, no backend running" \
                     --json review.json
echo $?     # 0 PASS · 2 FAIL · 3 INCONCLUSIVE · 1 error
```

`checks.txt` is one assertion per line; `#` comments and `-` bullets are stripped:

```
The login page renders fully, with no blank screen or missing layout.
Both an email field and a password field are visible and accept typed text.
A sign-in / submit control is present.
No error message, stack trace, "undefined"/"NaN" text, or broken layout appears.
```

Qwen answers in prose and then a fenced JSON block with a per-check breakdown,
verbatim on-screen evidence, observed issues and a timeline. An unparseable reply is
**INCONCLUSIVE (exit 3)**, never a pass — "the reviewer didn't answer" and "the app
works" must not collapse into the same outcome.

---

## Three things that decide whether this works

### 1. Hold the final frame — this one produced a false PASS

Screencast emits a frame **when something changes**, not on a clock. A run that ends
on a static error banner produces exactly *one* frame for it. The first version gave
that last frame the *median* duration, so **9 seconds of visible failure became 0.2s
of a 12.4s video** — and Qwen, which samples frames, never saw it and returned
`PASS`. The banner was genuinely in the file; I only caught it by extracting frames at
`t=12.2s` and looking myself.

The fix is in `record-cdp.cjs`: the final frame gets its real wall-clock dwell,
floored at 1s and capped by `--tail-max`. Same scenario after the fix: `FAIL`, quoting
"Network Error".

**This is the failure mode to distrust in any video-QA setup.** A reviewer that cannot
see the end state will cheerfully pass a broken app.

### 2. Attach the last frame as a still

Video is compressed and sampled; a still is neither. `--image run-last.jpg` gives the
reviewer a full-resolution view of the state that usually decides pass/fail. Qwen
accepts **1 video + up to 5 images in the same turn** — separate per-class caps, not
one shared budget.

### 3. Reviews get a fresh conversation

Qwen **keeps context across calls** — its chat id lives in the page's `localStorage`
for 2 hours and survives a Proxima restart. Good for follow-ups, wrong for verdicts:
chained onto a previous review, the model carries over "the app worked a moment ago"
and reasons about the wrong run. `qwen-review.cjs` therefore sends `newChat` by
default; `--keep-context` opts back in for a deliberate follow-up question.

---

## Verification

Two scenarios against the same app and the **same checklist**, so the verdict had to
come from the video rather than the prompt.

| run | what the agent did | ground truth | verdict | exit |
|---|---|---|---|---|
| A | load `/login`, fill both fields, scroll | renders clean, no errors | **PASS** (high) | 0 |
| B | fill fields, click **Sign In** (no backend) | red **"Network Error"** banner | **FAIL** (high) | 2 |

Run A's evidence quoted real on-screen strings — the `you@school.edu` placeholder,
"Welcome back", "Remember me", "Forgot password?" — and I confirmed each against a
frame grid I extracted myself. Run B named the banner and cited the attached still.

Recording cost is negligible: **151 frames / 20.7s / 0.2 MB**. Review latency was
~81–86s per run, dominated by Qwen's video processing, not the upload.

Also verified on the attachment path underneath: a **226 MB, 5-minute** 1920×1080
screen recording was accepted and described accurately (`video_tokens: 182,360`),
including small on-screen text. Qwen read a filename as "Lab Manual 06 New.pdf" where
my own downscaled frame grid looked like "05" — a full-resolution crop showed **Qwen
was right**.

### Honest limits

- **Sub-second events are unreliable.** The tail fix covers the *final* state. A toast
  that appears and vanishes mid-run can still fall between sampled frames. Dwell after
  the actions you care about, or capture a still at that moment.
- **Not a substitute for assertions.** Use it for what assertions cannot see. Keep
  DOM-level checks for exact values.
- **Qwen will narrate plausibly.** In the false-PASS run it described a "Loading…
  spinner" transition I could not find in the video. Treat the `evidence` fields as
  the part worth reading, and prefer checks whose answer is legible on screen.
- **One video per turn.** 500 MB and 10 minutes are the caps; images are 5 × 20 MB.
- **Requires a logged-in Qwen session** in Proxima. There is no 401 on this API — a
  logged-out session and a WAF block look identical, so a sudden run of
  INCONCLUSIVE/error results is worth checking against the Qwen tab.

---

## Agent recipe

```
1. Start the app under test.
2. Start Chrome with --remote-debugging-port=9333 --remote-debugging-address=127.0.0.1
3. Point chrome-devtools MCP at it:  --browserUrl http://127.0.0.1:9333
4. Spawn:  node record-cdp.cjs --port 9333 --out run.mp4 --last-frame run-last.jpg
                               --stop-file .stop --max-seconds 180
5. Drive the app through the MCP. Dwell ~2s after each state you want reviewed.
6. Write .stop  → wait for the recorder's JSON on stdout.
7. node qwen-review.cjs --video run.mp4 --image run-last.jpg --checklist checks.txt
                        --context "<what this app is>" --json review.json
8. Branch on the exit code. On FAIL, read review.json .parsed.issues and .checks
   for the failing check and its evidence.
```

## Files

| file | what it is |
|---|---|
| `record-cdp.cjs` | CDP screencast → mp4 (+ optional final still) |
| `qwen-review.cjs` | mp4 (+ stills) → Qwen 3.8 → verdict + exit code |
| `README.md` | this |

Attachment protocol underneath: `electron/providers/qwen-upload.cjs`
(`getstsToken` → Alibaba OSS single PUT → `messages[0].files`) and
`electron/providers/qwen-engine.js`.
