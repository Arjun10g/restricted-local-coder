# GPU and kernel acceleration — specification

We ship the CPU-only build. Upstream publishes **prebuilt Windows binaries for
five other backends**, verified against the b10355 release manifest:

| Backend | Windows asset | Size | Hardware |
|---|---|---:|---|
| CPU (current) | `win-cpu-x64.zip` | 18 MB | any x64 |
| **Vulkan** | `win-vulkan-x64.zip` | **34 MB** | Intel iGPU, AMD, NVIDIA — near-universal |
| SYCL | `win-sycl-x64.zip` | 120 MB | Intel GPU via oneAPI |
| OpenVINO | `win-openvino-2026.2.1-x64.zip` | 81 MB | Intel CPU / GPU / NPU |
| CUDA 12.4 | `win-cuda-12.4-x64.zip` | 251 MB (+391 MB cudart) | NVIDIA |
| HIP | `win-hip-radeon-x64.zip` | 325 MB | AMD Radeon |

**Vulkan is the interesting one: 34 MB is small enough to ship inside the VSIX
alongside the CPU build**, and it runs on the integrated graphics that nearly
every business laptop already has.

---

## Why this could matter more than it first appears

Our binding constraint is **prompt processing**, not generation. The two have
opposite characteristics:

- **Generation is memory-bandwidth-bound.** An integrated GPU shares system RAM,
  so it has the same bandwidth as the CPU. Expect little or no improvement.
- **Prefill is compute-bound.** An iGPU has far more arithmetic throughput than
  a handful of CPU cores. This is exactly the work a GPU is good at.

So the honest expectation is: **prefill improves, generation does not.** Since
prefill is what makes the assistant feel slow on a large workspace context, that
is the right axis to attack.

Measured on our own hardware, prefill scaled +46% from 14 to 28 cores while
generation did not move at all — direct confirmation that the two axes behave
differently and that prefill responds to added compute.

---

## The combination that fits our model

Qwen3-Coder-30B-A3B is a mixture-of-experts model: 30.5B total, 3.3B active.
The expert tensors dominate the file size; attention and shared layers are a
small fraction. b10355 provides:

```
-ncmoe, --n-cpu-moe N    keep the MoE weights of the first N layers in the CPU
        --cpu-moe        keep all MoE weights in the CPU
        --n-gpu-layers N
        --override-tensor  finer-grained placement
```

This is the right shape for a laptop GPU with limited VRAM:

**Put the experts on the CPU, where they are only streamed for the 3.3B that are
active. Put attention and the shared layers on the GPU, where the
compute-intensive prefill happens.**

A 17 GB model does not need 17 GB of VRAM under that split — attention and
shared weights are a small share of the total, and the KV cache for this model
at 16K with q8_0 is around 0.8 GiB. A 4–8 GB GPU may be sufficient. **This must
be measured, not assumed**; report the VRAM actually consumed.

---

## Prefill work that needs no GPU at all

These are cheaper than a second runtime and should be measured first:

- **`--cache-reuse N`.** We resend a large, nearly identical workspace prefix
  every turn. Prefix reuse could remove most prompt processing from turn 2
  onward. Potentially the largest single win available, and it costs nothing.
- **`--slot-save-path`.** llama.cpp can persist slot KV state to disk, so a
  warm prefix can survive a restart rather than being re-prefilled.
- **Batch sizing.** Prefill throughput responds to `--batch-size` / `--ubatch-size`;
  generation does not.

Do these before adding a backend. A 2× from cache reuse on a repeated prefix is
worth more than a 2× on work we can avoid entirely.

---

## What to do

### 1. Establish what hardware the target machine actually has

**Corrected 2026-08-11: the target machine has an INTEL GPU, not NVIDIA.** An
earlier revision of this document claimed NVIDIA on an unverified basis and
promoted CUDA to the primary backend. The user has since stated directly that it
is Intel. **CUDA is out entirely** — it cannot run on Intel hardware, and its
251 MB plus a 391 MB runtime pack were never shippable anyway.

The Intel-capable backends, all with prebuilt Windows binaries:

| Backend | Size | Notes |
|---|---:|---|
| **Vulkan** | 34 MB | Portable, works on Intel/AMD/NVIDIA. Only one small enough to ship in the VSIX. |
| SYCL | 120 MB | Intel's native oneAPI path; often faster than Vulkan on Intel silicon. |
| OpenVINO | 81 MB | Intel CPU/GPU/NPU. Newer Core Ultra parts have an NPU. |

