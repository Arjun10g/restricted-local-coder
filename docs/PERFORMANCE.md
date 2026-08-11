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

A second session, on **a different rented box of the same class** — AMD EPYC
7763, 2 sockets, 14 cores each, 28 physical cores with no SMT, 56 GB RAM,
Ubuntu 22.04, same b10355 build — added the speculative-decoding, depth, and
prefix-reuse numbers. Sections carrying those numbers say so. Because the class
matched, every Muse Glimmer baseline was re-measured on the new box rather than
compared across machines.

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

### The decision was reopened on purpose, and it survived

That table was taken before DFlash speculative decoding had ever been correctly
tested. The case for reopening was specific: Muse Glimmer scores 76.0 on
SWE-bench Verified against Qwen3-Coder's 51.6, and if speculation put it near
16 tok/s the better model would also be a usable one. That experiment has now
been run — see "Speculative decoding with DFlash, measured" below.

**The answer is no, and the default stays `qwen3-coder-30b-a3b-q4xl`.**

| | Qwen3-Coder (default) | Muse Glimmer, best measured config |
|---|---:|---:|
| generation | 22.68 tok/s | 8.50 tok/s |
| seconds to the first word of the answer | 1.2 | 53.2 |
| generation at ~7.2k of context | 4.01 tok/s | 3.33 tok/s |
| prefill at ~7.2k of context | 24.20 tok/s | 12.32 tok/s |
| SWE-bench Verified | 51.6 | 76.0 |

Muse Glimmer's best configuration is DFlash at `--spec-draft-n-max 3` with
`reasoning_strength: low`. It is a real 2.04× on generation and 1.74× on
time-to-first-word, and it is lossless. It is still 44× slower to the first
word, because that gap is reasoning tokens, not throughput, and doubling
throughput halves a wait that was never going to be short.

Two honest qualifications, because they cut against the conclusion.

**At depth the models nearly converge.** By ~7.2k of context Muse Glimmer's
generation deficit is 1.2× rather than 5.3×, and its prefill deficit 2.0× rather
than 5.6×, because 39 of its 52 layers use a sliding window and Qwen3-Coder's 48
are all full attention. Anyone working at long context should take the optional
profile seriously; it is not a curiosity.

**The quality difference was not measured here.** 76.0 against 51.6 is the
publishers' number, not ours, and this repository's benchmark is a regex screen
that cannot separate a good answer from a badly formatted one. The
recommendation rests on latency, which was measured, and treats the quality gap
as real but unquantified by us. If a future task set shows the default failing
work the reasoning model completes, this decision deserves revisiting again —
with a quality measurement, not a throughput one.

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

Both of the things this section used to list as unmeasured — the comparison at
realistic depth, and `--cache-reuse` — have since been measured. See "Prefill at
7.2k, where the two models nearly converge" and "Prefix reuse" below.

### Prefill at 7.2k, where the two models nearly converge

**Second measurement session, same machine class** (see the note at the top of
this file): a rented AMD EPYC 7763, 2 sockets, 14 cores each, 28 physical cores
with no SMT, 56 GB RAM, Ubuntu 22.04, `llama-server` b10355 (`dd1ea5243`),
CPU-only. The CPU backend selected was `libggml-cpu-haswell.so`, which is the
correct AVX2 variant — Zen 3 has no AVX-512, so no AVX-512 build exists to miss.
Both models were verified against their manifest digests before the run.

One request per depth, `max_tokens 48`, the extension's exact argv, no drafter,
prompt processing and generation reported separately:

| context depth | Qwen pp | Muse pp | Qwen tg | Muse tg |
|---:|---:|---:|---:|---:|
| ~130 | 85.94 | 15.24 | 22.68 | 4.29 |
| ~2.2k | 55.29 (-36%) | 13.99 (-8%) | 10.08 (-56%) | 3.71 (-14%) |
| **~7.2k** | **24.20 (-72%)** | **12.32 (-19%)** | **4.01 (-82%)** | **3.33 (-22%)** |

