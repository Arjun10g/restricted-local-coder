# Remaining work — consolidated backlog

Everything outstanding, deduplicated from a long thread of guidance and
corrections, in execution order. Each item states how you know it is done.

**Standing rule: your own measurement outranks any citation in this repository,
including mine.** Where an item says "measure", the number you produce on the
instance is the answer. Record the machine alongside every number.

---

## A. Prove the new default actually works

The default is now `qwen3-coder-30b-a3b-q4xl`. Nothing below matters until this
passes.

- [ ] Weights staged and verified against the manifest digest
      `e71c9271166ad64865767022e86f45ea4f03a8258389460cc55c8d95e18833db`.
- [ ] `llama-server` loads it with the extension's exact argv from
      `RuntimeManager.buildArguments`, no errors.
- [ ] `/v1/chat/completions` returns non-empty content on a real coding prompt.
- [ ] **FIM verified separately.** Qwen FIM must go through `/infill` or raw
      `/completion`, **not** the chat route, which returns markdown-fenced code.
      Confirm `client.js` uses the right endpoint; the hardcoded tokens already
      match this model.
- [ ] `n_ctx_train` captured; manifest `contextSize` reconciled against it.

**Done when:** a real prompt returns real code, and inline completion produces a
usable insertion.

---

## B. Client correctness — lands regardless of model

