<div align="center">

<img src="assets/proxima-icon.png" alt="Proxima" width="72"/>

# Proxima

**5 AI providers. 1 local server. No API keys.**

Use ChatGPT, Claude, Gemini, Qwen & Perplexity directly inside your coding tools — through your existing accounts.

<br>

[![Version](https://img.shields.io/badge/version-4.2.0-blue)](https://github.com/Ahad690/Proxima/releases)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](https://github.com/Ahad690/Proxima/releases)
[![MCP Tools](https://img.shields.io/badge/MCP_tools-57-green)](https://github.com/Ahad690/Proxima#mcp-tools)
[![License](https://img.shields.io/badge/license-Non--Commercial-red)](LICENSE)
[![Website](https://img.shields.io/badge/Website-proximamcp.in-blue)](https://www.proximamcp.in)
[![Docs](https://img.shields.io/badge/Docs-Documentation-orange)](https://www.proximamcp.in/documentation)
[![Stars](https://img.shields.io/github/stars/Ahad690/Proxima?style=social)](https://github.com/Ahad690/Proxima/stargazers)

<br>

[Getting Started](#getting-started) · [CLI](#cli-tool) · [Orchestration](#claude-orchestration-loop) · [Automation](#local-review-automation) · [REST API](#rest-api) · [WebSocket](#websocket) · [SDKs](#sdks) · [MCP Tools](#mcp-tools)

</div>

<br>

---

## Demo

**App Demo · CLI · Webhook Live Chat & Battle · Application Overview**

<table cellspacing="0" cellpadding="0">
<tr>
<td width="50%">

https://github.com/user-attachments/assets/5e75eb68-b1b5-43dc-979d-3bf6faa48fa0

</td>
<td width="50%">

https://github.com/user-attachments/assets/a8564fc9-b3b3-4a53-bc35-cfce72fe34da

</td>
</tr>
<tr>
<td width="50%">

https://github.com/user-attachments/assets/bb7fa455-d379-4e69-b530-f7c09d2faccf

</td>
<td width="50%">

https://github.com/user-attachments/assets/d4121fdb-f97e-4d35-846c-5ec7c5249a85

</td>
</tr>
</table>

---

## Overview

Proxima is a local AI gateway that connects multiple AI providers to your development environment. It communicates with each provider at the browser level through your active login sessions — the same way you'd chat with them in your browser.

<br>

<table>
<tr>
<td>🌐 <strong>One Endpoint</strong></td>
<td>Everything through <code>/v1/chat/completions</code> — no separate URLs</td>
</tr>
<tr>
<td>🤖 <strong>5 AI Providers</strong></td>
<td>ChatGPT, Claude, Gemini, Qwen, Perplexity — any model, any task</td>
</tr>
<tr>
<td>⚡ <strong>Provider Engines</strong></td>
<td>Native browser-level communication with SSE streaming and automatic DOM fallback where the provider supports it</td>
</tr>
<tr>
<td>🎛️ <strong>Claude Orchestration</strong></td>
<td>Use a Claude thread as a supervisor while your coding agent does the tool work — see <a href="docs/PROXIMA_CLAUDE_ORCHESTRATION.md">the guide</a></td>
</tr>
<tr>
<td>🖥️ <strong>CLI Tool</strong></td>
<td><code>proxima ask</code>, <code>proxima fix</code>, <code>proxima debate</code> — right from your terminal</td>
</tr>
<tr>
<td>🔌 <strong>WebSocket</strong></td>
<td>Real-time streaming at <code>ws://localhost:3210/ws</code></td>
</tr>
<tr>
<td>🧰 <strong>57 MCP Tools</strong></td>
<td>Search, code, translate, analyze, debate, audit — all via MCP</td>
</tr>
<tr>
<td>📡 <strong>REST API</strong></td>
<td>OpenAI-compatible API on <code>localhost:3210</code></td>
</tr>
<tr>
<td>📦 <strong>SDKs</strong></td>
<td>Python & JavaScript — one function each</td>
</tr>
<tr>
<td>🧠 <strong>Smart Router</strong></td>
<td>Auto-picks the best available AI for your query</td>
</tr>
<tr>
<td>🔑 <strong>No API Keys</strong></td>
<td>Uses your existing browser sessions — see <a href="#security--privacy">how it works</a></td>
</tr>
<tr>
<td>🔒 <strong>Local & Private</strong></td>
<td>Runs on <code>127.0.0.1</code>, data goes only to providers you're logged into</td>
</tr>
</table>

<br>

---

## What's New in v4.2.0

<table>
<tr>
<td width="40"><strong>🖥️</strong></td>
<td><strong>Qwen joins as a fifth provider</strong><br>Qwen 3.8 is available as an API-first provider with real image, video, audio, and document attachments, plus image generation and editing. It runs on the same cookie session as the Qwen website and has no DOM fallback — if the API path fails, it fails loudly instead of typing into the page.</td>
</tr>
<tr>
<td><strong>📎</strong></td>
<td><strong>Real file attachments</strong><br>Claude and Qwen accept actual files through MCP — images, PDFs, video, audio, and documents — not just text pasted into a prompt. ChatGPT file upload is wired in the app. A failed upload fails the call instead of quietly sending a text-only turn.</td>
</tr>
<tr>
<td><strong>📄</strong></td>
<td><strong>Claude threads and artifacts</strong><br>Address a Claude conversation by id or URL so a thread survives a restart, and pull files the model created or edited back to disk with <code>claude_artifacts</code>.</td>
</tr>
<tr>
<td><strong>🎚️</strong></td>
<td><strong>Configurable provider models</strong><br><code>models.json</code> sets ordered model chains per provider. Claude defaults to Mythos 5.2 then Opus 5.5 at high effort; each family is tried newest-first and the last model that answered is kept as the fallback. Claude can also resolve the newest active model from <code>GET /v1/models</code>.</td>
</tr>
<tr>
<td><strong>🎛️</strong></td>
<td><strong>Claude orchestration loop</strong><br>Run a Claude thread as a supervisor while your coding agent does the tool work. One Claude turn per checkpoint instead of one per tool call. The <a href="docs/PROXIMA_CLAUDE_ORCHESTRATION.md">orchestration guide</a> covers the CLI, message contract, attachments, and state file.</td>
</tr>
<tr>
<td><strong>🔍</strong></td>
<td><strong>Local review automation</strong><br>A pre-push hook queues a code review, and the local loop can generate patches, validate them, run tests, and push a bot branch. Review-only by default; repair is opt-in.</td>
</tr>
<tr>
<td><strong>🎬</strong></td>
<td><strong>Video-reviewed UI testing</strong><br>Record a browser run, send the video to Qwen, and get a machine-readable verdict. Catches rendering and interaction bugs that assertions miss. See <a href="tools/qa-video-review/README.md">tools/qa-video-review</a>.</td>
</tr>
<tr>
<td><strong>🧠</strong></td>
<td><strong>Provider memory unloading</strong><br>Unload provider renderers to reclaim RAM and reload them on demand, without losing the signed-in session.</td>
</tr>
</table>

<br>

**Bug fixes & improvements:**
- 🔧 ChatGPT and Qwen attachment uploads stream from disk instead of inflating files through the renderer
- 🔧 Claude edited files are transported after edit, not just newly created files
- 🔧 Per-caller Qwen conversation state — callers no longer share one chat pointer
- 🔧 Supervisor stdout retries are bounded; a stalled pipe no longer busy-spins
- 🔧 Preflight catches a running Electron process older than its source
- 🔧 Review automation serialises through a global lock and batches one review per push

The provider engine system, CLI, WebSocket streaming, and multi-model queries introduced
in v4.1.0 remain documented below.

---

## Getting Started

### Requirements

- [Node.js 18+](https://nodejs.org/) (for MCP server and CLI)
- **Windows 10/11** — pre-built installer available
- **macOS / Linux** — supported via source code

<br>

### Install

<table>
<tr>
<td width="50%">

**Download Installer (Windows)**

Download the latest release and run the installer.

<br>

[Download Proxima v4.2.0 →](https://github.com/Ahad690/Proxima/releases)

</td>
<td width="50%">

**Run from Source (Windows / macOS / Linux)**

```bash
git clone https://github.com/Ahad690/Proxima.git
cd Proxima
git checkout ahad/provider-work   # v4.2.0 work; omit once merged to main
npm install
npm start
```

</td>
</tr>
</table>

> Electron will open the Proxima window. Log in to your AI providers, enable the ones you want in Settings (Claude and Qwen start disabled), enable REST API, and you're ready.

<br>

**CLI install:**
- **Windows:** Settings → **⚡ Install CLI to PATH**, or `npm link`
- **macOS / Linux:** `npm link` (may need `sudo npm link`)

<br>

### Connect to your editor

1. Open Proxima and log into your AI providers (one-time setup)
2. Go to **Settings → MCP Configuration** → copy the config
3. Paste into your editor's MCP config file:

```json
{
  "mcpServers": {
    "proxima": {
      "command": "node",
      "args": ["C:/path/to/Proxima/src/mcp-server-v3.js"]
    }
  }
}
```

4. Restart your editor. The tools will appear.

> **Tip:** Use the copy button in Settings — don't type the path manually.

**Works with:** Cursor · VS Code (MCP extension) · Claude Desktop · Windsurf · Gemini CLI · any MCP-compatible client

---

## Supported Providers

<table>
<tr>
<td align="center" width="20%">
<br>
<strong>ChatGPT</strong>
<br>
OpenAI's GPT
<br><br>
</td>
<td align="center" width="20%">
<br>
<strong>Claude</strong>
<br>
Anthropic's Claude
<br><br>
</td>
<td align="center" width="20%">
<br>
<strong>Gemini</strong>
<br>
Google's Gemini
<br><br>
</td>
<td align="center" width="20%">
<br>
<strong>Qwen</strong>
<br>
Alibaba's Qwen 3.8
<br><br>
</td>
<td align="center" width="20%">
<br>
<strong>Perplexity</strong>
<br>
Web search & research
<br><br>
</td>
</tr>
</table>

Each provider runs through a dedicated **engine script** that handles communication at the browser level. Responses are streamed via SSE using your existing login. ChatGPT, Claude, Gemini, and Perplexity fall back to DOM-based interaction if their engine cannot connect; a Claude call pinned to a specific conversation fails instead of falling back, so it cannot answer in the wrong thread. **Qwen has no DOM fallback** — it is API-first, and a failed API path raises an error rather than typing into the page.

<br>


---

## How It Works

In v4.2.0, Proxima uses a **Provider Engine System** instead of DOM scraping.

When you send a query, Proxima uses a lightweight engine script within the provider's browser tab. That script handles communication at the browser level and streams the response back via SSE. If the engine fails and the provider has a DOM path, Proxima falls back to DOM-based interaction. Qwen is the exception: it is API-only, so a failure is reported instead of being retyped into the page.

```
Your editor → MCP tool call → Proxima local server
                                      ↓
                           Engine injected into session
                                      ↓
                      Browser-level communication (SSE stream)
                                      ↓
                              Response returned
```

<br>

<table>
<tr><th>Engine</th><th>Provider</th><th>How it works</th></tr>
<tr><td><code>chatgpt-engine.js</code></td><td>ChatGPT</td><td>Handles proof-of-work challenges, streams via SSE</td></tr>
<tr><td><code>claude-engine.js</code></td><td>Claude</td><td>Org-level auth handling, SSE streaming, auto-recovery</td></tr>
<tr><td><code>gemini-engine.js</code></td><td>Gemini</td><td>SSE streaming with auto-reconnect</td></tr>
<tr><td><code>qwen-engine.js</code></td><td>Qwen</td><td>API-first, per-caller conversation state, signed requests; no DOM fallback</td></tr>
<tr><td><code>perplexity-engine.js</code></td><td>Perplexity</td><td>SSE streaming</td></tr>
</table>

---

## Claude Orchestration Loop

Proxima can drive a long-lived Claude thread as a **supervisor** while your coding agent
does the tool work. The agent runs tools, tests, and deploys locally; Claude is called
only at checkpoints, so one Claude turn can cover dozens of tool calls.

The supervisor has no tools of its own — it sees only the message and the files you
attach — so evidence travels as real files, not summaries.

```bash
# First turn: start the thread and remember its id
node tools/orchestrate/supervisor.cjs \
  --message-file turn1.md --new --state ./supervisor-state.json > reply1.md

# Later turns: resume the remembered thread
node tools/orchestrate/supervisor.cjs \
  --message-file turn2.md --state ./supervisor-state.json

# Attach the evidence the supervisor should judge
node tools/orchestrate/supervisor.cjs \
  --message-file turn3.md \
  --attach ./artifacts/diff.patch \
  --attach ./artifacts/test-output.txt \
  --state ./supervisor-state.json
```

Proxima must be running and logged in to Claude. On Windows, keep each command on one
line — `\` is not a continuation character in cmd or PowerShell. See
[docs/PROXIMA_CLAUDE_ORCHESTRATION.md](docs/PROXIMA_CLAUDE_ORCHESTRATION.md) for the
message contract, attachment rules, state-file behaviour, and troubleshooting.

### Model configuration

All provider chains live in `models.json`:

```json
{
  "claude": { "effort": "high", "models": ["claude-mythos-5-2", "claude-opus-5-5"] },
  "chatgpt": { "effort": "max", "models": ["gpt-6-thinking", "gpt-5-6-thinking"] },
  "qwen": { "models": ["qwen3.8-max", "qwen3.7-max"] }
}
```

Within a family, the highest `major.minor` is tried first, so adding
`gpt-6.2-thinking` ahead of `gpt-6-thinking` upgrades ChatGPT without a code change. The
last model that answered is remembered as the fallback. Claude advances on
`403 permission_error/model_not_available`; ChatGPT and Qwen advance on a
model-unavailable error from their engines. An explicit `model` / `--model` disables the
chain. Gemini and Perplexity are unchanged: their engines do not take a versioned model
id.

With `ANTHROPIC_API_KEY` set, Claude's `autoLatest` uses `GET /v1/models` to replace each
Claude family with the newest active id. Without a key, the file is the source of truth —
the claude.ai web session itself has no models-list endpoint. `npm run models` prints every
provider chain; `npm run claude:models` resolves the Anthropic API for Claude, and
`npm run claude:models -- --write` updates the `claude` section of `models.json` without
touching the other providers. `PROXIMA_MODELS` overrides the path, and a `models.json` in
Proxima's user-data directory wins over the repo copy.

---

## CLI Tool

The `proxima` CLI lets you use any AI provider from your terminal.

<br>

### Install

<table>
<tr>
<td width="33%">

**From the app**

Settings → ⚡ Install CLI to PATH

</td>
<td width="33%">

**From source**

```bash
npm link                  # Windows
sudo npm link             # macOS / Linux
```

</td>
<td width="33%">

**Without installing**

```bash
npm run cli -- ask "question"
```

</td>
</tr>
</table>

<br>

### Commands

```bash
# Ask any provider
proxima ask "How does async/await work in JS?"
proxima ask claude "Review this approach"
proxima ask chatgpt "Explain this error"

# Search
proxima search "latest Node.js release"

# Code
proxima code "REST API with Express and JWT auth"
proxima code review "function fetchUser(id) { ... }"
proxima code explain "async/await"

# Smart tools
proxima fix "SyntaxError: Unexpected token '<'"
proxima debate "tabs vs spaces"
proxima audit "SELECT * FROM users WHERE id=" + req.query.id
proxima brainstorm "features for a dev productivity tool"

# Analyze a URL or a block of text
proxima analyze "https://example.com"

# Translate
proxima translate "Hello world" --to Hindi

# Compare all providers
proxima compare "Bun vs Node.js for production"

# Utilities
proxima status                     # server status
proxima stats                      # response time stats
proxima models                     # list available providers
proxima new                        # reset all conversations
```

### Pipe Support

```bash
# Fix build errors directly
npm run build 2>&1 | proxima fix

# Review a git diff
git diff | proxima code review

# Pass file as context
proxima ask "What does this do?" --file src/server.js
```

<br>

### Flags

<table>
<tr><th>Flag</th><th>What it does</th></tr>
<tr><td><code>-m</code> / <code>--model</code></td><td>Override provider (<code>claude</code>, <code>chatgpt</code>, <code>gemini</code>, <code>qwen</code>, <code>perplexity</code>, <code>auto</code>)</td></tr>
<tr><td><code>-l</code> / <code>--lang</code></td><td>Specify code language</td></tr>
<tr><td><code>--file</code></td><td>Include a file as context</td></tr>
<tr><td><code>--to</code></td><td>Target language for translate</td></tr>
<tr><td><code>--from</code></td><td>Source language for translate</td></tr>
</table>

---

## Local Review Automation

Proxima ships a local review loop that uses the same browser sessions — no API keys and
no cloud runner.

```bash
# Install the pre-push hook in the current repo
npm run hooks:install

# Review one commit manually
npm run review -- <sha>

# Review-only loop (the default: no patches applied)
npm run loop:local

# Let the loop generate and apply patches for this run
node scripts/proxima-loop.cjs --auto-fix
```

Reviews are written to `perplexity-reviews/<shortSha>.md`. The loop defaults to
review-only (`enableAutoFix: false` in `proxima-automation.config.json`); repair, tests,
and bot branches are opt-in. Bot branches use `proxima/fix-<shortSha>-iter-<n>`.

See [docs/local-automation.md](docs/local-automation.md) for configuration and recovery.

Environment overrides for a single run:

| Variable | Effect |
|---|---|
| `PROXIMA_SKIP_REVIEW=1` | Skip the review for this push |
| `PROXIMA_REVIEW_MODEL` | Override the review model |
| `PROXIMA_REPAIR_MODEL` | Override the repair model |
| `PROXIMA_REVIEW_DIR` | Write reviews to another directory |
| `PROXIMA_BASE_URL` | Point the loop at a different Proxima REST URL |
| `PROXIMA_IPC_PORT` | Use a specific Proxima IPC port |

---

## REST API

Proxima runs an OpenAI-compatible REST API at `http://localhost:3210`.

Enable it in **Settings → REST API & CLI**.

<br>

### Endpoints

```
POST /v1/chat/completions   — OpenAI-compatible chat
GET  /v1/models             — List available models
GET  /v1/functions          — API function catalog with examples
GET  /v1/stats              — Response time stats per provider
POST /v1/conversations/new  — Reset all conversations
GET  /api/status            — Server status
GET  /docs                  — Interactive API docs (with live chat widget)
GET  /cli                   — CLI documentation
GET  /ws                    — WebSocket documentation
```

<br>

### Functions

The `"function"` field controls what happens. No function = normal chat.

<table>
<tr><th>Function</th><th>Body Fields</th><th>What it does</th></tr>
<tr><td><em>(none)</em></td><td><code>model</code>, <code>message</code></td><td>Normal chat</td></tr>
<tr><td><code>"search"</code></td><td><code>model</code>, <code>message</code>, <code>function</code></td><td>Web search + AI analysis</td></tr>
<tr><td><code>"translate"</code></td><td><code>model</code>, <code>message</code>, <code>function</code>, <code>to</code></td><td>Translate text</td></tr>
<tr><td><code>"brainstorm"</code></td><td><code>model</code>, <code>message</code>, <code>function</code></td><td>Generate ideas</td></tr>
<tr><td><code>"code"</code></td><td><code>model</code>, <code>message</code>, <code>function</code>, <code>action</code></td><td>Code generate/review/debug/explain</td></tr>
<tr><td><code>"analyze"</code></td><td><code>model</code>, <code>function</code>, <code>url</code></td><td>Analyze URL or content</td></tr>
<tr><td><code>"security_audit"</code></td><td><code>model</code>, <code>code</code>, <code>function</code></td><td>Scan code for vulnerabilities</td></tr>
<tr><td><code>"debate"</code></td><td><code>model</code>, <code>message</code>, <code>function</code></td><td>Multi-perspective debate</td></tr>
</table>

<br>

### Examples

**Chat:**
```bash
curl http://localhost:3210/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "claude", "message": "What is AI?"}'
```

**Search:**
```bash
curl http://localhost:3210/v1/chat/completions \
  -d '{"model": "perplexity", "message": "AI news 2026", "function": "search"}'
```

**Translate:**
```bash
curl http://localhost:3210/v1/chat/completions \
  -d '{"model": "gemini", "message": "Hello world", "function": "translate", "to": "Hindi"}'
```

**Code Generate:**
```bash
curl http://localhost:3210/v1/chat/completions \
  -d '{"model": "claude", "message": "Sort algorithm", "function": "code", "action": "generate", "language": "Python"}'
```

**Query All Providers:**
```bash
curl http://localhost:3210/v1/chat/completions \
  -d '{"model": "all", "message": "Explain quantum computing"}'
```

**Security Audit:**
```bash
curl http://localhost:3210/v1/chat/completions \
  -d '{"model": "claude", "function": "security_audit", "code": "db.query(\"SELECT * FROM users WHERE id=\" + req.query.id)"}'
```

<br>

### Multi-model queries

```javascript
model: "all"                       // all enabled providers
model: ["claude", "chatgpt"]       // specific providers
```

<br>

### Response Format

```json
{
  "id": "proxima-abc123",
  "model": "claude",
  "choices": [{
    "message": {
      "role": "assistant",
      "content": "AI response here..."
    }
  }],
  "proxima": {
    "provider": "claude",
    "responseTimeMs": 2400
  }
}
```

When using `model: "all"`, each provider gets its own entry in `choices[]`.

---

## SDKs

<table>
<tr>
<td width="50%">

### Python

```python
from proxima import Proxima
client = Proxima()

# Chat — any model
response = client.chat("Hello", model="claude")
response = client.chat("Hello", model="chatgpt")
response = client.chat("Hello")  # auto picks best
print(response.text)
print(response.response_time_ms)

# Search
result = client.chat("AI news 2026",
    model="perplexity", function="search")

# Translate
hindi = client.chat("Hello world",
    model="gemini", function="translate",
    to="Hindi")

# Code
code = client.chat("Sort algorithm",
    model="claude", function="code",
    action="generate", language="Python")

# System
models = client.get_models()
stats = client.get_stats()
client.new_conversation()
```

`pip install requests`, then copy `sdk/proxima.py` to your project.

</td>
<td width="50%">

### JavaScript

```javascript
const { Proxima } = require('./sdk/proxima');
const client = new Proxima();

// Chat — any model
const res = await client.chat("Hello",
    { model: "claude" });
console.log(res.text);

// Search
const news = await client.chat("AI news",
    { model: "perplexity",
      function: "search" });

// Translate
const hindi = await client.chat("Hello",
    { model: "gemini",
      function: "translate",
      to: "Hindi" });

// Code generate
const code = await client.chat("Sort algo",
    { model: "claude",
      function: "code",
      action: "generate" });

// System
const models = await client.getModels();
const stats = await client.getStats();
```

Works with Node.js 18+ (native `fetch`).

</td>
</tr>
</table>

<br>

### SDK Configuration

```python
client = Proxima(base_url="http://192.168.1.100:3210")   # custom URL
client = Proxima(default_model="claude")                  # default model
```

---

## WebSocket

Real-time streaming AI at `ws://localhost:3210/ws`.

Requires REST API to be enabled in Settings.

<br>

### Example

```javascript
const ws = new WebSocket("ws://localhost:3210/ws");

ws.send(JSON.stringify({
  action: "ask",
  model: "claude",
  message: "What is a closure?",
  id: "req_1"
}));

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  // { type: "status",   id: "req_1", status: "processing", model: "claude" }
  // { type: "response", id: "req_1", model: "claude", content: "...", responseTimeMs: 2400 }
};
```

<br>

### Available Actions

<table>
<tr><th>Action</th><th>What it does</th></tr>
<tr><td><code>ask</code> / <code>chat</code></td><td>Chat with any provider</td></tr>
<tr><td><code>search</code></td><td>Web search</td></tr>
<tr><td><code>code</code></td><td>generate / review / explain / optimize / debug</td></tr>
<tr><td><code>translate</code></td><td>Translate text</td></tr>
<tr><td><code>brainstorm</code></td><td>Generate ideas</td></tr>
<tr><td><code>debate</code></td><td>Multi-provider debate (queries all providers)</td></tr>
<tr><td><code>audit</code></td><td>Security code audit</td></tr>
<tr><td><code>new_conversation</code></td><td>Reset conversation context for all providers</td></tr>
<tr><td><code>stats</code></td><td>Connection and provider statistics</td></tr>
<tr><td><code>ping</code></td><td>Keepalive — returns <code>pong</code></td></tr>
</table>

---

## MCP Tools

### 🤖 AI Provider Tools

<table>
<tr><th>Tool</th><th>What it does</th></tr>
<tr><td><code>ask_chatgpt</code></td><td>Query ChatGPT (file context via <code>files</code>)</td></tr>
<tr><td><code>ask_claude</code></td><td>Query Claude (real file attachments; resume a thread by id)</td></tr>
<tr><td><code>ask_gemini</code></td><td>Query Gemini (file context via <code>files</code>)</td></tr>
<tr><td><code>ask_qwen</code></td><td>Query Qwen 3.8 (real image/video/audio/document attachments; image generation and editing)</td></tr>
<tr><td><code>ask_perplexity</code></td><td>Query Perplexity</td></tr>
<tr><td><code>ask_all_ais</code></td><td>Send same query to all providers at once</td></tr>
<tr><td><code>ask_selected</code></td><td>Pick specific providers to query</td></tr>
<tr><td><code>compare_ais</code></td><td>Get and compare responses side by side</td></tr>
<tr><td><code>smart_query</code></td><td>Auto-picks best provider, falls back if one fails</td></tr>
</table>

### 🔧 Development Tools

<table>
<tr><th>Tool</th><th>What it does</th></tr>
<tr><td><code>solve</code></td><td>One-shot problem solver — senior engineer level</td></tr>
<tr><td><code>fix_error</code></td><td>Root cause + exact fix for any error</td></tr>
<tr><td><code>build_architecture</code></td><td>Full project architecture blueprint</td></tr>
<tr><td><code>write_tests</code></td><td>Generate tests (jest / vitest / mocha / pytest)</td></tr>
<tr><td><code>explain_error</code></td><td>Error explained in plain terms, no jargon</td></tr>
<tr><td><code>convert_code</code></td><td>Convert code between languages or frameworks</td></tr>
</table>

### ⚔️ Multi-AI Tools

<table>
<tr><th>Tool</th><th>What it does</th></tr>
<tr><td><code>chain_query</code></td><td>Sequential multi-AI pipeline — use <code>{previous}</code> to pass output forward</td></tr>
<tr><td><code>debate</code></td><td>Multi-provider debate with FOR / AGAINST / NEUTRAL stances</td></tr>
<tr><td><code>verify</code></td><td>Cross-provider answer verification with confidence score (0–100%)</td></tr>
<tr><td><code>security_audit</code></td><td>Code security scan — flags CRITICAL / HIGH / MEDIUM / LOW issues</td></tr>
</table>

### 💻 Code Tools

<table>
<tr><th>Tool</th><th>What it does</th></tr>
<tr><td><code>generate_code</code></td><td>Generate code from a description</td></tr>
<tr><td><code>explain_code</code></td><td>Plain-English explanation of any code</td></tr>
<tr><td><code>optimize_code</code></td><td>Performance improvement suggestions</td></tr>
<tr><td><code>review_code</code></td><td>Code review feedback</td></tr>
<tr><td><code>verify_code</code></td><td>Check against best practices</td></tr>
</table>

### 🔍 Search Tools

<table>
<tr><th>Tool</th><th>What it does</th></tr>
<tr><td><code>deep_search</code></td><td>Comprehensive web search</td></tr>
<tr><td><code>internet_search</code></td><td>General internet search on any topic</td></tr>
<tr><td><code>news_search</code></td><td>Latest news articles</td></tr>
<tr><td><code>reddit_search</code></td><td>Reddit discussions</td></tr>
<tr><td><code>github_search</code></td><td>Find open-source repos, code, and solutions on GitHub</td></tr>
<tr><td><code>academic_search</code></td><td>Papers and research</td></tr>
<tr><td><code>math_search</code></td><td>Math problems step-by-step</td></tr>
</table>

### 📝 Content Tools

<table>
<tr><th>Tool</th><th>What it does</th></tr>
<tr><td><code>brainstorm</code></td><td>Generate ideas on any topic</td></tr>
<tr><td><code>summarize_url</code></td><td>Summarize any URL</td></tr>
<tr><td><code>generate_article</code></td><td>Full article generation</td></tr>
<tr><td><code>writing_help</code></td><td>Writing assistance</td></tr>
<tr><td><code>fact_check</code></td><td>Fact verification</td></tr>
<tr><td><code>find_stats</code></td><td>Find statistics and data</td></tr>
<tr><td><code>how_to</code></td><td>Step-by-step instructions</td></tr>
<tr><td><code>compare</code></td><td>Compare two things in depth</td></tr>
</table>

### 🔬 Analysis Tools

<table>
<tr><th>Tool</th><th>What it does</th></tr>
<tr><td><code>analyze_document</code></td><td>Analyze documents from URL</td></tr>
<tr><td><code>extract_data</code></td><td>Extract structured data from text or URL</td></tr>
<tr><td><code>get_ui_reference</code></td><td>UI/UX design consultant — colors, layouts, components, CSS tokens, and code improvements</td></tr>
</table>

### 📁 File Tools

<table>
<tr><th>Tool</th><th>What it does</th></tr>
<tr><td><code>analyze_file</code></td><td>Upload and analyze a local file</td></tr>
<tr><td><code>review_code_file</code></td><td>Code review on a local file (bugs, performance, security)</td></tr>
</table>

### 🪟 Window Controls

<table>
<tr><th>Tool</th><th>What it does</th></tr>
<tr><td><code>show_window</code></td><td>Show the Proxima window</td></tr>
<tr><td><code>hide_window</code></td><td>Hide to system tray</td></tr>
<tr><td><code>toggle_window</code></td><td>Toggle visibility</td></tr>
<tr><td><code>set_headless_mode</code></td><td>Run fully in background</td></tr>
</table>

### 🔄 Session Tools

<table>
<tr><th>Tool</th><th>What it does</th></tr>
<tr><td><code>new_conversation</code></td><td>Reset conversation context</td></tr>
<tr><td><code>clear_cache</code></td><td>Clear response cache</td></tr>
<tr><td><code>conversation_export</code></td><td>Export full conversation history</td></tr>
<tr><td><code>claude_conversation</code></td><td>Inspect a Claude thread by id or URL</td></tr>
<tr><td><code>claude_artifacts</code></td><td>Download files a Claude thread created or edited to disk</td></tr>
</table>

---

## Security & Privacy

Since Proxima works without API keys, a few things worth knowing:

- **No credentials stored.** Proxima uses your existing browser session cookies — the same way you're already logged in.
- **Nothing leaves your machine** except the queries and files you send to AI providers you're logged into.
- **Attachments are real uploads.** A file you attach to Claude, ChatGPT, or Qwen is uploaded to that provider, exactly as if you had attached it in the provider's web UI. Redact secrets first.
- **Runs on localhost.** The MCP server, REST API, and WebSocket are all local. Nothing is exposed to the internet.
- **No telemetry.** Proxima doesn't collect or send any usage data anywhere.
- **Sessions are yours.** If you log out from a provider's website or clear browser data, you'll need to log in again through Proxima.

> Proxima doesn't bypass authentication — it uses the sessions you already have. Same as using the site in a browser.

---

## Project Structure

```
Proxima/
├── electron/
│   ├── main-v2.cjs                  # Electron main process
│   ├── browser-manager.cjs          # Browser session management
│   ├── claude-models.cjs            # Claude config + Anthropic latest-version resolver
│   ├── model-registry.cjs           # Universal family/version chains + last-working state
│   ├── rest-api.cjs                 # REST API server (OpenAI-compatible)
│   ├── ws-server.cjs                # WebSocket server
│   ├── provider-api.cjs             # Provider engine injection manager
│   ├── index-v2.html                # App UI
│   ├── preload.cjs                  # Renderer preload bridge
│   └── providers/
│       ├── chatgpt-engine.js        # SHA3-512 POW + SSE streaming
│       ├── chatgpt-upload.cjs       # ChatGPT attachment upload
│       ├── claude-engine.js         # Org auth + SSE streaming
│       ├── claude-upload.cjs        # Claude attachment upload
│       ├── gemini-engine.js         # Session SSE streaming
│       ├── qwen-engine.js           # API-first Qwen 3.8 engine (no DOM fallback)
│       ├── qwen-upload.cjs          # Qwen OSS attachment upload
│       └── perplexity-engine.js     # SSE streaming
├── cli/
│   ├── proxima-cli.cjs              # Terminal CLI
│   ├── proxima-review.cjs           # Code review (manual or pre-push hook)
│   └── install-hooks.cjs            # Git hook installer
├── scripts/
│   ├── proxima-loop.cjs             # Review / repair / test loop
│   └── proxima-repair.cjs           # Patch generation and validation
├── tools/
│   ├── orchestrate/
│   │   ├── supervisor.cjs           # Claude checkpoint CLI
│   │   └── preflight.cjs            # Readiness checks
│   └── qa-video-review/             # Record a run, review it with Qwen
├── src/
│   ├── mcp-server-v3.js             # MCP server (57 tools)
│   └── enabled-providers.json       # Provider config
├── sdk/
│   ├── proxima.py                   # Python SDK
│   └── proxima.js                   # JavaScript SDK
├── docs/                            # Orchestration and automation guides
├── assets/                          # Icons and demo assets
├── models.json                      # Per-provider model chains and effort
└── package.json
```

---

## Troubleshooting

**Windows Firewall prompt on first launch**
<br>Proxima listens on localhost for the app IPC port (19222, or 19223 if 19222 is taken) and for the REST API on 3210. Click Allow — it only accepts local connections.

**Provider shows "Not logged in"**
<br>Each provider has a different login method:
- **ChatGPT, Claude, Perplexity** — click the provider tab and log in using OTP (email code). Google Sign-In is restricted in embedded browsers by Google's policy.
- **Qwen** — open the Qwen tab and sign in. The engine uses the resulting `chat.qwen.ai` cookie session.
- **Gemini** — uses cookie-based authentication. Log in to Google in your regular browser first, then Proxima picks up the session automatically.

**Qwen sends hang, or preflight reports "Qwen WAF" / "Qwen signing"**
<br>A slider CAPTCHA is pending or the signing SDK has not booted. Open the Qwen tab, solve the slider if one is shown, then reload the tab and wait about ten seconds. Unsigned requests are what plant the CAPTCHA in the first place.

**A source change behaves like a broken feature**
<br>Anything in `electron/**`, and the provider engines, only takes effect after Proxima restarts. Run `node tools/orchestrate/preflight.cjs`; its "running code is current" check tells a stale process apart from a real bug.

**Orchestration: `MCP server exited` or the thread id is not saved**
<br>Run preflight first. If the state file stays empty after a successful first turn, the reply did not contain the `_conversation_id` marker — check the reply tail and the Claude tab. Full troubleshooting is in [docs/PROXIMA_CLAUDE_ORCHESTRATION.md](docs/PROXIMA_CLAUDE_ORCHESTRATION.md).

**Review automation: the pre-push hook does not fire**
<br>Run `npm run hooks:install` from the repository root, then confirm `.git/hooks/pre-push` exists. Reviews are written to `perplexity-reviews/`.

**REST API not responding**
<br>Check that REST API is enabled in Settings → REST API & CLI section. Visit `http://localhost:3210` in your browser to verify.

**MCP tools not showing in editor**
1. Make sure Proxima is running
2. Verify the path in your MCP config (use the Settings copy button)
3. Restart your editor

**CLI: `proxima` not found after install**
<br>Open a fresh terminal. If still not found, click **🔧 Fix** in Settings → CLI section.

**CLI: "Cannot connect to Proxima"**
<br>Proxima must be running and REST API must be enabled. The CLI connects to `localhost:3210`.

**WebSocket won't connect**
<br>WebSocket shares the REST API server. Enable REST API in Settings first.

---

## License

Personal, non-commercial use only. See [LICENSE](LICENSE) for details.

---

<div align="center">

<br>

**Proxima v4.2.0** — One API, All AI Models ⚡

Made by [Zen4-bit](https://github.com/Zen4-bit)

<br>

If it saved you time, a ⭐ goes a long way.

<br>

</div>