This is the sliding-window prediction confirmed, and more strongly than
expected. Across the same depth range Qwen3-Coder loses 72% of its prefill and
82% of its generation; Muse Glimmer loses 19% and 22%. **The prefill gap narrows
from 5.6× to 2.0×, and the generation gap from 5.3× to 1.2×.**

Two things follow, and they point in opposite directions, so both are stated.

The favourable one: at a realistic workspace depth the two models are far closer
than the headline 94× suggests, and Muse Glimmer is a defensible profile for
long-context work. The unfavourable one: **Qwen3-Coder's own generation falls to
4.01 tok/s at 7.2k**, which is below the comfortable-chat floor. Depth hurts the
default profile far more than it hurts the optional one, and that is an argument
for keeping the context budget small — not an argument for changing models.

## Speculative decoding with DFlash, measured

Same second session, same machine. The previous attempt at this omitted
`--spec-type`, so speculation never engaged and the result was withdrawn. This
one engaged, and the log was checked before any number was recorded:

```
common_speculative_init_result: loading draft model 'dflash-kquant.gguf'
common_speculative_impl_draft_dflash: adding speculative implementation 'draft-dflash'
common_speculative_impl_draft_dflash: - n_max=15, n_min=0, p_min=0.00
common_speculative_impl_draft_dflash: - block_size=16, mask_token_id=201818, n_extract=5
```

The absence of those lines is the silent failure mode. Absence of errors proves
nothing; the drafter loads and is simply never used.

### The sweep, run greedily so only the flag moves

Muse Glimmer, `reasoning_strength: low`, one fixed prompt, temperature 0 so every
row generated a **byte-identical 430-token answer**. That also settles a
separate question: DFlash verification is lossless in practice, not just in
theory — the drafted runs and the undrafted run produced the same tokens.

| `--spec-draft-n-max` | acceptance | accepted per pass | tok/s | vs baseline | s to first answer word | total s |
|---:|---:|---:|---:|---:|---:|---:|
| none (baseline) | — | 1.00 | 4.17 | 1.00× | 92.8 | 113.0 |
| 1 | 0.932 | 1.93 | 6.20 | 1.49× | 68.0 | 79.9 |
| 2 | 0.878 | 2.76 | 8.21 | 1.97× | 53.2 | 62.6 |
| **3** | **0.813** | **3.44** | **8.50** | **2.04×** | **53.2** | **61.7** |
| 4 | 0.764 | 4.06 | 8.49 | 2.04× | 52.7 | 60.9 |
| 5 | 0.694 | 4.47 | 7.99 | 1.91× | 56.2 | 64.2 |
| 7 | 0.538 | 4.77 | 6.62 | 1.59× | 67.2 | 75.3 |
| **15 (what this extension shipped)** | **0.354** | **6.31** | **4.54** | **1.09×** | **98.2** | **105.3** |

The baseline was measured three times. Two runs agreed to four significant
figures (4.172 and 4.171 tok/s); a third read 3.40 and is discarded as
contention from a concurrent session, which is recorded here rather than quietly
dropped.

At the profile's own sampling settings — temperature 1.0, top-p 0.95, top-k 64,
which is what the extension actually sends — acceptance is lower and the picture
is worse at large blocks: `n-max 15` measured **0.265–0.302 acceptance and 3.56–3.89
tok/s against a 4.10–4.17 baseline, an outright slowdown.** `n-max 3` measured
0.812 and 7.97 tok/s. Sampling temperature costs roughly 0.5 tok/s at the
optimum and considerably more at large blocks.

At `reasoning_strength: high`, greedy, 1504 identical tokens: baseline 3.97
tok/s and 367.4 s to the first answer word; `n-max 3` gives 7.42 tok/s,
acceptance 0.696, and 203.7 s. Same 1.87× shape.

### Why 15 loses and 3 wins, in one table

Acceptance was never the problem. The drafter is good: even at a full 16-token
block it lands 6.3 tokens per target pass, *better* than the ~4 the published
RTX 5090 result implies. What failed was the assumption that verifying those 16
positions is free because it streams the weights once.

Turning each row's accepted-per-pass and ms/token into the cost of a single
target forward pass:

