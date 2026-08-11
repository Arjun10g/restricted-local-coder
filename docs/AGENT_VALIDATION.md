# Agent write tools — validation against the real model

`AGENT_WRITE_TOOLS_SPEC.md` §8 asks a question the unit suite cannot answer:
the write tools are built and tested, but **can the shipped model actually drive
them?** A tool whose contract the model cannot satisfy is a feature on paper and
a source of refusals in practice.

This file answers it with numbers. Every number carries the machine it came
from, and nothing here is softened.

---

## The short answer

**Yes, and by a wider margin than expected.** On the default profile, across 72
agent tasks and 190 tool calls:

| | |
|---|---:|
| Tool calls emitted | 190 |
| …with malformed JSON arguments | **0** |
| …naming a tool that does not exist | **0** |
| …refused by the permission layer or a tool | **0** |
| `edit_file` calls | 64 |
| …whose `old_text` matched **exactly once** | **64 (100%)** |
| …whose `old_text` was ambiguous (0 or >1 matches) | **0** |
| Turns whose visible content leaked tool markup | **0 of 262** |

The failure mode `edit_file` exists to refuse — an `old_text` that matches zero
or several times — **did not occur once**. The model does not send a bare
identifier and hope; the `old_text` values it sent were 91 to 226 characters
long, median 176, which is enough surrounding context to be unique by
construction.

64 of the 72 tasks produced a verified-correct result. **All 8 failures are one
condition**, and the cause is retrieval, not tool calling — see "When retrieval
disagrees with the workspace" below. In the other 64 attempts the loop never hit
the step cap and never needed a retry.

The honest caveat is speed, not correctness: see "What it costs".

---

## The machine and the artifacts

Everything below was measured on **2026-08-11**, on a rented **AMD EPYC
7763, 28 vCPU, 56 GB RAM, Ubuntu 22.04, x86-64, CPU-only** (Hyperstack via
Shadeform, `montreal-canada-2`, 2.12 instance-hours). This is the same class of
box as every other measurement in `PERFORMANCE.md`, so the throughput numbers are
comparable to it.

| | |
|---|---|
| Runtime | `llama-server` from the pinned tag **b10355** (`dd1ea5243`), fetched with `tools/fetch-runtime.py --key linux-x64 --verify` |
| Model | `Qwen3-Coder-30B-A3B-Instruct-1M-UD-Q4_K_XL.gguf`, SHA-256 `e71c9271…33db`, 17,690,500,448 bytes — matching `extension/models/manifest.json` exactly |
| Comparison model | `muse-glimmer-30B-kquant-17gb.gguf`, SHA-256 `7e9b74b7…c488d8`, 16,756,681,056 bytes — also matching the manifest |
| Server arguments | exactly what `RuntimeManager.buildArguments` produces for the profile, including the **f16 KV cache** shipped in 0.5.1, `--threads 16` (the value `automaticThreads()` returns on 28 cores), `--ctx-size 16384` |
| Sampling | the profile's own: temperature 0.2, top-p 0.9, top-k 40, min-p 0.02 |
| Harness | `bench/agent-validation.js` |

**No GPU was used.** The `ubuntu-x64` release archive contains only
`libggml-cpu-*.so`, so `--n-gpu-layers -1` was a no-op, exactly as on the
Windows target.

### The day-0 GGUF confound, eliminated

Our GGUFs were staged on the model's release day, and Unsloth later fixed a
tool-calling bug in the Qwen3-Coder chat template. If tool-call validity had
looked poor, that would have been the first suspect.

It is not a factor here, and this was checked rather than assumed. The chat
template was extracted from the GGUF metadata of **our staged copy** and from
the **first 40 MB of the current upstream ModelScope object**, and the two are
byte-identical:

```
tokenizer.chat_template   length 6896
                          sha256 87710339d25b4e789c1d723f93c91ee861a86d305bb3d20a845536f251d6ea8a
```

The template we ship *is* the current upstream template. No re-download and
re-test was needed, and there is no second rate to report.

---

## What was run

The harness **drives the shipped code**. It requires `extension/src/client.js`,
`extension/src/agent/agentLoop.js` and the tool schemas from
`toolSchemasFor({ allowWrite: true })`, and calls `runAgentLoop` the way
`chatView.runAgentTurn` does — same system prompt text, same
`agent.allowedCommands` defaults, same `maxSteps` of 8, `mode: "allowlist"`,
`allowWrite: true`. Nothing about the loop, the permission decision, or the
write tools is reimplemented; the only substitution is `applyEdit`, which writes
the buffer to the file because there is no editor in a headless run. (The undo
property is asserted by the unit suite against a stubbed
`vscode.workspace.applyEdit`, which is where it belongs.)

Each attempt gets a fresh scratch workspace. The three scenarios are the three
the spec asks for:

