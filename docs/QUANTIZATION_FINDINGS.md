# Quantisation and model-choice findings

Researched 2026-08-10 by parsing the GGUF headers of the actual published files
over range requests, plus published benchmarks. Several things we believed were
wrong. Corrections first.

---

## Corrections to what we shipped

### "kquant" is plain Q4_K_M

`muse-glimmer-30B-kquant-17gb.gguf` declares `general.file_type = 15`
(`MOSTLY_Q4_K_M`): Q4_K ×365, Q6_K ×52 (all `ffn_down`), Q5_K ×1, F32 ×313.
27.85B params in 16,756,681,056 bytes = **4.81 bpw**, matching stock Q4_K_M.

**"kquant" is a marketing label, not a format.** Nothing proprietary, nothing to
preserve. Unsloth publishes a standard-named ladder for the same model where
UD-Q4_K_XL is *smaller* (15.9 GB) than the publisher's 16.8 GB file.

### `kquant-dynamic` is a 5-bit file labelled 4-bit

It also declares `file_type = 15`, but its real mix is Q6_K ×237, Q5_K ×130,
Q4_K ×51 → **5.65 bpw**. Our manifest calls it `"nominalBitClass": "4-bit"`.
That is wrong, and it explains the 18.3 GiB footprint.

### The `UD-TQ1_0` profiles contain no ternary tensors at all

Both declare `general.file_type = 24` (`MOSTLY_IQ1_S`):

| Profile | Actual mix | TQ1_0 tensors |
|---|---|---|
| `qwen3-coder-30b-a3b-tq1` | IQ1_S ×97 (experts, 1.56 bpw), IQ2_XXS ×26, IQ3_XXS ×76, IQ3_S ×80, IQ4_XS ×31 | **0** |
| `qwen3-coder-next-tq1` | IQ1_S ×154, MXFP4 ×138, IQ3_XXS ×84 | **0** |

The name is a repo-discoverability choice by the publisher, acknowledged on the
record. Our manifest warning about "ternary post-training quantization" reaches
the right conclusion through the wrong mechanism: what we would actually ship is
**IQ1_S experts at 1.56 bpw**, which scores **50.7 Aider against 69.7 at
Q4_K_M** — a 20.9-point loss.

**Both profiles should be deleted, not marked experimental.** They are not a
footprint trade-off; they are a broken assistant.

---

## The two findings that change the default

### 1. IQ2_M costs correctness and buys almost no speed

Generation above ~4 bpw is bandwidth-bound, so smaller is faster. **Below 4 bpw
that inverts**, because dequantisation cost eats the byte saving. From
llama.cpp's own reference table, effective bandwidth (file size × tok/s):

| Quant | GiB | tok/s | eff GiB/s | vs Q4_K_M |
|---|---|---|---|---|
| Q4_K_M | 4.58 | 71.9 | 329 | — |
| IQ4_XS | 4.17 | 77.5 | 323 | 1.08× |
| IQ2_M | 2.74 | 74.4 | **204** | **1.03×** |
| IQ1_S | 1.87 | 79.7 | 149 | 1.11× |

**IQ2_M is 40% smaller and only 3% faster.** Meanwhile code degrades far faster
than chat at low bit width — a 24B dense coder loses **12%** composite at IQ2_M,
and 2-bit damage is invisible to multiple-choice evals while HumanEval collapses.

So our stated rationale for the 2-bit default — smaller *and* faster — does not
survive measurement. It is smaller, and that is all.

### 2. Muse Glimmer is dense, so 4.45 tok/s is the design, not a misconfiguration

All ~30B parameters are active per token. Our measured **69.5 GiB/s** effective
bandwidth is a clean read of a fully-active dense model. Combined with
unsuppressable reasoning, the measured **113 s to first visible answer at 16
threads, 216 s at 6** is the product working as designed.

A mixture-of-experts model touches ~3B of 30B per token. That is the lever —
not quantisation.

---

## Measured dense-vs-MoE on CPU

| Model | Active | Machine | tok/s |
|---|---|---|---|
| Qwen2.5-Coder-32B Q4_K_M dense | 32.8B | Ryzen AI 9 HX PRO 370 | 3.54 |
| Qwen3-Coder-Next 80B-A3B Q4_K_M | 3B | *same box, same run* | **7.74** |
| Qwen3-30B-A3B Q4_0 (`qwen3moe`) | 3.3B | EPYC 9454P | **63.1** |
| Qwen3-Next-80B-A3B (DeltaNet) | 3B | *same box* | 11.8 |