| positions verified | ms per target forward pass |
|---:|---:|
| 1 (no speculation) | 240 |
| 2 | 311 |
| 4 | 405 |
| 6 | 560 |
| 8 | 721 |
| 16 | 1390 |

≈ **157 ms fixed + 77 ms per verified position**. The fixed part is the weight
stream: 16.4 GB in 157 ms is 105 GB/s, which is what this machine does. The
variable part is compute, and 77 ms is *a third of a whole weight stream per
extra token verified*. Verifying a 16-token block therefore costs **5.8 target
forward passes, not one**, and 6.3 tokens bought for 5.8 passes is barely break
even. Four positions cost 1.7 passes and buy 3.4 tokens, which is the 2×.

This is the general result, not a Muse Glimmer quirk: **on a CPU, block
speculation is limited by verification compute, so the optimum block is small.**
Upstream's default for `--spec-draft-n-max` is already 3. This extension
overrode it to 15 on the reasoning that a DFlash block holds 16 slots, which
confused the drafter's capacity with the verifier's economics.

### `--spec-draft-p-min`, the confidence gate

`--spec-draft-p-min` defaults to `0.00`, meaning the drafter proposes its full
block regardless of confidence. Gating is the adaptive version of the same
mechanism that makes a small block win, so it was measured rather than assumed.

Same machine, same greedy prompt, same byte-identical 430-token answer:

| `n-max` | `p-min` | acceptance | accepted per pass | tok/s | vs baseline |
|---:|---:|---:|---:|---:|---:|
| 15 | 0.00 (default) | 0.354 | 6.31 | 4.54 | 1.09× |
| 15 | 0.50 | 0.764 | 6.49 | 7.38 | 1.77× |
| 15 | 0.75 | 0.947 | 6.56 | 7.33 | 1.76× |
| 15 | 0.90 | 0.987 | 5.70 | 6.49 | 1.56× |
| 7 | 0.75 | 0.969 | 4.56 | 7.73 | 1.85× |
| 3 | 0.75 | 0.962 | 3.33 | 7.88 | 1.89× |
| **4** | **0.50** | **0.915** | **3.93** | **8.69** | **2.08×** |
| 3 | 0.00 | 0.813 | 3.44 | 8.50 | 2.04× |

Gating works, and it works dramatically where the block is large: at `n-max 15`
it lifts acceptance from 0.354 to 0.947 and converts a 1.09× non-result into
1.76×. Anyone forced to run a full block should set it.

**It does not beat a small block, though.** The best gated configuration,
`n-max 4 --spec-draft-p-min 0.5`, measured 8.69 tok/s against 8.50 for plain
`n-max 3` — a 2% edge, which is close enough to run-to-run variation that it does
not justify adding a flag the extension does not currently pass. The reason
gating cannot win outright is visible in the "accepted per pass" column: raising
acceptance does not shorten the block that gets *verified*, and verification
cost is what dominates. `p-min 0.90` makes that explicit — near-perfect
acceptance, and slower than `p-min 0.50`.

Draft KV cache type was also measured, since the drafter inherits the main
model's `q8_0`: forcing `--spec-draft-type-k f16 --spec-draft-type-v f16` gave
identical acceptance and was consistently ~6% *slower* (8.00 against 8.50 at
`n-max 3`; 7.00 against 7.33 at `n-max 15 p-min 0.75`). Left alone.

**Conservative choice recorded:** the extension passes `--spec-draft-n-max 3`
and no `p-min`. That is upstream's own default for the flag, it is within 2% of
the best measured configuration, and it adds nothing new to the argument list.

### What this buys, and what it does not

DFlash at `--spec-draft-n-max 3` is a real 2× on generation and a real 1.7× on
time-to-first-word, it is lossless, and it costs 1.6 GB of extra resident
memory. It is worth having on the Muse Glimmer profile.

It does not change the model decision. The best measured Muse Glimmer
configuration is 8.50 tok/s and 53 seconds to the first word of an answer.
Qwen3-Coder on the same box, same session, is 22.68 tok/s and 1.2 seconds. The
gap is not throughput, it is that a reasoning model spends hundreds of tokens
before it says anything, and doubling throughput halves a wait that was never
going to be short.

