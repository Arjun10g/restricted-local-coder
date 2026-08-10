# Inference path revamp — execution plan

Status: **root cause established, fix identified, needs end-to-end validation on
real hardware before release.**

This document is the brief for the session executing the work. It is written to
be followed without further questions.

---

## 1. Root cause (established, not hypothesised)

The model cannot load, because the pinned llama.cpp does not know its
architecture.

```
GGUF general.architecture of muse-glimmer-30B-kquant-17gb.gguf : muse-glimmer
Architectures registered in llama.cpp b10344 (our pin)          : 140
Occurrences of "muse" in b10344 src/llama-arch.cpp              : 0
```

Bisecting upstream tags:

| tag | `muse-glimmer` | `dflash` |
|---|---|---|
| b10344 (our pin) | absent | present |
| b10345 – b10352 | absent | present |
| **b10353** | **present** | present |
| b10355 (latest) | present | present |

So every symptom reported — `error loading model`, `failed to create
llama_context`, and finally "no output at all" — is one fact: **the runtime
predates the model.** No change to the extension's inference code can fix it.

The drafter (`dflash`, 5 blocks, its own architecture) is a separate matter and
stays off by default until proven on the new runtime.

### What this means

- The extension's inference path is **not known to be broken**. It has never
  been observed running against a model the runtime can load.
- The fix is a runtime bump: **b10344 → b10355**.
- Nothing may be claimed working until real tokens come out of a real server.

---

## 2. Objective

A released VSIX where, on a clean machine, **Local Coder: Open Chat** returns
generated text. Everything else is subordinate to that.

Definition of done, all required:

1. `llama-server` from b10355 loads `muse-glimmer-30B-kquant-17gb.gguf`.
2. A `/v1/chat/completions` request with **the extension's exact argv** returns
   non-empty content.
3. `n_ctx_train` is captured and `contextSize` reconciled against it.
4. The drafter is tested on b10355 and either enabled or left off **with
   evidence**.
5. Digests for every b10355 asset are recorded in the lock and verified by CI.
6. The published VSIX passes the clean-PATH Windows check.
7. The rented instance is terminated and confirmed gone.

---

## 3. Constraints

- **Cost.** Honour `SHADEFORM_MAX_HOURLY_COST_USD` and
  `SHADEFORM_MAX_TOTAL_COST_USD` from `.env`. Cheapest instance that fits; this
  is a CPU workload. A GPU is not required — the Windows target runs CPU-only —
  so do not pay for a large one.
- **Terminate.** The instance must be destroyed at the end, on success or
  failure. Set `SHADEFORM_AUTO_TERMINATE_HOURS` as a backstop and verify
  deletion by listing instances afterwards.
- **Disk.** The weights are 15.6 GiB. Provision `SHADEFORM_DISK_SIZE_GB` with
  room for weights + drafter + archives, at least 60 GB.
- **Secrets.** Source `.env`; never echo a value, never commit one, never put
  one in a log or a commit message.
- **Do not push weights to git.** They live in Cloud Storage.
- **Do not touch any account other than the one in `.env` and the `Arjun10g`
  GitHub repository.**

---

## 4. Steps

### 4.1 Provision

Source `.env` without printing it:

```bash
set -a; . "/Users/arjunghumman/Downloads/VS Code Stuff/Python/Local Model/.env"; set +a
```

Shadeform API is REST over `https://api.shadeform.ai/v1`, header
`X-API-KEY`. Useful calls: `GET /instances/types`, `POST /instances/create`,
`GET /instances`, `POST /instances/{id}/delete`. Consult the current docs rather
than assuming the shape — search if a call 4xxs.

Choose an x86-64 Linux box, adequate RAM (**at least 32 GB**, since the model is
15.6 GiB and the KV cache and OS need headroom), cheapest available.

### 4.2 Fetch and hash the b10355 assets

On the instance, for each of `win-cpu-x64`, `ubuntu-x64`, `ubuntu-arm64`,
`macos-arm64`, plus the two CUDA packs, download from

```
https://github.com/ggml-org/llama.cpp/releases/download/b10355/<name>
```

and record `sha256` and byte length. The instance has fast network; this is why
it is done there rather than on the laptop.

Update `vendor/llama.cpp.lock.json`:

