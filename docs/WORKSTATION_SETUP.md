# Workstation setup runbook

End-to-end setup for the restricted 32 GB Windows workstation that can reach
`github.com` but not Hugging Face or ModelScope.

Three components are governed and delivered separately. Nothing here requires
administrator rights, Git, Python, Node, CMake, Docker, or a model manager **on
the workstation**. Those are only needed on the staging machine.

| Component | Lives in | Reaches the workstation as |
|---|---|---|
| Extension source | the git repository | not shipped directly |
| Extension + native `llama-server` | built by CI | a platform `.vsix` release asset |
| Model weights (10.9 GB GGUF) | never in git | split release assets, reassembled on device |

---

## Order matters

The model manifest is **baked into the VSIX at package time**. If you build the
VSIX before the `parts` block exists, the installed extension will not know the
weights are on GitHub and the download command will have no source to use.

Do it in this order:

1. Stage and publish the model parts (Stage B).
2. Paste the `parts` block into the manifest and commit it.
3. Tag a release so CI builds the VSIX **containing** that manifest (Stage A).
4. Install on the workstation (Stage C).

---

## Stage A — Build the VSIX

Runs entirely on GitHub runners. Costs nothing on your laptop.

Once the `parts` block from Stage B is committed:

```bash
git tag v0.4.1
git push origin v0.4.1
```

The `Build platform VSIX` workflow compiles the pinned `llama.cpp` for four
targets, packages each into a platform VSIX with a SHA-256 sidecar, and attaches
them to a GitHub release. The workstation needs only:

```
restricted-local-coder-0.4.1-win32-x64.vsix
restricted-local-coder-0.4.1-win32-x64.vsix.sha256
```

To rehearse the build without publishing anything, run the workflow manually
(Actions → Build platform VSIX → Run workflow). The release job is gated on a
`v*` tag, so a manual run builds and uploads artifacts but publishes no release.

---

## Stage B — Publish the model weights

Do this on a machine that **can** reach ModelScope. The workstation never runs
this stage.

### Disk requirements — check before starting

Splitting needs the source model and the parts on disk simultaneously:

| Item | Size |
|---|---|
| Source GGUF | 10.9 GB |
| Parts written alongside it | 10.9 GB |
| **Peak requirement** | **~22 GB free** |

If the staging machine is tight on space, point `-OutputDirectory` at an
external volume so only the source sits on the internal disk. Do not try to
squeeze this into a couple of spare gigabytes; a failed split halfway through
wastes the whole download.

### Steps

1. Download the exact file named in `extension/models/manifest.json` for the
   profile you are deploying (default `qwen3-coder-30b-a3b-q4xl`):
   `Qwen3-Coder-30B-A3B-Instruct-1M-UD-Q4_K_XL.gguf`.

2. Verify it before doing anything else:

   ```powershell
   (Get-FileHash .\Qwen3-Coder-30B-A3B-Instruct-1M-UD-Q4_K_XL.gguf -Algorithm SHA256).Hash.ToLower()
   ```

   It must equal the `acceptedSha256` entry in the manifest. If it does not,
   stop — do not publish it.

3. Split and publish:

   ```powershell
   .\scripts\Publish-ModelParts.ps1 `
     -ModelPath .\Qwen3-Coder-30B-A3B-Instruct-1M-UD-Q4_K_XL.gguf `
     -Repository <owner>/restricted-local-coder `
     -Tag model-muse-glimmer-v1 `
     -OutputDirectory E:\model-parts
   ```

   The script refuses to publish unless the digest is already approved, splits
   into `.part-NNN` assets below the 2 GB release-asset limit, uploads them, and
   prints a `parts` block.

   Requires `node` and `gh` on the staging machine, and `gh auth login` as the
   account that owns the repository.

4. Paste the printed block into the profile in
   `extension/models/manifest.json`, then:

   ```bash
   npm run validate
   git commit -am "Publish IQ2_M model parts"
   git push
   ```

   `check-manifest.js` enforces part naming, unique digests, the 2 GB ceiling,
   and that the parts sum to the declared model size. If validation fails, the
   block is wrong — fix it before tagging.

5. Now do Stage A.

> Release assets on a public repository do not count against repository size and
> are not billed for bandwidth, which is why this route is used instead of Git
> LFS.

---

## Stage C — The workstation

### 1. Prerequisites

- Windows x64, 32 GB RAM.
- VS Code **1.95.0 or newer**.
- About 15 GB free disk (10.9 GB model plus working room).
- HTTPS access to `github.com`.

### 2. Install the extension

Copy the `.vsix` and its `.sha256` across, then confirm the file is intact:

```powershell
(Get-FileHash .\restricted-local-coder-0.4.1-win32-x64.vsix -Algorithm SHA256).Hash.ToLower()
Get-Content .\restricted-local-coder-0.4.1-win32-x64.vsix.sha256
```

Install it:

```powershell
code --install-extension .\restricted-local-coder-0.4.1-win32-x64.vsix
```

Or in VS Code: Extensions → `…` menu → **Install from VSIX**.

### 3. Trust the workspace

Open your project folder and choose **Yes, I trust the authors**. The extension
refuses to start in an untrusted workspace, by design.

### 4. Apply the starting settings

Open Settings (JSON) and add:

```json
{
  "localCoder.modelProfile": "qwen3-coder-30b-a3b-q4xl",
  "localCoder.runtime.contextSize": 8192,
  "localCoder.runtime.promptCacheMiB": 512,
  "localCoder.runtime.autoStart": false,
  "localCoder.runtime.gpuLayers": "auto",
  "localCoder.runtime.enableDraftModel": true,
  "localCoder.inlineCompletions.enabled": false,
  "localCoder.context.maxCharacters": 48000
}
```

