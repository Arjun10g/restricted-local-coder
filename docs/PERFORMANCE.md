# Performance and memory tuning

Every number in this file was measured, and every number carries the machine it
came from. Where a claim from elsewhere disagreed with a measurement taken here,
the measurement won and the claim is recorded as refuted so it does not come
back.

**The measurement machine**, unless stated otherwise: a rented AMD EPYC 7763,
two sockets, 14 cores each, **28 physical cores with no SMT**, 56 GB RAM, Linux
x86-64, `llama-server` from the pinned tag **b10355**, CPU-only. The argument
list is the one `RuntimeManager.buildArguments` produces, with exactly one
variable changed per comparison.

**No GPU was used in any of it.** The `ubuntu-x64` release archive contains only
`libggml-cpu-*.so`, exactly as the shipped `win-cpu-x64` archive does, so
`--n-gpu-layers -1` was a no-op and no offload line appears in any startup log.
These are CPU numbers, which is what the Windows target runs.

A note on reading them: **prompt processing (prefill) and generation are bound by
different resources and must never be averaged together.** Prefill is
compute-bound and scales with cores; generation is memory-bandwidth-bound and
does not. Measured here, going from 14 to 28 cores moved prefill by +46% and
generation by less than 1%. Prefill is also the cost that dominates in this
extension, because a workspace context is attached to every turn.

## The model choice, decided by measurement

Both models, same machine, same prompt, each with the extension's exact argv:

| | Qwen3-Coder 30B-A3B UD-Q4_K_XL (default) | Muse Glimmer 30B kquant |
|---|---|---|
| Architecture | `qwen3moe`, 128 experts, 8 active (~3.3B active) | `muse-glimmer`, dense, all ~27.9B active |
| Reasoning phase | none | 529 analysis tokens before any answer |
| **Seconds to the first word of the answer** | **1.2** | **113.0** |
| Total seconds for the reply | 24.1 | 179.6 |
| Generation | ~19 tok/s | ~4.5 tok/s |
| Fill-in-the-middle | yes | no |
| Load time | 27 s | 19 s |

That is roughly **94x to the first visible word** and 7.5x end to end. Two
independent causes: only ~3.3B of Qwen's parameters are read per token against
all ~27.9B of Muse Glimmer's, and Muse Glimmer spends hundreds of tokens
thinking before it says anything.

Fill-in-the-middle was verified separately, through the route the extension
actually uses — a raw `POST /completion` with the FIM control tokens, **not** the
chat route, which returns fenced Markdown. It returned usable code in 1.3 s.

## Repacking doubles resident memory, and that is the memory finding that matters

`--no-repack` is now the default. Online repacking rewrites the quantised
weights into a CPU-friendly layout at load time and keeps that rewritten copy in
**anonymous** memory — a second, private copy of the whole model, on top of the
memory-mapped original.

| model | repacking | prefill tok/s | generation tok/s | peak resident | anonymous | mapped (evictable) |
|---|---|---|---|---|---|---|
| Qwen3-Coder Q4_K_XL | on (upstream default) | 38.20 | 11.32 | **30.95 GiB** | 14.57 | 16.38 |
| Qwen3-Coder Q4_K_XL | **off** | 38.67 | 10.81 | **16.97 GiB** | 0.48 | 16.48 |
| Muse Glimmer kquant | on (upstream default) | 12.08 | 4.38 | 27.28 GiB | 11.68 | 15.60 |
| Muse Glimmer kquant | **off** | 10.63 | 3.84 | 15.93 GiB | 0.33 | 15.60 |

On the default profile, repacking costs **14.0 GiB of extra resident memory** and
buys 4.5% of generation speed and *nothing* for prefill. A 16.5 GiB model needing
31 GiB of peak resident memory does not fit on a 32 GB machine that is also
running VS Code and a language server. Off, it needs 17.0 GiB.

On Muse Glimmer the speed case is stronger — about 12% on both axes — but it
still costs 11.4 GiB.

Profiles may set `"repack": true` in the manifest to opt back in where the memory
exists. Nothing is hardcoded.

One caveat stated honestly: peak resident is a high-water mark. After loading,
the mapped copy is redundant and the kernel may evict it, so steady-state
pressure is probably lower than the peak. The peak is still real, and it is what
a 32 GB machine has to survive.

## Context costs almost nothing; do not tune it for memory

Same machine, everything else held constant.

Qwen3-Coder Q4_K_XL, with repacking on:

| `--ctx-size` | peak resident | anonymous |
|---|---|---|
| 4096 | 30.73 GiB | 14.35 GiB |
| 8192 | 30.93 GiB | 14.55 GiB |
| 16384 | 31.33 GiB | 14.95 GiB |
| 32768 | 32.13 GiB | 15.75 GiB |

Muse Glimmer kquant:

| `--ctx-size` | peak resident | anonymous |
|---|---|---|
| 4096 | 27.15 GiB | 11.54 GiB |
| 8192 | 27.18 GiB | 11.57 GiB |
| 16384 | 27.23 GiB | 11.62 GiB |

Quadrupling the context costs **85 MiB** on Muse Glimmer and about 600 MiB on
Qwen3-Coder. Both use grouped-query attention with few KV heads, and Muse Glimmer
additionally uses a 2048-token sliding window on three of every four layers.

**So lowering `localCoder.runtime.contextSize` is not a memory remedy on either
model.** It only shortens the conversation. Earlier advice in this file said
otherwise; it had never been measured. The default context is 16384, chosen
because it is nearly free rather than because memory forced it down.

## Flash attention: measured, and a widely-repeated claim refuted

