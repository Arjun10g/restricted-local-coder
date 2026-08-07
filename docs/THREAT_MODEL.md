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
| Runtime source silently changes | full immutable Git commit and release workflow |
| Prompt injection closes context wrapper | reserved-tag neutralization, adaptive code fences, and explicit untrusted-data instruction |
| Secret file enters context | path/extension deny-list plus active-document rejection and bounded retrieval |
| Malicious environment changes child behavior | strip `LLAMA_*`, `GGML_*`, HF and inherited loader variables; use only the bundled runtime directory for adjacent native libraries |
| Huge prompt/cache exhausts memory | bounded context, one slot, one parallel request, prompt-cache cap, output limits/cancellation |
| Extension update removes the model | model stored outside extension installation directory |

## Residual risk

Native parsers process complex binary data, and an approved hash can still identify a malicious or vulnerable artifact. A local model can generate insecure or incorrect code. Enterprise scanning, least-privilege workstation controls, normal tests, static analysis, human review, and rollback remain required.
