# Troubleshooting

## Preflight says the runtime is missing

The source repository intentionally excludes compiled native binaries. Use the platform VSIX produced by **Build platform VSIX**, or build the pinned runtime on an approved build machine. Do not point `localCoder.runtimePath` at Ollama; the extension requires a compatible `llama-server`.

## ModelScope download is blocked

Set an internal HTTPS mirror base URL or transfer the exact GGUF and use **Import Existing GGUF Model**. The extension never falls back to Hugging Face. A public `http://` mirror is rejected; use HTTPS or a loopback-only development server.

## Download restarts rather than resumes

The endpoint or proxy did not honor `Range`, returned an incompatible `Content-Range`, or replaced the object. The downloader safely restarts instead of appending duplicate bytes. Immutable internal object storage is usually more predictable.

## SHA-256 mismatch

Do not move a `.part` or quarantined file into place. Confirm the exact artifact revision. Publishers can replace a file under the same name; update the manifest only after independently acquiring, evaluating, and approving the replacement. Hash enforcement is mandatory and cannot be disabled.

## First validation takes a long time

Hashing a 10–19 GB GGUF is expected to take time. After a successful validation, the extension caches the approved digest with file path, size, and modification time. Normal starts reuse that record; changing or replacing the file forces a new hash.

## Runtime starts and exits

Open **View → Output → Local Coder** and inspect the final native lines. Common causes include a platform/architecture mismatch, missing packaged library, unsupported CPU instruction path, unsupported model architecture/quantization, insufficient virtual memory, or endpoint security blocking execution from the extension directory.

Run the packaged `llama-server --version` and then `scripts/Invoke-SmokeTest.ps1` on an approved diagnostic machine to separate binary loading from model loading.

## Runtime is extremely slow or the laptop swaps

- Start at an 8K context.
- Keep prompt cache at 512 MiB or set it to zero.
- Use the IQ2 30B-A3B profile rather than Coder-Next.
- Avoid Q4 while other large developer tools are open.
- Disable inline completion during long chat sessions.
- Compare physical-core-oriented thread counts instead of assuming every logical CPU is faster.
- Keep the approved power mode and capture peak working set/page faults.

## Inline completion shows nothing

The runtime must already be ready, `localCoder.inlineCompletions.enabled` must be true, the active document must be a non-sensitive local code file, the request must survive typing cancellation, and the profile must support the Qwen FIM path. Use VS Code's **Trigger Inline Suggestion** command for an explicit test.

## Chat misses a relevant file

Select the code, open the file, mention its path, or add a reviewed glob to `localCoder.context.extraFiles`. The retriever deliberately avoids indexing or embedding the entire repository.
