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
