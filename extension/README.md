# Restricted Local Coder VS Code extension

A dependency-free desktop extension that supervises a bundled, pinned `llama-server` and exposes private coding chat, explicit editor commands, verified model acquisition/import, bounded workspace context, and optional Qwen fill-in-the-middle suggestions.

Release builds place the native runtime in `runtime/<platform>-<arch>/` and package this directory as a platform-specific VSIX. The source checkout retains only runtime placeholders; a target laptop should receive the workflow-built VSIX rather than run a compiler.

Development without native inference is supported through `F5` and the repository test suite. Real inference requires both a compatible built runtime and an approved GGUF from `models/manifest.json`.
