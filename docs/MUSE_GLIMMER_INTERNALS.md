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

This matters *because* of the sliding window. With SWA, the cache for most layers
has discarded old keys, so the server cannot simply rewind and reuse a prefix the
way it can with full attention — it needs checkpoints to restore state.

We resend a large, nearly identical workspace prefix every turn. On a
sliding-window model, prefix reuse depends on this being configured. **Measure
`--cache-reuse` with and without checkpoints;** on this architecture they are
likely to interact, and the pairing may be worth more than any backend change.

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
- Set `--ctx-checkpoints` and measure with `--cache-reuse`.
- `--spec-type draft-dflash --spec-draft-n-max 15`, kept only if acceptance
  justifies it.
- `reasoning_strength: low` — measured 4.2× faster to the first word with a
  *longer* answer.
- Never stop on `<|eom|>`.
