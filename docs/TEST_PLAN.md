# Test plan — unit and behavioral (Gherkin)

Two layers, one rule: **the zero-dependency policy does not relax for testing.**
Everything runs under `node --test` exactly as today. No cucumber-js, no jest,
no chai. Gherkin is a *format*, not a framework — we parse the subset we use
(~150 lines, specified below) rather than adopting a dependency the repo's own
policy forbids.

Machine-attached honesty applies to tests too: a scenario that needs a live
model states so, is tagged `@live`, is excluded from CI, and its latest result
is recorded with the machine it ran on.

---

## 1. Unit layer (`extension/test/*.test.js`, node:test)

Existing suites stay authoritative for what they cover (manifest, downloader,
parted download, runtime policy, system libraries, context rules, completion
client). The gaps below are ordered by how likely the code is to be wrong
tonight.

### 1.1 SSE stream parser (`client.js`) — highest risk, pure function, no stubs needed
Feed synthetic byte streams through `chatStream` against a stubbed `fetch`:
- comment/keep-alive lines (`:\n\n`) mid-stream — must be skipped, not crash
  the JSON parse (llama-server emits them after 30 s of silence; at our
  prefill speeds this fires constantly)
- terminal `{"error":{...}}` frame instead of a delta — must surface as an
  error, never a blank result
- first chunk `{"role":"assistant","content":null}` — null, not `""`
- `content`, `reasoning_content`, `tool_calls` deltas interleaved — three
  buffers, none overwrites another
- a `data:` line split across two reads; a final un-terminated line; `[DONE]`
- `usage` and `timings` captured from the last frame that carries them

### 1.2 Reasoning controls (`client.js`, `chatView.js`)
- `reasoningOptions()`: profile without `reasoning` → `{}` always; invalid
  strength → `{}`; valid → exact `chat_template_kwargs` shape
- **the `'off'` regression test**: once fixed, `'off'` must produce an explicit
  zero-thinking request (`--reasoning-budget 0` path or `low`), and a test must
  fail if `'off'` ever again maps to "send nothing" (which the template treats
  as `high`)
- `callSite: 'selection'` → `low` regardless of the configured depth

### 1.3 Argv construction (`runtimeManager.buildArguments`) — golden tests
One golden argv per profile shape: repack on/off, draft model
present/absent/`enableDraftModel` off/`draftDisabledForSession`, GPU layers
auto/off/N/garbage, context override set/unset, prompt-cache clamping. Assert
the *complete* argv, not flag presence — order and pairing bugs (a flag whose
value lands on the next flag) are the real failure mode. Then one test that
`startWithDraftFallback` retries exactly once, without the draft flags, and
only when the failed launch used them.

### 1.4 History budget (`historyBudget.js`)
Boundaries: exact fit, one-token overflow evicts the *oldest* pair, `maxTurns`
cap wins over token room, output reservation subtracts the same
`maxOutputTokens` the request will send, empty history, single oversized turn.

### 1.5 Conversation store (`conversationStore.js`)
Round-trip; atomic write (a leftover `.part`/temp file from a simulated crash
is ignored and cleaned); corrupt JSON → empty history plus a log line, never a
throw; `clear()` removes the file; oversized transcript pruned by the stated
policy.

