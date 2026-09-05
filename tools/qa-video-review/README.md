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

**This file is meant to be self-sufficient.** Paths below are absolute so an agent
working in any repo can run them unchanged.

```
TOOLS = C:/Users/subha/Documents/PROJECTS/Proxima/tools/qa-video-review
```

**Prerequisites**

| need | check | note |
|---|---|---|
| Proxima running, Qwen logged in | `netstat -ano | findstr 19222` | supplies the Qwen upload path |
| `ffmpeg` + `ffprobe` on PATH | `ffmpeg -version` | encodes frames, probes duration |
| Node | `node -v` | — |
| Chrome or Edge | — | auto-detected; override with `CHROME_PATH` |

`ws` is required by the recorder and resolves out of Proxima's own `node_modules`
via the script's location — so call the scripts by their absolute path and do **not**
copy them elsewhere.

### The browser, and why the port is not negotiable

Chrome DevTools MCP is installed user-scoped on this machine as:

```
npx chrome-devtools-mcp@latest --browserUrl=http://127.0.0.1:9333
```

`--browserUrl` means the MCP **attaches to an existing browser instead of launching
one**. Two consequences, and both bite:

1. **Port 9333 is mandatory.** It is baked into the MCP registration, so the browser
   has to be there. Using another port means the MCP and the recorder look at
   different browsers, or the MCP fails outright.
2. **Chrome must be listening before the MCP server starts.** The MCP server starts
   with the Claude Code session, so start the browser *first*. If it is not up, the
   MCP may launch a browser of its own to cope — leaving a second Chrome on the port
   and a confusing split.

So always begin with:

```bash
node C:/Users/subha/Documents/PROJECTS/Proxima/tools/qa-video-review/start-browser.cjs --port 9333 --url http://localhost:4173
```

```json
{"ok":true,"launched":true,"port":9333,"host":"127.0.0.1","headed":false,
 "profile":"...\qa-chrome-profile","pages":["http://localhost:4173/"]}
```

It is idempotent: if something already listens on the port it reports
`"reused":true` and launches nothing. Add `--headed` to watch it work,
`--kill` to stop whatever holds the port.

> After changing MCP registration you must **start a new Claude Code session** — MCP
> servers are loaded at session start, so the tools do not appear in a session that
> was already running.

---

## Usage

### 1. Record

```bash
node C:/Users/subha/Documents/PROJECTS/Proxima/tools/qa-video-review/record-cdp.cjs --port 9333 --url-filter localhost:4173 \
                    --out run.mp4 --last-frame run-last.jpg \
                    --stop-file .stop --max-seconds 120
```

Runs until `--stop-file` appears, `--max-seconds` elapses, or SIGINT. Start it, have
the agent drive the app, then create the stop file — note `touch` does not exist in
cmd or PowerShell:

```bash
node -e "require('fs').writeFileSync('.stop','x')"    # portable, use this
cmd /c "type nul > .stop"                             # cmd
New-Item .stop -Force | Out-Null                      # PowerShell
```

The recorder then prints one line of JSON and exits:

```json
{"ok":true,"out":"...run.mp4","frames":151,"seconds":20.72,"capturedSeconds":12.25,
 "tailSeconds":4,"lastFrame":"...run-last.jpg","mb":0.2,"reason":"stop-file"}
```

| flag | default | notes |
|---|---|---|
| `--port` | `9222` | Chrome debug port |
| `--host` | `127.0.0.1` | falls back to `[::1]` automatically |
| `--url-filter` | — | substring match. Must hit EXACTLY one tab — zero or several is an error, never a guess |
| `--new-tab` | — | open a fresh tab and use it. Safest on a shared browser |
| `--target` | — | pin an exact webSocketDebuggerUrl |
| `--instance` | — | resolve the port from a named browser instance |
| `--allow-any-tab` | off | opt back into taking the first tab, for working alone |
| `--network` / `--network-bodies` | — | capture requests, and optionally text bodies |
| `--dom` / `--console` | — | final DOM snapshot, and console + uncaught exceptions |
| `--out` | `run.mp4` | H.264 / yuv420p, even dimensions |
| `--last-frame` | — | writes the final frame as a still. **Use it** |
| `--tail-max` | `4` | seconds the final state is held on screen |
| `--quality` | `70` | JPEG quality per frame |
| `--max-width/height` | `1280`/`800` | frames are scaled down to fit |
| `--stop-file` | — | recorder exits when this path exists |
| `--keep-frames` | off | keep the raw JPEGs for debugging |

### 2. Review

```bash
node C:/Users/subha/Documents/PROJECTS/Proxima/tools/qa-video-review/qwen-review.cjs --video run.mp4 --image run-last.jpg \
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

## Capturing more than pixels

The recorder can collect four other channels alongside the video, in the same run and from
the same tab:

```bash
node record-cdp.cjs --instance myproj --new-tab http://localhost:4173 \
  --out run.mp4 --last-frame run-last.jpg \
  --network net.json --network-bodies \
  --dom final.html \
  --console log.json