One user-visible side effect worth knowing: with speculation on, tokens arrive
in **bursts**. Median inter-token latency drops to ~0.1 ms while p95 rises to
410 ms at `n-max 3` and 1.4 s at `n-max 15`. Total time improves; the stream
stops feeling like typing and starts feeling like paste.

## Is our prefill number an artifact? No, and here is the arithmetic that closes it

A concern was raised that a dense 28B model should show batched prefill at
roughly 5–20× its generation rate, and that our 2.9× looked like a
misconfiguration — with the drafter, `--no-repack`, `--ubatch-size 128`,
quantised V forcing flash attention, or a wrong CPU variant as suspects. Each
was checked on the second session's box.

`llama-bench`, b10355, 28 threads, `-p 512 -n 128`, two repetitions:

| model | `-ub` | `-b` | KV | pp512 | tg128 |
|---|---:|---:|---|---:|---:|
| Muse Glimmer | 128 | 512 | q8_0/q8_0 | 19.34 ± 0.21 | 4.08 ± 0.04 |
| Muse Glimmer | 256 | 512 | q8_0/q8_0 | 20.02 ± 0.12 | — |
| Muse Glimmer | 512 | 512 | q8_0/q8_0 | 20.32 ± 0.04 | — |
| Muse Glimmer | 512 | 2048 | q8_0/q8_0 | 20.08 ± 0.05 | — |
| Qwen3-Coder | 128 | 512 | q8_0/q8_0 | 87.63 ± 0.03 | 21.78 ± 0.29 |
| Qwen3-Coder | 512 | 2048 | q8_0/q8_0 | 87.34 ± 0.16 | — |

Flash attention, f16 KV so it can be turned off at all:

| model | `-fa` | pp512 |
|---|---|---:|
| Muse Glimmer | on | 20.49 ± 0.02 |
| Muse Glimmer | off | 19.78 ± 0.20 |

Taking the suspects in order.

- **The drafter was not loaded** in any of these runs, and prefill is unchanged
  from the server measurements, so the drafter is not taxing prefill. Separately,
  in the server runs the drafter cost 3–4% of prefill, not a factor of anything.
- **`--ubatch-size` is worth 5%, not a factor of 2–4.** 128 → 512 moves Muse
  Glimmer from 19.34 to 20.32 and moves Qwen3-Coder not at all. Raising it is not
  free — it enlarges the compute buffer — so it stays at 128.
- **Repacking** was already A/B'd in the first session and is worth about 12% on
  Muse Glimmer, not 2–4×. `llama-bench` here runs with repacking on and lands in
  the same place, which is a second, independent confirmation.
- **Flash attention off is slower**, again, by 3.5%. Turning it off to escape
  the quantised-V requirement is a loss, not a win.
- **The CPU variant is correct**: the loader selected `libggml-cpu-haswell.so`,
  the AVX2 build. Zen 3 has no AVX-512, so there is no faster variant to have
  missed. On an AVX-512 machine this question would need asking again.

**So the number stands, and the ratio is a property of this machine.** Compared
like for like — `llama-bench` pp512 against tg128 — it is 4.7× on Muse Glimmer
and 4.0× on Qwen3-Coder, at the bottom of the expected band rather than outside
it. The 2.9× that prompted the concern came from comparing a *short-prompt
server* prefill against generation, which understates prefill because a
152-token prompt amortises fixed costs badly.

The independent check is the speculative-decoding sweep above, which measured
the marginal cost of a batched token position at ~77 ms against ~157 ms for a
full weight stream. A 512-token prefill at 20.3 tok/s is 49 ms per position.
Those are the same quantity measured two different ways, and they predict a
prefill-to-generation ratio of 240/49 ≈ 4.9×. Measured: 4.7×. **The machine is
compute-poor relative to its bandwidth, and every result in this document is
consistent with that single fact.**

## Prefix reuse: free when the prefix is really a prefix, and unrescuable when it is not

This extension resends a large, nearly identical workspace prefix every turn, so
prefix reuse was expected to be the largest single win available — larger than
any throughput flag. It was measured directly, second session, same machine.

