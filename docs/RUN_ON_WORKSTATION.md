# Run it on the workstation — copy and paste

Empty Windows machine to working local chat. Every command is literal; nothing
to substitute.

## What this page pins

Digests below are exact and **version-locked**. They are correct for release
`v0.5.1` and the weights currently published. When either is republished the
digests change, so take them from the `.sha256` sidecar and the manifest rather
than from memory.

| | |
|---|---|
| Release | `v0.5.1` |
| Extension id | `restricted-local.restricted-local-coder` |
| VSIX | `restricted-local-coder-0.5.1-win32-x64.vsix` |
| VSIX size | see the `.sha256` sidecar on the release |
| VSIX SHA-256 | see the `.sha256` sidecar on the release |
| Model | `Qwen3-Coder-30B-A3B-Instruct-1M-UD-Q4_K_XL.gguf` |
| Model size | `17690500448` bytes (16.48 GiB) |
| Model SHA-256 | `e71c9271166ad64865767022e86f45ea4f03a8258389460cc55c8d95e18833db` |
| Draft model | `dflash-kquant.gguf` (optional) |
| Draft size | `1631205312` bytes (1.52 GiB) |
| Draft SHA-256 | `27d9a805fa29b943cfb6ad4843367cd4eaaaf06bd452d8cc3e00a2cd18a677bc` |
| Model source | `https://storage.googleapis.com/restricted-local-coder-dazzling-howl-491904/` |

About 17.1 GiB is transferred in step 6, and roughly 22 GiB of free disk is
wanted. The Qwen profiles remain in the manifest but their weights are **not**
staged in this bucket; selecting one without staging it first will fail to
download.

---

## Step 1 — Remove any earlier install

Skip nothing here even if you think the machine is clean.

**If you installed `v0.1.0`, you must replace it.** That build shipped before the
model pivot: it knows only the Qwen profiles, whose weights are no longer staged
in the bucket, so it cannot download anything. It also predates GPU offload,
speculative decoding, and the draft-model download. Uninstalling first also
avoids VS Code retaining files from a same-versioned build.

```powershell
code --uninstall-extension restricted-local.restricted-local-coder
```

Reporting that it is not installed is fine. Close VS Code afterwards so nothing
stays locked.

---

## Step 2 — Download the VSIX

```powershell
New-Item -ItemType Directory -Force -Path C:\coder | Out-Null
Invoke-WebRequest -Uri "https://github.com/Arjun10g/restricted-local-coder/releases/download/v0.5.1/restricted-local-coder-0.5.1-win32-x64.vsix" -OutFile "C:\coder\coder.vsix"
```

`curl` in PowerShell is an alias for `Invoke-WebRequest` and rejects curl flags,
so `curl -LO` fails with *"cannot find parameter name LO"*. If the download
fails for any other reason, [INSTALL_WINDOWS.md](INSTALL_WINDOWS.md) has six
further routes — proxy credentials, BITS, `curl.exe`, a browser, and a
repository archive for networks that permit `codeload.github.com` but not the
release CDN.

---

## Step 3 — Verify before installing

Every release publishes a `.sha256` sidecar beside each VSIX, so the expected
digest is fetched rather than typed. This stays correct across releases:

```powershell
$Base = "https://github.com/Arjun10g/restricted-local-coder/releases/download/v0.5.1"
$Expected = ((Invoke-WebRequest -Uri "$Base/restricted-local-coder-0.5.1-win32-x64.vsix.sha256" -UseBasicParsing).Content -split '\s+')[0]
$Actual = (Get-FileHash "C:\coder\coder.vsix" -Algorithm SHA256).Hash.ToLower()
"expected $Expected"
"actual   $Actual"
if ($Actual -eq $Expected) { "OK - safe to install" } else { "MISMATCH - do not install" }
```

If this machine cannot reach the release CDN to fetch the sidecar, read the
digest from the release page in a browser and compare it by eye against
`$Actual`.

A file of a few kilobytes is a proxy block page saved under a `.vsix` name.
Retrying the same route will fetch the same page; change routes instead.

---

## Step 4 — Install

```powershell
code --install-extension "C:\coder\coder.vsix"
code --list-extensions | Select-String -Pattern "local"
```

If `code` is not recognised, either add it for this session:

```powershell
$env:PATH += ";$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin"
```

