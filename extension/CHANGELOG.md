# Change Log

## 0.4.1

Measured on a rented 28-core EPYC 7763 running the pinned b10355, using the exact
argument list the extension builds. Every number below is from that machine.

- **The default model changes to Qwen3-Coder 30B-A3B UD-Q4_K_XL.** Same prompt,
  same machine: **1.2 seconds to the first word of the answer against 113
  seconds** for Muse Glimmer, and 24 s against 180 s for the whole reply. Two
  causes, both structural: Qwen activates ~3.3B of its parameters per token
  where Muse Glimmer is dense and reads all ~27.9B, and Muse Glimmer spends
  hundreds of tokens thinking before it says anything. Muse Glimmer stays as an
  optional "deep reasoning, slow" profile with the measured costs written into
  its warning.
- **Inline completion works again.** The new default carries the
  fill-in-the-middle tokens the client already hardcoded. Verified through the
  route the feature actually uses -- a raw `POST /completion`, not the chat
  route, which returns fenced Markdown -- and it returned usable code in 1.3 s.
- **Repacking is off by default, which is the memory fix.** Online repacking
  keeps a second private copy of the weights in anonymous memory. Measured, it
  took peak resident memory from **17.0 GiB to 31.0 GiB** for a 16.5 GiB model,
  in exchange for 4.5% of generation speed and nothing at all for prompt
  processing. A 32 GB machine also running VS Code cannot afford that. Profiles
  may set `"repack": true` to opt back in.
- **Speculative decoding was being loaded and never used.** `--model-draft`
  alone does not enable it for a local file: the speculative type defaults to
  none and is only inferred for Hugging Face sidecar downloads, so the drafter
  cost memory and did nothing, silently. The runtime now passes `--spec-type`
  from the manifest, and clamps `--spec-draft-n-max` to the drafter's declared
  block size minus one. An earlier measurement of "no speedup" was taken without
  this flag and was therefore measuring nothing; it has been withdrawn.
- **The manifest said the drafter was incompatible. It is not.** The
  `dflash requires ctx_other to be set` line is a benign warning from
  llama-server's memory-fitting probe, which builds the draft context with no
  target to borrow tensors from. The real failure was the next line,
  `unknown model architecture: muse-glimmer` -- the old runtime pin.
- **Both "TQ1" profiles are removed.** Their GGUF headers declare `IQ1_S` and
  they contain no ternary tensors; the name was a publisher labelling choice.
  The dynamic Muse Glimmer profile was also mislabelled 4-bit and is 5.65 bpw.
- `localCoder.chat.reasoningStrength` controls how hard a reasoning model
  thinks, per request rather than per launch. Measured on Muse Glimmer, `low`
  reached the first word in 27 s against 147 s at the model's own default of
  `high`. Short selection commands always ask for `low`.
- Reasoning is now replayed inside an open tool-calling sequence, where several
  model families require it, and still dropped from completed turns, where it
  wastes context. A defensive strip removes any `<think>` block that arrives
  inline before it can be stored and replayed forever.
- A widely repeated claim that disabling flash attention gives a large prompt
  processing win was **tested and refuted** on this build: it is marginally
  faster on, and neutral for generation. `--flash-attn auto` is unchanged.
  `docs/PERFORMANCE.md` records the table so the claim cannot return.
- `docs/PERFORMANCE.md` is rewritten around measurements, each carrying the
  machine it came from, and the guidance that lowering the context window saves
  memory is corrected: it does not, on either model.


## 0.4.0

The release that makes the chat produce text. Two independent faults were
stopping it, and each on its own was sufficient.

- **The runtime predated the model.** `muse-glimmer-30B-kquant-17gb.gguf`
  declares `general.architecture = muse-glimmer`, which llama.cpp b10344 — the
  previous pin — does not register. Bisecting the release tags puts its first
  appearance at b10353. The model could never load, so nothing downstream could
  ever work. The vendored runtime moves to **b10355**, with a real SHA-256 and
  byte length recorded for every asset, all six re-downloaded and re-hashed
  rather than copied from a listing.
- **The reasoning channel was dropped on the floor.** Muse Glimmer streams its
  private analysis as `reasoning_content` and only afterwards opens `content`.
  The client read `content` alone, so the whole thinking phase rendered as an
  empty bubble — minutes of it, on CPU — and when the output budget ran out
  before the answer began, the reply was empty forever. Reasoning is now read
  and shown in its own collapsible block, and is kept strictly out of the
  answer: it never reaches `lastResponse`, the stored transcript, or the
  messages replayed to the model on the next turn.
- Profiles declare `reasoning` in the manifest, alongside the existing `fim`
  flag, so this is a property of the model rather than a check on its name.
- `maxOutputTokens` for the reasoning profiles is raised from 2048, which the
  analysis alone could exhaust, to 4096 (3072 on the 8K-context profile).
- New `localCoder.chat.maxOutputTokens` setting overrides it. Raising it shrinks
  the conversation history that fits alongside the reply, which is accounted for.
- Agent mode no longer returns a blank answer when the model reasons its budget
  away without calling a tool; it says what happened.
- Speculative decoding stays off, now on evidence: on b10355 the drafter no
  longer breaks the launch, but it measured 4.55 tok/s against 4.54 tok/s
  without it, and its context still fails to initialise. Recorded in the
  manifest.
- `docs/PERFORMANCE.md` carries measured numbers in place of estimates,
  including the finding that lowering the context size does **not** reduce this
  model's memory use.
- `docs/INSTALL_WINDOWS.md` pointed every download at a `runtime-preview-*` tag
  that was never published; corrected to the real release tag.

## 0.1.0

- Initial local coding chat and explicit selection commands.
- Optional Qwen fill-in-the-middle inline completion.
- Bundled pinned llama.cpp runtime workflow.
- ModelScope/internal-mirror/offline acquisition with mandatory approved SHA-256.
- Loopback authentication and disabled Web UI, agents, tools, MCP, slots, and cloud model sources.
- Bounded secret-aware workspace context, preflight, smoke test, and coding benchmark harness.