A claim circulated that `--flash-attn auto` resolves to on for CPU builds and
that turning it off gives a large prefill win (a figure of +258% was quoted).
`llama-bench`, Muse Glimmer, same machine:

| threads | flash attention | pp512 (prefill) | tg128 (generation) |
|---|---|---|---|
| 14 | off | 13.08 ± 0.51 | 4.32 ± 0.04 |
| 28 | off | 20.06 ± 0.01 | 4.26 ± 0.00 |
| 14 | on | 14.28 ± 0.75 | 4.27 ± 0.08 |
| 28 | on | 20.92 ± 0.05 | 4.29 ± 0.01 |

Flash attention on is **slightly faster** for prefill at both thread counts and
neutral for generation. On this build and this hardware the claim is false, and
`--flash-attn auto` is kept unchanged.

Also visible in that table: prefill scales with cores (+46% from 14 to 28) while
generation does not move. **Untested here:** whether simultaneous multithreading
hurts. This machine reports one thread per core, so there were no logical cores
to test with; the recommendation to pin to physical cores on Windows remains a
recommendation, not something verified in this repository.

## Prompt processing at realistic depth, which is the cost that actually hurts

Everything above used a short prompt. This extension attaches workspace context
to every turn, so the number that decides how the tool feels is prefill at
depth. Default profile, `--no-repack`, one variable -- prompt length:

| prompt tokens | prefill tok/s | generation tok/s | wall clock for the turn |
|---|---|---|---|
| 579 | 59.68 | 16.81 | 12 s |
| 2327 | 37.23 | 11.15 | 66 s |
| 9227 | 16.41 | 5.34 | **569 s (9.5 minutes)** |

Prefill throughput falls 3.6x between a small prompt and a 9k-token one, and
because the whole prompt must be processed before the first token appears, the
wall-clock cost rises far faster than the token count. **On a 28-core server
chip.** A 12-core laptop will be worse.

`localCoder.context.maxCharacters` used to default to 48000 characters, roughly
12000 tokens, which put every single turn in the bottom row of that table. It now
defaults to **16000**. That is the difference between a tool that answers in
under a minute and one that answers in ten.

This is also why prefix reuse matters more than raw throughput for this
workload, and why the context builder selects relevant files rather than dumping
the repository.

### The two models degrade differently with depth

Muse Glimmer uses a 2048-token sliding window on three of every four layers, so
three quarters of it pays no depth penalty; Qwen3-Coder is full attention on all
48 layers. That predicts Muse Glimmer degrades more gracefully, and it does:

| prompt tokens | Qwen3-Coder prefill | Muse Glimmer prefill |
|---|---|---|
| ~600 | 59.68 tok/s | 12.15 tok/s |
| ~2400 | 37.23 tok/s (-38%) | 11.24 tok/s (-7%) |

So the 5x prefill advantage at a short prompt narrows to 3.3x by 2400 tokens.
The advantage is real but it is not constant, and a comparison taken only on
short prompts overstates it.

**Not measured, and not guessed at:** the same comparison at ~9000 tokens, and
whether `--cache-reuse` removes prefill from the second turn onward. Both runs
were still in progress when the instance was released. The second is the more
valuable of the two, because this extension resends a nearly identical workspace
prefix every turn, and eliminating that work would beat any throughput tuning.

## Reasoning strength, for the optional Muse Glimmer profile

Muse Glimmer's chat template accepts a `reasoning_strength` argument and
**defaults to `high`**, its most expensive setting, so sending nothing was buying
the slowest mode. It is passed per request in `chat_template_kwargs`, so it costs
no restart and different call sites can ask for different depths.

Same machine, same prompt, temperature 0, 16 threads:

| `reasoning_strength` | analysis tokens | seconds to the first word | total seconds | answer length |
|---|---|---|---|---|
| `low` | 73 | **27.2** | 110.9 | 1459 chars |
| `medium` | 318 | 83.8 | 137.4 | 961 chars |
| `high` (model default) | 589 | 147.0 | 220.4 | 1159 chars |
| `xhigh` | 584 | 146.6 | 223.5 | 1211 chars |

`low` reaches the answer 5.4x sooner and on this prompt returned the *longest*
answer of the four. `xhigh` is indistinguishable from `high` and is not worth
choosing.

Two caveats. This is one prompt, so read it as a latency result, not a quality
ranking — the repository's benchmark is a regex screen that cannot tell a wrong
answer from a right one in the wrong format, and the quality-versus-strength
question is **not settled here**. And the effect is on generation only; it does
nothing for prefill, which dominates once a real workspace context is attached.

`localCoder.chat.reasoningStrength` exposes this, defaulting to `medium`. The
short selection commands always ask for `low`, because the user is waiting on
them.

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
2. Leave repacking off. It is the single largest memory lever measured here:
   14 GiB on the default profile. Do not turn it on below 48 GB of RAM.
3. Do **not** lower `localCoder.runtime.contextSize` to save memory. Measured, it
   does almost nothing (see the table above); it only shortens the conversation.
4. Keep `localCoder.runtime.promptCacheMiB` at `512`, or set it to `0` to disable prompt caching entirely.
5. Set threads to the physical-core count. Prefill scales with cores; generation
   does not, so there is nothing to gain past that and contention to lose.
6. Disable inline completions during long chat work.
7. Prefer the 4-bit `Q4_K_XL` profile. Going below about 4 bits per weight buys
   file size but not proportional speed on a CPU, because dequantisation cost
   rises as the byte count falls, and it measurably costs code correctness. The
   two "TQ1" profiles were removed in 0.4.2: their GGUF headers declared
   `IQ1_S`, contained no ternary tensors at all, and the name was a publisher
   labelling choice rather than a format.

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