| Scenario | Task | Verified by |
|---|---|---|
| `single-edit` | "Add a short JSDoc comment above the slugify function in `src/util.js`." | the doc comment is present **and** the function body and exports are byte-identical |
| `read-then-edit` | "Find the default request timeout in `src/config.js` and change it to 60 seconds. Leave every other default alone." | `requestTimeoutMs: 60000` **and** the two neighbouring defaults untouched |
| `run-tests-and-fix` | "Run the test suite with `npm test`. One test fails. Fix the source; do not change the tests." | the suite is **executed** afterwards and must exit 0, **and** the test file must be unmodified |

Each was run 8 times, under three context conditions, for 72 attempts in total.
Verification runs the real test suite rather than pattern-matching the answer,
so a task counted as successful actually works.

---

## Result 1: tool-call validity

Per scenario, at the shallow (near-empty) context condition:

| Scenario | Attempts | Verified correct | `edit_file` calls | Ambiguous `old_text` | Malformed JSON | Step cap hit |
|---|---:|---:|---:|---:|---:|---:|
| `single-edit` | 8 | **8** | 8 | 0 | 0 | 0 |
| `read-then-edit` | 8 | **8** | 8 | 0 | 0 | 0 |
| `run-tests-and-fix` | 8 | **8** | 8 | 0 | 0 | 0 |

And at a realistic ~7.5k-token workspace context, with retrieval consistent with
the workspace:

| Scenario | Attempts | Verified correct | `edit_file` calls | Ambiguous `old_text` | Malformed JSON | Step cap hit |
|---|---:|---:|---:|---:|---:|---:|
| `single-edit` | 8 | **8** | 8 | 0 | 0 | 0 |
| `read-then-edit` | 8 | **8** | 8 | 0 | 0 | 0 |
| `run-tests-and-fix` | 8 | **8** | 8 | 0 | 0 | 0 |

Some detail worth keeping:

- **Sequencing is correct.** `read-then-edit` read the file before editing it in
  every attempt. `run-tests-and-fix` ran the suite, read the source, edited it,
  and re-ran the suite; the fix was a genuine one (`<` to `<=` in a loop bound),
  confirmed by executing the tests.
- **argv is correct.** All 48 `run_command` calls were exactly
  `["npm", "test"]` — never a single shell-shaped string, which the permission
  layer would have rejected. That agrees with what the `tool-call-argv-shape`
  benchmark task already predicted.
- **Retrieval saves steps.** With the file already in `<workspace_context>`, 7 of
  8 `single-edit` attempts edited without a `read_file` first — correctly,
  because the context was accurate.

## Result 2: when retrieval disagrees with the workspace

The eight failures were the `single-edit` scenario run with ~7k tokens of
context taken from **a different project**, which is what retrieval produces when
it ranks the wrong files.

In 8 of 8 attempts the model **emitted no tool call at all**. It read
`<workspace_context>` as the complete truth about the workspace, concluded the
file did not exist, and said so:

> "I notice that the workspace context you provided doesn't contain a
> `src/util.js` file, so I can't find the `slugify` function… Could you please
> provide the content of `src/util.js`?"

This is not a tool-calling defect — the arguments were never emitted, so nothing
was malformed — and it is not a safety problem, because the outcome is a
question rather than a wrong edit. But it is a real behaviour worth knowing:
**the model trusts retrieved context over its own tools.** The same condition
did not break `read-then-edit` or `run-tests-and-fix` (8 of 8 each), because
those prompts name a specific file or command and so force a tool call.

The practical reading: agent tasks phrased with a concrete file or command are
robust to bad retrieval; a task phrased in terms of "the function in x.js" is
not, if retrieval has already told the model x.js is absent.

## Result 3: the upstream tool-markup leak (#26849 / #26879)

Both issues were open at the last check, and roughly **17% of Muse Glimmer
agentic turns** are documented as leaking raw tool markup into visible content.

**It did not reproduce, for either model, on b10355 with the shipped argument
list.**

| Model | Agentic turns sampled | Turns with markup in `message.content` |
|---|---:|---:|
| Qwen3-Coder 30B-A3B UD-Q4_K_XL | 262 | **0** |
| Muse Glimmer 30B kquant | 36 | **0** |

Content was scanned both for a fixed marker list (`<tool_call>`, `<function=`,
`<parameter=`, `[TOOL_CALLS]`, `<|python_tag|>`, and others) and, separately, for
*any* angle-bracket-shaped token at all. Neither found anything in 298 turns.

What this supports:

- For **Qwen3-Coder the rate is 0 of 262**; the 95% upper bound on the true rate
  is about 1%. It is not a generic property of llama.cpp's tool parsing at this
  build.
- For **Muse Glimmer the rate is 0 of 36**. A 17% rate would produce zero leaks
  in 36 turns about 0.1% of the time, so this sample is enough to say the rate is
  **not** 17% under these conditions — the 95% upper bound is about 8%. It is not
  enough to say the bug is gone.

The difference between the two observations is the configuration, not the
sample: this run used tag **b10355** with `--jinja` and the profile's own
sampling. Whoever files on the upstream issues should say so, because "we cannot
reproduce it on b10355" is the useful contribution here. Attribution stays
upstream either way; nothing in our permission layer was changed or investigated
for this.

