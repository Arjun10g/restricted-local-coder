# Muse Glimmer speed-up — consolidated research review (2026-08-11)

Three independent sweeps, run ~24h after the model's release: (A) llama.cpp
upstream PRs/issues since our b10355 pin, (B) community/vendor findings, (C) a
file-and-line read of the b10355 source. Companion to
`MUSE_GLIMMER_INTERNALS.md` and `RUNTIME_PERFORMANCE_SPEC.md` §0; where this
document and an older one disagree, this one is newer — and a measurement on
our own hardware outranks all of them.

Labels: **[M]** measured with hardware attached · **[C]** claimed/vendor ·
**[D]** derived/arithmetic · **[S]** read from source, cited file:line.

---

## 1. Verdicts that close open questions

- **Stay pinned at b10355.** Only three commits landed upstream after it as of
  2026-08-11 ~01:30 UTC (a header comment, an OpenCL prefill kernel, a CI
  bump) — a newer pin currently buys nothing on our backends [M-upstream].
- **`--no-cache-idle-slots` is resolved: keep it, zero further action.** At
  explicit `--parallel 1` the idle-slot machinery is a no-op-to-harmless
  (KV clearing requires `kv_unified`; the save loop skips the only, busy
  slot) [S: server-context.cpp:2459-2472, 1711-1740].
- **`--cache-reuse` is a no-op for Muse Glimmer — stop planning around it.**
  Chunk salvage needs `llama_memory_can_shift()`, which for iSWA requires
  both sub-caches equal-sized — false for a real SWA model unless
  `--swa-full` [S]. Prefix reuse (`cache_prompt`, default on) is unaffected
  and is the mechanism we actually rely on; the request-shape fix
  (RUNTIME_PERFORMANCE_SPEC §0) is what makes it bite.
- **Checkpoints: defaults are already right.** `-ctxcp 32`,
  `--checkpoint-min-step 8192`, auto-created for SWA models at user-turn
  boundaries, snapshotting only the SWA-layer state (cheap under 16:1 GQA)
  [S]. Pure append reuses KV with no flags; divergence deeper than the 2048
  window without a checkpoint forces the logged "full prompt re-processing"
  path — the failure mode the §0 layout fix exists to avoid.
