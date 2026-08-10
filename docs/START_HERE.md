# Start here — everything, from scratch

An empty Windows machine to a working private coding assistant. Every command is
literal and copy-pasteable; nothing needs substituting.

If you only read one section, read [Section 2](#2-the-fast-path--one-command).

> **One thing worth knowing before you paste anything.** Copying from a rendered
> page can convert straight quotes (`"`) into curly ones, which PowerShell
> rejects with `The string is missing the terminator: "`. The commands on the
> main path deliberately use **no quotation marks at all**, so they cannot fail
> that way. A handful of later commands do need quotes — if one of those errors,
> retype the quote characters by hand. And if you are stuck at a `>>` prompt,
> press `Ctrl+C` before doing anything else.

---

## Contents

- [0. What you are installing](#0-what-you-are-installing)
- [1. Before you start](#1-before-you-start)
- [2. The fast path — one command](#2-the-fast-path--one-command)
- [3. The manual path — every step](#3-the-manual-path--every-step)
- [4. Settings](#4-settings)
- [5. Get the model](#5-get-the-model)
- [6. Start it](#6-start-it)
- [7. Prove it works](#7-prove-it-works)
- [8. Find the real context limit](#8-find-the-real-context-limit)
- [9. Optional — agent mode](#9-optional--agent-mode)
- [10. Optional — measure quality](#10-optional--measure-quality)
- [11. Troubleshooting](#11-troubleshooting)
- [12. Reference values](#12-reference-values)
- [13. Starting completely over](#13-starting-completely-over)

---

## 0. What you are installing

A VS Code extension that runs a language model **entirely on your machine**. No
cloud inference, no telemetry, no Hugging Face. The extension starts a bundled
`llama.cpp` server on `127.0.0.1` with a random key, loads an approved model file
whose SHA-256 it verifies itself, and gives you chat plus editor commands.

Three things get downloaded:

| Thing | Size | From |
|---|---:|---|
| The extension (VSIX) | 17 MB | GitHub release |
| The model weights | 15.61 GiB | Cloud Storage mirror |
| An optional draft model | 1.52 GiB | Cloud Storage mirror |

Total about **17.1 GiB**. Have **22 GiB** free.

---

## 1. Before you start

**VS Code must be installed.** Nothing else is needed — no Git, no Python, no
Node, no admin rights, no Docker.

Check it is there:

```powershell
code --version
```

If that says `code is not recognized`, add it for this session:

```powershell
$env:PATH += ";$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin"
code --version
```

Still nothing? VS Code is not installed, or is installed system-wide. Try:

```powershell
& "C:\Program Files\Microsoft VS Code\bin\code.cmd" --version
```

Every step below also has a mouse-driven alternative, so a missing CLI is not a
blocker.

### Remove any earlier install

Do this even if you think the machine is clean.

```powershell
code --uninstall-extension restricted-local.restricted-local-coder
```

"Not installed" is a fine answer. Then **close VS Code** so nothing stays locked.

> **If you ever installed `v0.1.0`, this step is mandatory.** That build predates
> the model change: it knows only the Qwen profiles, whose weights are no longer
> published, so it cannot download anything at all.

---

## 2. The fast path — one command

This downloads the extension, verifies its digest, installs it, and writes your
settings. It does **not** download the weights — that happens inside VS Code,
where you get progress and resume.

Paste these **one line at a time**, pressing Enter after each. There are no
quotation marks anywhere in them, deliberately — see the note below.

```powershell
mkdir C:\coder -Force
iwr https://raw.githubusercontent.com/Arjun10g/restricted-local-coder/main/scripts/Start-Workstation.ps1 -OutFile C:\coder\bootstrap.ps1
powershell -ExecutionPolicy Bypass -File C:\coder\bootstrap.ps1
```

> **Why no quotes?** Copying from a rendered web page or a chat window can turn
> straight quotes (`"`) into curly ones (`"` and `"`), which PowerShell does not
> recognise. The result is `The string is missing the terminator: "`. Commands
> without quotes cannot fail that way. If you have already hit that error, press
> `Ctrl+C` first: PowerShell is waiting at a `>>` prompt for you to close the
> string, and everything typed until then will also fail.

Want to read it before running it? Sensible. Open `C:\coder\bootstrap.ps1`
between the second and third lines.

What it does, in order:

1. finds the VS Code CLI even when it is not on `PATH`;
2. downloads the VSIX for this release;
3. fetches the published `.sha256` and compares — **it stops if they differ**;
4. installs the extension;
5. backs up `settings.json`, then merges the recommended settings in.

If your `settings.json` contains `//` comments, it will **not** rewrite it —
rewriting would delete them. It prints the block to paste instead and leaves your
file untouched.

Then skip to [Section 5](#5-get-the-model).

---

## 3. The manual path — every step

Use this if the script fails, or if you prefer doing it yourself.

### 3.1 Download the extension

```powershell
mkdir C:\coder -Force
iwr https://github.com/Arjun10g/restricted-local-coder/releases/download/v0.3.1/restricted-local-coder-0.3.1-win32-x64.vsix -OutFile C:\coder\coder.vsix
```

> Two things that bite here, both avoided above:
>
> - `curl` in PowerShell is an alias for `Invoke-WebRequest` and rejects curl
>   flags, so `curl -LO ...` fails with *"cannot find parameter name LO"*.
> - Quotation marks copied from a rendered page are often curly, which produces
>   *"The string is missing the terminator"*. These commands use none.

Behind a proxy that needs your credentials:

```powershell
$Proxy = [System.Net.WebRequest]::GetSystemWebProxy()
$Proxy.Credentials = [System.Net.CredentialCache]::DefaultNetworkCredentials
Invoke-WebRequest -Uri "https://github.com/Arjun10g/restricted-local-coder/releases/download/v0.3.1/restricted-local-coder-0.3.1-win32-x64.vsix" -OutFile "C:\coder\coder.vsix" -Proxy $Proxy.GetProxy("https://github.com").AbsoluteUri -ProxyUseDefaultCredentials
```

Other routes, if both fail:

```powershell
# Real curl, which ships with Windows 10+ as curl.exe
curl.exe -L -o C:\coder\coder.vsix https://github.com/Arjun10g/restricted-local-coder/releases/download/v0.3.1/restricted-local-coder-0.3.1-win32-x64.vsix

# Background Intelligent Transfer Service, which often works when others do not
Start-BitsTransfer -Source https://github.com/Arjun10g/restricted-local-coder/releases/download/v0.3.1/restricted-local-coder-0.3.1-win32-x64.vsix -Destination C:\coder\coder.vsix
```

Or simply open the release page in a browser and save the `win32-x64` asset to
`C:\coder\coder.vsix`:
<https://github.com/Arjun10g/restricted-local-coder/releases/tag/v0.3.1>

### 3.2 Verify it

```powershell
(Get-FileHash C:\coder\coder.vsix -Algorithm SHA256).Hash
```

Compare what it prints, ignoring case, against the digest published beside the
release asset:

<https://github.com/Arjun10g/restricted-local-coder/releases/download/v0.3.1/restricted-local-coder-0.3.1-win32-x64.vsix.sha256>

They must match exactly. If they differ, delete the file and download it again
over a different route — do not install it.

A file of a few kilobytes is a proxy block page saved under a `.vsix` name.
Retrying the same route fetches the same page — change routes instead.

### 3.3 Install it

```powershell
code --install-extension C:\coder\coder.vsix --force
code --list-extensions | Select-String local
```

No CLI? Use the UI: **Extensions** → `…` menu → **Install from VSIX…** → pick
`C:\coder\coder.vsix`.

---

## 4. Settings

Open a project folder in VS Code and choose **Yes, I trust the authors** — the
extension refuses to start in an untrusted workspace by design.

Then `Ctrl+Shift+P` → `Preferences: Open User Settings (JSON)` and paste:

```json
{
  "localCoder.modelProfile": "muse-glimmer-30b-kquant",
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

If the file already has settings, merge these in rather than replacing the whole
file — keep your existing entries and add these inside the same outer braces.

Three notes worth reading:

- **The trailing slash on the mirror URL matters.** The extension appends the
  model file name to it.
- **`allowPublicModelDownload: false`** stops it falling back to ModelScope,
  which this machine cannot reach anyway.
- **Leave inline completions off.** The default model has no fill-in-the-middle
  tokens, so the extension refuses those requests regardless of this setting.

### Check the mirror before starting a 17 GiB download

```powershell
(iwr https://storage.googleapis.com/restricted-local-coder-dazzling-howl-491904/muse-glimmer-30B-kquant-17gb.gguf -Method Head -UseBasicParsing).Headers
```

```powershell
(iwr https://storage.googleapis.com/restricted-local-coder-dazzling-howl-491904/dflash-kquant.gguf -Method Head -UseBasicParsing).Headers
```

Each prints a table of headers. Find `Content-Length`; it must read exactly
`16756681056` for the model and `1631205312` for the drafter. A timeout, or a
redirect to a login page, means the mirror is unreachable from here and no
setting will fix that.

---

## 5. Get the model

`Ctrl+Shift+P` → **Local Coder: Run Preflight**

Read the table it opens. On a fresh machine these warnings are **expected and
not blockers**:

| Row | Why it warns |
|---|---|
| Model file | nothing is downloaded yet |
| Draft model | nothing is downloaded yet |
| GPU offload | the Windows runtime is a CPU-only build |

Resolve any row marked **FAIL** before continuing. Then:

`Ctrl+Shift+P` → **Local Coder: Download or Repair Model**

About 15.6 GiB for the weights, then 1.5 GiB for the drafter. Both resume, so
cancelling and rerunning is safe. The extension computes each SHA-256 itself and
refuses a file that does not match. That check has no setting and cannot be
turned off.

If the drafter fails but the weights succeed you get a warning and a **working
install** — speculative decoding is a speed optimisation, not a requirement.

Both files land in `%LOCALAPPDATA%\RestrictedLocalCoder\models\`.

---

## 6. Start it

`Ctrl+Shift+P`, in order:

1. **Local Coder: Run Preflight** — *Model file* should now be PASS
2. **Local Coder: Start Local Runtime** — the first start is slow while 15.6 GiB
   pages in from disk; later starts are quicker against a warm file cache
3. **Local Coder: Open Chat**

The server binds to `127.0.0.1` on a random port with a random bearer key held in
VS Code SecretStorage. No web UI, no cloud endpoint.

---

## 7. Prove it works

Getting a reply proves the plumbing, not the model. Try these on your own code:

1. Select a function → **Local Coder: Explain Selection**
2. Select a function → **Local Coder: Generate Tests for Selection**, then check
   the tests actually compile
3. Paste a real compiler or test error and check the fix is *correct*, not merely
   plausible
4. Watch Task Manager with your usual language servers running. Sustained hard
   page faults mean the context or prompt cache is too large for this machine.

---

## 8. Find the real context limit

`localCoder.runtime.contextSize` is set to 8192, and the model profile caps at
16384. Both are deliberately conservative, because setting a context larger than
the model was trained for degrades output quality **silently** — no error, just
worse answers.

The true limit is printed only by the loader. To read it, get the repository and
run the smoke test.

```powershell
iwr https://codeload.github.com/Arjun10g/restricted-local-coder/zip/refs/heads/main -OutFile C:\coder\repo.zip
Expand-Archive -Path C:\coder\repo.zip -DestinationPath C:\coder -Force
Set-Location C:\coder\restricted-local-coder-main
```

Locate the installed runtime — the folder name includes the version and
platform, so discover it rather than typing it:

```powershell
$Ext = Get-ChildItem "$env:USERPROFILE\.vscode\extensions" -Directory -Filter "restricted-local.restricted-local-coder-*" |
       Sort-Object Name -Descending | Select-Object -First 1
$Runtime = Join-Path $Ext.FullName "runtime\win32-x64\llama-server.exe"
$Model = "$env:LOCALAPPDATA\RestrictedLocalCoder\models\muse-glimmer-30B-kquant-17gb.gguf"
"runtime: $Runtime"
"model  : $Model"
Test-Path $Runtime, $Model
```

Both must print `True`. Then:

```powershell
.\scripts\Invoke-SmokeTest.ps1 -RuntimePath $Runtime -ModelPath $Model
```

It loads the model, sends one request, and prints:

```
Model trained context (n_ctx_train): <N> tokens
GPU offload: ... layers
```

**Never set `localCoder.runtime.contextSize` above that `N`.** Staying below it
is a memory trade-off; going above it is a correctness one.

To also test speculative decoding:

```powershell
.\scripts\Invoke-SmokeTest.ps1 -RuntimePath $Runtime -ModelPath $Model `
  -DraftPath "$env:LOCALAPPDATA\RestrictedLocalCoder\models\dflash-kquant.gguf"
```

---

## 9. Optional — agent mode

Off by default. It lets the model read your workspace and run approved commands
instead of only answering from what it was handed.

Start read-only. It cannot cause any effect outside the editor:

```json
{
  "localCoder.agent.mode": "readonly"
}
```

| Mode | The model may |
|---|---|
| `off` | nothing — tools are not offered at all (default) |
| `readonly` | read, list, and search workspace files |
| `allowlist` | the above, plus commands matching your approved list |
| `confirm` | the above, plus any command, each needing a modal confirmation |

Before allowing commands, check the model can even produce the right shape — see
[Section 10](#10-optional--measure-quality). A model that emits one shell string
instead of separate arguments will have every command rejected.

To allow commands:

```json
{
  "localCoder.agent.mode": "allowlist",
  "localCoder.agent.allowedCommands": ["npm test", "npm run lint", "git status"]
}
```

That list **replaces** the built-in defaults. Keep entries specific: a rule of
just `git` would also permit `git push`.

See what it did: `Ctrl+Shift+P` → **Local Coder: Show Agent Audit Log**. Every
call is recorded with its outcome and reason. File *contents* are never logged.

Full detail, including why the boundary is argv matching rather than filtering
command text: [AGENT_MODE.md](AGENT_MODE.md).

---

## 10. Optional — measure quality

```powershell
.\scripts\Invoke-ModelBenchmark.ps1 -RuntimePath $Runtime -ModelPath $Model
```

Seven static checks, including `tool-call-argv-shape`, which measures whether the
model can emit tool arguments correctly. Results are written to
`artifacts\benchmarks\<timestamp>\`.

To measure what speculative decoding is worth on your hardware, run it twice and
compare — each run records its settings, so the two stay comparable:

```powershell
# baseline
.\scripts\Invoke-ModelBenchmark.ps1 -RuntimePath $Runtime -ModelPath $Model -GpuLayers off

# with the drafter
.\scripts\Invoke-ModelBenchmark.ps1 -RuntimePath $Runtime -ModelPath $Model `
  -DraftPath "$env:LOCALAPPDATA\RestrictedLocalCoder\models\dflash-kquant.gguf"
```

The benchmark screens statically and never executes generated code. Real approval
still needs your own tests and review.

---

## 11. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `The string is missing the terminator: "` | Curly quotes from copying rendered text, or a truncated paste | Press `Ctrl+C`, then use the quote-free commands in [Section 2](#2-the-fast-path--one-command) |
| Stuck at a `>>` prompt | PowerShell is waiting for an unclosed quote or brace | Press `Ctrl+C` and retype the line |
| `code is not recognized` | CLI not on PATH | `$env:PATH += ";$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin"`, or use the Extensions UI |
| `cannot find parameter name LO` | `curl` is an alias for `Invoke-WebRequest` | Use the commands in [3.1](#31-download-the-extension) |
| Downloaded file is a few KB | Proxy block page saved as `.vsix` | Change route — see [3.1](#31-download-the-extension) |
| Digest mismatch on the VSIX | Corrupt or intercepted download | Delete it and retry over a different route |
| Preflight: Native runtime FAIL | Wrong-platform VSIX, or a missing dependency | Install the `win32-x64` asset from **v0.3.1 or later**; v0.3.0 shipped without `libomp140.x86_64.dll` and could not start at all |
| Preflight: System libraries FAIL naming `libomp140.x86_64.dll` | Runtime built before v0.3.1 | Install v0.3.1 or later |
| Preflight: System libraries FAIL | MSVC runtime missing | This VSIX bundles it; reinstall and recheck the digest |
| Preflight: Workspace trust FAIL | Folder not trusted | Trust it and reload |
| Preflight: Model file WARN | Not downloaded yet | Expected before step 5 |
| Preflight: Draft model WARN | Optional drafter absent | Harmless; rerun **Download or Repair Model** |
| Preflight: GPU offload WARN | CPU-only Windows runtime | Expected; see the note below |
| `No model source is enabled` | Mirror URL missing or lacks its trailing slash | Recheck [Section 4](#4-settings) |
| Download fails instantly | Mirror unreachable | Run the check in [Section 4](#4-settings) |
| Download stops partway | Network interruption | Rerun — it resumes |
| Hash mismatch after downloading the model | Stale extension, or corrupt copy | Confirm the old extension was removed, then reinstall |
| Inline suggestions never appear | Default profile has no FIM | Expected — see [Section 4](#4-settings) |
| Log says `Draft model … is not installed` | Drafter absent | Harmless; speculative decoding is skipped |
| Runtime exits immediately | Usually memory | Lower `contextSize` to 4096 and `promptCacheMiB` to 0 |

### About GPU offload on Windows

The `win32-x64` package bundles the **CPU-only** llama.cpp build. On Windows the
offload setting is accepted and ignored, so it changes nothing even on a machine
with a large GPU. Preflight detects this and says so rather than reporting a GPU
it cannot use. Treat Windows performance as CPU performance for now.

---

## 12. Reference values

Correct for release `v0.3.1` and the weights currently published. If either is
republished, take the values from the `.sha256` sidecar and the manifest rather
than from here.

| | |
|---|---|
| Release | `v0.3.1` |
| Extension id | `restricted-local.restricted-local-coder` |
| VSIX | `restricted-local-coder-0.3.1-win32-x64.vsix` |
| VSIX size | see the `.sha256` sidecar on the release |
| VSIX SHA-256 | see the `.sha256` sidecar on the release |
| Model | `muse-glimmer-30B-kquant-17gb.gguf` |
| Model size | `16756681056` bytes (15.61 GiB) |
| Model SHA-256 | `7e9b74b7c8875e9e265695df9613bf6290f2392e479ce740495a129019c488d8` |
| Draft model | `dflash-kquant.gguf` (optional) |
| Draft size | `1631205312` bytes (1.52 GiB) |
| Draft SHA-256 | `27d9a805fa29b943cfb6ad4843367cd4eaaaf06bd452d8cc3e00a2cd18a677bc` |
| Mirror | `https://storage.googleapis.com/restricted-local-coder-dazzling-howl-491904/` |
| Models directory | `%LOCALAPPDATA%\RestrictedLocalCoder\models\` |
| Repository | <https://github.com/Arjun10g/restricted-local-coder> |

The Qwen profiles remain selectable in the manifest, but **their weights are not
staged** in this mirror. Choosing one without publishing its weights first will
fail to download.

---

## 13. Starting completely over

```powershell
code --uninstall-extension restricted-local.restricted-local-coder
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\RestrictedLocalCoder" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force C:\coder -ErrorAction SilentlyContinue
```

That removes the extension, the downloaded weights, and the working directory.
Your VS Code settings are left alone — delete the `localCoder.*` entries by hand
if you want those gone too. Then start again at [Section 1](#1-before-you-start).
