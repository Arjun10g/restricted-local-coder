# Muse Glimmer internals, and what can actually be sped up

Read from llama.cpp b10355 source: `src/models/muse-glimmer.cpp` (208 lines),
`src/models/dflash.cpp`, `common/arg.cpp`. File-and-line evidence, not inference.

---

## What the graph actually does

### Dense, and confirmed in a source comment

```cpp
// Dense FFN (unlike afmoe, no MoE branches).
layer.ffn_gate = create_tensor(... {n_embd, n_ff} ...);
```

All ~30B parameters are read per token. This is the root of the 4.45 tok/s
figure and nothing in the runtime can change it.

### Sliding window attention on 3 of every 4 layers — the one genuinely good property

```cpp
hparams.swa_type = LLAMA_SWA_TYPE_STANDARD;
uint32_t swa_period = 4;
ml.get_key_or_arr(LLM_KV_ATTENTION_SLIDING_WINDOW_PATTERN, swa_period, false);
hparams.set_swa_pattern(swa_period);
```

With 52 layers that is **39 sliding-window layers and 13 full-attention layers**,
window 2048. It explains the cheap KV cache measured earlier, and it has a
consequence we have not exploited:

**Prefill cost on 39 of 52 layers does not grow with context depth.** Only the 13
full-attention layers pay the quadratic term. For a workspace prefix of 10–12k
tokens, Muse Glimmer's prefill should scale *better* than a full-attention model
of the same size. Our measured prefill numbers were taken on short prompts, so
they do not capture this. **Worth measuring at realistic depth before concluding
anything about long-context behaviour.**

### Per-layer work is heavier than a vanilla block

Each layer carries **four RMS norms** — `attn_norm`, `attn_post_norm`,
`ffn_norm`, `ffn_post_norm` — against two in a standard Llama block, plus
QK-norm on Q and K, plus this:

```cpp
// Attention output gate: sigmoid(gate) * attn_out before o_proj (same as afmoe).
layer.wqkv_gate = create_tensor(..., {n_embd, n_embd_head_k * n_head}, 0);
...
ggml_tensor * gate = build_lora_mm(model.layers[il].wqkv_gate, attn_inp);
```

`wqkv_gate` is `6656 × 4096` per layer — **a full extra projection the size of Q**,
computed on every layer. Across 52 layers that is roughly 1.4B parameters, about
5% of the model, spent on gating. It is extra weight to stream *and* extra
matmul work.

So the model is not merely dense; it is dense with above-average per-token cost.
Two independent reasons it is slow.

---

## Levers that exist, ranked

### 1. Context checkpoints — the one most relevant to us

```
-ctxcp, --ctx-checkpoints, --swa-checkpoints N
        max number of context checkpoints to create per slot
-cms,   --checkpoint-min-step N
```

The reasoning was that with SWA the cache for most layers has discarded old
keys, so the server cannot rewind and reuse a prefix the way it can with full
attention, and would need checkpoints to restore state.

**Measured, and both halves of that are wrong.** See `PERFORMANCE.md`. A pure
append reuses the entire 7.2k prefix with no flags at all — sliding window and
full attention behave identically, 2.6 s against 2.1 s. And when the prefix is
*edited* near the top, `--ctx-checkpoints 8 --cache-reuse 256` changes the
reprocess time by 0.5%: 573.6 s against 570.6 s. Neither flag is worth setting.

What survives is the underlying point, in a stronger form: **prefix reuse is the
largest win available, but it is won in the client, not in a flag.** Keep the
workspace context stable and ahead of the history so each turn is a true append,
and Muse Glimmer's second turn costs 2.6 s instead of 9.5 minutes.

### 2. Do not set `--swa-full`

Default is off, which uses the small rolling SWA cache. Setting it would use a
full-size cache for every layer and throw away the model's main memory advantage.
We do not set it. Keep it that way, and do not let it in through
`runtime.extraArguments`.

### 3. Speculative decoding is architecturally intended here

`dflash.cpp` extracts hidden states from five target layers — the GGUF declares
`target_layers [2, 14, 26, 38, 50]` — and injects them into the drafter's
attention. That is why it borrows the target's tensors through `ctx_other`, and
why it has no embedding or output tensors of its own.

