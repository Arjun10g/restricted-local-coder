# Change Log

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
