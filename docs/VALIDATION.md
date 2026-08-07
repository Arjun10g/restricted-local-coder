# Validation status

Validated on **2026-08-07** against the source-only repository.

## Completed locally

- Model-manifest schema, HTTPS/host policy, approved SHA-256 shape, RAM/profile bounds, and default-profile checks.
- Source-policy checks covering cloud endpoints, shell execution helpers, runtime hardening flags, secret-path exclusions, immutable `llama.cpp` pinning, and deterministic benchmark definitions.
- Fourteen Node.js behavior tests for streaming parsing, workspace-context safety, resumable downloads, GGUF validation, URL policy, model selection, argument policy, and sanitized native-runtime environments.
- JavaScript syntax checks for extension, test, and tool sources.
- Python bytecode compilation for build helpers.
- Bash syntax validation for the portable runtime builder.
- JSON parsing for every checked-in JSON file.
- YAML parsing for both GitHub Actions workflows.
- Git whitespace/error checking before the initial commit.

## Enforced in GitHub Actions

The source-validation workflow repeats the checks above and uses the PowerShell parser for every `scripts/*.ps1` file. Workflow actions are pinned to full commits, and package-manager caching is explicitly disabled because this repository has no dependency install step.

The platform-build workflow additionally:

1. checks out the exact `llama.cpp` commit in `vendor/llama.cpp.lock.json`;
2. compiles `llama-server` for the matrix platform;
3. collects adjacent native runtime libraries and the upstream license;
4. executes the packaged server with `--version`;
5. packages a platform-targeted VSIX; and
6. emits a SHA-256 sidecar.

## Requires the real target or build runner

The source archive deliberately excludes native binaries and model weights. The following therefore remain deployment gates rather than source-only claims:

- successful native compilation on each selected GitHub runner or approved internal runner;
- successful VSIX installation on the restricted VS Code desktop;
- actual loading of the 10.9 GB default GGUF;
- peak working-set, page-fault, first-token, decode-rate, and tail-latency measurements on the 32 GB laptop;
- chat-template and fill-in-the-middle behavior against the exact approved model artifact; and
- organization-specific code-quality, security, and repository-test evaluation.

Use `scripts/Invoke-SmokeTest.ps1`, `scripts/Invoke-ModelBenchmark.ps1`, and the target project's normal test suite for those gates. Generated code is never executed by the included benchmark itself.
