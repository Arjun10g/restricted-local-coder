# Runtime performance — specification

Throughput, inter-token latency, and context are to be tuned deliberately and
**measured**, not asserted. Every number written into the repository must come
from a run that is reproducible on the rented instance.

Baseline to beat, measured on b10355 with the current argv: **4.45 tok/s
generation, 10.1 tok/s prompt.** Confirm first whether that was CPU-only before
treating it as the floor.

---

## 0. The request shape defeats the cache — fix before measuring anything

Every plan in this repository says "we resend a large, nearly identical
workspace prefix every turn" and reaches for `--cache-reuse`. Read the actual
request assembly first, because the problem is worse and the fix is cheaper:

- `chatView.ask()` builds `[system, ...history, user]`, and
  `contextBuilder.build()` embeds the entire `<workspace_context>` block inside
  the **final user message**. On turn 2 the shared prefix between consecutive
  requests is the system prompt alone: the multi-thousand-token context block
  sits *after* the history, moves position every turn, and is re-prefilled even
  when byte-identical. `cache_prompt: true` is sent and buys almost nothing.
  `--cache-reuse` only partially rescues shifted chunks, and on this
  sliding-window architecture shifted-chunk reuse is exactly the case that
  needs checkpoints.
- `contextBuilder.build()` runs again on every message, and retrieval is
  query-term-dependent, so the context genuinely differs turn to turn — even a
  perfect cache would miss.

The structural fix, in order:

1. **Move the stable context into the system message** (or a fixed-position
   message directly after it, before any history). Every turn then becomes a
   pure append. Pure prefix extension is reused even on SWA models with no
   checkpoint machinery at all.
2. **Snapshot the context per conversation** — build it once when the
   conversation starts, reuse it verbatim across turns, refresh only on an
   explicit action. This also removes the per-message retrieval cost (see §4).
3. **Order blocks stable-first**: project memory and retrieved files first;
   diagnostics and the active selection — which change constantly — last, in
   the user message. A volatile block early in the prefix truncates the
   reusable region at its first differing byte.

