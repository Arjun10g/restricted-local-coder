# Run it on the workstation — copy and paste

Empty Windows machine to working local chat. Every command is literal; nothing
to substitute.

## What this page pins

Digests below are exact and **version-locked**. They are correct for release
`v0.1.0` and the weights currently published. When either is republished the
digests change, so take them from the `.sha256` sidecar and the manifest rather
than from memory.

| | |
|---|---|
| Release | `v0.1.0` |
| Extension id | `restricted-local.restricted-local-coder` |
| VSIX | `restricted-local-coder-0.1.0-win32-x64.vsix` |
| VSIX size | `8200308` bytes |
| VSIX SHA-256 | `781db8b9f55ab9da7a4deb34eebf8f1761901a75748a5b488315524846c36a24` |
| Model | `Qwen3-Coder-30B-A3B-Instruct-1M-UD-IQ2_M.gguf` |
| Model size | `10848017760` bytes (10.1 GiB) |
| Model SHA-256 | `0823c953beeda2db652da5839b94fbe08a75725d67bfcd093ca39ba8c1b47d41` |
| Model source | `https://storage.googleapis.com/restricted-local-coder-dazzling-howl-491904/` |

Roughly 10 GB is transferred in step 6, and about 15 GB of free disk is wanted.

---

## Step 1 — Remove any earlier install

Skip nothing here even if you think the machine is clean. The version number has
not changed between builds, so VS Code can keep old files, and any build made
before 2026-08-10 carries an approved digest that **rejects the published
weights** — which surfaces as a hash mismatch at the end of a 10 GB download,
looking exactly like a corrupted transfer.

```powershell
code --uninstall-extension restricted-local.restricted-local-coder
```

Reporting that it is not installed is fine. Close VS Code afterwards so nothing
stays locked.

---

## Step 2 — Download the VSIX

```powershell
New-Item -ItemType Directory -Force -Path C:\coder | Out-Null
Invoke-WebRequest -Uri "https://github.com/Arjun10g/restricted-local-coder/releases/download/v0.1.0/restricted-local-coder-0.1.0-win32-x64.vsix" -OutFile "C:\coder\coder.vsix"
```

`curl` in PowerShell is an alias for `Invoke-WebRequest` and rejects curl flags,
so `curl -LO` fails with *"cannot find parameter name LO"*. If the download
fails for any other reason, [INSTALL_WINDOWS.md](INSTALL_WINDOWS.md) has six
further routes — proxy credentials, BITS, `curl.exe`, a browser, and a
repository archive for networks that permit `codeload.github.com` but not the
release CDN.

---

## Step 3 — Verify before installing

```powershell
if ((Get-FileHash "C:\coder\coder.vsix" -Algorithm SHA256).Hash.ToLower() -eq "781db8b9f55ab9da7a4deb34eebf8f1761901a75748a5b488315524846c36a24") { "OK - safe to install" } else { "MISMATCH - do not install" }
```

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
  "localCoder.modelProfile": "qwen3-coder-30b-a3b-iq2m",
  "localCoder.modelMirrorBaseUrl": "https://storage.googleapis.com/restricted-local-coder-dazzling-howl-491904/",
  "localCoder.network.allowPublicModelDownload": false,
  "localCoder.runtime.contextSize": 8192,
  "localCoder.runtime.promptCacheMiB": 512,
  "localCoder.runtime.autoStart": false,
  "localCoder.inlineCompletions.enabled": false
}
```

The trailing slash on the mirror URL matters — the extension appends the model
file name to it. Setting `allowPublicModelDownload` to `false` stops it falling
back to ModelScope, which this machine cannot reach.

Confirm the weights are visible before starting a 10 GB transfer:

```powershell
(Invoke-WebRequest -Uri "https://storage.googleapis.com/restricted-local-coder-dazzling-howl-491904/Qwen3-Coder-30B-A3B-Instruct-1M-UD-IQ2_M.gguf" -Method Head -UseBasicParsing).Headers["Content-Length"]
```

Expect exactly `10848017760`. Anything else — a timeout, a redirect to a login
page — means the mirror is unreachable from here, and no setting will fix that.

---

## Step 6 — Acquire the model

`Ctrl+Shift+P` → **Local Coder: Run Preflight**

Every row should read PASS except **Model file**, which correctly warns the
weights are absent. Resolve any FAIL before continuing; a WARN there is
expected.

`Ctrl+Shift+P` → **Local Coder: Download or Repair Model**

About 10 GB, resumable, so cancelling and rerunning is safe. On completion the
extension computes the SHA-256 itself and refuses the file unless it matches the
approved digest. That check has no setting and cannot be turned off.

Weights are stored per-user at `%LOCALAPPDATA%\RestrictedLocalCoder\models\`.

---

## Step 7 — Start it

`Ctrl+Shift+P`, in order:

1. **Local Coder: Run Preflight** — *Model file* is now PASS
2. **Local Coder: Start Local Runtime** — the first start is slow while 10 GB
   pages in; later starts are quicker against a warm file cache
3. **Local Coder: Open Chat**

The server binds to `127.0.0.1` on a random port with a random bearer key held
in VS Code SecretStorage. No web UI, no agent or tool surface, no cloud
endpoint.

---

## Step 8 — Decide whether it is actually good

Getting a reply proves the plumbing, not the model. This profile is an
aggressive 2-bit quantization and that is the open question about it.

1. Select a function and run **Local Coder: Explain Selection**.
2. Run **Local Coder: Generate Tests for Selection**; check the tests compile.
3. Give it a real compiler or test error from your codebase and check the fix is
   correct rather than merely plausible.
4. Watch Task Manager with your usual language servers running. Sustained hard
   page faults mean the context or prompt cache is too large for the machine.

If quality disappoints, that is a quantization question, not a setup one.
[MODEL_SELECTION.md](MODEL_SELECTION.md) describes the 4-bit control profile and
the evidence worth gathering before switching.

---

## Tuning, in order

1. Close memory-heavy applications.
2. Keep `runtime.contextSize` at `8192` until memory has been measured.
3. `runtime.promptCacheMiB` to `512`, or `0` to disable it.
4. `runtime.threads` near the physical core count, not the logical count; extra
   threads can slow memory-bound decoding.
5. Leave inline completions off during long chats — every typing pause can
   otherwise schedule inference.

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
| Runtime will not start | Weights failed verification | Run preflight; *Model file* names the problem |
| Very slow first response | 10 GB paging in | Expected cold; judge the second run |
| Sustained page faults | Context or cache too large | 8K context, `promptCacheMiB: 0` |

Logs: **Local Coder: Show Logs**.
