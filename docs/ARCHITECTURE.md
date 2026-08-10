# Architecture

## Design goal

Provide a useful local coding assistant on a 32 GB enterprise laptop without requiring a separately installed model manager, Python environment, container runtime, administrator privileges, or Hugging Face access.

## Runtime topology

```mermaid
flowchart LR
    U[Developer in VS Code] --> E[Restricted Local Coder extension]
    E --> C[Secret-aware context builder]
    E --> D[Verified model downloader / importer]
    E --> R[Runtime supervisor]
    C --> W[Selected workspace files and diagnostics]
    D --> M[(Approved local GGUF)]
    R --> S[Bundled llama-server]
    S --> M
    E -->|Bearer token, loopback only| S
    D --> I[Approved internal HTTPS object directory]
    D -. optional .-> MS[ModelScope]
```

## Build-time flow

1. GitHub Actions reads `vendor/llama.cpp.lock.json`.
2. It fetches the exact 40-character commit from `ggml-org/llama.cpp` and verifies `HEAD` byte-for-byte against the lock.
3. It builds only the CPU `llama-server` target, with the Web UI excluded from the build.
4. The server, selected native libraries, and the upstream license are copied into `extension/runtime/<platform-arch>/`.
5. `@vscode/vsce` creates a platform-specific VSIX and a SHA-256 sidecar.
6. The target laptop installs that VSIX; it performs no native build and needs no Node, Python, Git, CMake, or compiler.

## Model acquisition flow

1. The extension loads the checked-in allow-list in `extension/models/manifest.json`.
2. The user accepts the model license and selects a profile.
3. Sources are tried in this order: managed internal HTTPS mirror, approved ModelScope URL, or explicit local-file import.
4. Hugging Face hostnames and their subdomains are denied. Public cleartext HTTP is denied; HTTP is accepted only for a loopback development server.
5. Network acquisition writes to `<model>.part`, uses HTTP `Range` when available, and revalidates every redirect.
6. Before use, the extension requires GGUF magic bytes, an exact size when the manifest supplies one, and an approved SHA-256.
7. A validated hash is cached with the absolute path, file size, and modification time. Any file change forces a full rehash.
8. Invalid final or staged files are removed from the approved path and quarantined where possible.

## Request-time flow

1. A user sends a chat request, invokes a selection command, or VS Code asks for an inline completion.
2. The extension gathers bounded context from the active selection, nearby code, diagnostics, open files, lexical workspace retrieval, and explicitly configured files.
3. Active sensitive files and common secret locations are rejected, including `.env*`, private keys, credential files, `.vscode`, `.ssh`, `.aws`, `.azure`, `.gnupg`, and `.kube`.
4. Reserved wrapper tags are neutralized, code fences grow beyond any backtick run in the source, and the resulting blocks are explicitly labeled as untrusted data.
5. Chat uses the OpenAI-compatible `/v1/chat/completions` route with streaming. How much prior conversation is resent is budgeted against the profile's context window rather than a fixed character count: the system prompt, the current request, and the reply allowance are subtracted first, a further 5% is held back against tokenizer drift, and whole turns are then selected newest-first. Turns are never truncated mid-message, since a cut-off assistant reply invites the model to continue something it never said.
6. Inline completion uses llama.cpp's `/completion` route and fill-in-the-middle tokens, and is available only for profiles whose manifest entry sets `fim: true`. The control tokens default to Qwen's spelling and may be overridden per profile with `fimTemplate`. A profile declaring `fim: false` — including the current default — refuses the request rather than sending tokens the model was never trained on.
7. Responses travel only over a bearer-authenticated loopback connection.

## Runtime process contract

The extension launches `llama-server` with a sanitized child environment. On Linux and macOS, the native-library search path is reset to the directory containing the approved runtime rather than inherited from the parent process. Runtime controls are equivalent to:

```text
child environment: LLAMA_API_KEY=<random SecretStorage value>

--model <approved-local.gguf>
--alias local-coder
--host 127.0.0.1
--port <free-loopback-port>
--ctx-size <profile-or-user-value>
--threads <auto-or-user-value>
--threads-batch <same>
--batch-size <profile-value>
--ubatch-size <profile-value>
--parallel 1
--cache-ram <bounded setting; 512 MiB by default>
--no-cache-idle-slots
--cache-type-k q8_0
--cache-type-v q8_0
--load-mode mmap
--flash-attn auto
--n-gpu-layers <-1 for auto, a pinned count, or the flag omitted when "off">
--model-draft <approved drafter, only when the file is installed>
--spec-draft-n-max <1-64; 16 by default>
--n-gpu-layers-draft -1
--jinja
--no-webui
--no-agent
--offline
--cors-origins localhost
--no-cors-credentials
--no-slots
```

The three acceleration flags are all conditional and all degrade rather than fail:

- `--n-gpu-layers` is omitted entirely when `localCoder.runtime.gpuLayers` is `off`. A value of `-1` asks llama.cpp to place as many layers as the device holds, which is a no-op on a machine with no GPU. A value that is neither `auto`, `off`, nor a number falls back to `auto` and is logged, because reading a typo as "zero layers" is indistinguishable from a machine that lost its GPU.
- `--model-draft` appears only when the selected profile declares a `draftModel`, the setting is on, **and** the file is present on disk. A missing drafter logs one line and starts normally.
- Offload requires a build that has a GPU backend, not merely a GPU. llama.cpp is built with `GGML_BACKEND_DL`, so each backend is a separate loadable library beside the server; a CPU-only build has none and ignores `--n-gpu-layers` silently. The pinned `win32-x64` and Linux assets are CPU builds and `darwin-arm64` carries Metal, so preflight reports the backends the installed runtime can actually load rather than the hardware present. The CUDA pack is recorded in the lock as `delivery: external` and is not yet staged.
- Flag naming is pinned to the vendored llama.cpp tag. Upstream removed `--draft-max` and `--draft-min` in favour of `--spec-draft-n-max` and `--spec-draft-n-min`; the older spellings are rejected by the server, so `tools/check-source.js` asserts the current names appear in the runtime source.

The API key is not placed on the process command line. Inherited `LLAMA_*`, `GGML_*`, Hugging Face, and dynamic-library injection variables are stripped before the child starts. User-supplied extra arguments cannot override model, network, authentication, logging, agent/tool, context, parallelism, cache, or endpoint controls.

## Persistence

- Model files: configurable user-level application-data directory, outside the extension installation. An optional draft model lives in the same directory and is verified against its own approved digest.
- Validation record: VS Code global state; it stores only file metadata and the approved digest.
- API key: VS Code SecretStorage.
- Selected profile and accepted license: VS Code global state.
- Conversation: memory only by default, cleared with the extension host. Setting `localCoder.chat.persistHistory` to `true` stores the transcript for the current workspace under the extension's private global-storage directory — never inside the workspace, so it cannot be committed, retrieved by the lexical context pass, or read back as workspace context. The file is written `0o600` via an atomic rename, keyed by a SHA-256 digest of the workspace path so the directory listing does not enumerate projects, and capped at 200 messages and 400,000 characters. "Clear conversation" deletes it regardless of the setting.
- Runtime logs: Local Coder output channel; prompt logging flags are blocked.

## Failure isolation

- The runtime is a supervised child process and can be stopped without closing VS Code.
- A partial network download remains resumable as `.part`.
- A hash mismatch never reaches the approved model path.
- The extension never falls back to cloud inference.
- Runtime exit, model validation, acquisition, and context-selection failures are surfaced separately.
