# Threat model

## Assets

- proprietary source code, diagnostics, and prompts;
- approved model weights and their integrity record;
- internal mirror locations;
- local API credential;
- developer workstation availability.

## Trust boundaries

1. VS Code extension host.
2. Supervised native `llama-server` child process.
3. GGUF/native parser boundary.
4. Model acquisition channel and redirects.
5. Workspace files, including malicious comments or instructions.
6. Build/release pipeline for the platform VSIX.

## Principal threats and controls

| Threat | Control |
|---|---|
| Network peer reaches inference | Fixed `127.0.0.1` bind, one random bearer key, loopback-only client |
| Browser/extension abuses server UI | `--no-webui`, local CORS scope, no credentials in CORS |
| Model output invokes tools or shell | `--no-agent`; no MCP/tools; extension exposes no execution tool |
| Runtime fetches a different model | Approved local `--model`, `--offline`, inherited model-source variables stripped |
| Prompt or source is written to native logs | prompt/verbose/log-file flags blocked; no slots endpoint |
| Cleartext or prohibited model download | HTTPS required except loopback; deny-list reapplied after redirects |
| Partial/tampered weights are loaded | `.part` staging, GGUF magic, mandatory approved SHA-256, cache invalidation on file change |
| Runtime source silently changes | pinned release tag plus the full immutable Git commit; every release asset recorded with its SHA-256 and byte length in `vendor/llama.cpp.lock.json`, verified before the archive is unpacked |
| Runtime binary is altered in transit or at rest | binaries are hashed. Until the move to prebuilt releases only the VSIX carried a digest, so the most security-sensitive artifact was the least verified |
| Prebuilt runtime carries an unwanted Web UI | official archives bundle Web UI assets; the server is always started with `--no-webui`, so the mitigation is at runtime rather than at build time |
| Prompt injection closes context wrapper | reserved-tag neutralization, adaptive code fences, and explicit untrusted-data instruction |
| Secret file enters context | path/extension deny-list plus active-document rejection and bounded retrieval |
| Malicious environment changes child behavior | strip `LLAMA_*`, `GGML_*`, HF and inherited loader variables; use only the bundled runtime directory for adjacent native libraries |
| Huge prompt/cache exhausts memory | bounded context, one slot, one parallel request, prompt-cache cap, output limits/cancellation |
| Extension update removes the model | model stored outside extension installation directory |
| Model output invokes a shell | agent commands are started with `spawn` and an argv array with `shell: false`, so operators such as `&&` or `;` arrive at the program as literal arguments; `child_process.exec` is banned repository-wide by `check-source.js` |
| Allow-list defeated by command concatenation | commands are matched as an argv **prefix**, token by token; nothing joins argv into a string to decide, and `check-source.js` asserts that no permission decision is made on a joined string |
| Agent reads a secret the chat context excludes | `read_file` applies the same deny-list as workspace context; a refusal names the path and never returns contents |
| Agent reaches outside the workspace | paths are resolved before the containment check, which requires a path separator so a sibling sharing the root's prefix is outside it; NUL-containing paths are rejected because they would truncate at the syscall |
| Tool output is treated as instructions | tool results are neutralized like any other untrusted workspace text before re-entering the prompt |
| Model edits the wrong file | writing is a separate capability (`agent.allowWrite`, default `false`) that also requires `allowlist` or `confirm` mode; every change is applied through `vscode.workspace.applyEdit`, so `Ctrl+Z` restores it, and `check-source.js` asserts the write tools never call `fs.writeFile`; in `confirm` mode every write is confirmed through a modal naming the file and the byte delta, never a webview message |
| Model edits the wrong call site within a file | `edit_file` requires `old_text` to match **exactly once**; zero matches refuses, two or more refuses and names the count, and the first of several is never silently chosen. Measured over 64 live `edit_file` calls, the model produced a unique `old_text` every time -- see AGENT_VALIDATION.md |
| Model edits its own project memory | anything under `.localcoder/` is refused outright: `memory.md` is injected into every prompt, so a model able to edit it could persist an instruction into all future turns -- a prompt-injection amplifier rather than a convenience |
| Runaway loop rewrites the workspace | at most 20 writes per agent turn, counted across the whole loop rather than per call; content over 1 MiB or containing a NUL byte is refused; the audit log records path, operation, and byte delta, never contents |
| Agent loops indefinitely on local hardware | a bounded step count (`agent.maxSteps`, default 8); reaching it is reported rather than retried, and each step costs a full prompt evaluation |
| Agent capability is enabled unnoticed | `agent.mode` defaults to `off` and `check-source.js` asserts that default; every tool call is recorded in an audit log with its outcome and reason, viewable from a command |
| Chat transcript outlives the session on disk | persistence is opt-in (`chat.persistHistory`, default off); transcripts are written `0o600` by atomic rename into the extension's private global storage, never into the workspace, so they cannot be committed or re-entered as workspace context; bounded to 200 messages and 400,000 characters; deleted by "Clear conversation" whatever the setting |
| Stored-transcript filenames disclose project names | the file is named by a SHA-256 digest of the workspace path, so the storage directory does not enumerate what a user works on |
| Tampered transcript re-enters the prompt | a transcript is data, never instructions: on load, the schema version is checked, only `user`/`assistant` roles with non-empty string content survive, and unreadable or unknown-schema files are ignored rather than trusted. The system prompt is always rebuilt from source, never restored from disk |
| Acceleration flags cannot be turned off by an operator | `check-source.js` asserts that every runtime flag has a declared setting, so a bad offload can always be disabled without rebuilding the VSIX |

## Residual risk

Native parsers process complex binary data, and an approved hash can still identify a malicious or vulnerable artifact. A local model can generate insecure or incorrect code. Enterprise scanning, least-privilege workstation controls, normal tests, static analysis, human review, and rollback remain required.
