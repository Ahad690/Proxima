# Resolved: edited files now transport through the orchestrator

**Status: fixed and verified live.** 2026-09-01, branch `ahad/provider-work`,
commits `fdb512d` → `7aa15e1` → `fc62dd9` → `9a0edcb`.

If you previously worked around this by pulling **every** file out of a conversation
(`claude_artifacts` with no filter), **stop doing that.** It is no longer necessary, and on
a conversation with dozens of outputs it was downloading and rewriting all of them to catch
one changed file.

---

## The bug

A turn that **created** a new file delivered it. A turn that **edited an existing** file
delivered nothing, silently, while the file sat in the sandbox perfectly intact.

The cause was structural, not flaky. Proxima captured artifacts only from `create_file`
tool blocks in the response stream. An edit is performed by **`str_replace`**, a different
tool, which emits no `create_file` block — so the send path reported zero artifacts and
nothing anywhere raised an error.

Reproduced on a throwaway conversation:

| turn | action | artifacts reported | sandbox |
|---|---|---|---|
| 1 | create `PRD.md` | **1** | 49 B |
| 2 | edit it in place | **0** | 76 B |

---

## What changed

The send path now asks the sandbox what actually changed, and pulls **only those files**.

1. Before sending, it fingerprints the conversation's output files (one cheap listing call —
   no downloads).
2. It records the name and input byte-lengths of **every** tool the turn used, not just
   `create_file`.
3. If any tool could have written, it polls `wiggle/list-files` until the changed file
   reaches its **predicted size**, then downloads just that file.

The prediction is the important part. `str_replace` carries `old_str` and `new_str`, so the
resulting size is exactly `previous + (new_str − old_str)` bytes — known from the stream
before the sandbox is consulted. Verified against the live run: `49 + (52 − 25) = 76`.

### Why prediction, and not simply "wait for it to change"

Two earlier attempts failed live, and both failures are worth knowing about because they
look like success:

- The sandbox listing bumps `created_at` **immediately** but keeps reporting the **old
  size** for several seconds, and the download endpoint serves the **old body** in the
  meantime.
- Byte-matching the download against the listing does **not** catch this — both are stale at
  the same number and agree with each other.
- The listing then sits **stable** on the stale size across polls, so waiting for it to
  "settle" settles on the wrong value.

So the file arrived, at the right path, with the right byte count on the listing, unflagged —
and containing the pre-edit text. Predicting the size from the tool call is the only signal a
lagging endpoint cannot satisfy early.

---

## What you see now

Every artifact reports how it was found:

```
PROMPT.md    17B  via:stream     ← newly created, announced on the stream
PRD.md       76B  via:listing    ← edited, recovered from the sandbox
```

- `via: 'stream'` — announced by `create_file`, as before.
- `via: 'listing'` — **an edited file**. This is the class that used to vanish.
- `stale: true` — set only if the download never reached the predicted size. The file is
  still saved, and it is logged loudly. **Treat a `stale` file as untrustworthy** rather than
  as the current version.
- The send response also returns `toolCalls` (the tool names the turn used) and
  `artifactsRecovered` (how many files the listing had to recover).

The MCP reply marks recovered files inline:

```
- C:\...\claude-artifacts\<conv>\PRD.md (76 bytes) [edited file, recovered from sandbox]
```

### Cost

A turn that touches no files pays nothing — measured at **3.8 s** with zero reconciliation,
because a turn with no tool calls skips the listing entirely. A turn that edits a file pays
one listing call plus one download per **changed** file.

---

## Verified

Live, in one turn: edit an existing `PRD.md` **and** create a new `PROMPT.md`. Both arrived;
the PRD on disk kept `Section A` and gained `Section B`; nothing flagged stale.

`scripts/tests/claude-reconcile-test.cjs` — 13 assertions, in the suite
(`node scripts/tests/automation-tests.cjs`, 9/9). It drives the logic against a sandbox
stubbed to lag exactly as measured, including the stably-stale listing that defeated the two
earlier attempts, and the case where a file is created **and** edited in the same turn (the
stream then holds the pre-edit body, so "the stream mentioned it" must not count as
delivered).

---

## Known limits

- **`replace_all`.** If `str_replace` is ever called with a replace-all flag, the delta
  arithmetic is wrong by one occurrence's worth per extra match. It degrades safely — the
  file is flagged `stale: true` with a loud log rather than handed over as correct — but it
  is unhandled.
- **The read-only tool list is `['view']`.** A read must not veto the prediction, because
  the model views a file before editing it as a matter of course. Any *other* read-only
  tool would bail prediction back to the slow heuristic, and names can only be added as
  they are observed. If you see an unfamiliar tool name in `toolCalls`, that is worth
  reporting.
- **A tool that writes without naming a path** (a raw shell write, say) falls back to a
  full before/after diff of the listing, which is correct but slower.
- **Restart requirement.** These changes live in the Electron main process and the injected
  engine, so they only take effect after Proxima restarts. Run
  `node tools/orchestrate/preflight.cjs` — it compares the running process's start time
  against every source file and fails with `RESTART PROXIMA` if the code on disk is newer.
  An un-restarted change is indistinguishable from a broken feature.