or use the UI, which needs no CLI: **Extensions** → `…` menu → **Install from
VSIX…**.

---

## Step 5 — Settings

Open a project folder and choose **Yes, I trust the authors**; the extension
refuses to start in an untrusted workspace by design. Then `Ctrl+Shift+P` →
`Preferences: Open User Settings (JSON)`:

```json
{
  "localCoder.modelProfile": "qwen3-coder-30b-a3b-q4xl",
  "localCoder.modelMirrorBaseUrl": "https://storage.googleapis.com/restricted-local-coder-dazzling-howl-491904/",
  "localCoder.network.allowPublicModelDownload": false,
  "localCoder.runtime.contextSize": 8192,
  "localCoder.runtime.promptCacheMiB": 512,
  "localCoder.runtime.autoStart": false,
  "localCoder.runtime.gpuLayers": "auto",
  "localCoder.runtime.enableDraftModel": true,
  "localCoder.inlineCompletions.enabled": false
}
```

The trailing slash on the mirror URL matters — the extension appends the model
file name to it. Setting `allowPublicModelDownload` to `false` stops it falling
back to ModelScope, which this machine cannot reach.

`gpuLayers` on `auto` is safe on a machine with no GPU: llama.cpp simply places
nothing and runs on the CPU. Set it to `"off"` only if a partial offload turns
out to be slower than pure CPU, which does happen on small VRAM.

> **The `win32-x64` VSIX bundles the CPU-only llama.cpp build.** On Windows the
> offload flag is currently accepted and ignored, so `gpuLayers` changes nothing
> even on a machine with a large GPU. Preflight detects this and says so rather
> than reporting a GPU it cannot use. Delivering the CUDA runtime is tracked
> separately; until then, treat Windows performance as CPU performance.

Inline completion now works: the default Qwen3-Coder profile carries the fill-in-the-middle tokens, verified end to end. The older Muse Glimmer profile has no
fill-in-the-middle tokens, so the extension refuses inline requests for this
profile regardless — turning it on has no effect. Inline completion needs one of
the Qwen profiles, whose weights are not currently staged.

Confirm the weights are visible before starting a 16 GB transfer:

```powershell
(Invoke-WebRequest -Uri "https://storage.googleapis.com/restricted-local-coder-dazzling-howl-491904/Qwen3-Coder-30B-A3B-Instruct-1M-UD-Q4_K_XL.gguf" -Method Head -UseBasicParsing).Headers["Content-Length"]
(Invoke-WebRequest -Uri "https://storage.googleapis.com/restricted-local-coder-dazzling-howl-491904/dflash-kquant.gguf" -Method Head -UseBasicParsing).Headers["Content-Length"]
```

Expect exactly `17690500448` and `1631205312`. Anything else — a timeout, a
redirect to a login page — means the mirror is unreachable from here, and no
setting will fix that.

---

## Step 6 — Acquire the model

`Ctrl+Shift+P` → **Local Coder: Run Preflight**

Every row should read PASS except **Model file** and **Draft model**, which
correctly warn that nothing is downloaded yet. **GPU offload** warns on a machine
with no NVIDIA device; that is expected and not a blocker. Resolve any FAIL
before continuing.

`Ctrl+Shift+P` → **Local Coder: Download or Repair Model**

About 15.6 GiB for the weights, then a further 1.5 GiB for the optional draft
model. Both are resumable, so cancelling and rerunning is safe. On completion the
extension computes each SHA-256 itself and refuses a file unless it matches the
approved digest. That check has no setting and cannot be turned off.

If the drafter fails but the weights succeed, you get a warning and a working
install — speculative decoding is a speed optimisation, not a requirement, and
the runtime starts without it.

