# Model selection record

Verified on **2026-08-07**.

## Decision

Use **Qwen3-Coder-30B-A3B-Instruct with the UD-IQ2_M GGUF** as the initial default, while treating the selection as an empirical deployment decision rather than a permanent claim that it is the strongest open coding model.

The reasons are unusually practical:

- it is explicitly code-specialized and trained for coding/agentic work rather than merely scoring well on some code benchmarks;
- its 30B-total / roughly 3B-active MoE shape is plausible for CPU inference while providing more capacity than a small dense model;
- the family exposes fill-in-the-middle behavior needed for native VS Code completions;
- a single-file GGUF is available through ModelScope, with an exact approved SHA-256 and an Apache-2.0 license;
- the pinned llama.cpp runtime supports the architecture and quantization path;
- the 10.9 GB IQ2 file leaves materially more safety margin than 18–30 GB alternatives on a 32 GB workstation.

The model advertises a far larger context than this repository enables. The default is 16K and the operational starting point is 8K because model weights are only part of process memory.

## Shipped profiles

| Profile | Approx. file | Purpose | 32 GB position |
|---|---:|---|---|
| Qwen3-Coder 30B-A3B UD-IQ2_M | 10.9 GB | Aggressive 2-bit balance | **Default** |
| Qwen3-Coder 30B-A3B UD-TQ1_0 | 8.1 GB | Ternary / 1-bit-class experiment | Smallest, not presumed equivalent |
| Qwen3-Coder 30B-A3B UD-Q4_K_XL | 17.7 GB | Quality-control profile | Use at 8K with low background memory |
| Qwen3-Coder-Next UD-TQ1_0 | 18.9 GB | 80B-total hybrid edge test | Controlled comparison only |

### Why 2-bit rather than ternary by default

Coding quality is discontinuous: a response can be mostly fluent yet fail because one boundary condition, identifier, operator, or API contract is wrong. Ternary post-training quantization gives the smallest file but can disproportionately perturb expert routing and exact repair behavior. The repository therefore makes TQ1 measurable, not aspirational: compare it with the included coding benchmark and real tests before promotion.

### Why keep a 4-bit control

Without a higher-quality control, it is hard to distinguish a weak prompt or retrieval failure from quantization damage. The Q4 profile costs RAM and throughput but provides a useful same-family comparison.

## Newer 2026 candidates reviewed

### Qwen3.6-35B-A3B

Qwen released this 35B-total / 3B-active model in April 2026 and positions it strongly for agentic coding; official documentation also states that llama.cpp supports Qwen3.6 and recommends ModelScope where Hugging Face is unavailable. Community IQ2 conversions are roughly 11–13 GB, depending on the conversion and metadata. It is a serious successor candidate, but this repository does not ship it yet because the available artifact/hash path has not been vetted here and the extension's Qwen Coder FIM behavior has not been validated against Qwen3.6. Add it only after checking chat templates, completion tokens, hashes, and the benchmark suite.

### GLM-4.7-Flash

Z.ai describes GLM-4.7-Flash as a lightweight 30B-A3B option derived from a family with strong coding/agentic results, and publishes official weights on ModelScope. It is architecturally attractive for this laptop. It remains a watch-list model because current llama.cpp support has had model-specific compatibility work, and this repository has not approved a stable ultra-low-bit GGUF plus digest. It may become the best chat-first alternative after runtime validation.

### Devstral Small 2

Devstral Small 2 is a dense 24B Apache-2.0 software-engineering model intended for codebase exploration and multi-file editing. A 2-bit form can fit, but all 24B dense weights participate per token, so CPU decode may be less favorable than an A3B MoE. Its official hosted model card was deprecated in February 2026, and it does not supply the Qwen-specific FIM path implemented here. It remains useful as a chat/review comparator.

### Mistral Small 4

Mistral recommends this 119B-total / 6.5B-active hybrid reasoning-and-coding MoE for local use where adequate hardware exists. Total weights still have to reside somewhere: even near 2 bits, the raw weight payload approaches the full 32 GB machine budget before quantization metadata, runtime buffers, cache, VS Code, and the OS. It is not a safe laptop profile.

### BitNet b1.58

Microsoft's official BitNet runtime demonstrates native 1.58-bit inference, but the publicly highlighted small checkpoint is general-purpose rather than a leading coding assistant. It is a kernel/runtime research baseline, not the default productivity model.

## Approval gate

Do not promote a profile from file size or a publisher benchmark alone. Run:

1. `scripts/Invoke-SmokeTest.ps1` for load, authentication, template, and basic inference.
2. `scripts/Invoke-ModelBenchmark.ps1` with identical runtime settings for every quantization.
3. Organization-specific tasks covering completion, compiler/test-error repair, repository Q&A, refactoring, tests, security review, and the primary internal languages.
4. Existing unit/integration tests against generated patches; the included benchmark deliberately does not execute generated code.
5. Peak working-set, page-fault, first-token, median response, and tail-latency measurement while normal VS Code language servers are active.

A practical rule is to retain IQ2 unless TQ1 meets the internal correctness floor, and to move to Q4 when IQ2 repeatedly fails tasks that Q4 solves under the same prompt and context.

## Source index

See `docs/RESEARCH_SOURCES.md` for the dated verification record and direct primary-source URLs.
