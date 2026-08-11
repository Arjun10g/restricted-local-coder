# Restricted Local Coder

A self-contained, private VS Code coding assistant for a restricted workstation where Ollama, LM Studio, Docker, Python packages, Hugging Face, and administrator-installed software are unavailable.

The repository builds a platform-specific VSIX that embeds a pinned `llama.cpp` inference server. On the target laptop, the extension starts that binary on loopback, verifies and loads an approved GGUF, provides streamed coding chat and selection commands, and optionally supplies fill-in-the-middle completions. Source code and prompts are not sent to a cloud inference API.

## Target environment

- 32 GB system RAM.
- VS Code desktop with permission to install an approved VSIX.
- Windows x64 is the primary target; Linux x64 and macOS arm64 workflows are included.
- No target-machine Git, compiler, CMake, Python, Node/npm, Docker, Ollama, or administrator rights.
- No Hugging Face access.
- Model delivery through ModelScope, an internal HTTPS mirror, or approved offline transfer.
- CPU-first inference. A separate GPU-enabled runtime build can be added later without changing the extension protocol.

## Default model decision

The default is **Muse Glimmer 30B, kquant GGUF**: an agentic chat model in a 16.48 GiB 4-bit file, with an optional 1.52 GiB drafter for speculative decoding. It is selected because the exact artifact has an approved digest, fits a 32 GB machine with room for the KV cache and the editor, and is the profile whose weights are actually staged.

It has **no fill-in-the-middle tokens**, so inline completion is unavailable for it and the extension refuses those requests rather than sending Qwen control tokens to a model that never saw them. Inline completion needs one of the Qwen profiles.

| Approved profile | Approx. file | FIM | Position on 32 GB |
|---|---:|---|---|
| Muse Glimmer 30B kquant | 15.6 GiB | no | **Recommended default; weights staged** |
| Muse Glimmer 30B kquant dynamic | 18.3 GiB | no | Quality comparison; less headroom |
| Qwen3-Coder 30B-A3B UD-IQ2_M | 10.1 GiB | yes | 2-bit balance; needs staging |
| Qwen3-Coder 30B-A3B UD-TQ1_0 | 7.5 GiB | yes | Ternary; benchmark first |
| Qwen3-Coder 30B-A3B UD-Q4_K_XL | 16.5 GiB | yes | Quality control; start at 8K |
| Qwen3-Coder-Next UD-TQ1_0 | 17.6 GiB | yes | 80B-total experiment; little margin |

Only the Muse Glimmer weights and drafter are published to the configured mirror. Selecting a Qwen profile means staging its weights first.

`docs/MODEL_SELECTION.md` also reviews 2026 alternatives including Qwen3.6-35B-A3B, GLM-4.7-Flash, Devstral Small 2, Mistral Small 4, and BitNet. They are not silently added to the allow-list: each needs a stable GGUF, approved SHA-256, llama.cpp validation, memory measurement, chat/FIM checks, and local coding evaluation.

## What is implemented

- Private streamed chat in the Activity Bar.
- Explain, review, refactor, debug, test-generation, and custom selection commands.
- Optional fill-in-the-middle inline suggestions, for profiles that declare FIM support.
- GPU offload (opt-out) and speculative decoding (opt-in), both degrading to plain CPU decoding when the hardware or a compatible drafter is absent. A launch that offers a drafter and fails is retried without it, so an incompatible drafter cannot stop the model loading.
- Conversation history budgeted against the model's context window, and optional per-workspace transcript persistence (off by default).
- Optional project memory in `.localcoder/memory.md`, treated as untrusted workspace data.
- Optional agent mode — read, list, search, and approved command execution — disabled by default, with argv-prefix permissions, no shell, a bounded step count, and an audit log. See [docs/AGENT_MODE.md](docs/AGENT_MODE.md).
- Bounded active-file, diagnostics, open-file, and lexical workspace context.
- Active secret-file rejection and exclusions for credential directories, keys, models, dependencies, and generated output.
- Content-safe untrusted-context wrappers and adaptive code fences that file text cannot close directly.
- Resumable HTTPS downloads from an internal mirror or checked-in ModelScope sources.
- Hugging Face deny-list, redirect revalidation, and public cleartext-HTTP rejection.
- Mandatory GGUF magic and approved SHA-256 verification, with safe validation caching.
- Pinned native runtime build and platform-specific VSIX packaging in GitHub Actions.
- Loopback-only server, random SecretStorage bearer key, no Web UI, no slots endpoint, one inference slot, and offline runtime mode. The server's own agent, tool, and MCP surfaces stay disabled (`--no-agent`); tool use, when enabled, is mediated entirely by the extension so that permission is decided in one auditable place rather than inside the inference server.
- Preflight, native smoke test, offline bundle, and coding-model comparison scripts.
- No third-party npm runtime dependencies.

