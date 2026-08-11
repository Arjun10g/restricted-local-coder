# Muse Glimmer 30B — what we know, and what it changes

Researched 2026-08-10, the day the model was published. Every primary source is
from that day, so **nothing here has been independently validated by users yet**
and the publisher's benchmark numbers are unreplicated.

---

## What it is

Meta's **Muse Glimmer 30B** (`meta-models/Muse-Glimmer-30B`), Apache 2.0.
Roughly 29.6B parameters, **dense — not mixture-of-experts**, distilled from a
larger internal "Muse Spark" model. 52 layers, hidden 6656, SwiGLU, 131072
context. The ~1.8B of that total is a ViT perception encoder; image input needs a
separate `mmproj` file we do not ship, so we run text-only.

GQA is aggressive: **32 query heads to 2 KV heads, 16:1**, which is why the KV
cache is cheap relative to the parameter count. That matches the GGUF header we
read directly, so the file is the genuine artifact.

It is **agentic-first**, not a general chat model and not a narrow coding model.
Published coding-relevant scores: SWE-Bench Verified **76.0**, SWE-Bench Pro
51.2, TerminalBench 2.1 51.7, SciCode 43.6, MCP Atlas (tool use) 75.5. There are
**no published HumanEval, Aider, or LiveCodeBench numbers** — do not assume any.

Licence is plain Apache 2.0: no Llama-style community terms, no user threshold,
no attribution requirement. The card carries an 18+ statement and standard
lawful-use language. Nothing that obstructs corporate deployment.

There is **no smaller variant and no non-reasoning sibling.** Speed is meant to
come from quantisation and speculative decoding, not from a smaller checkpoint.

---

## What changes our configuration

### 1. Reasoning cannot be turned off — but its depth is controllable

There is **no `enable_thinking` flag and no `/no_think` equivalent**. The chat
template emits reasoning unconditionally. Instead the template accepts
**`reasoning_strength`: `low` | `medium` | `high` | `xhigh`, defaulting to
`high`**, injected as a literal system-prompt line:

```
Reasoning strength: low.
```

We set nothing, so **we have been silently running `high`** — the most expensive
setting — on a CPU machine at ~4.5 tok/s. Meta recommends high or xhigh for
coding and agentic work, so there is a real quality trade here, but the default
was never a deliberate choice on our part.

This is a separate lever from `--reasoning-budget`, and probably the better one:
budget truncates thinking mid-flight, whereas strength asks for less of it up
front.

### 2. Stop tokens: one specific mistake truncates every tool call

Correct stop tokens are **`<|end_of_text|>` (200001)** and **`<|eot|>` (200008)**.

**`<|eom|>` must never be a stop token.** It marks message boundaries *within* a
turn — reasoning ends, tool call begins — so stopping on it truncates every tool
call. The extension does not currently set `stop` for chat, which is correct;
this must stay that way, and the FIM stop list must never be reused for chat.

### 3. Reasoning surfaces as `reasoning_content` — and `--reasoning-format none` breaks that

Under `llama-server`, thinking arrives on `reasoning_content`, which is what we
now read. Passing `--reasoning-format none` would instead fold reasoning into the
visible assistant message. We do not pass it, and must not.

### 4. `--jinja` is mandatory

The GGUF's embedded template is byte-identical to the base repository's, so no
`--chat-template-file` is needed. We already pass `--jinja`.

### 5. `-c` is divided across `-np` slots

Per-slot context is `--ctx-size / --parallel`. We pass `--parallel 1`, so the
full context reaches the single slot. Anyone raising `--parallel` must raise
`--ctx-size` in step or silently lose context.

### 6. Sampling defaults are already right

Meta states temperature **1.0**, top_p **0.95**, top_k **64** — exactly what the
manifest carries. Meta publishes no guidance for `min_p` or `repeat_penalty`; our
0.0 and 1.0 are the neutral values, so they neither follow nor contradict. No
change needed.

---

## Known llama.cpp issues that affect us

**Tool-call markup can leak into visible content — PR #26849, open.** The parser
reads content `until("<|eot|>")`, so when the model emits prose *and* a tool call
in one generation, the raw tool markup is swallowed into `message.content` and
shown to the user. Reported at roughly **17% of tasks**. This lands directly on
agent mode: it means a meaningful minority of tool calls will be malformed or
missing until the fix merges. Track it before recommending agent mode.