### 1.6 Context builder determinism (`contextBuilder.js`) — the §0 cache work's safety net
- same inputs → **byte-identical** output, twice in a row (guards the snapshot
  design's core assumption)
- block order is stable-first: project memory and retrieved files precede
  diagnostics and selection (once the reorder lands, this test pins it)
- sensitive paths excluded; `neutralizeContextMarkup` applied; per-block and
  total truncation budgets respected

### 1.7 Agent layer (`agent/permissions.js`, `agent/toolExecutor.js`, `agent/agentLoop.js`)
- mode normalization: unknown → `off`; each of `off/confirm/auto` documented
- allowlist matching is **parsed-argv-prefix**, never substring: `npm test`
  allowed must not admit `npm test; rm -rf ~`, `npm&&curl`, quoted tricks, or
  `npmXtest`; empty rules allow nothing
- `run_command`: spawn only (a test greps the agent sources for
  `child_process.exec` and fails if it appears — same style as check-source),
  cwd is the workspace, output truncated at the stated budget, timeout kills
- `read_file`/`search`: refuse `contextRules`-excluded paths (`.env` proof)
- `write_file`/`edit_file`: `old_text` must match exactly once — zero matches
  refuses, two matches refuses and names the count; writes under
  `.localcoder/` refuse (it is injected into every prompt); all writes go
  through the injected `applyEdit` — stub it and assert `fs.writeFile` is
  never reached
- loop: `maxSteps` cap ends the loop with a visible notice; abort mid-tool
  propagates; a tool result exceeding budget is truncated before replay;
  assistant messages carrying `tool_calls` replay with their
  `reasoning_content`, completed turns replay content-only
- audit: every executed tool produces a record with path/argv, byte delta for
  writes, and never file content

### 1.8 Gates test themselves (`tools/check-manifest.js`, `tools/check-source.js`)
Meta-tests: run each gate in-process against a mutated fixture (bad hash
length, prohibited host, `fim` missing where `fimTemplate` exists, lock asset
without sha256) and assert it **fails**. A gate that cannot fail is
decoration; today nothing proves either gate still rejects anything.

### 1.9 FIM (`client.js`, `inlineCompletion.js`)
`buildFimPrompt` with default and overridden templates; `fim: false` refusal;
`cleanCompletion` / `removeSuffixOverlap` edges (overlap shorter than 3, NUL
byte, fence-only response).

---

## 2. Behavioral layer — Gherkin

### 2.1 Runner: `tools/bdd-runner.js` (new, ~150 lines, zero-dep)
Parses the subset we use: `Feature:`, `Scenario:`, `Given/When/Then/And/But`,
`@tags`, and `"""` doc strings. No Backgrounds, no Examples tables, no i18n —
if a scenario needs them, rewrite the scenario. Each `.feature` file becomes a
`node:test` `describe`, each scenario a `test`. Steps resolve against a regex
registry in `extension/test/features/steps/*.js`. **An unmatched step fails
the run** — no silent "pending" in CI, ever. `@live`-tagged scenarios are
skipped unless `LOCAL_CODER_LIVE=1`.

Runner self-test: `extension/test/bdd-runner.test.js` — parse errors name the
file and line; tag filtering; doc-string fidelity; duplicate step definitions
rejected.

### 2.2 Features (`extension/test/features/*.feature`)

**model-acquisition.feature** — download resumes after a killed transfer;
corrupted file quarantined, never loaded; hash verification cannot be disabled
by settings; import path verifies before accepting.

**runtime-lifecycle.feature** — untrusted workspace refuses to start; ready
only after `/health` ok; draft-model failure falls back to a working plain
start with a visible warning (not a broken model); stop terminates the child.

**chat-caching.feature** `@live` — the §0 acceptance criteria as scenarios:
turn 2 with an unchanged workspace reprocesses only the new turn's tokens
(asserted from `timings.prompt_n`, not wall clock); an idle pause between
turns does not evict the cache (`--no-cache-idle-slots` decision, recorded
either way); a context refresh honestly re-prefills.

**reasoning.feature** — `'off'` produces no thinking phase (regression for the
footgun); `selection` commands think at `low`; a response that spends its whole
budget thinking renders the explanatory note, never an empty bubble.

**agent-permissions.feature** — in `confirm` mode a command runs only after
approval and a decline runs nothing; an allowlisted command runs without a
prompt and `npm test; rm -rf ~` still prompts; `auto` requires the one-time
modal opt-in; every executed tool leaves an audit record; the agent cannot
read `.env` or write `.localcoder/` in any mode.

**inline-completion.feature** — FIM profile yields an insertion with control
tokens stripped; Muse profile yields no provider and the stated reason; a
sensitive path yields nothing.

**telemetry.feature** `@live` — each response logs one line with tokens,
tok/s, ms/token; the client-side pre-request gap is on the same line.

### 2.3 Live-suite wiring
`scripts/Invoke-LiveAcceptance.ps1` (Windows) and a bash twin: start the real
server with the extension's exact argv, run `LOCAL_CODER_LIVE=1 node --test`
on the `@live` features, append a dated results table (machine attached) to
`docs/VALIDATION.md`. This replaces "deployment gates rather than source-only
claims" hand-waving with a runnable list.

---

## 3. Wiring and done-criteria

- `npm run validate` grows one step: the BDD runner over non-`@live` features.
  CI stays hermetic; total added CI time must stay under ~10 s.
- New test files follow the existing naming (`*.test.js`, flat in
  `extension/test/`); features and steps live under `extension/test/features/`.
- **Done when:** `npm run validate` is green with all of the above; every
  backlog item in `REMAINING_WORK.md` §B and §C that says "tests cover each"
  points at a named test; the `@live` suite has run at least once on the
  rented instance with results in `VALIDATION.md`; and both gates have
  meta-tests proving they still reject bad input.