## Architecture

```text
VS Code desktop
└─ Restricted Local Coder extension (plain JavaScript)
   ├─ Chat + explicit editor commands
   ├─ Optional FIM inline provider
   ├─ Secret-aware bounded context builder
   ├─ Optional agent tools (off by default)
   │  ├─ argv-prefix permissions, no shell
   │  ├─ workspace-confined paths, secret deny-list
   │  └─ bounded step count + audit log
   ├─ Verified downloader/importer
   └─ Runtime supervisor
      └─ bundled llama-server
         ├─ 127.0.0.1 only
         ├─ bearer key from child environment
         ├─ Web UI / server-side agent / MCP disabled
         ├─ bounded context, cache, and concurrency
         └─ approved local GGUF
```

See `docs/ARCHITECTURE.md` and `docs/THREAT_MODEL.md` for the detailed flows and controls.

## Build and deploy

> **Setting up a workstation from scratch? Start with
> [docs/START_HERE.md](docs/START_HERE.md).** It is the whole path in one page:
> one scripted command, or every manual step, plus settings, model acquisition,
> verification, troubleshooting, and the reference digests. The pages below cover
> narrower jobs.
>
> Cloning an existing checkout onto another machine and getting to a running
> chat? Use **[docs/QUICKSTART.md](docs/QUICKSTART.md)** — prerequisites, clone,
> verify, obtain or build a VSIX, install, configure, run. For the locked-down
> target workstation, use **[docs/WORKSTATION_SETUP.md](docs/WORKSTATION_SETUP.md)**.
>
> On Windows behind a proxy, **[docs/INSTALL_WINDOWS.md](docs/INSTALL_WINDOWS.md)**
> is copy-and-paste only: seven independent download routes, verification,
> install, and an error reference.
>
> To publish the weights without a large transfer touching a laptop, see
> **[docs/STAGE_MODEL_GCS.md](docs/STAGE_MODEL_GCS.md)** — a disposable VM stages
> the model into an object store, which needs no split and no new VSIX.
>
> Once the weights are published, **[docs/RUN_ON_WORKSTATION.md](docs/RUN_ON_WORKSTATION.md)**
> is the end-to-end copy-and-paste path on the target machine: install, settings,
> acquire the model, start, and verify.

### 1. Put this tree in GitHub

Create an empty repository, extract or copy this source tree, then run:

```bash
git init -b main
git add .
git commit -m "Initial restricted local coding assistant"
git remote add origin <your-approved-repository>
git push -u origin main
```

The source repository intentionally contains neither model weights nor compiled native runtime binaries.

### 2. Produce the platform VSIX

Run **Actions → Build platform VSIX → Run workflow**, or push a release tag such as `v0.5.0`. The workflow:

1. validates the source and tests;
2. checks out the full commit in `vendor/llama.cpp.lock.json`;
3. builds a CPU `llama-server` without Web UI assets;
4. verifies the collected binary with `--version`;
5. packages a platform VSIX and SHA-256 sidecar.

For the intended laptop, download the `restricted-local-coder-win32-x64` workflow artifact.

### 3. Install the VSIX

Use **Extensions → … → Install from VSIX…**, or:

```powershell
code --install-extension .\restricted-local-coder-0.5.0-win32-x64.vsix --force
```

### 4. Deliver the model

