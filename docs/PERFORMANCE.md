# Performance and memory tuning

## Measured numbers for the default profile

These replace the estimates that used to be in this file. They were taken on
2026-08-11 on a rented Linux x86-64 machine (28 vCPU, 56 GB RAM) running
`llama-server` from the pinned tag **b10355** with **the exact argument list
`RuntimeManager.buildArguments` produces** — same context, KV type, batch sizes,
prompt cache, and flags. Model: `muse-glimmer-30B-kquant-17gb.gguf` (Q4_K_M,
15.6 GiB, architecture `muse-glimmer`, `n_ctx_train` 131072).

**No GPU was involved.** The `ubuntu-x64` release archive contains only
`libggml-cpu-*.so`, exactly as the shipped `win-cpu-x64` archive does, so
`--n-gpu-layers -1` was a no-op and the startup log shows no offload line. Every
number here is a CPU number.

| | `--threads 16` (16+ core machine) | `--threads 6` (what an 8-core workstation picks) |
|---|---|---|
| Cold load to `/health` ok | 19 s | 19 s |
| Prompt processing | 12.9 tok/s | 6.2 tok/s |
| Generation | **4.5 tok/s** | **2.7 tok/s** |
| Peak resident set | 27.2 GiB | 27.2 GiB |

`localCoder.runtime.threads` defaults to `0`, which selects
`max(2, min(16, floor(cores * 0.75)))` — so an 8-core workstation runs the
right-hand column.

### What that means for one question

The default model is a **reasoning** model: it emits a private analysis channel
first and only then the answer. Both are generated at the same speed and both
are spent from the same output budget. For the prompt *"Write a Python function
`merge_intervals(intervals)` … then briefly explain the time complexity"*:

| | 16 threads | 6 threads |
|---|---|---|
| Reasoning tokens before any answer | 529 | 529 |
| Answer tokens | 316 | 316 |
| **Wall-clock to the first visible answer character** | **113 s** | **216 s** |
| Total time for the reply | 180 s | 329 s |

On an 8-core workstation that is **three and a half minutes of thinking before
the first word of the answer appears**, and five and a half minutes to a
finished reply, for a question of this size. Plan around that; it is not a
misconfiguration. The chat view shows the reasoning as it streams so the wait is
visible rather than a blank bubble.

### Memory does not scale with context on this model

Measured with everything else held constant:

| `--ctx-size` | anonymous (not evictable) | mapped model pages (clean) | peak resident |
|---|---|---|---|
| 4096 | 11.54 GiB | 15.60 GiB | 27.15 GiB |
| 8192 | 11.57 GiB | 15.60 GiB | 27.18 GiB |
| 16384 | 11.62 GiB | 15.60 GiB | 27.23 GiB |

Quadrupling the context costs about **85 MiB**. The model uses grouped-query
attention with 2 KV heads and a sliding-window pattern, so its KV cache is tiny;
the ~11.6 GiB of anonymous memory is a fixed load-time cost, not a context cost.

**Therefore: lowering `localCoder.runtime.contextSize` will not fix memory
pressure on this profile.** It only shortens the conversation. Earlier advice in
this file said otherwise; it was never measured. On a 32 GB machine the ~11.6 GiB
of anonymous memory is the hard floor — the 15.6 GiB of mapped model pages are
clean and can be evicted under pressure, at the cost of paging.

`--cache-type-k/v q8_0` versus `f16` made no measurable difference to either
speed (117 s vs 113 s to first answer, within run-to-run variation) or memory,
for the same reason: the KV cache is not where the memory goes. q8_0 is kept.

### Speculative decoding is off, and this is why

Tested on b10355 with the drafter the manifest declares
(`dflash-kquant.gguf`, `--model-draft` + `--spec-draft-n-max 16` +
`--n-gpu-layers-draft -1`, the exact flags the extension adds):

- b10355 no longer fails the launch, as b10344 did. The server logs
  `dflash requires ctx_other to be set` and
  `[spec] failed to measure draft model memory`, then loads the drafter and
  serves normally.
- **4.55 tok/s with the drafter against 4.54 tok/s without**, same prompt, same
  machine. No speedup at all, for an extra 1.6 GiB of RAM.

`localCoder.runtime.enableDraftModel` therefore stays `false`. The draft context
never initialises, so speculation is not actually running.

## Memory model

A 10.9 GB model file does not imply an 11 GB process. Budget for memory-mapped model pages, native compute buffers, q8 KV cache, prompt-processing batches, the bounded prompt cache, VS Code, language servers, browsers/terminals, endpoint security, and the operating-system file cache.

The extension therefore starts conservatively:

- one inference slot (`--parallel 1`);
- q8 key/value cache;
- profile context of 8K–16K, with 8K recommended for first deployment;
- 512 MiB maximum prompt cache by default;
- bounded batch and micro-batch sizes;
- inline completion disabled until chat is stable.

## Recommended tuning order

1. Keep one model loaded and close unused memory-heavy applications.
2. Lowering `localCoder.runtime.contextSize` is worth trying on the Qwen
   profiles, but see the measurements above: on the default Muse Glimmer profile
   it reclaims about 85 MiB between 16K and 4K and is not a memory remedy.
3. Keep `localCoder.runtime.promptCacheMiB` at `512`, or set it to `0` to disable prompt caching entirely.
4. Choose threads near physical-core count; more logical threads can make memory-bound decode slower.
5. Reduce the profile micro-batch from 128 to 64 through a reviewed profile change if prefill causes pressure.
6. Disable inline completions during long chat work.
7. Prefer IQ2 over Q4 when paging occurs; use TQ1 only after measuring its correctness.

The prompt-cache cap is separate from the KV cache. Increasing it can accelerate repeated prefixes but directly consumes RAM; values above 1 GiB are difficult to justify on the intended laptop without measurement.

## Context selection

The advertised model context is not a practical laptop target. The extension selects relevant context rather than dumping the repository. It prioritizes selected/nearby code, diagnostics, open files, lexically relevant paths/snippets, and explicitly configured files. This usually improves useful information density and greatly reduces CPU prefill.

## Inline completion

Inline completion is intentionally opt-in because every pause in typing may schedule inference:

```json
{
  "localCoder.inlineCompletions.enabled": true,
  "localCoder.inlineCompletions.maxTokens": 96,
  "localCoder.inlineCompletions.debounceMs": 450
}
```

The provider never starts the runtime implicitly. Start and validate chat first, then enable FIM suggestions.

## Measurement

Use `scripts/Invoke-SmokeTest.ps1` for a basic operational test and `scripts/Invoke-ModelBenchmark.ps1` for a repeatable static coding screen. Keep constant:

- native runtime commit and platform build;
- task/prompt and context;
- model family and only the quantization under comparison;
- context, KV type, batch sizes, threads, and prompt-cache setting;
- power mode and background applications.

Record cold load time, first-token latency, completion tokens per second, total latency, median and tail values, peak working set, hard page faults, and benchmark/test correctness. A smaller GGUF is not a win when it causes enough quality loss to require repeated generations.