Expected effect, to be confirmed by measurement: turn-2+ prompt processing
drops from the full prefix (~minutes at Muse Glimmer's measured 12.9 tok/s pp)
to only the new turn's tokens (~seconds). This is worth more than any flag in
§2 and it costs no memory.

**Resolved by source reading (b10355, `tools/server/server-context.cpp`,
`common/common.h:612`), superseding an earlier suspicion in this section's
first revision:** `--no-cache-idle-slots` does **not** evict KV in our
configuration. Idle-slot KV clearing only happens under unified KV
(`kv_unified`), which explicit `--parallel 1` never enables. What the default
(`cache_idle_slots = true`) actually does with one slot is a full state
serialize into the RAM prompt cache on every request — pure overhead for a
single client. **Keep the flag; no A/B needed.** Two more facts from the same
reading: pure prefix-append reuse requires *no flags at all* (`cache_prompt`
defaults on, common-prefix matching is automatic, context checkpoints default
to 32 with min step 8192), and `--cache-reuse` only matters for divergent or
removed chunks — after the request-shape fix above it is irrelevant. The
verification that matters is simply `timings.prompt_n` on turn 2.

---

## 1. The dominant lever: reasoning budget

`b10355` supports `--reasoning-budget N`:

```
-1  unrestricted (the current default)
 0  end thinking immediately
 N  cap thinking at N tokens
```

For a reasoning model on a CPU workstation this outranks every other tuning
knob. At 4.45 tok/s, 600 tokens of thinking is well over two minutes before a
single word of answer appears. Capping it is the difference between a tool
someone uses and one they abandon.

Expose it as `localCoder.runtime.reasoningBudget`:

- an integer setting, default chosen from measurement, **not** `-1`
- `0` must be reachable, so a user can turn thinking off entirely
- pass `--reasoning-budget` only when the selected profile declares
  `reasoning: true`, so nothing is sent to a model that has no thinking channel
- pair it with `--reasoning-budget-message` so a truncated thinking phase ends
  cleanly rather than mid-sentence

**Known footgun to fix while doing this:** `chatView.reasoningStrength()`
returns `undefined` when `localCoder.chat.reasoningStrength` is `'off'`, so
nothing is sent and the template falls back to its own default — which is
`high`, the slowest mode. Today the setting named "off" silently selects the
147-second behaviour instead of the 27-second one. `'off'` must map to
`--reasoning-budget 0` (or at minimum to `low`), never to "send nothing".

Measure, for one realistic coding question, at budgets `0`, `128`, `512` and
`-1`: wall-clock to first visible answer token, total wall-clock, and whether
answer quality degrades. Recommend a default from that table. Quality at `0` is
the important unknown — a reasoning model with thinking suppressed can be worse
than a non-reasoning model of the same size, and if so, that is an argument for
changing the model rather than the flag.

---

## 2. Runtime knobs to measure

Vary one at a time from the current argv, on the same prompt, and record
generation tok/s, prompt tok/s, ms/token, and peak RSS.

| Knob | Current | What to try | Why |
|---|---|---|---|
| `--threads` | conservative auto | physical cores, and ±2 around it | The current `automaticThreads()` caps low. Logical cores usually hurt: hyperthreads contend for the same vector units |
| `--threads-batch` | same as threads | higher than `--threads` | Prompt processing is compute-bound and scales further than generation, which is memory-bound |
| `--cache-type-k/v` | **`f16` since v0.5.1** | resolved | **Measured (EPYC 7763, 28 cores, b10355, Qwen UD-Q4_K_XL, greedy, 3 reps):** q8_0 KV *was* the depth collapse. f16/f16 vs q8_0/q8_0 tg: 19.36 vs 18.76 at depth 130, 16.38 vs 9.91 at 2048, 14.38 vs 6.37 at 4096, **10.88 vs 3.46 at 8192 (3.1×)**, 6.86 vs 2.17 at 14336 — for +0.71 GiB peak RSS. Prefill also +49% at 8192 (19.66 → 29.22). K carries ~80% of the damage; q8_0-K/f16-V recovers only a fifth. Shipped: f16 default, per-profile `kvCacheType` manifest override; the check-source `'q8_0'` literal was deliberately changed with a comment recording that the assertion was measured wrong. Muse confirms the mechanism in miniature: only ~21% depth loss either way, as its SWA + 16:1 GQA cache predicts |
| `--batch-size` / `--ubatch-size` | 512 / 128 | 1024/256, 2048/512 | Prompt throughput; watch RSS |
| `--flash-attn` | `auto` | `on`, `off` | Confirm what `auto` actually resolves to on this build and architecture; do not assume it is on |
| `--mlock`, `--no-mmap` | mmap | `--mlock` | mmap can page-fault during generation on a memory-tight machine, which shows up as erratic inter-token latency rather than lower throughput |
| `--cache-reuse` | unset | try it | Chat resends a large, mostly identical workspace-context prefix every turn. Prefix reuse could remove most prompt processing from turns 2+, which is a larger real-world win than raw tok/s — but fix the request shape first (§0) or this measures the wrong thing |
| `--no-cache-idle-slots` | set | keep it | Resolved in §0: with explicit `--parallel 1` it cannot evict KV; it only skips a useless per-request state serialize. Keeping it is correct |
| `--no-repack` | set | re-test `--repack` for pp | Disabling repack also drops the interleaved-quant CPU GEMM kernels (`no_extra_bufts` → generic row-dot fallback), which theory says costs 2–4× on prefill. Our own earlier measurement saw only ~12% — re-measure pp specifically, combined with `-ub 512`, before trusting either number. The RAM cost (measured +11.4 GiB on Muse) still decides |
| `--flash-attn` | `auto` | resolved — keep `auto` | The FA confound was checked and came back clean: with f16 KV, `-fa on` beats `off` by **34% tg at depth 8192** (and loses 14% at trivial depth 130), so the KV-type recovery above is dequantisation, not the FA path. Caution for future measurements: "FA is neutral for generation" only holds at trivial depth — always A/B at realistic context. (Historical note: q8_0 V used to *force* FA on — `llama-context.cpp:3580-3589` — which made `-fa off` untestable until the f16 switch) |
| `--numa` | unset | `distribute` if multi-socket | Only if the instance is multi-socket; irrelevant on the target laptop |
| `--n-cpu-moe` / `--cpu-moe` | unset | only if the model is MoE | Check the GGUF: muse-glimmer may not be MoE. Qwen3-Coder is, and this matters if we switch |

Encode the winning values **per profile in the manifest**, not as hardcoded
constants, so a future model can carry its own tuning. `batchSize`, `ubatchSize`
and `contextSize` already live there; add what else proves load-bearing.

---

## 3. Context sizing, decided by memory

`n_ctx_train` is 131072; the manifest sets 16384. The limit is not the model, it
is RAM: KV cache bytes scale linearly with context.

Measure peak RSS at 4096, 8192, 16384 and 32768 with the chosen KV type, and
publish the table in `docs/PERFORMANCE.md`. Choose the largest context that
leaves comfortable headroom on a 32 GB machine **with VS Code and language
servers also running** — roughly 8 GB of headroom, not 1 GB. Preflight's context
row should warn against a value the measured table says will not fit.

---

## 4. Telemetry — make throughput visible

`llama-server` returns a `timings` object on completion responses
(`prompt_per_second`, `predicted_per_second`, `predicted_per_token_ms`, and
counts). Verify the exact field names against this build rather than trusting
this list.

Surface it:

1. Capture `timings` in `client.js` and return it alongside `usage`.
2. After each chat response, show a single quiet line: tokens generated,
   generation tok/s, and **ms/token** — the inter-token latency the user
   actually feels.
3. Log the same to the output channel, so a slow session can be diagnosed after
   the fact rather than re-run.
4. For streaming, measure inter-token latency directly: record the timestamp of
   each token in `chatStream` and report the median and the 95th percentile. The
   median is the feel; the tail is what makes a session frustrating, and an
   average hides both.
5. **Server timings miss the client-side wait.** `contextBuilder.build()` runs
   `findFiles` over up to 600 candidates and then reads up to 100 files
   *serially* before the HTTP request is even issued. That latency is invisible
   to every server-side number above and the user feels it as TTFT. Time the
   gap between "send" and the request leaving, and log it on the same quiet
   line. The context snapshot in §0 removes most of it; until then, parallelise
   the reads and cache the candidate index between turns.

Do not build a dashboard. One line after each response and a log entry.

---

## 5. Reporting

`docs/PERFORMANCE.md` replaces its estimates with measured tables:

- the reasoning-budget table from section 1
- the knob-by-knob table from section 2, with the chosen defaults marked
- the context/RSS table from section 3
- the instance the numbers came from, and an explicit statement of how they are
  expected to scale down to a CPU-only workstation with fewer cores

State the hardware every number came from. A tok/s figure without the machine
attached is not a measurement.