This is a designed pairing, not an accident, and verification is lossless. It is
the only lever that attacks *generation* rather than prefill on a dense model.
Needs `--spec-type draft-dflash` and its acceptance rate measured.

### 4. What cannot be fixed

Generation is bandwidth-bound on 30B of active weights, plus ~5% extra for the
gates. No flag, backend, or quantisation choice changes that arithmetic. A GPU
with its own high-bandwidth memory would, but 17 GB does not fit in a laptop
GPU, and an integrated GPU shares the same system RAM.

---

## How this bears on the model decision

It reinforces it, with one caveat worth testing.

**Reinforces:** the model is dense *and* carries an extra Q-sized projection per
layer. Against Qwen3-Coder-30B-A3B's 3.3B active parameters, the generation gap
is structural.

**The caveat:** Muse Glimmer's sliding-window attention means its prefill may
degrade far more gracefully with context depth than Qwen3-Coder's full attention.
Our comparison was on a short prompt. At a realistic 10k-token workspace prefix
the prefill gap could be narrower than 94× suggests — though Qwen still wins
outright on generation, and on not emitting hundreds of reasoning tokens first.

That is worth one measurement, not a reopened decision: **run both models at 8k
prefix depth and record pp separately.** If Muse Glimmer holds up better than
expected at depth, that is a reason to keep it as a serious optional profile for
long-context work rather than a curiosity.

---

## Recommended flags for the Muse Glimmer profile

- Keep `--flash-attn auto` (measured slightly faster here).
- Never `--swa-full`.
- Do **not** set `--ctx-checkpoints` or `--cache-reuse`. Both measured as no-ops
  on this workload, to within 0.5%.
- `--spec-type draft-dflash --spec-draft-n-max 3` — measured 2.04×. **Not 15**;
  15 measured 1.09× greedy and a net slowdown at this profile's temperature.
- `reasoning_strength: low` — measured 4.0× faster to the first word than
  `high` on the same box and prompt (92.8 s against 367.4 s, greedy).
- Never stop on `<|eom|>`.

---

## What the model card actually claims, read directly

Fetched from the publisher's GGUF card and the Meta research blog, 2026-08-11.

### The published baselines are all GPU or Apple-silicon

| Hardware | baseline | with DFlash | speedup |
|---|---:|---:|---:|
| RTX 5090 | 74.9 tok/s | 233.4 tok/s | 3.1× |
| Apple M5 Max | 26.6 | 50.2 | 1.8× |
| Apple M4 Max | 23.7 | 37.8 | 1.5× |
| **our CPU box** | **4.17** | **8.50** (measured, `n-max 3`) | **2.04×** |

**Crucially: the Apple figures were measured with ExecuTorch, not llama.cpp.**
Only the RTX number is a llama.cpp result. So **there is no published llama.cpp
CPU number for DFlash anywhere** — the closest analogue to our hardware was
measured on a different runtime.

Those baselines also validate the bandwidth model. Dividing published throughput
into the 16.75 GB file gives 1,254 GB/s effective for the 5090 and 397 GB/s for
the M4 Max — roughly 70% of each machine's rated bandwidth, the same efficiency
factor our own 4.45 tok/s implies. The model behaves exactly as a dense
bandwidth-bound model should. It is not underperforming; we are running it on a
machine with an order of magnitude less bandwidth than its target.

Every command on the card uses `-ngl 99`. **There is no CPU guidance at all.**

### DFlash is unusually well suited to bandwidth-bound hardware

From the drafter card: it "predicts entire blocks of 16 tokens in a single
forward pass. The main model then verifies these proposals in parallel."

### The prediction we made, and what the measurement did to it

This section used to argue that DFlash suits bandwidth-bound hardware *better*
than the 1.5× Apple figure suggests, because on such hardware **verifying 16
tokens costs one target forward pass — the same bytes as generating one token**.
From that premise it predicted:

| accepted of 16 | GB/token | predicted speedup | predicted tok/s |
|---:|---:|---:|---:|
| 8 | 2.30 | 7.3× | 32.6 |
| 6 | 3.06 | 5.5× | 24.5 |
| **4** | **4.59** | **3.6×** | **16.3** |
| 2 | 9.19 | 1.8× | 8.2 |

**That prediction has now been measured on the same class of box, and its
premise is false.** Speculation was confirmed engaged from the startup log, the
sweep was run greedily so every row produced a byte-identical 430-token answer,
and the result is in `PERFORMANCE.md`. The short version:

| `--spec-draft-n-max` | acceptance | accepted per pass | measured tok/s | vs baseline |
|---:|---:|---:|---:|---:|
| none (baseline) | — | 1.00 | 4.17 | 1.00× |
| 2 | 0.878 | 2.76 | 8.21 | 1.97× |
| **3** | **0.813** | **3.44** | **8.50** | **2.04×** |
| 4 | 0.764 | 4.06 | 8.49 | 2.04× |
| 7 | 0.538 | 4.77 | 6.62 | 1.59× |
| 15 | 0.354 | 6.31 | 4.54 | 1.09× |

Acceptance was never the problem — the drafter is good, and at a 16-token block
it still lands 6.3 tokens per pass, above the 4 the RTX result implies. **The
premise was wrong.** Extra verified positions are not free on a CPU. Turning
each row's accepted-per-pass and ms/token into the cost of one target forward
pass gives a straight line:

| positions verified | ms per target forward pass |
|---:|---:|
| 1 (no speculation) | 240 |
| 2 | 311 |
| 4 | 405 |
| 6 | 560 |
| 8 | 721 |
| 16 | 1390 |

That is **≈157 ms fixed + ≈77 ms per verified position**. The fixed part is the
weight stream — 16.4 GB in 157 ms is 105 GB/s, which is what this machine does.
The per-position part is compute, and at 77 ms it costs *a third of a whole
weight stream per extra token verified*. So verifying a 16-token block costs
**5.8 target forward passes, not one**, and the speedup collapses to the ratio
between 6.3 tokens gained and 5.8 passes spent.

The caveat this document already flagged — "verifying 16 positions is more
*compute* than verifying one, and a CPU is compute-poor" — is the whole story.
It was right, and it is worth more than the arithmetic it was appended to.

**The lever is still worth having, at the right setting.** Because the cost is
linear in positions and the gain saturates, the optimum sits at a small block:
`--spec-draft-n-max 3` or `4` gives **2.04×**, and upstream's own default for
that flag is already 3. Our extension overrode it to 15 — the single worst value
in the sweep, and the one that turns the drafter into a net loss at the model's
own sampling settings.

### Other card details worth keeping

- Drafter: 5 layers, sliding window 2048 on **all** layers, 32 Q / 8 KV heads.
- The card's own invocation is `-md dflash-kquant.gguf -ngld 99` with no
  `--spec-type`. Since upstream only auto-infers the speculative type for
  Hugging Face sidecar downloads, pass `--spec-type draft-dflash` explicitly for
  a local file.
- `-c 131072 -np 4` means 32k per slot; the card warns to scale `-c` with `-np`.
- Full precision is 55+ GB, quantised to under 20 GB.

### The question this created, now answered

The open question was whether a 76.0-SWE-bench model at ~16 tok/s would beat a
51.6-SWE-bench model at 19 tok/s and reopen the model decision.

**It does not reach 16 tok/s. It reaches 8.5, and the decision does not reopen.**
Best measured Muse Glimmer configuration — DFlash at `--spec-draft-n-max 3`,
`reasoning_strength: low` — is 8.50 tok/s of generation and **53 seconds to the
first word of the answer**, against Qwen3-Coder's 22.7 tok/s and 1.2 seconds on
the same box. Doubling generation does not close a 44× latency gap, because that
gap is reasoning tokens, not throughput.

One genuine finding does survive in Muse Glimmer's favour, and it is the
sliding-window one this document predicted: **at ~7.2k of context the prefill
gap narrows from 5.6× to 2.0×, and the generation gap from 5.3× to 1.2×.** See
`PERFORMANCE.md`. That makes Muse Glimmer a defensible *long-context* optional
profile rather than a curiosity — but not a default.
