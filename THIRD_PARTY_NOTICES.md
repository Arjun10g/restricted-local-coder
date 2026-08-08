# Third-party notices

This repository's original source is licensed under MIT.

## llama.cpp

- Project: `ggml-org/llama.cpp`
- License: MIT
- Runtime pin: see `vendor/llama.cpp.lock.json`
- The release workflow builds and redistributes selected runtime binaries. Preserve the upstream license in release artifacts.

## Qwen3-Coder model family

- Project: Qwen3-Coder by the Qwen team.
- Base model license: Apache License 2.0 for the profiles listed in the manifest.
- Quantized GGUF files: community conversions published by Unsloth and mirrored through ModelScope.
- Model weights are not part of this source repository. Users remain responsible for reviewing model licenses and organizational policy before acquisition or use.

## Microsoft Visual C++ Runtime (Windows VSIX only)

- Files: `msvcp140.dll`, `vcruntime140.dll`, `vcruntime140_1.dll`
- Publisher: Microsoft Corporation
- Distributed under the Microsoft Visual Studio redistributable terms, which permit app-local distribution of these runtime files alongside an application.

Windows does not include the MSVC C/C++ runtime, unlike the Universal CRT. The
`win32-x64` VSIX therefore carries these three libraries next to
`llama-server.exe`, because the intended user has no administrator rights and
could not install the redistributable if it were absent. Windows resolves a DLL
from the executable's own directory first, so no installation or registration
occurs. They are copied at build time from the Visual Studio redistributable
directory on the build agent and are not committed to this repository. No other
platform bundles them.

## VS Code

The extension uses the public Visual Studio Code Extension API. VS Code itself is not redistributed by this repository.
