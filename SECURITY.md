# Security policy

## Security boundary

Restricted Local Coder keeps prompts and source code on the workstation. The bundled inference server binds to `127.0.0.1`, requires a random bearer key stored through VS Code SecretStorage, has its Web UI and built-in agent/tool surfaces disabled, and runs in offline mode against an approved local model.

The model downloader is the only component intended to make outbound requests. Public download can be disabled completely; internal acquisition requires HTTPS, while cleartext HTTP is accepted only for loopback development tests.

## Model and runtime supply chain

- `llama.cpp` is pinned to a full immutable 40-character commit and built in GitHub Actions.
- The release workflow creates a platform-specific VSIX and SHA-256 sidecar.
- Every model download or import requires GGUF magic validation and an approved SHA-256; this cannot be disabled in settings.
- Hash results are cached only while absolute path, size, and modification time remain unchanged.
- Invalid files are kept out of the approved path and quarantined where possible.
- Hugging Face hosts and subdomains are denied by both the manifest and source policy.

Hash approval reduces substitution risk; it does not prove that the approved native parser or model is intrinsically safe. Scan artifacts and review runtime upgrades normally.

## Runtime hardening

The API key is delivered through the child environment rather than the process command line. Inherited llama.cpp, GGML, Hugging Face, and dynamic-library injection variables are removed. A strict allow-list limits user-supplied arguments to CPU scheduling and warm-up controls; bind host, API, model source, CORS, logging, prompt capture, agent/tools, MCP, slots, parallelism, cache policy, and context limits remain extension-controlled.

## Workspace data handling

The context builder excludes common secret paths and active sensitive documents, including `.env*`, `.vscode`, `.ssh`, `.aws`, `.azure`, `.gnupg`, `.kube`, key/certificate files, credentials, models, dependencies, and generated output. Workspace text is treated as untrusted data; reserved wrapper tags are neutralized and code-fence lengths adapt to the file content.

No generated shell command is executed, and model output does not modify files except through an explicit editor command initiated by the user.

## Reporting

Do not place proprietary source, model files, credentials, internal URLs, or unsanitized logs in a public issue. Report only the minimum reproducible detail.
