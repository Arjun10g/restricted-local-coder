# Performance and memory tuning

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
2. Set `localCoder.runtime.contextSize` to `8192`.
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