Both files are stored per-user at `%LOCALAPPDATA%\RestrictedLocalCoder\models\`.

---

## Step 7 — Start it

`Ctrl+Shift+P`, in order:

1. **Local Coder: Run Preflight** — *Model file* is now PASS, and *Draft model*
   is PASS if the optional drafter downloaded
2. **Local Coder: Start Local Runtime** — the first start is slow while 15.6 GiB
   pages in; later starts are quicker against a warm file cache
3. **Local Coder: Open Chat**

The server binds to `127.0.0.1` on a random port with a random bearer key held
in VS Code SecretStorage. No web UI, no agent or tool surface, no cloud
endpoint.

---

## Step 8 — Decide whether it is actually good

Getting a reply proves the plumbing, not the model. The default profile is a 4-bit
kquant chosen for agentic chat, and its coding quality on your codebase is the
open question.

1. Select a function and run **Local Coder: Explain Selection**.
2. Run **Local Coder: Generate Tests for Selection**; check the tests compile.
3. Give it a real compiler or test error from your codebase and check the fix is
   correct rather than merely plausible.
4. Watch Task Manager with your usual language servers running. Sustained hard
   page faults mean the context or prompt cache is too large for the machine.

If quality disappoints, that is a model question, not a setup one.
[MODEL_SELECTION.md](MODEL_SELECTION.md) describes the alternative profiles and
the evidence worth gathering before switching. Note that switching to a profile
whose weights are not staged in the bucket means staging them first.

### Finding the real context limit

The manifest pins `contextSize` to 16384 conservatively, because raising it above
what the model was trained for degrades output quality silently. The trained
limit is printed only by the loader. To read it, run the smoke test — it now
extracts the value for you:

```powershell
.\scripts\Invoke-SmokeTest.ps1 `
  -RuntimePath "$env:USERPROFILE\.vscode\extensions\restricted-local.restricted-local-coder-0.5.1\runtime\win32-x64\llama-server.exe" `
  -ModelPath "$env:LOCALAPPDATA\RestrictedLocalCoder\models\Qwen3-Coder-30B-A3B-Instruct-1M-UD-Q4_K_XL.gguf"
```

It prints `Model trained context (n_ctx_train): <N> tokens` and the GPU layer
count actually offloaded. Never set `runtime.contextSize` above that `N`. Staying
below it is a memory decision; going above it is a correctness one.

---

## Tuning, in order

1. Close memory-heavy applications.
2. Keep `runtime.contextSize` at `8192` until memory has been measured.
3. `runtime.promptCacheMiB` to `512`, or `0` to disable it.
4. `runtime.threads` near the physical core count, not the logical count; extra
   threads can slow memory-bound decoding.
5. Leave inline completions off during long chats — every typing pause can
   otherwise schedule inference. On a Muse Glimmer profile this is moot; it has
   no FIM tokens and the request is refused.
6. Leave `runtime.gpuLayers` on `auto`. If preflight reports VRAM below the
   profile's `minVramGiB`, compare `off` against `auto` with the benchmark
   script before assuming a partial offload helps.
7. `runtime.draftMaxTokens` defaults to 3, which is what measurement picked and
   also what upstream defaults to. Raising it is almost always wrong on a CPU:
   verification cost grows with the number of positions verified, so larger
   drafts cost throughput even when the drafter agrees. Measured, 15 is a net
   loss. See `docs/PERFORMANCE.md`.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Preflight: Native runtime FAIL | Wrong-platform VSIX | Install the `win32-x64` asset |
| Preflight: System libraries FAIL | MSVC runtime missing | This VSIX bundles it; reinstall and recheck the digest in step 3 |
| Preflight: Workspace trust FAIL | Folder not trusted | Trust it and reload |
| "No model source is enabled" | Mirror URL absent or missing its trailing slash | Recheck step 5 |
| Download fails at once | Mirror unreachable | Run the step 5 check |
| Download stops partway | Network interruption | Rerun; it resumes |
| Hash mismatch after downloading | Stale extension build, or a corrupt copy | Confirm step 1 removed the old install, then reinstall |
| Preflight: Draft model WARN | Optional drafter not downloaded | Rerun **Download or Repair Model**; the weights are skipped if already valid |
| Preflight: GPU offload WARN | No NVIDIA device, or VRAM below the profile | Expected on a CPU-only machine; generation still works |
| Inline suggestions never appear | Selected profile has `fim: false` | Expected on the Muse Glimmer profiles only; the default Qwen3-Coder profile supports it |
| Runtime log says "Draft model … is not installed" | Drafter absent | Harmless; speculative decoding is skipped |
| Runtime will not start | Weights failed verification | Run preflight; *Model file* names the problem |
| Very slow first response | 10 GB paging in | Expected cold; judge the second run |
| Sustained page faults | Context or cache too large | 8K context, `promptCacheMiB: 0` |

Logs: **Local Coder: Show Logs**.