- [ ] **SSE comment lines.** `llama-server` emits a bare `:\n\n` after 30 s of
      silence, specifically because undici (Node's fetch, what we use) times out.
      The parser must skip comment lines. At our prefill speeds this fires often.
- [ ] **Error termination.** A stream can end with `{"error": {...}}` instead of
      a delta. Render it; never a blank bubble.
- [ ] **First chunk** is `{"role":"assistant","content":null}` — null, not `""`.
- [ ] **Separate buffers** for `content`, `reasoning_content`, and `tool_calls`.
      One diff per chunk; they never mix. Never let one overwrite another.
- [ ] **Reasoning replay inside tool sequences.** Assistant messages carrying
      `tool_calls` must include their `reasoning_content` when replayed in the
      agent loop. Completed turns stay content-only. This is the industry norm
      and several model families fail without it.
- [ ] **Defensive `<think>` strip** when appending to history and when
      persisting, so a model that emits tags inline cannot poison its own
      context forever.
- [ ] **`chat.reasoningStrength: 'off'` selects the slowest mode.**
      `reasoningStrength()` returns `undefined` for `'off'`, nothing is sent,
      and the template defaults to `high` — the 147-second behaviour under a
      setting named "off". Map `'off'` to `--reasoning-budget 0` (b10355
      supports it) or at minimum to `low`.
- [ ] **FIM/chat slot thrash, document or fix.** With one slot, any inline
      completion evicts the chat conversation's KV, forcing a full re-prefill
      on the next chat turn. Acceptable while inline completion defaults off;
      say so in PERFORMANCE.md, and note the `--parallel 2` trade-off (splits
      the context budget between slots).
- [ ] `maxOutputTokens` sized as thinking + answer, since `max_tokens` counts
      reasoning tokens (proven from source).

**Done when:** tests cover each, and a truncated response renders partial output
rather than nothing.

---

## C. Throughput, latency, and context — the user asked for these explicitly

Ordering note: the first three items below outrank every knob measurement.
They were found by reading the request-assembly code
(`chatView.ask()` + `contextBuilder.build()`); details in
`RUNTIME_PERFORMANCE_SPEC.md` §0.

- [ ] **Fix the request shape.** The workspace context is embedded in the
      final user message, after the growing history, so consecutive requests
      share only the system prompt as a prefix and the context is re-prefilled
      every turn even when identical. Move stable context into the system
      message (fixed position, before history) so each turn is a pure append —
      pure prefix extension reuses KV even on SWA with no checkpoints.
      **Done when:** turn-2 prompt processing covers only the new turn's
      tokens, confirmed via `timings`.
- [ ] **Snapshot the context per conversation** instead of rebuilding
      per message (retrieval is query-dependent, so today the context differs
      every turn and even a perfect cache would miss). Volatile blocks —
      diagnostics, selection — move to the end, in the user message.
      **Done when:** two consecutive turns produce byte-identical prefixes up
      to the previous turn's end.
- [x] ~~A/B `--no-cache-idle-slots`~~ **Resolved by source reading, no A/B
      needed** (see RUNTIME_PERFORMANCE_SPEC.md §0): with explicit
      `--parallel 1`, idle-slot KV clearing is impossible (`kv_unified` only)
      and the flag merely skips a useless per-request state serialize. Keep
      it. Verify reuse the direct way instead: `timings.prompt_n` on turn 2
      after the request-shape fix.
- [ ] **Telemetry.** Send `"timings_per_token": true` and use the server's
      `timings` rather than timing deltas ourselves. Show one quiet line after
      each response: tokens, tok/s, **ms/token**. Log the same.
- [ ] **Streaming latency.** Report **median and p95** inter-token latency. The
      median is the feel; the tail is what makes a session frustrating; an
      average hides both.
- [ ] **`"return_progress": true`.** Prefill is our binding constraint and it is
      silent. This turns a dead minute into visible progress. High value.
- [ ] **`llama-bench`** both models, physical cores, `-p 512 -n 128`. Report
      pp512 and tg128 separately.
- [ ] **`-fa off` A/B.** `auto` resolves to ON on CPU via a capability probe, not
      a speed probe. Measure both directions. Note quantised V *requires* flash
      attention, so vary them together.
- [ ] **Threads.** Physical versus logical. `-t -1` and `-t 0` select logical
      cores; omitting `-t` resolves to physical. Revisit `automaticThreads()`.
      On Windows, llama.cpp does **not** exclude E-cores automatically.
- [ ] **`--cache-reuse`.** We resend a large near-identical workspace prefix each
      turn. If prefix reuse removes prompt processing from turn 2 onward, that is
      worth more than any tok/s delta.
- [ ] **KV cache type at realistic depth.** No published CPU sweep exists at
      8k–32k, so this is genuinely new data. Leave the current setting unless
      your own numbers justify changing it.
- [ ] **Context sizing by measured RSS** at 4096 / 8192 / 16384 / 32768. Choose
      the largest leaving ~8 GB headroom on a 32 GB machine that is also running
      an editor and language servers — not 1 GB.

**Done when:** `PERFORMANCE.md` carries measured tables with the machine
attached, and estimates are labelled as estimates.

---

## D. Speculative decoding — decide with evidence

- [ ] Run with `--spec-type draft-dflash --spec-draft-n-max 15`.
- [ ] **Verify engagement** by the log line `adding speculative implementation
      'draft-dflash'`. Its absence is the silent failure mode; absence of errors
      proves nothing.
- [ ] Report **acceptance rate** alongside tok/s. Near 0.15 means a known issue
      and a net slowdown — then leave it off and say so.

**Done when:** the manifest note reflects a measured outcome, not an assumption.

---

## E. Reasoning profile (Muse Glimmer, now optional)

- [ ] `reasoningStrength` as a per-request setting via `chat_template_kwargs`;
      no restart needed. Quick commands may use a shallower depth than chat.
- [ ] **Quality-versus-strength table**: all 7 benchmark tasks at low / medium /
      high / xhigh, `MaxTokens` 3072 so the harness is not the limiter. Report
      pass counts, failure modes, time-to-first-word, and total wall-clock. Say
      plainly that 7 regex tasks cannot separate 5/7 from 6/7 — that is noise.
- [ ] **Skip-thinking control**: `"reasoning_control": true`, then the control
      endpoint with `{"action":"reasoning_end"}` mid-stream. Better than guessing
      a budget in advance.
- [ ] **Reasoning UI**: streamed live and expanded, auto-collapsing when the
      first content delta arrives; plain pre-wrap, not markdown; live elapsed
      timer; auto-scroll that yields to the user; on truncation label it
      "Cancelled" and **keep the partial thought visible**.

---

## F. Agent write tools — per `AGENT_WRITE_TOOLS_SPEC.md`

- [x] `write_file` and `edit_file`, applied through `vscode.workspace.applyEdit`
      so every change lands in the undo stack. Test against a stubbed
      `applyEdit` so a later refactor to `fs.writeFile` fails the build.
- [x] `edit_file` requires `old_text` to match **exactly once**; zero refuses,
      two or more refuses and names the count.
- [x] `agent.allowWrite`, default **false**, separate from command execution.
- [x] Refuse writes under `.localcoder/` — it is injected into every prompt.
- [x] Audit records path, operation, byte delta; never content.
- [x] **Validate against the live model**: done, see `docs/AGENT_VALIDATION.md`.
      72 tasks, 190 tool calls on a 28-core EPYC 7763 with b10355 and the f16 KV
      cache: 0 malformed arguments, 0 ambiguous `old_text` in 64 `edit_file`
      calls, 64 of 72 tasks verified correct. The 8 failures are one condition —
      the model believes a `<workspace_context>` that does not contain the file
      and asks rather than calling `read_file`. Wall-clock 21-127 s per task
      warm, plus ~170 s of prefill on the first turn of a conversation with a 7k
      context.
- [x] Add an `edit_file` argument-shape task to `bench/coding-smoke.json` —
      `edit-file-argument-shape`, which fails a one-word or duplicated-line
      `old_text`.
- [x] Check whether upstream PR #26849 has merged. Both #26849 and #26879 were
      still open, but **the leak did not reproduce on b10355**: 0 of 262
      Qwen3-Coder agentic turns and 0 of 36 Muse Glimmer turns carried tool
      markup in visible content, scanning both a fixed marker list and any
      angle-bracket-shaped token. The 17% figure is not what this build does.
      Enough Muse turns to exclude 17% (p about 0.001), not enough to call the
      bug gone. Worth reporting upstream that b10355 with `--jinja` does not
      reproduce it.
- [ ] Documented behaviour, not a defect, but worth a decision: the model treats
      `<workspace_context>` as the complete truth about the workspace and will
      not call `read_file` to check a file retrieval omitted. Either instruct it
      in the system prompt that the context is partial, or accept it and phrase
      agent tasks concretely. Measured 8 of 8 failures in that condition.

---

## G. Tidy-ups

- [ ] `check-manifest.js`: `nominalBitClass` is free text and was wrong for
      `kquant-dynamic` (5.65 bpw labelled 4-bit). Assert against something real.
- [ ] Resolve `MODEL_SELECTION.md` against the new default.
- [ ] Update version references across the docs.
- [ ] `START_HERE.md`: the model, sizes, and digests all changed.

---

## H. Ship and close out

- [ ] `npm run validate` green.
- [ ] Version bumped; `$FallbackVersion` in `Start-Workstation.ps1` matches
      (CI asserts it). All `.ps1` stay ASCII + BOM.
- [ ] Tag, CI builds, release.
- [ ] **Verify the published artifact**, not a local build: digest matches its
      sidecar, the runtime is b10355, settings defaults are correct.
- [ ] Run "Verify a published Windows release" — both jobs, including the
      PowerShell 5.1 bootstrap.
- [ ] **Terminate the Shadeform instance. List instances to confirm none remain.
      Report spend.** Mandatory on success or failure.

---

## Honesty requirements for the write-up

- Every number carries its machine.
- Estimates are labelled as estimates.
- Anything skipped is reported as skipped, not omitted.
- `PERFORMANCE.md` states plainly where this lands against real usability
  floors: roughly 10 tok/s for chat, 30–40 for code generation, 40–60+ decode
  and 150–300+ prefill for agentic work. If we sit at the chat floor and below
  the agentic floor, say so. Do not oversell it.