- `tag`: `b10355`
- `commit`: `dd1ea524333b1e697489067d7a4c39c60d32beee` — **verify** this resolves
  to tag b10355 before trusting it
- every asset renamed `b10344` → `b10355` with its true digest and size

`tools/check-source.js` asserts the tag appears in each `llama-*` asset name, so
a missed rename fails the build rather than shipping.

### 4.3 Prove inference works — the central step

Fetch the weights from the mirror (they are already published):

```
https://storage.googleapis.com/restricted-local-coder-dazzling-howl-491904/muse-glimmer-30B-kquant-17gb.gguf
https://storage.googleapis.com/restricted-local-coder-dazzling-howl-491904/dflash-kquant.gguf
```

Verify both SHA-256 values against `extension/models/manifest.json` before use.

Then run `llama-server` with **the argv the extension actually builds** — read it
from `RuntimeManager.buildArguments` in `extension/src/runtimeManager.js` and
mirror it exactly, including `--jinja`, `--no-webui`, `--no-agent`, `--offline`,
`--cache-type-k q8_0`, `--cache-type-v q8_0`, `--flash-attn auto`, `--parallel 1`.
Do not "simplify" it: a difference between what is tested and what ships is how
this failed the first time.

Capture from the startup log:

- `n_ctx_train`
- the loaded architecture
- whether `--flash-attn auto` and the quantised KV cache are accepted

Then send a real request and **require non-empty content**:

```bash
curl -s http://127.0.0.1:PORT/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"local-coder","messages":[{"role":"user","content":"Reply with exactly: LOCAL_RUNTIME_READY"}],"max_tokens":32,"temperature":0}'
```

Also exercise a realistic coding prompt and record tokens/second, so the
`PERFORMANCE.md` numbers stop being estimates.

**If any of this fails, that is the real work.** Diagnose it on the instance,
where iteration is cheap. Likely candidates, in order:

1. quantised KV cache unsupported for this architecture → try `f16`, and if that
   is the fix, add a `runtime.cacheType` setting rather than hardcoding
2. `--flash-attn auto` disagreeing with the architecture
3. the chat template failing under `--jinja` → capture the template and test
   `--chat-template` alternatives
4. `contextSize` above `n_ctx_train`

### 4.4 The drafter, decided by evidence

With b10355, retry with `--model-draft`. If the server starts and generation is
correct, enable it by default and record the measured speedup. If it still
fails, keep it off and record the exact error in the manifest note. Do not guess
either way.

### 4.5 Also validate what the workstation will do

On the instance, run the repo's own scripts against the real model:

- `scripts/Invoke-SmokeTest.ps1` equivalent (or the bash path) to confirm the
  documented flow
- `scripts/Invoke-ModelBenchmark.ps1` task set, including
  `tool-call-argv-shape`, to learn whether agent mode is usable with this model

### 4.6 Ship

1. `npm run validate` green.
2. Bump the version, update `$FallbackVersion` in `scripts/Start-Workstation.ps1`
   (CI asserts they match), and update the docs' version references.
3. Tag and let CI build.
4. Run the **Verify a published Windows release** workflow against the new
   version; it must pass the clean-PATH start.
5. Re-verify the published VSIX contains the b10355 runtime.

### 4.7 Terminate

Delete the instance. Then list instances and confirm none remain. Report the
approximate spend.

---

## 5. Reporting

Write findings back into the repository, not just into chat:

- `docs/PERFORMANCE.md` — measured tokens/second and memory, replacing estimates
- `extension/models/manifest.json` — `contextSize` reconciled against
  `n_ctx_train`; drafter note updated with the b10355 result
- `docs/START_HERE.md` — any step that proved wrong in practice
- This file — a short "what actually happened" section at the end

State plainly anything that remains unverified. A step that was skipped must be
reported as skipped, not omitted.

---

## 6. Standing guidance

- Verify against the artifact, not the intention. Every failure in this project
  so far came from testing something adjacent to what shipped: PowerShell 7
  instead of 5.1, a dev-tooled CI runner instead of a clean workstation, a
  `-SkipInstall` path instead of the install path.
- When a check passes, ask what it would have caught.
- Prefer a static check over a run: running proves the machine you ran on.
- If stuck, search. The upstream repository, its issues, and the release notes
  are authoritative for flag names and architecture support.