Two operational notes: **SMT hurts** — set threads to *physical* cores — and
`Q4_0` online-repacks to AVX-512 layouts, beating Q4_K_M on CPU. Both worth
measuring.

Note the last row: the newer DeltaNet hybrid architectures have **immature CPU
kernels**, 5× slower than a plain MoE with identical active parameters on the
same machine. That is an implementation gap, not an architectural cost, but it
is real today and gates any move to that family.

---

## Qwen3-Coder-30B-A3B, verified

30.5B total, **3.3B active**, 128 experts with 8 active, 48 layers, 4 KV heads.

- **Not a reasoning model.** The card states it supports only non-thinking mode.
  This alone removes the 113–216 s time-to-first-answer.
- **FIM is official**, and its tokens are `<|fim_prefix|>`, `<|fim_suffix|>`,
  `<|fim_middle|>`, `<|fim_pad|>` — **exactly the tokens already hardcoded in our
  `client.js`**. Switching restores inline completion with no code change. Use
  `/infill` or raw `/completion`, not the chat route, which returns fenced code.
- Independent pass@1: HumanEval 92.1, HumanEval+ 87.8, MBPP 87.6, MBPP+ 73.5.
- SWE-bench Verified **51.6**, against Muse Glimmer's **76.0**. That is the real
  trade, and it is a large one on agentic work.

Its KV cache is **7.4× more expensive per token** than Muse Glimmer's, which has
2 KV heads and sliding-window attention on 39 of 52 layers. At 16K with q8_0 that
is 0.82 GiB — still comfortable: 16.48 GiB weights + 0.82 GiB KV + ~1 GiB
compute ≈ **18.5 GiB**, leaving ~13 GiB for Windows and the editor.

---

## KV cache arithmetic

```
bytes/token = 2 × n_attention_layers × n_kv_heads × head_dim × bytes_per_element
f16 = 2.0 bytes; q8_0 = 34/32 = 1.0625 bytes
```

llama.cpp allocates the full `n_ctx` up front, so this is fixed, not growing.

| Model | f16 /1K tok | q8_0 /1K tok | 16K (q8_0) |
|---|---|---|---|
| Muse Glimmer 30B | 12.7 MiB + 78 MiB fixed | 6.7 MiB + 41 MiB | 152 MiB |
| Qwen3-Coder-30B-A3B | 93.8 MiB | 49.8 MiB | 816 MiB |
| Qwen3.6-35B-A3B | 19.5 MiB | 10.4 MiB | 170 MiB |

This reproduces our own measurement — predicted 82 MiB for Muse Glimmer 4K→16K,
measured 85 MiB — which validates both the formula and the measurement.

---

## Our benchmark cannot settle a quantisation question

`bench/coding-smoke.json` pattern-matches on regexes like `while\s+lo\s*<=\s*hi`
and deliberately never executes generated code. The failure mode low-bit
quantisation actually causes is **plausible, fluent code with one wrong boundary
condition** — which passes a regex and fails a test. For quantisation decisions
specifically, the current suite is blind to the thing being decided.

Perplexity and KL divergence are also unsuitable: above ~Q4 their correlation
with code correctness is statistically zero.

---

## Ranked recommendation

1. **Switch the default to `qwen3-coder-30b-a3b-q4xl`** (UD-Q4_K_XL, 16.48 GiB,
   all-K-quant so it takes the fast CPU dequant path). Non-reasoning, FIM works
   with existing code, 3.3B active, essentially the same footprint as today.
2. **Evaluate Qwen3.6-35B-A3B UD-Q3_K_XL** (15.69 GiB) as the successor —
   SWE-bench 73.4, disableable thinking, MTP speculative decoding, cheap KV.
   **Gate on a `llama-bench` run** proving its DeltaNet CPU kernels are not the
   5× penalty measured on the same family.
3. **Keep Muse Glimmer as an optional deep-reasoning profile.** Best model here
   on paper, Apache-2.0, with vision. It is simply not an interactive CPU
   assistant.
4. **Delete both TQ1 profiles.**
5. **Demote `qwen3-coder-30b-a3b-iq2m`** to a low-RAM fallback.

Also fix: `defaultProfile` contradicts `MODEL_SELECTION.md`, and
`kquant-dynamic` is mislabelled 4-bit.

## What would settle it

`llama-bench -ngl 0 -t <physical cores> -p 512 -n 128` across the candidates on
the **target workstation**, plus time-to-first-answer-token on one realistic
prompt per profile. Twenty minutes, and it replaces every estimate here with a
measurement on the hardware that matters.
