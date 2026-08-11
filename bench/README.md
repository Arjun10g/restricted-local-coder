# Coding smoke benchmark

This is a deliberately small, deterministic comparison harness for deciding whether a lower-bit GGUF remains useful for routine coding. It covers repair, implementation, parameterization, tests, and cancellation semantics.

The grader performs static regular-expression checks only. It **does not execute model-generated code**, so a pass is a screening signal rather than proof of correctness. Use the same runtime build, context, thread count, power state, and task file when comparing IQ2, TQ1, and Q4 profiles.

Example on a Windows build machine:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\Invoke-ModelBenchmark.ps1 `
  -RuntimePath .\extension\runtime\win32-x64\llama-server.exe `
  -ModelPath "$env:LOCALAPPDATA\RestrictedLocalCoder\models\Qwen3-Coder-30B-A3B-Instruct-1M-UD-IQ2_M.gguf"
```

Results are written to a timestamped directory under `artifacts/benchmarks/` unless `-OutputDirectory` is supplied. Review the raw responses and run real repository tests before approving a model profile.

## Agent validation

`agent-validation.js` is a different instrument from the task file above. Rather
than scoring a single response with regular expressions, it drives the shipped
agent loop -- `runAgentLoop`, the real tool schemas, the real permission layer --
against a running `llama-server` and a throwaway workspace, and verifies the
result by executing the workspace's own tests.

```bash
node bench/agent-validation.js --base-url http://127.0.0.1:8080 \
  --api-key "$LLAMA_API_KEY" --repeats 8 --out results.json --label shallow
```

`--deep-context-tokens` pads the system message with a workspace context of about
that size; `--deep-context-mode consistent` builds it from files that really are
in the scratch workspace, `foreign` from another project. `--profile` and
`--reasoning-strength` select a manifest profile. Results and method are in
[../docs/AGENT_VALIDATION.md](../docs/AGENT_VALIDATION.md).

The `edit-file-argument-shape` task in `coding-smoke.json` is the cheap screen for
the same property when a full agent run is not worth it.