- **Never load the mmproj.** Beyond being unused, a live upstream bug shows
  prefill degrading persistently 3062 → 1875 t/s (+1.1 GB) after the first
  image request ([#26873], 7800X3D + 2×5070 Ti) [M]. Text-only is also what
  keeps `cache_prompt` compatible (multimodal hard-disables cache reuse).
- **OpenVINO is not an option** — no Muse Glimmer support exists in
  optimum-intel/OpenVINO GenAI. **On Windows/Intel the backend is Vulkan**;
  SYCL is fragile-to-broken on Arc/Windows in current builds and its
  occasional ~5% tg edge does not survive the setup cost [M-adjacent].
  AMD's published Muse numbers are llama.cpp-Vulkan-on-Windows with DFlash
  engaged, which de-risks exactly our path [M-vendor].

---

## 2. The prefill anomaly — our 12.9 t/s pp is wrong, and that changes everything

Two sweeps independently flag it: batched prefill on a dense 28B should be
compute-bound at roughly **5–20× tg**, not our measured 2.9× (12.9 pp vs 4.45
tg on 28 cores). Something in our configuration is throttling prompt
processing. Ranked suspects, all cheap to test [S/D]:

1. **`--no-repack` drops the fast CPU GEMM kernels entirely.** It sets
   `no_extra_bufts`, removing the interleaved-quant repack buffer types
   (`ggml/src/ggml-cpu/repack.cpp`) — quantized matmuls fall back to generic
   row-dot kernels, routinely a 2–4× prefill hit on AVX-512
   [S: arg.cpp:2353-2360 → llama-model.cpp:902-934]. Our earlier "repack ≈
   +12%" measurement conflicts with this theory — re-measure **pp
   specifically** (`llama-bench -p 512`), repack on/off × ubatch 128/512. RAM
   (+11.4 GiB measured) still decides the shipped default; a 3× pp win would
   justify a repack-on variant for machines with headroom.
2. **`-ub 128` undersizes prefill.** Weights stream once per ubatch; 512 is
   the upstream default and typically +20–50% pp on CPU [D].
3. **q8_0 V forces flash attention ON** — "auto" never probes for us
   [S: llama-context.cpp:3580-3589], and CPU FA can lose to the non-FA GEMM
   path at large prefill batches. A/B `-ctv f16 --flash-attn off` (K may stay
   q8_0; V at 16:1 GQA is trivial).
4. **Was the drafter loaded during the measurement?** DFlash taxes *prefill*:
   every prefill ubatch pays an extra drafter encoder + injection pass
   [S: speculative.cpp:1066-1089, server-context.cpp:3710-3718]. Re-measure
   pp with the drafter absent to isolate.
5. Threads = physical cores; verify the `load_backend: ggml-cpu-<variant>`
   log line actually selected the AVX-512 variant.

Fixing pp is also what would make DFlash viable on CPU (next section) and
directly sets TTFT for turn 1 and every context refresh.

---

## 3. DFlash — decision tree, not a checkbox

**The single most important knob upstream: `--spec-draft-p-min` defaults to
0.0 = confidence gating OFF.** In the closest measured case ([#25792], same
code path, CPU and Vulkan identical): acceptance 0.15 → **0.95** and net
slowdown → net win, purely from `p_min 0.75` [M]. The only published
acceptance for Glimmer's own drafter upstream is **0.34, mean accepted 3.04**
(PR #26841 validation) [M]. Meta's 3.1× is greedy-sampled and unreproduced —
a real 4090 run got 1.5× at 80k ctx [M]; our profile's temp 1.0 sampling will
cost acceptance further [C/analysis].

**CPU (today's box):** at our *current* 2.9× pp/tg ratio, verifying a
15-token block costs ~1.2 s to commit ~3–4 tokens vs ~0.8 s serial — a net
loss [D]. DFlash on CPU is therefore *downstream of the §2 prefill fix*. If
tested anyway: `--spec-draft-n-max 3..4 --spec-draft-p-min 0.5–0.75
--spec-draft-n-min 0`, f16 draft KV, greedy. A CPU datapoint would still be
the first published anywhere.

**Intel GPU (workstation):** proven on the Vulkan backend (AMD: 24 t/s
Ryzen AI Max iGPU-class, 53 t/s R9700, `--spec-draft-n-max 4`) [M-vendor].
Community working config: `--spec-type draft-dflash --spec-draft-p-min 0.2
--spec-draft-n-min 0 --spec-draft-n-max 3 -b 2048 -ub 1024`, **`--split-mode
layer` only** — tensor split fails to build the dflash context [M-community].

Mechanics that matter [S]: verify batches (≤17 tokens) ride the normal ubatch
path — `-ub 128` is sufficient; speculation runs during the reasoning phase
(nothing gates it); rollback needs no target checkpoints on this arch (iSWA
partial `seq_rm`). Engagement check stays what the manifest note says: the
`adding speculative implementation 'draft-dflash'` log line, and
`tok/decode-pass > 1.000` — a silently-inactive drafter still costs prefill.
Known edge: spec decode can assert at the 16k boundary ([#26478], fix #26575
open) — cap `n_predict` short of `n_ctx` when the drafter is on.

---

## 4. Reasoning cost — confirmed, with numbers

- `chat_template_kwargs.reasoning_strength` is the **only** correct control:
  the model-card system-prompt method renders *both* directives and is
  half-strength. Mean completion tokens 199 (absent = high) / 147
  (card-method low) / 113 (kwarg low), GB10, n=6 [M]. Our client already
  does this correctly; never add the system-prompt variant.
- Top-level `reasoning_effort` and `enable_thinking` are dead knobs for this
  template [M]. Absent = high — which is why the `'off'` footgun
  (REMAINING_WORK §B) matters: today "off" buys the slowest mode.
- `--reasoning-budget N` works on b10355 for hard caps; `0` = no thinking.
  No published quality-vs-strength benchmark deltas exist yet — our own
  bench table (REMAINING_WORK §E) would be genuinely new data.
- DFlash accelerates the thinking phase too (paper claim [C]; nothing in the
  server gates it [S]).

---

## 5. Intel GPU playbook (when the workstation work starts)

- **Backend: Vulkan.** Fresh driver is load-bearing — a driver/Mesa update
  alone *doubled* Vulkan decode on Battlemage-class hardware [M-adjacent].
- **Dense-28B reality check:** best proxy measured on Arc B70-class 32 GB:
  ~20 t/s decode (Qwen3.6-27B Q4) [M-adjacent]. Full-offload NVIDIA
  reference: pp 3062 / tg 38.7 (2×5070 Ti, dynamic kquant) [M].
- **Prefer a quant that fits entirely on-GPU over splitting a bigger one:**
  UD-Q3_K_XL (13.4 GB) + drafter fits 16 GB; kquant-17gb split loses to it
  on paper [D]. 8 GB: `-ngl 18-22`, skip the drafter (1.6 GB ≈ 5 layers).
  12 GB: `-ngl 30-34`. `tok_embd` is always CPU; `output.weight` offloads
  only at `-ngl 53` — under speculation the lm_head runs 17-row batches, so
  pin it (`-ot "output\.weight=<device>"`) when partially offloaded [S].
- **`-ub 2048` measured +61% prefill on Arc with zero decode penalty**
  [M-adjacent]; watch Vulkan compute-buffer VRAM.
- **No KV quant on Intel**: FA gains there are 5–10% at best, quant-KV
  kernels immature, and this model's KV is tiny anyway (~1.7 GiB for full
  128k BF16 [D]; hundreds of MB at our contexts). Spend VRAM on layers.
- Integrated Xe/UHD expectation: ~2× prefill, **zero** generation gain
  (shared bandwidth) [M-adjacent] — a prefill assist, not a speed tier.

---

## 6. Upstream watchlist (recheck before each pin bump)

| Item | Status 2026-08-11 | Why we care |
|---|---|---|
| [#26849] / [#26879] tool-call parsing | OPEN (maintainers steering to #26879 first) | ~17% of agentic tasks leak raw tool markup into visible content on Glimmer; 0/425 turns after fix. Attribute tonight's agent-loop parse failures to this, not to our permission layer |
| [#26842] Glimmer drafter optimization | OPEN, unblocked by #25532 (already in our pin) | Backend block-sampling for DFlash; mostly a GPU win |
| [#26814] spec-type auto-detect from GGUF | OPEN | We pass `--spec-type` explicitly, so not exposed; it's the check if logs ever show tok/decode-pass = 1.000 |
| [#26575] / [#26478] 16k-boundary spec assert | OPEN | Cap n_predict short of n_ctx while the drafter is on |
| [#25908] p_min default footgun | OPEN | Upstream may change the default; our profiles should carry explicit `p_min` regardless |

---

## 7. Ranked actions (supersedes the ordering in older docs where they differ)

1. Request-shape fix + context snapshot (RUNTIME_PERFORMANCE_SPEC §0) —
   turn-2+ TTFT to seconds, no flags needed, verified by `timings.prompt_n`.
2. Resolve the §2 prefill anomaly: repack × ubatch × FA/-ctv × drafter-absent
   matrix via `llama-bench`. Everything downstream (DFlash viability, context
   budgets, GPU expectations) re-derives from the corrected pp number.
3. Reasoning: fix the `'off'` mapping; keep kwarg-only control; default
   `low` for interactive call sites.
4. DFlash per the §3 decision tree — explicit `p_min` in the profile's
   draft config, engagement + acceptance logged, CPU verdict recorded
   honestly even if it is "net loss, off by default".
5. Muse profiles: consider dropping q8_0 KV (gate change; KV is too small to
   be worth quantizing) after the §2 A/B says which way f16 V cuts.
6. Intel playbook (§5) when workstation hardware is in hand.

---

## 8. Raising raw generation tok/s — literature review (added 2026-08-11)

Two further sweeps: the speculative/decode-acceleration menu actually present
in b10355, and the quantization ladder's speed/quality trade for this model.
Extends §7; where they touch the same knobs, this section is newer.

### 8.0 The wall, priced exactly — scope corrected 2026-08-11

**For Muse Glimmer (dense):** 16.76 GB × 4.45 tok/s = 74.6 GB/s — at 100% of
the box's ~75 GB/s bandwidth [D]. Dense generation is performing as physics
allows for this file size; the levers are fewer bytes per token, more tokens
per weight-read (speculation), or different silicon.

**This does NOT generalize to the Qwen MoE default** (correction from the
executing session, arithmetic verified): 3.3B active of 30.5B ⇒ ~1.78 GiB
read per token; at its measured 22.68 t/s that is only ~40 GiB/s — roughly
half what the same box sustains on the dense model. The gap is llama.cpp's
scattered expert gather (8 of 128 experts, paying miss latency rather than
streaming) [D]. The MoE default has real headroom; "physics-perfect" must not
close that case.

**And the number users actually feel is the DEPTH number — RESOLVED
2026-08-11, shipped in v0.5.1 (commit 51115a5).** The depth collapse was the
q8_0 KV cache type. Measured (EPYC 7763, 28 physical cores, b10355, Qwen
UD-Q4_K_XL, greedy, 3 reps, server timings) [M]:

| depth | q8_0/q8_0 | q8_0-K/f16-V | f16/f16 |
|---:|---:|---:|---:|
| 130 | 18.76 | 18.50 | 19.36 |
| 2048 | 9.91 | 11.23 | 16.38 |
| 4096 | 6.37 | 8.06 | 14.38 |
| 8192 | **3.46** | 4.96 | **10.88** |
| 14336 | 2.17 | 2.98 | 6.86 |
| peak RSS | 17.39 GiB | 17.74 GiB | 18.10 GiB |

**3.1× at 8192 for 0.71 GiB**, and prefill gained +49% at 8192 (19.66 →
29.22) — unpredicted, and it matters more than tg for our workload. K is
~80% of the damage; the K-quantized half-measure recovers only a fifth.
Shipped: f16 default, per-profile `kvCacheType` manifest override, and the
check-source `'q8_0'` literal deliberately changed, with a comment recording
that the assertion was measured wrong.

Findings that ride along [M]:
- **The speculation-amortisation hypothesis was confirmed, then obsoleted by
  the same fix**: ngram at 8192 took q8_0 from 3.46 → 7.23 (best repetition
  48/48 accepted, landing exactly on the f16 baseline), but adds nothing on
  top of f16 — both were paying the same dequantisation bill. Ngram stays
  non-default on the Qwen profile (5.4–10.9 t/s variance as the lookup
  warms vs f16's deterministic recovery).
- **FA confound clean**: with f16 KV, `-fa on` beats `off` by 34% at 8192
  (loses 14% at depth 130) — recovery is dequantisation, not the FA path;
  `--flash-attn auto` was already right. Any "FA is neutral" claim from
  trivial-depth llama-bench does not hold at real depth.
- **Muse confirms the mechanism in miniature**: only ~21% depth loss either
  way (3.99→3.30 q8_0 vs 4.18→3.98 f16), exactly as SWA + 16:1 GQA
  predicts. **DFlash on Muse improves WITH depth** — 1.30× at 130 → 1.65×
  at 8192, acceptance 0.35 → 0.58, at n-max 3 — the only measured
  configuration that gets better with context.

**Reversal of an earlier reading**: apparent model convergence at depth was
a q8_0 artifact. The real gap at 8192 is **2.7× (Qwen 10.88 vs Muse 3.98)**,
and the Qwen default is back above the ~10 t/s chat floor at workspace
depth — the default-model decision is more clearly right, not less.

### 8.1 The free lever nobody had on the list: ngram speculation

b10355 ships draftless prompt-lookup speculation — `--spec-type ngram-mod`
(also `ngram-simple`, `ngram-map-k`, `ngram-map-k4v`): drafts by matching the
current n-gram against prompt+generation history, ~16 MB constant memory, no
draft model, works on CPU and Vulkan. Upstream's own docs name its use cases
as "code iteration, reasoning models, summarization" — and our agent loop is
its best case (edits echo `old_text`, tool results get restated). Measured
analog: mean acceptance **7.27 tokens on code-editing (InstructCoder) vs 4.24
for EAGLE, ~2.1× at batch 1** [M, Llama3.1-8B/vLLM, arXiv 2601.11580]; on
chat/GSM8K it collapses to ~1.4–2.0 accepted (≈1×, small overhead). Long
drafts are NOT free — one measured config at n-max 64 was **−39%** [M];
start `--spec-draft-n-max 16–24` on CPU.

**It composes with DFlash**: `--spec-type ngram-mod,draft-dflash` — draftless
strategy takes precedence when it hits, drafter covers the rest (types run
independently, they don't pipeline — #23184).

### 8.2 DFlash, updated picture

- Acceptance on a comparable target measured at **5.3–7.7 tokens per
  15-block** (85–90% at position 0, 12–20% at position 14) [M] — materially
  better than the 0.34-acceptance datapoint in §3; workload variance is huge
  (one community A/B measured **−33.5%** [M]). §3's p_min guidance stands.
- Verification reads the target weights **once per block** — on a
  bandwidth-pinned box that is the whole point. §3's "net loss at current
  pp/tg ratio" arithmetic is exactly why the §2 prefill fix gates this:
  fix pp, and the verify batch becomes nearly free.
- Spec × quant literature [M, arXiv 2505.22179]: target quantization barely
  moves acceptance down to 4-bit, but the *relative* spec speedup shrinks on
  low-bit targets (verify compute becomes the bottleneck). Keep the agent
  profile ≥4-bit and take speed from speculation, not from Q2.

### 8.3 Quant ladder verdicts (Muse-specific where it exists)

| Option | Size | CPU expectation | Verdict |
|---|---:|---|---|
| official kquant (current) | 16.8 GB | 4.45 t/s [M, ours] | baseline; ~1.0% degradation [C, Meta] |
| UD-Q4_K_XL | 15.9 GB | ~4.7 [D] | drop-in, marginal |
| **UD-Q3_K_XL** | 13.4 GB | **~5.3–5.6 [D]** | CPU sweet spot for *chat*; coding loss ~2–4% [D from analogs] |
| UD-Q2_K_XL | 12.4 GB | ~5.7–6.0 [D] | chat-only; tool-calling degrades first (−17.5% vs −3.8% math in closest eval [C]) |
| any IQ2/IQ3 | 10.7–14.1 GB | **no speed win** | IQ codebook dequant ~3× slower/token when compute-bound [M, 7950X]; skip on CPU AND Arc |

Two mandatory preconditions before any quant-quality conclusion: **re-download
the GGUFs** (Unsloth fixed a tool-calling chat-template bug "that affects all
quant uploaders" [C] — day-0 files are tainted for tool-call evals), and run
our own bench tool-call-validity task. Tailwind worth recording: gated
attention measurably suppresses activation outliers (NeurIPS 2025 [M, on
other models]), so this architecture should quantize *better* than 2024-era
30B priors.

### 8.4 Dead ends, so nobody re-litigates them

draft-mtp (model has no MTP heads — vLLM recipe confirms), draft-eagle3 (no
Muse head exists yet; watch SpecForge), draft-dspark (Qwen-backbone-only),
draft-simple (no small sibling model, 202k vocab blocks cross-family),
lookahead/LayerSkip/SWIFT/CLaSp (not in llama.cpp; self-speculation also
spends ~half the bandwidth on drafting), PowerInfer/TurboSparse-style
activation sparsity (needs dReLU retraining; SwiGLU has low natural
sparsity). Sampling: negligible at our speeds — just never set `--top-k 0`
(measured multi-% slowdown over a 202k vocab, #15223); `--backend-sampling`
is a no-op on CPU, small win on GPU.

### 8.5 Intel backend — a genuine measurement conflict to settle on-device

Evidence now points both ways: B70-class SYCL measured ~2× Vulkan on dense
TG in one suite (16.3 vs 8.1 t/s, UD-Q4_K_XL) [M], another current thread
has SYCL only +6% TG with Vulkan ~2× ahead on pp [M], and Windows/Arc SYCL
builds have real fragility reports. Resolution is empirical: A/B both on the
actual laptop; pick by the binding axis (tg for chat, pp for agentic context
re-reads). Independent of backend: **Q4_K is the fast path on Arc — dropping
below Q4 gains nothing there** (Q3_K_M measured *slower* than Q4_K_M),
Q8_0 runs at 21–24% of theoretical bandwidth, and IQ formats are ~4× slow.

### 8.6 Ranked tok/s plan

**Gate resolved (v0.5.1): f16 KV shipped and recovered depth throughput**
(§8.0 table — 3.46 → 10.88 t/s at 8192 on the default profile). Consequences
for the list below: the Q3_K_XL chat tier is **un-deprioritised** but must be
evaluated against the f16-KV baseline, not the old numbers; ngram stays
non-default on Qwen (its gain was the q8_0 bill, now paid differently, and
its rep-to-rep variance is worse than f16's determinism); and the Muse DFlash
A/B is no longer purely gated on the prefill fix — at depth it already pays
(1.65× at 8192, measured), the prefill fix decides the *short-prompt* case.

CPU box (agent workloads): (1) `ngram-mod,draft-dflash` combo with n-max
16–24 (ngram) / 15 (dflash) + explicit p_min — expected 1.4–2.2× [D];
(2) ngram alone as the zero-cost control; (3) after the §2 prefill fix,
re-run the DFlash A/B; (4) UD-Q3_K_XL for the *chat* profile (+~20%,
multiplicative) after the template-fixed re-download + tool-call bench;
(5) record the stacked result honestly — ~7–10 tok/s is the plausible ceiling
[D], and any CPU DFlash/ngram number is the first published. Use b10355's
bundled SPEED-Bench (`tools/server/bench/speed-bench/`) with real agent
transcripts — measured spec-decode outcomes span −39% to +210% by workload.

Intel laptop: DFlash `-ngld 99` on the AMD-validated Vulkan path (1.5–2.5×
[D]), ngram in front for free, SYCL-vs-Vulkan A/B per §8.5, Q4-class quant,
`--backend-sampling` if the sampler chain is backend-supported.

[#26873]: https://github.com/ggml-org/llama.cpp/issues/26873
[#25792]: https://github.com/ggml-org/llama.cpp/issues/25792
[#26478]: https://github.com/ggml-org/llama.cpp/issues/26478
[#26849]: https://github.com/ggml-org/llama.cpp/pull/26849
[#26879]: https://github.com/ggml-org/llama.cpp/pull/26879
[#26842]: https://github.com/ggml-org/llama.cpp/pull/26842
[#26814]: https://github.com/ggml-org/llama.cpp/pull/26814
[#26575]: https://github.com/ggml-org/llama.cpp/pull/26575
[#25908]: https://github.com/ggml-org/llama.cpp/issues/25908