## Result 4: what it costs

Wall-clock per task, and the context depth reached at the final step. **Cold** is
the first turn against an empty prompt cache; **warm** is every later turn in the
same conversation, where the shared prefix is reused and only the appended tool
results are prefilled.

| Condition | Scenario | Depth at final step | Cold | Warm (median) | Generation |
|---|---|---:|---:|---:|---:|
| shallow | `single-edit` | 1,491 | 39 s | **27 s** | 17.1 tok/s |
| shallow | `read-then-edit` | 1,399 | 22 s | **21 s** | 18.0 tok/s |
| shallow | `run-tests-and-fix` | 2,641 | 79 s | **76 s** | 14.8 tok/s |
| ~7.5k context | `single-edit` | 7,594 | 203 s | **36 s** | 8.6 tok/s |
| ~7.5k context | `read-then-edit` | 7,662 | 207 s | **41 s** | 8.6 tok/s |
| ~7.5k context | `run-tests-and-fix` | 8,803 | 272 s | **127 s** | 8.1 tok/s |

Two things this makes plain.

**Generation holds up at depth, and the f16 KV cache is why.** At 7.5–8.8k
tokens the loop generated at **8.1–8.6 tok/s**, against 14.8–18.0 near the top of
the context. That is a 2× decay across the whole depth of a multi-step task, not
the collapse the `q8_0` cache produced — the same measurement at 8192 tokens read
3.46 tok/s before the KV cache type was fixed in 0.5.1. A three-step agent task
would have been unusable on the old default and is merely slow on this one. The
generation rate measured at the *deepest* step of each task (7.8–9.0 tok/s) is
within 5% of the whole-task average, so the loop does not degrade as it goes; it
starts at its depth and stays there.

**The first turn is the expensive one, and it is expensive.** A 7k-token
workspace context costs about **170 seconds of prefill** (roughly 40 tok/s)
before the model produces a single token. Every subsequent turn in the same
conversation is a pure append and costs 130–160 ms of prefill. This is the
single largest number in the table, it is paid once per conversation, and it is
the reason the context structure — pinning the stable prefix — matters more than
any sampling tuning.

For contrast, the same two scenarios on **Muse Glimmer** at
`reasoningStrength: "low"` and a shallow context: 8 of 8 verified correct, 8 of
8 `edit_file` calls unique, and **171–187 s per task** at 4.1 tok/s generation —
about seven times the wall-clock of the default profile for the same work. The
default profile is the right choice for agent mode by a wide margin.

---

## Reproducing it

```bash
python3 tools/fetch-runtime.py --key linux-x64 --verify
# start llama-server with exactly the arguments buildArguments produces
node bench/agent-validation.js \
  --base-url http://127.0.0.1:8080 --api-key "$LLAMA_API_KEY" \
  --repeats 8 --out results.json --label shallow
node bench/agent-validation.js \
  --base-url http://127.0.0.1:8080 --api-key "$LLAMA_API_KEY" \
  --repeats 8 --deep-context-tokens 7000 --deep-context-mode consistent \
  --out results-deep.json --label deep
```

`--deep-context-mode foreign` reproduces the retrieval-mismatch condition in
Result 2. `--profile` and `--reasoning-strength` select a different manifest
profile.

Without a full agent run, the `edit-file-argument-shape` task in
`bench/coding-smoke.json` is the cheap screen: it passes only for a
`{"path", "old_text", "new_text"}` object whose `old_text` carries enough
surrounding context to be unique, and fails a one-word or duplicated-line
`old_text`. Run it with `scripts/Invoke-ModelBenchmark.ps1`.

It was checked from both sides on this machine, because a task that everything
passes measures nothing:

| Candidate answer | Result |
|---|---|
| `old_text` anchored on `function format(...)` | pass |
| `old_text` of `"trim"` | fail |
| `old_text` of `"input.trim()"` — real, but matches twice | fail |
| `old_text` of the whole duplicated line — matches twice | fail |
| A correct object wrapped in Markdown fences | fail |
| The **live default model**, 5 attempts | **5 of 5 pass** |

The pre-existing `tool-call-argv-shape` task also scored 5 of 5 on the same
machine, which is consistent with the 48 of 48 correct `run_command` argv arrays
observed in the agent runs.

---

## What this does not show

- **It is not a quality measurement.** The tasks are small and unambiguous by
  design, because the question was whether the tool contract can be satisfied,
  not whether the model is a good engineer. It says nothing about a
  multi-file refactor.
- **72 attempts at temperature 0.2 is a narrow sample.** The profile samples
  close to greedy, so the variance between attempts is small and a 100% rate
  should be read as "no failure was observed in 72 attempts", not as a
  guarantee. The 95% lower bound on the per-task success rate from 64 clean
  attempts is about 95%.
- **It is one machine.** A 28-core server chip; the Windows target has fewer
  cores and less memory bandwidth, and prefill scales with cores, so the
  first-turn cost above is a floor rather than a typical figure.