Choose one route:

1. Set `localCoder.modelMirrorBaseUrl` to an approved internal HTTPS directory and disable public download.
2. Run **Local Coder: Download or Repair Model** against the checked-in ModelScope URL.
3. Transfer the exact GGUF offline and run **Local Coder: Import Existing GGUF Model**.
4. Publish the weights as split GitHub release assets with `scripts/Publish-ModelParts.ps1`, so a
   workstation that can reach only `github.com` gets source, VSIX, and model from one repository.
   **Download or Repair Model** reassembles and verifies the parts automatically.

Every route ends in mandatory SHA-256 verification. The extension never contacts Hugging Face.

### 5. Validate and run

Run these commands in VS Code:

1. **Local Coder: Run Preflight**.
2. **Local Coder: Start Local Runtime**.
3. Open the Local Coder Activity Bar icon.
4. Enable `localCoder.inlineCompletions.enabled` only after chat behavior and CPU load are acceptable.

A conservative managed configuration is:

```json
{
  "localCoder.network.allowPublicModelDownload": false,
  "localCoder.runtime.contextSize": 8192,
  "localCoder.runtime.promptCacheMiB": 512,
  "localCoder.inlineCompletions.enabled": false,
  "localCoder.context.maxCharacters": 48000
}
```

## Model and runtime evaluation

After a real runtime and model are available:

```powershell
.\scripts\Invoke-SmokeTest.ps1 `
  -RuntimePath .\extension\runtime\win32-x64\llama-server.exe `
  -ModelPath "$env:LOCALAPPDATA\RestrictedLocalCoder\models\muse-glimmer-30B-kquant-17gb.gguf"
```

The smoke test also reports the model's trained context (`n_ctx_train`) and how
many layers were actually offloaded to the GPU. The manifest keeps `contextSize`
below the trained value deliberately; raising it past that point degrades output
quality silently rather than failing.

Compare quantizations, and measure what acceleration is worth on your hardware,
with:

```powershell
.\scripts\Invoke-ModelBenchmark.ps1 `
  -RuntimePath .\extension\runtime\win32-x64\llama-server.exe `
  -ModelPath <approved-gguf> `
  -GpuLayers auto `
  -DraftPath "$env:LOCALAPPDATA\RestrictedLocalCoder\models\dflash-kquant.gguf"
```

Each run records its `gpuLayers` and draft model in `benchmark-results.json`, so
two result sets stay comparable. Run it with `-GpuLayers off` and without
`-DraftPath` to get the baseline.

The included benchmark performs static checks and never executes generated code. Production approval still requires real repository tests, security review, and latency/memory measurement.

## Repository map

- `extension/` — dependency-free VS Code extension source and model allow-list.
- `extension/src/agent/` — opt-in tool use: argv-prefix permissions, shell-free execution, a bounded loop, and an audit log. See [docs/AGENT_MODE.md](docs/AGENT_MODE.md).
- `bench/` — small deterministic coding screen.
- `scripts/` — build, acquisition, install, preflight, smoke, benchmark, and offline staging.
- `tools/` — source-policy, manifest, pinned-checkout, and runtime-collection helpers.
- `.github/workflows/` — source CI and platform VSIX build/release with full-commit action pins.
- `vendor/llama.cpp.lock.json` — exact native runtime source pin.
- `docs/` — START_HERE (from scratch), quickstart, workstation setup, design, security, deployment, model decision, performance, validation, and source record.

## Source-only validation

No package installation is needed:

```bash
npm run validate
```

Equivalent direct commands:

```bash
node tools/check-manifest.js
node tools/check-source.js
node --test extension/test/*.test.js
```

The native model path cannot be executed from the source archive alone because the multi-gigabyte GGUF and compiled `llama-server` are deliberately excluded. The build workflow is the reproducible path that fills the runtime directory and produces the installable VSIX.

## Deliberate boundary

This is a coding assistant, not an autonomous shell agent. It does not execute generated commands, enable native agent/tool surfaces, or edit files without an explicit editor command. That narrower boundary is intentional for a restricted enterprise laptop.
