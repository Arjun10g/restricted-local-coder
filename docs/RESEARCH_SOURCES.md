# Research sources and verification record

Checked on **2026-08-07**. URLs are retained here so future maintainers can repeat the review.

## Native runtime

- llama.cpp repository: https://github.com/ggml-org/llama.cpp
- server documentation: https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
- release page: https://github.com/ggml-org/llama.cpp/releases
- pinned release: `b10307`
- pinned commit: `fc3f10b3895ebb0ddfe1fcb7fd5950f2c1719339`

Capabilities verified for the pin: local GGUF inference, OpenAI-compatible HTTP routes, loopback host support, environment/API-key authentication, offline mode, q8 KV types, prompt-cache controls, no-Web-UI switch, and agent/tool disablement.

## Default coding family and exact files

- Qwen3-Coder repository: https://github.com/QwenLM/Qwen3-Coder
- Qwen3-Coder release article: https://qwenlm.github.io/blog/qwen3-coder/
- official ModelScope base model: https://modelscope.cn/models/Qwen/Qwen3-Coder-30B-A3B-Instruct
- ModelScope GGUF mirror used by the manifest: https://modelscope.cn/models/unsloth/Qwen3-Coder-30B-A3B-Instruct-1M-GGUF
- Qwen3-Coder-Next GGUF mirror: https://modelscope.cn/models/unsloth/Qwen3-Coder-Next-GGUF

The approved filenames and SHA-256 values are recorded in `extension/models/manifest.json`. The upstream file records were checked for size, license, and digest before inclusion.

## Newer candidate review

- Qwen3.6 official repository and ModelScope guidance: https://github.com/QwenLM/Qwen3.6
- Qwen3.6 35B-A3B GGUF candidate on ModelScope: https://modelscope.cn/models/bartowski/Qwen_Qwen3.6-35B-A3B-GGUF
- Z.ai GLM-4.7 / GLM-4.7-Flash repository: https://github.com/zai-org/GLM-4.5
- GLM-4.7-Flash official ModelScope entry: https://modelscope.cn/models/ZhipuAI/GLM-4.7-Flash
- Mistral Devstral Small 2 card: https://docs.mistral.ai/models/model-cards/devstral-small-2-25-12
- Mistral offline model guidance, including Mistral Small 4: https://docs.mistral.ai/vibe/code/cli/offline-models

These are watch-list entries, not approved model sources. A candidate enters the manifest only after its exact GGUF, hash, license, chat/FIM behavior, llama.cpp compatibility, memory, and coding benchmark results are verified.

## Ultra-low-bit behavior

- Microsoft BitNet runtime: https://github.com/microsoft/BitNet
- software-repair quantization trade-off study: https://arxiv.org/abs/2606.27205

The second reference is retained because it treats quantization as a change in software-engineering behavior, not only model compression.

## VS Code extension APIs

- VS Code API reference: https://code.visualstudio.com/api/references/vscode-api
- Webview guide: https://code.visualstudio.com/api/extension-guides/webview
- Inline completion API is documented in the API reference under `InlineCompletionItemProvider`.

The implementation uses stable commands, WebviewViewProvider, SecretStorage, diagnostics/workspace access, and InlineCompletionItemProvider APIs.