Start at 8K context. Raise it to 16K only after you have measured memory under
real use, and never above the `n_ctx_train` the smoke test reports. Leave inline
completions off until chat is proven stable — every pause in typing can otherwise
schedule inference. The default profile has no fill-in-the-middle tokens, so
inline requests are refused for it regardless of this setting.

If an internal HTTPS mirror also exists, add it and it will be tried ahead of
GitHub:

```json
{ "localCoder.modelMirrorBaseUrl": "https://approved.example/models/local-coder/" }
```

### 5. Preflight

Command Palette (`Ctrl+Shift+P`) → **Local Coder: Run Preflight**.

A report opens. Expect at this point:

| Check | Expected |
|---|---|
| Platform | PASS |
| System RAM | PASS at 32 GB |
| Model directory | PASS |
| Model file | **WARN — not installed yet** |
| Free disk | PASS |
| Native runtime | PASS |
| System libraries | PASS |
| Workspace trust | PASS |
| Prompt cache / Context budget | PASS |

Resolve every **FAIL** before continuing. A WARN on the model file is expected
until the next step.

### 6. Acquire the model

Command Palette → **Local Coder: Download or Repair Model**.

Because the profile declares `parts`, the extension takes the parted route
automatically:

- parts stream straight into the destination file, so peak disk stays at one
  model plus the part in flight rather than two full copies;
- each part is verified against its own SHA-256 as it lands;
- a bad part is repaired in place without discarding later parts;
- an interrupted download resumes mid-part;
- the assembled file is checked against the whole-file SHA-256 and quarantined
  rather than installed if it disagrees.

Expect roughly 11 GB of transfer. It is safe to cancel and re-run; it resumes.

The model lands in:

```
%LOCALAPPDATA%\RestrictedLocalCoder\models\
```

If the workstation cannot reach GitHub after all, use **Local Coder: Import
Existing GGUF Model** with an offline copy instead. Verification is identical
and cannot be disabled.

### 7. Start it

1. **Local Coder: Run Preflight** again — the model file should now be PASS.
2. **Local Coder: Start Local Runtime**.
3. **Local Coder: Open Chat**.

First load is slow: the weights are being paged in. Later starts are faster
while the OS file cache is warm.

The server binds to `127.0.0.1` on a random port with a random bearer key held
in VS Code SecretStorage. There is no Web UI, no agent or tool surface, and no
cloud endpoint.

---

## Verify it actually works

Beyond "it replies", confirm:

1. **Selection commands** — select a function, run **Local Coder: Explain
   Selection** and **Generate Tests for Selection**.
2. **Real repair** — give it a genuine compiler or test error from your codebase
   and check the fix compiles.
3. **Memory under load** — keep Task Manager open with your normal language
   servers running. Watch for sustained hard page faults, which mean the context
   or prompt cache is too large.
4. **Benchmark** — run `scripts/Invoke-SmokeTest.ps1`, then
   `scripts/Invoke-ModelBenchmark.ps1` on the staging machine against the same
   model and runtime pair.

Record cold load time, first-token latency, tokens/second, peak working set, and
correctness on your own tasks. A profile is only approved after that, never from
file size alone.

---

## Tuning on 32 GB

Apply in this order if memory pressure appears:

1. Close memory-heavy applications; keep one model loaded.
2. `localCoder.runtime.contextSize` → `8192`.
3. `localCoder.runtime.promptCacheMiB` → `512`, or `0` to disable.
4. `localCoder.runtime.threads` near the physical core count, not the logical
   count — more threads can make memory-bound decode slower.
5. Keep inline completions off during long chat sessions.
6. Prefer the IQ2 profile over Q4 if paging occurs.

If IQ2 repeatedly fails tasks that a 4-bit control solves under the same prompt,
switch profiles with **Local Coder: Select Model Profile** and re-acquire. The
Q4 profile is 17.7 GB and wants a 28 GB minimum — keep context at 8K there.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Preflight: Native runtime FAIL | Wrong-platform VSIX | Install the `win32-x64` build |
| Preflight: Workspace trust FAIL | Folder not trusted | Trust the workspace and reload |
| "No model source is enabled" | Manifest has no `parts` and public download is off | Rebuild the VSIX after committing the parts block |
| Download stops partway | Network interruption | Re-run **Download or Repair Model**; it resumes |
| "SHA-256 mismatch" on a part | Corrupt or replaced asset | Re-run; it repairs that part alone. If it persists, the release asset is wrong |
| "assembled model failed verification" | Wrong model published | The bad file is quarantined as `.invalid-*`. Re-publish from a correctly hashed source |
| Preflight: System libraries FAIL | MSVC runtime absent | The `win32-x64` VSIX bundles `msvcp140.dll`, `vcruntime140.dll` and `vcruntime140_1.dll` beside `llama-server.exe`. If they are missing, the VSIX was built before that step existed — rebuild it |
| Runtime will not start, no clear error | Missing native libraries | Run preflight first; the System libraries row names the missing file. All `.dll` files must sit beside `llama-server.exe` |
| Very slow first response | Weights paging in | Expected on cold start; measure the second run |
| Sustained page faults | Context or cache too large | Drop to 8K context and 0 prompt cache |

Logs: **Local Coder: Show Logs**.

---

## What is still unproven

Be clear-eyed about what has and has not been demonstrated:

- **Verified:** the parted download, resume, per-part repair, source failover,
  and quarantine logic, plus the splitter/assembler round trip — all covered by
  the test suite.
- **Not yet verified:** that this specific 2-bit quantization is good enough for
  your actual coding tasks. That is a measurement, not a prediction, and
  `docs/MODEL_SELECTION.md` deliberately refuses to claim it from file size or a
  publisher benchmark. Run the approval gate before rolling this out widely.
