# Writing a provider engine

An engine is the only place provider API knowledge lives. The gateway knows how to
manage a session; it knows nothing about how to talk to ChatGPT. That separation is
what lets an engine be rewritten without touching the gateway — and what makes a
clean-room implementation possible.

## The contract

An engine is a plain JavaScript file evaluated **in the page's own origin context**.
It must assign a namespaced global before the gateway will accept it.

File location: `gateway/engines/<provider>-engine.js`

| Provider | Required global |
|---|---|
| chatgpt | `window.__proximaChatGPT` |
| perplexity | `window.__proximaPerplexity` |
| claude | `window.__proximaClaude` |
| gemini | `window.__proximaGemini` |
| qwen | `window.__proximaQwen` |

The gateway **probes** for the global after injection. A missing global is reported as
an engine failure, distinct from a transport failure, so a caller can tell "the browser
broke" from "the provider rejected us".

## Required methods

| Method | Returns | Notes |
|---|---|---|
| `sendMessage(options)` | anything | `options.message` plus allowlisted provider options. Must throw a classified error on failure. |
| `newConversation()` | — | Clear conversation state. Required so an automated turn cannot land inside somebody's unrelated thread. |
| `getResponse()` | `string` | **Return an empty string if there is genuinely no answer yet.** Do not fabricate text — the gateway treats `''` and the `no response` sentinels as "retry", and anything else as final. |

### Optional methods

| Method | Used for |
|---|---|
| `getTypingStatus()` | `getTypingStatus` action |
| `getConversation()` | conversation introspection |
| `isReady()` | `waitForSendButton`; omit to mean "ready" |
| `getUploadToken(meta)` | attachment preflight |
| `checkAttachmentSupport(...)` | attachment preflight |
| `createUpload` / `finalizeUpload` / `uploadedFileInfo` | provider upload protocol |
| `listArtifacts(cid)` / `downloadArtifact(...)` | artifact access |
| `lastMeta()` | response metadata |

## Rules

**Same-origin fetch. Always.**
```js
fetch('/some/api/path', { credentials: 'include', headers: {...} })
```
The browser attaches the profile's session cookies and origin clearance. This is the
mechanism the whole system depends on — a request that escapes the page origin loses
authentication.

**Classify your failures.** Attach `kind` and `retryable` so the caller can decide
between waiting and re-authenticating:
```js
err.kind = 'waf';      // or 'auth' | 'upstream' | 'unknown'
err.retryable = true;
```

**Do not fake a response.** Returning a placeholder string defeats the gateway's
retry logic (invariant A8) and hands the operator a fabricated answer.

**Idempotent re-evaluation.** The engine is re-injected on every navigation. It must be
safe to run repeatedly, and must overwrite the global rather than merging into a stale
one.

## Qwen has no DOM fallback

Qwen's engine owns the conversation completely. There is no scrape-the-DOM retry path,
so a capture failure is a hard failure. Any other provider may fall back to reading the
rendered page if its API call fails.

## Porting an existing engine

If you are moving an engine you already own:

1. Copy the file to `gateway/engines/<provider>-engine.js`.
2. Confirm the global name matches the table above.
3. Confirm `sendMessage` / `newConversation` / `getResponse` exist.
4. Check how it authenticates. Anything that depended on an Electron-specific API
   (`net.request` with `useSessionCookies`, `ipcRenderer`, `webContents`) needs replacing
   with an in-page `fetch`.
5. Run: `node --test test/integration.test.js` — the gateway is exercised against a stub
   for every provider, so a contract mismatch fails fast.

If the engine was contributed by someone else under a restrictive licence, it must be
independently written against this contract rather than copied. The contract above is
sufficient; nothing in it requires reading an existing implementation.

## Testing an engine in isolation

```js
// in a test
const loader = new EngineLoader();
const src = loader.load('perplexity');
assert.ok(src.includes('__proximaPerplexity'));
```

For live verification, point `PROXIMA_GATEWAY_STATE_DIR` at a scratch directory so you
never touch a real authenticated profile.