```

Each answers a different question, and the last three are **machine-checkable** in a way a
video reviewed by a language model is not. A verdict on a recording is a judgement; "one
failed request, two console errors" is a fact. Branch on the facts, and use the review for
what only judgement can settle.

The one-line summary carries the headline numbers so a caller never has to open the files
to decide:

```json
"network": { "total": 2, "failed": 1, "byStatus": { "200": 1, "failed": 1 } },
"dom":     { "chars": 485, "title": "Bundle Probe", "url": "..." },
"console": { "total": 3, "errors": 2 }
```

| flag | what it gets you |
|---|---|
| `--network <file>` | every request: method, url, resource type, status, mime, size, headers, and failures as `net::ERR_*` |
| `--network-bodies` | response bodies too, for text/JSON only, capped at 256KB each |
| `--network-headers-raw` | headers unredacted — see the warning below |
| `--dom <file>` | `outerHTML` at stop time, with the url and title in a comment header |
| `--console <file>` | `console.*` calls **and uncaught exceptions**, with levels and an error count |

### Why the DOM is worth having next to a screenshot

A still shows *that* a run failed; the DOM shows *why*. From the probe used to test this:

```html
<div class="error-banner" role="alert">Network Error — could not load cart</div>
```

That is greppable. The same information in a JPEG depends on a model reading it correctly,
at whatever resolution survived encoding — and this pipeline has already produced one false
PASS by mis-sampling exactly that kind of banner.

Console catches the class of failure that leaves no pixels at all:

```
[console/log]      probe: booted
[console/error]    probe: cart fetch failed
[exception/error]  Error: probe: uncaught boom
```

A run can look perfect on video and have thrown three uncaught errors.

### Headers are redacted by default

`Cookie`, `Set-Cookie`, `Authorization` and the usual API-key headers are replaced with
`<redacted N chars>`. These files are made to be handed to someone — a reviewer, a bug
report, another agent — and a capture that quietly contains a session token is a worse
thing to have produced than no capture at all. `--network-headers-raw` turns it off when
you are debugging auth and know where the file is going.

### Cost

Metadata capture is passive bookkeeping. `--network-bodies` adds one CDP round-trip per
text response, so it competes with screencast frame acks — worth it when you need bodies,
not worth leaving on by default. Outstanding body fetches are drained before the socket
closes, with a warning if any do not arrive, because a body that silently went missing
looks exactly like a request the app never made.

## Sharing a laptop with another agent

Two agents, one machine, one debug port is a collision by default. This was measured, not
imagined: port 9333 held **eight page targets belonging to a different project**, so
`pages[0]` — the tab every tool here used to fall back to — was
`https://tx-2fded057.pages.dev/`. A typo'd `--url-filter` meant recording someone else's
application and getting a confident review of it, or worse, the drivers navigating their
page away and clicking into it.

Two ways out. Pick one; do not rely on being careful.

### Your own browser (preferred)

```bash
node start-browser.cjs --instance myproj --url http://localhost:4173
node record-cdp.cjs   --instance myproj --new-tab http://localhost:4173 --out run.mp4 ...
node start-browser.cjs --instance myproj --kill      # stops only yours
node start-browser.cjs --list                        # who is running what
```

A named instance gets its own port **and its own profile directory**. The profile is what
actually separates browsers — Chrome treats `--user-data-dir` as a browser's identity, so
launching with a profile that is already in use hands the command line to the running
browser and exits rather than starting a second one. Same profile means same browser
whatever port you asked for, which is why the port alone was never enough.

`--instance` also resolves the port for the recorder and drivers, so nobody has to
remember that this file defaults to 9333 while `record-cdp.cjs` defaults to 9222 — a
mismatch that used to attach you to a port nobody had started.

### Someone else's browser, safely

If you must share the port, **name the tab**. In order of safety:

| flag | meaning |
|---|---|
| `--new-tab <url>` | opens a fresh tab and pins it. Nothing else can be using a tab that did not exist a moment ago. |
| `--target ws://…` | pins an exact target. Immune to anything else on the port. |
| `--url-filter <s>` | matches open tabs. **One match required** — zero or several is an error. |

There is no fallback any more. If nothing matches, the tools stop and print the tabs they
found rather than guessing:

```
--url-filter "checkout" matched NOTHING. The port has 8 page(s), which may belong to
another agent:
  [0] https://tx-2fded057.pages.dev/
  [1] http://localhost:5173/account
```

`--allow-any-tab` restores the old take-the-first-page behaviour for someone genuinely
working alone. It is opt-in because a silent fallback is indistinguishable from success,
which is the property that made it dangerous rather than merely wrong.

### Never kill a port you do not own

`--kill` without `--instance` now refuses, because killing by port takes down whatever
holds it — on a shared machine, another agent's browser and everything they had open.
`--instance <name> --kill` stops only the process this tool started under that name;
`--force` overrides, and means it.

### Chrome's `/json/new` wants PUT

Worth knowing if you open tabs by hand: current Chrome answers a GET on `/json/new` with
HTTP 405 and *"Using unsafe HTTP verb GET to invoke /json/new"*. The obvious PowerShell
one-liner (`Invoke-RestMethod ".../json/new?url"`) defaults to GET and hits exactly that.
`--new-tab` handles it, falling back to GET for older builds.