`nvidia-smi` detection is now useless for this machine. Preflight must enumerate
**any** adapter — on Windows `Get-CimInstance Win32_VideoController` gives names
and memory without admin rights.

### The question that decides how much this is worth

**Integrated Xe/UHD, or discrete Arc?** They are entirely different propositions:

- **Integrated** shares system RAM, so it has the *same* memory bandwidth as the
  CPU. Generation will not improve. Prefill is compute-bound and should improve,
  which is still the right target since prefill is our binding constraint.
- **Discrete Arc** (A770 16 GB, B-series 12 GB) has its own VRAM at several
  hundred GB/s. That would lift *generation* too, potentially several-fold, and
  a 12–16 GB card could hold most of a 17 GB model with `--n-cpu-moe` parking
  the experts in system RAM.

Establish which before sizing the effort. The adapter name from
`Win32_VideoController` answers it.

### Two consequences either way

- **The context budget becomes hardware-conditional.** `context.maxCharacters`
  was cut to what CPU prefill can afford. If GPU prefill is much faster, a budget
  sized for 12.9 tok/s wastes the machine. Key it off the measured pp rate or a
  preflight hardware tier, not one global constant.
- **`--n-cpu-moe` applies only to the Qwen profiles.** Muse Glimmer is dense —
  there are no expert tensors to park on the CPU. Its partial-offload story is
  `-ngl N` plus, if needed, `--override-tensor`; its unusually small KV cache
  (16:1 GQA) means more layers fit per GiB than the file size suggests.

### 2. Measure on the instance, in this order

1. Fix the request shape first (see `RUNTIME_PERFORMANCE_SPEC.md` §0) — no
   backend helps with prefill we can avoid entirely.
2. Vulkan build, prefill and generation separately, against the CPU baseline.
3. SYCL against Vulkan on the same Intel hardware. Intel's native path is often
   faster on Intel silicon, and 120 MB versus 34 MB is only worth paying if it
   wins by a margin that matters.
4. Vulkan or SYCL plus `--n-cpu-moe`, sweeping N for the knee — Qwen profiles
   only, since Muse Glimmer is dense.

CUDA is not on this list. The target hardware cannot run it.

Report pp512 and tg128 for each, with VRAM consumed and the machine attached.

### 3. Ship a second runtime only if the numbers justify it

If Vulkan wins materially, add it as a second runtime directory alongside
`win32-x64`, selected at launch. The existing machinery already anticipates this:
`ACCELERATED_RUNTIME_KEYS` in `paths.js`, and `delivery: vsix | external` in the
lock file.

Constraints that do not relax:

- Every asset gets a SHA-256 in `vendor/llama.cpp.lock.json`, verified before
  unpacking, exactly as the CPU build is now.
- The Windows PE import check must pass for the new runtime too. Vulkan will
  import `vulkan-1.dll`, which is part of a Windows driver install rather than
  the OS — add it to the known-system list only after confirming that, or bundle
  what is needed.
- Preflight must **detect and fall back**. A machine with no usable Vulkan driver
  must transparently use the CPU runtime, not fail. Same principle as the draft
  model: an optimisation may never prevent the thing from working.
- 34 MB roughly triples the VSIX. Acceptable if it earns its size; not otherwise.

CUDA is removed from consideration: the target machine is Intel. The lock's
`win32-x64-cuda` entry stays recorded as `delivery: external` for completeness
but is not a deliverable.

If SYCL wins materially over Vulkan it is 120 MB, which is too large to bundle
alongside the CPU runtime — it would be `delivery: external`, fetched on demand,
with the same digest verification. Prefer Vulkan unless the margin is large.

---

## What not to do

**Do not adopt a llama.cpp fork.** `ik_llama.cpp` reports strong CPU gains, but
our entire supply chain rests on pinned upstream releases with published digests
and a reproducible CI fetch. A fork means self-built binaries, no published
digests to verify against, and a second project to track for security fixes.
That is a real cost against an unverified gain on our specific hardware.

**Do not build from source to chase kernel flags.** We deliberately moved from
source builds to verified prebuilt releases because the binaries were the least
verified artifact in the pipeline. Reversing that for a performance experiment
would undo a security improvement.

---

## The honest ceiling

Even if all of this works, generation stays bandwidth-bound at roughly 12–19
tok/s on this class of machine. GPU acceleration attacks the prefill wall, which
is the right target, but it does not turn a CPU workstation into a
Cursor-equivalent. Say so in the write-up.