**mmproj memory regression — issue #26873, open.** Memory grows ~1.1 GB and
prefill throughput drops after first image use. We ship no mmproj and do not
accept images, so this does not affect us.

The merge PR itself describes its chat handling as "the basic minimum to allow
tool calling", with follow-ups expected. Expect churn for a week or two.

---

## Speculative decoding: the drafter works, and we invoked it wrongly

`dflash-kquant.gguf` is Meta's **DFlash block-diffusion drafter**, ~3B, 5 draft
layers, block size 16, sliding window 2048. Meta reports **~3.1x on an RTX 5090,
1.5x on an M4 Max, with identical output quality**, since verification is
lossless.

**Correction.** We previously recorded the drafter as architecturally
incompatible. That was wrong, and the manifest said so in shipped data. The
evidence:

- **`"dflash requires ctc_other"` is a misreading of `ctx_other`, and it is a
  benign warning, not an error.** DFlash has no `token_embd.weight` and no
  `output.weight` because it borrows both from the target model, so it cannot
  build a standalone context. During llama-server's memory-fitting probe the
  draft context is built without a target, so the throw always fires; it is
  caught and logged as a warning, and startup continues.
  (`src/llama-context.cpp:154-161`, caught at
  `tools/server/server-context.cpp:1191-1193`.)
- Our actual failure was the **next line in the log**: `unknown model
  architecture: 'muse-glimmer'`. The same root cause as everything else.
- Meta's published GGUF is **fully upstream-conformant** — the header carries
  `target_layers`, `block_size 16`, and `mask_token_id`, and the tensor shapes
  match. **Do not re-convert it.** The Q/K layout does differ between the two
  files (target NORM rope, drafter NEOX rope) but that asymmetry is deliberate
  and upstream handles both.

### The flag we were missing

`--model-draft` **alone does not enable speculative decoding for a local file.**
The speculative type defaults to `NONE`, and the auto-inference that would set it
only fires for Hugging Face sidecar downloads, never for a local path. The draft
model loads into memory and is then never used. That gap is open upstream bug
**PR #26814**.

The correct invocation, matching Meta's own model card:

```
--model-draft dflash-kquant.gguf --spec-type draft-dflash --spec-draft-n-max 15
```

Note **15, not 16**: DFlash spends one of the block's 16 slots on the anchor
token, so the value is clamped to `block_size - 1` with a warning.

Also: `--cache-type-k/v` do **not** propagate to the draft context — the draft
uses its own `-ctkd` / `-ctvd`. And quantised KV on the draft was once
catastrophic for acceptance (issue #25725, ~0-2%); that is fixed well before our
floor, but it is a reason to change draft cache settings only deliberately.

### Verifying it actually engaged

Watch the startup log for `adding speculative implementation 'draft-dflash'` and
`block_size=16, mask_token_id=201818, n_extract=5`. **If those lines are absent,
speculation is not running** however healthy the rest looks — which is exactly
the failure mode of the missing-flag bug. Then check draft acceptance in the
per-request timings.

**Open risk:** issue #25792 reported DFlash acceptance stuck near 0.15 —
explicitly device-independent, and a net *slowdown* at that rate. It is closed,
the reason is unclear, and whether it affects Meta's drafter is unknown. An open
PR titled "Glimmer drafter optimization" (#26842) may be related. So measure
acceptance; do not assume the published speedup transfers to CPU. Meta's 1.5x
figure is Metal, and **no published CPU benchmark for this pairing exists.**

---

## Version floor

Support merged in commit `62bf73d` (PR #26841), earlier on 2026-08-10 than the
b10353 tag. **b10353 and later contain it**, so requiring ≥ b10353 is correct —
it simply is not the build that introduced it. Given the open parser bug, prefer
the newest build that contains the #26849 fix once it merges.

---

## Sources

- https://huggingface.co/meta-models/Muse-Glimmer-30B
- https://huggingface.co/meta-models/Muse-Glimmer-30B-GGUF
- https://huggingface.co/meta-models/Muse-Glimmer-30B-assistant
- https://huggingface.co/meta-models/Muse-Glimmer-30B/raw/main/chat_template.jinja
- https://research.meta.ai/blog/introducing-muse-glimmer-open-agentic-model
- https://github.com/ggml-org/llama.cpp/pull/26841 (merged, adds support)
- https://github.com/ggml-org/llama.cpp/pull/26849 (open, tool-call parser fix)
- https://github.com/ggml-org/llama.cpp/issues/26873 (open, mmproj regression)
