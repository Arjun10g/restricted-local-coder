# Contributing

1. Keep the target-laptop path dependency-free: VS Code plus the packaged VSIX and GGUF must be sufficient.
2. Do not add telemetry, remote prompt processing, hidden model sources, or automatic command execution.
3. Pin native dependencies by immutable commit.
4. Add tests for downloader, manifest, prompting, and path-security changes.
5. Never commit model weights or runtime binaries to the source branch.
6. Update `THIRD_PARTY_NOTICES.md` and the model manifest when changing upstream components.