Three turns per configuration, all carrying the same ~7.2k-token workspace
prefix, `max_tokens 32`:

- **t1 cold** — the prefix is seen for the first time.
- **t2 continuation** — byte-identical prefix, one more user turn appended at
  the end. This is a pure append.
- **t3 edited prefix** — one line inserted *near the top* of the prefix, which
  is what a real workspace resend looks like when a file changed. Everything
  after the edit shifts position.

| model | flags | t1 cold | t2 continuation | t3 edited prefix |
|---|---|---:|---:|---:|
| Qwen3-Coder | none | 247.2 s (7201 new) | **2.1 s (7201 reused, 28 new)** | 246.9 s (7193 new) |
| Qwen3-Coder | `--cache-reuse 256` | 247.3 s | **2.0 s** | 245.1 s |
| Muse Glimmer | none | 571.6 s (7259 new) | **2.6 s (7260 reused, 27 new)** | 570.6 s (7224 new) |
| Muse Glimmer | `--ctx-checkpoints 8 --cache-reuse 256` | 574.5 s | **2.6 s** | 573.6 s |

Two clean results, and neither is the one that was expected.

**A pure append is already free, on both models, with no flag at all.** The
server reuses the whole 7.2k prefix and processes only the 27–28 new tokens, in
about two seconds. Sliding-window attention does not prevent this; Muse Glimmer
reuses its prefix exactly as readily as Qwen3-Coder does. The concern in
`MUSE_GLIMMER_INTERNALS.md` that SWA would require checkpoints to reuse a prefix
does not show up in the append case.

**An edited prefix is a full reprocess, and no flag rescues it.**
`--cache-reuse 256` changed Qwen3-Coder's edited-prefix turn by 0.7% — noise.
`--ctx-checkpoints 8` plus `--cache-reuse 256` changed Muse Glimmer's by 0.5% —
noise. In every case the server reused 22–49 tokens, i.e. the system prompt and
nothing else, and reprocessed the remaining 7.2k. Both flags are therefore
**not worth setting**, and the recommendation in `MUSE_GLIMMER_INTERNALS.md` to
set `--ctx-checkpoints` is withdrawn as measured-ineffective.

The conclusion is that this is not a runtime-flag problem at all. **The win is
structural: keep the resent context an actual unchanged prefix.** If the
workspace context sits ahead of the conversation history and is held stable
across a conversation, every turn after the first costs two seconds instead of
four to ten minutes. If it sits after the history, or is rebuilt per turn, no
llama.cpp flag will recover it. That is a client-side fix, and it is worth more
than everything else in this document combined: **on Muse Glimmer it is the
difference between 2.6 seconds and 9.5 minutes per turn.**

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

The second session reproduced the direction on a different prompt at 28 threads
and greedy sampling: `low` reached the first answer word in 92.8 s against
`high`'s 367.4 s, a 4.0x gap. The absolute seconds differ from the table above
because the prompt and thread count differ — **the ratio is the transferable
part, not the seconds.** With DFlash at `--spec-draft-n-max 3` on top, `low`
reaches the first word in 53.2 s and finishes in 61.7 s.

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
   two "TQ1" profiles were removed in 0.5.0: their GGUF headers declared
   `IQ1_S`, contained no ternary tensors at all, and the name was a publisher
   labelling choice rather than a format.

8. Keep the workspace context **stable and ahead of the conversation history**,
   so every turn after the first is a pure append. Measured, this is the single
   largest lever in this document: 2.1 s instead of 247 s on the default
   profile, 2.6 s instead of 571 s on Muse Glimmer. Nothing in the runtime can
   substitute for it — `--cache-reuse` and `--ctx-checkpoints` were both
   measured as no-ops once the prefix has changed.
9. On the Muse Glimmer profile only, leave `localCoder.runtime.draftMaxTokens`
   at its default of `3`. Raising it toward the drafter's 15-slot ceiling is a
   measured loss on a CPU.

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

## Where this actually lands, stated without softening

Commonly cited floors for this kind of tool are roughly 10 tok/s for chat to
feel live, 30–40 tok/s for code generation, and 40–60+ decode with 150–300+
prefill for agentic work. Against those, on a 28-core server chip:

| | Qwen3-Coder, short prompt | Qwen3-Coder, ~7.2k context | Muse Glimmer, best config |
|---|---:|---:|---:|
| generation | 22.68 | 4.01 | 8.50 |
| prefill | 87.63 (pp512) | 24.20 | 20.32 (pp512) |

**On a short prompt the default profile clears the chat floor and nothing else.**
It is roughly half of what comfortable code generation wants and well under a
tenth of what agentic work wants on prefill.

**At a realistic workspace depth it does not clear the chat floor either**, at
4.01 tok/s — unless every turn after the first is a pure append, in which case
the prefill is paid once and generation is what is left. That is why the context
structure matters more than any tuning in this file.

**Muse Glimmer with DFlash sits at the chat floor on throughput and far below it
on latency**, at 53 seconds before the first word of an answer.

And this is the favourable machine. The Windows target is a laptop with fewer
cores and less memory bandwidth; prefill scales with cores, so it will be worse
there. None of this is a reason not to ship it, but nobody should be told it is
fast.

## Measurement

Use `scripts/Invoke-SmokeTest.ps1` for a basic operational test and `scripts/Invoke-ModelBenchmark.ps1` for a repeatable static coding screen. Keep constant:

- native runtime commit and platform build;
- task/prompt and context;
- model family and only the quantization under comparison;
- context, KV type, batch sizes, threads, and prompt-cache setting;
- power mode and background applications.

Record cold load time, first-token latency, completion tokens per second, total latency, median and tail values, peak working set, hard page faults, and benchmark/test correctness. A smaller GGUF is not a win when it causes enough quality loss to require repeated generations.

---

## Why our numbers differ from the model card

They do not, once normalised for hardware. Same code, same efficiency, different
silicon.

| | throughput | × file size | effective bandwidth | as % of rated |
|---|---:|---:|---:|---:|
| Model card, RTX 5090 | 74.9 tok/s | 16.75 GB | ~1,254 GB/s | ~70% of ~1.79 TB/s |
| Our CPU box | 4.45 tok/s | 16.76 GB | ~74.6 GB/s | ~70% of sustainable |

**Identical bandwidth efficiency.** The 5090 simply has roughly 17× the memory
bandwidth, and 4.45 × 17 ≈ 75 — the card's own number, reproduced. A dense 30B
streams its entire file once per generated token, and no software change turns
75 GB/s into 1,250 GB/s.

Two further reasons the headline figures read high:

- The **233 tok/s** is DFlash at greedy sampling. The 3.1× has not been
  reproduced anywhere; a real RTX 4090 run measured 1.5× at 80k context, and
  acceptance degrades at the card's own recommended temperature of 1.0. Our own
  CPU measurement was 2.04×, at a small block.
- **Every command on the card uses `-ngl 99`** — full GPU offload. There is no
  official CPU number and no CPU guidance at all. The closest non-flagship
  analogues are an M4 Max at 23.7 tok/s (ExecuTorch, ~400 GB/s unified memory)
  and AMD integrated graphics around 24 via Vulkan.

So chasing 75 tok/s on this CPU is not a defect to fix; it is a bandwidth wall.

**Where we are genuinely below what this hardware permits** is narrower and more
actionable:

- **Prompt processing.** 12.9 tok/s against a generation rate of 4.45 is a ratio
  of 2.9×, where a dense model of this size should show 5–20×.
- **The depth collapse.** The MoE default drops from 22.68 tok/s on a short
  prompt to 4.01 at ~7.2k context, where bandwidth arithmetic predicts ~19.
- **MoE gather efficiency.** The default reads 1.78 GiB of active weights per
  token, which at 22.68 tok/s is only ~40 GiB/s of the 75–105 the same box
  sustains on a dense model — scattered expert reads rather than a stream.

Those three are real recoverable losses. Raw short-prompt generation on a dense
model is not.

If the published class of numbers is the goal, the routes are hardware
(a discrete Arc GPU) or architecture (the MoE default, whose 3.3B active
parameters per token sit on the right side of the bandwidth wall — subject to
the depth finding above).
