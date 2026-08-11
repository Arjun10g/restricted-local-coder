# Runtime performance — specification

Throughput, inter-token latency, and context are to be tuned deliberately and
**measured**, not asserted. Every number written into the repository must come
from a run that is reproducible on the rented instance.

Baseline to beat, measured on b10355 with the current argv: **4.45 tok/s
generation, 10.1 tok/s prompt.** Confirm first whether that was CPU-only before
treating it as the floor.

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
| `--cache-type-k/v` | `q8_0` | `f16` | Quantised KV saves RAM but costs dequantisation per token on CPU. `f16` may be faster and is the correctness-safe choice; measure the RAM cost before choosing |
| `--batch-size` / `--ubatch-size` | 512 / 128 | 1024/256, 2048/512 | Prompt throughput; watch RSS |
| `--flash-attn` | `auto` | `on`, `off` | Confirm what `auto` actually resolves to on this build and architecture; do not assume it is on |
| `--mlock`, `--no-mmap` | mmap | `--mlock` | mmap can page-fault during generation on a memory-tight machine, which shows up as erratic inter-token latency rather than lower throughput |
| `--cache-reuse` | unset | try it | Chat resends a large, mostly identical workspace-context prefix every turn. Prefix reuse could remove most prompt processing from turns 2+, which is a larger real-world win than raw tok/s |
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