### Proxima has the same shape of hazard

One Qwen engine serves every caller on the page, so **pass `session: "<name>"`** or you
share the `default` conversation pointer with whatever else is running. Claude's
conversation state there is a single pointer, safe only because the orchestrator pins
`conversation_id` on every turn — a second unpinned consumer collides.

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

Copy-pasteable. Set `APP` to the URL of the app under test.

```bash
T="C:/Users/subha/Documents/PROJECTS/Proxima/tools/qa-video-review"
APP="http://localhost:4173"

# 1. Browser FIRST — the MCP attaches to this one, it does not launch its own.
node "$T/start-browser.cjs" --port 9333 --url "$APP"

# 2. Start recording in the background. It exits by itself when .stop appears.
node "$T/record-cdp.cjs" --port 9333 --url-filter "localhost:4173" \
     --out run.mp4 --last-frame run-last.jpg \
     --stop-file .stop --max-seconds 180 &

# 3. Drive the app with the chrome-devtools MCP tools now.
#    Dwell ~2s on each state you want reviewed: a state that never stays on screen
#    for about a second may not survive frame sampling.

# 4. Stop the recording. `touch` does not exist in cmd/PowerShell, so use node.
node -e "require('fs').writeFileSync('.stop','x')"

# 5. Review. The exit code IS the result.
node "$T/qwen-review.cjs" --video run.mp4 --image run-last.jpg \
     --checklist checks.txt \
     --context "<one or two sentences: what this app is, what the run did>" \
     --json review.json
echo "verdict exit: $?"     # 0 PASS · 2 FAIL · 3 INCONCLUSIVE · 1 error
```

On a non-zero verdict, `review.json` holds the detail worth acting on. Print the
checks that did not pass, with the evidence the model committed to:

```bash
node -e "
const r = require('./review.json');
console.log(r.verdict, '(' + r.parsed.confidence + ')');
r.parsed.checks.filter(c => c.result !== 'pass').forEach(c => {
  console.log('-', c.result.toUpperCase(), '::', c.check);
  console.log('  evidence:', c.evidence);
});
(r.parsed.issues || []).forEach(i => console.log('  issue:', i));
"
```

Read the `evidence` fields, not just the verdict. That is where the model has to
commit to something it actually saw on screen, and it is how you catch a confident
answer built on nothing.


## Reasoning is on, and it is checked

Qwen reasons only when `feature_config.thinking_enabled` is set, and the engine reads a
missing flag as *off*. This script omitted it, so **every verdict it produced before
2026-09-01 was reached with no reasoning pass** — measured, not inferred:

| request | phases seen in the SSE stream | reasoning tokens |
|---|---|---|
| `thinking` omitted (the old behaviour) | `answer` | *field absent* |
| `thinking: true` (now the default) | `thinking_summary`, `answer` | 2522 on a 20s clip |

Nothing errored either way. The verdicts still arrived, still parsed, still read like
considered judgements — which is exactly why this went unnoticed. Watching a multi-minute
recording and reconciling it against a checklist is the work reasoning is *for*, so it is
on by default here and has to be switched off deliberately with `--no-thinking`.

Because "I asked for thinking" is not evidence that thinking happened, the reply now
carries proof. The engine tallies every SSE phase, and `thinking_summary` appears if and
only if reasoning frames arrived. `thinkingStatus` in the JSON output reports one of:

- **`verified`** — asked for it, and the stream proves it happened.
- **`contradicted`** — asked for it, and the stream proves it did not. The verdict is
  suppressed and reported as `INCONCLUSIVE` (exit 3): a judgement reached without the
  reasoning pass it was configured for is not one this script will pass along as PASS.
  `--allow-no-thinking` accepts it anyway.
- **`unverifiable`** — the running Proxima predates the metadata field. Warns; never
  fails, because "older build" and "broken reviewer" are different things. **Restart
  Proxima** to turn this into `verified`.
- **`not requested`** — `--no-thinking` was passed.

The same evidence rides `ask_qwen` (thinking defaults **on** there too, `thinking: false`
to opt out). An `ask_qwen` reply annotates itself when thinking was requested and did not
happen — silence on that mismatch is precisely how it hid for weeks.

## Files

| file | what it is |
|---|---|
| `start-browser.cjs` | launches/reuses the Chrome that the MCP **and** recorder share |
| `cdp-target.cjs` | picks a tab, and refuses to guess when it cannot tell them apart |
| `chrome-instances.cjs` | named browsers — own port, own profile, shared registry |
| `record-cdp.cjs` | CDP screencast → mp4 (+ optional final still) |
| `qwen-review.cjs` | mp4 (+ stills) → Qwen 3.8 → verdict + exit code |
| `README.md` | this |

Attachment protocol underneath: `electron/providers/qwen-upload.cjs`
(`getstsToken` → Alibaba OSS single PUT → `messages[0].files`) and
`electron/providers/qwen-engine.js`.
