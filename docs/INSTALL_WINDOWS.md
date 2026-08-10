# Windows install — copy and paste

Every command here is complete and literal. Nothing to substitute, no variables
carried between blocks, no line continuations. Copy a whole block and run it.

Values used throughout:

| | |
|---|---|
| Repository | `Arjun10g/restricted-local-coder` |
| Release tag | `runtime-preview-0.2.0` |
| Asset | `restricted-local-coder-0.2.0-win32-x64.vsix` |
| Size | `8200334` bytes |
| SHA-256 | `01a2f57a355dd55eeaf54e276ffd2f0c0e60722ee0469db88f050122ba4e3cc6` |

Everything below writes to `C:\coder\coder.vsix`. A short path avoids the
truncated extractions and path-length failures that deep folders under
`Downloads` produce.

---

## Part 1 — Download the VSIX

Try the routes in order. Stop at the first that produces a file of `8200334`
bytes.

Each block is genuinely self-contained: it creates the folder itself, so the
blocks can be run in any order and none depends on an earlier step.
`Invoke-WebRequest` does **not** create a missing destination folder — it fails
with *"could not find a part of the path"* — which is why every block below
begins by creating it.

### Route 1 — one line, no variables

```powershell
New-Item -ItemType Directory -Force -Path C:\coder | Out-Null
Invoke-WebRequest -Uri "https://github.com/Arjun10g/restricted-local-coder/releases/download/runtime-preview-0.2.0/restricted-local-coder-0.2.0-win32-x64.vsix" -OutFile "C:\coder\coder.vsix"
```

### Route 2 — same, but authenticate to the proxy

This is the most common fix on a managed network. `-ProxyUseDefaultCredentials`
passes your Windows logon to the proxy, which is what PowerShell otherwise fails
to do.

```powershell
New-Item -ItemType Directory -Force -Path C:\coder | Out-Null
Invoke-WebRequest -Uri "https://github.com/Arjun10g/restricted-local-coder/releases/download/runtime-preview-0.2.0/restricted-local-coder-0.2.0-win32-x64.vsix" -OutFile "C:\coder\coder.vsix" -ProxyUseDefaultCredentials -UseBasicParsing
```

If your proxy address is not auto-detected, name it explicitly:

```powershell
New-Item -ItemType Directory -Force -Path C:\coder | Out-Null
Invoke-WebRequest -Uri "https://github.com/Arjun10g/restricted-local-coder/releases/download/runtime-preview-0.2.0/restricted-local-coder-0.2.0-win32-x64.vsix" -OutFile "C:\coder\coder.vsix" -Proxy "http://proxy.yourorg.com:8080" -ProxyUseDefaultCredentials -UseBasicParsing
```

### Route 3 — .NET WebClient with default credentials

Uses a different HTTP stack from `Invoke-WebRequest`, and often succeeds where
it fails.

```powershell
New-Item -ItemType Directory -Force -Path C:\coder | Out-Null
$w = New-Object System.Net.WebClient
$w.Proxy = [System.Net.WebRequest]::GetSystemWebProxy()
$w.Proxy.Credentials = [System.Net.CredentialCache]::DefaultCredentials
$w.DownloadFile("https://github.com/Arjun10g/restricted-local-coder/releases/download/runtime-preview-0.2.0/restricted-local-coder-0.2.0-win32-x64.vsix", "C:\coder\coder.vsix")
```

### Route 4 — BITS

BITS is the Windows Update transfer service. It honours WinHTTP proxy settings
and machine policy, so it often works when everything else is blocked.

```powershell
New-Item -ItemType Directory -Force -Path C:\coder | Out-Null
Start-BitsTransfer -Source "https://github.com/Arjun10g/restricted-local-coder/releases/download/runtime-preview-0.2.0/restricted-local-coder-0.2.0-win32-x64.vsix" -Destination "C:\coder\coder.vsix"
```

### Route 5 — real curl

The `.exe` matters. Without it PowerShell resolves `curl` to
`Invoke-WebRequest`, which rejects curl's flags with *"cannot find parameter
name LO"*. Unlike `Invoke-WebRequest`, curl creates no directories either.

```powershell
New-Item -ItemType Directory -Force -Path C:\coder | Out-Null
curl.exe -L --output "C:\coder\coder.vsix" "https://github.com/Arjun10g/restricted-local-coder/releases/download/runtime-preview-0.2.0/restricted-local-coder-0.2.0-win32-x64.vsix"
```

With proxy authentication:

```powershell
New-Item -ItemType Directory -Force -Path C:\coder | Out-Null
curl.exe -L --proxy-ntlm --proxy-user : --output "C:\coder\coder.vsix" "https://github.com/Arjun10g/restricted-local-coder/releases/download/runtime-preview-0.2.0/restricted-local-coder-0.2.0-win32-x64.vsix"
```

### Route 6 — a browser

Browsers already hold the proxy configuration and credentials that PowerShell
lacks, so this frequently works when nothing else does. Open:

```
https://github.com/Arjun10g/restricted-local-coder/releases/tag/runtime-preview-0.2.0
```

Download `restricted-local-coder-0.2.0-win32-x64.vsix`, then move it into place:

```powershell
New-Item -ItemType Directory -Force -Path C:\coder | Out-Null
Move-Item "$env:USERPROFILE\Downloads\restricted-local-coder-0.2.0-win32-x64.vsix" "C:\coder\coder.vsix" -Force
```

### Route 7 — through `codeload.github.com` instead

Release assets are served from `release-assets.githubusercontent.com`, while
repository archives come from `codeload.github.com`. A proxy can permit one and
deny the other. If a repository zip downloads but release assets do not, take
the VSIX from a branch archive so it travels the path that already works:

```powershell
New-Item -ItemType Directory -Force -Path C:\coder | Out-Null
Invoke-WebRequest -Uri "https://github.com/Arjun10g/restricted-local-coder/archive/refs/heads/vsix-drop.zip" -OutFile "C:\coder\vsix-drop.zip" -UseBasicParsing
Expand-Archive -Path "C:\coder\vsix-drop.zip" -DestinationPath "C:\coder\drop" -Force
Copy-Item "C:\coder\drop\restricted-local-coder-vsix-drop\dist\restricted-local-coder-0.2.0-win32-x64.vsix" "C:\coder\coder.vsix" -Force
```

---

## Part 2 — Verify before installing

Never install a VSIX you have not checked. All three must hold.

```powershell
cd C:\coder
(Get-Item .\coder.vsix).Length
Get-Content .\coder.vsix -TotalCount 1
(Get-FileHash .\coder.vsix -Algorithm SHA256).Hash.ToLower()
```

Expected:

| Check | Expected |
|---|---|
| Length | `8200334` |
| First line | **unreadable binary noise beginning with `PK`** |
| SHA-256 | `01a2f57a355dd55eeaf54e276ffd2f0c0e60722ee0469db88f050122ba4e3cc6` |

> Garbled output from `Get-Content` is the **success** case, not a fault. A VSIX
> is a zip archive, so reading it as text necessarily prints binary noise, and
> `PK` is the zip signature. The failure case is the opposite: *readable* text,
> such as `<!DOCTYPE html>` or a proxy notice, means a block page was saved
> under a `.vsix` name.

Or as a single pass/fail:

```powershell
if ((Get-FileHash "C:\coder\coder.vsix" -Algorithm SHA256).Hash.ToLower() -eq "01a2f57a355dd55eeaf54e276ffd2f0c0e60722ee0469db88f050122ba4e3cc6") { "OK - safe to install" } else { "MISMATCH - do not install, download again" }
```

A file of a few kilobytes, or one whose first line is HTML, is a proxy block
page saved under a `.vsix` name. Downloading it again by the same route will
produce the same page; switch routes.

---

## Part 3 — Install

```powershell
code --install-extension "C:\coder\coder.vsix"
```

If `code` is not recognised, either add it to `PATH` for this session:

```powershell
$env:PATH += ";$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin"
code --install-extension "C:\coder\coder.vsix"
```

or install through the UI, which needs no CLI at all: **Extensions** view →
`…` menu (top right) → **Install from VSIX…** → select `C:\coder\coder.vsix`.

Confirm it registered:

```powershell
code --list-extensions | Select-String -Pattern "local"
```

---

## Part 4 — First run

1. Open a project folder in VS Code.
2. Choose **Yes, I trust the authors**. The extension refuses to start in an
   untrusted workspace by design.
3. `Ctrl+Shift+P` → **Local Coder: Run Preflight**.

Preflight needs no model and reports whether the machine is viable: platform,
RAM against the profile thresholds, model directory, free disk, that
`llama-server.exe` launches, that the MSVC runtime libraries resolve, and
workspace trust.

Every row should be PASS except **Model file**, which correctly warns that the
weights are not installed.

**Model download will not work from this build.** No profile declares a source
yet, so **Local Coder: Download or Repair Model** reports that no model source
is enabled. Publishing the weights requires a new VSIX afterwards, because the
manifest is baked in when the VSIX is packaged.

---

## Diagnostics

Run these when a route fails, to tell a blocked host from a bad command.

Is the release CDN reachable at all? Any response, even 400 or 403, means it is
reachable and the command is at fault. A timeout or block page means the host is
denied and no command will help.

```powershell
Invoke-WebRequest -Uri "https://release-assets.githubusercontent.com" -Method Head -UseBasicParsing
```

What proxy does Windows think it should use?

```powershell
netsh winhttp show proxy
[System.Net.WebRequest]::GetSystemWebProxy().GetProxy("https://github.com")
Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings" | Select-Object ProxyEnable, ProxyServer, AutoConfigURL
```

Is TLS being intercepted? An issuer that is not GitHub's own CA means a
corporate inspector is in the path.

```powershell
curl.exe -v "https://github.com" 2>&1 | Select-String -Pattern "issuer|subject|SSL|TLS"
```

Which PowerShell is this?

```powershell
$PSVersionTable.PSVersion
```

Force modern TLS on older Windows PowerShell, then retry a download route:

```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
```

Speed up any `Invoke-WebRequest` — the progress renderer is remarkably costly:

```powershell
$ProgressPreference = 'SilentlyContinue'
```

---

## Error reference

| Message | Cause | Do this |
|---|---|---|
| `Could not find a part of the path 'C:\coder\coder.vsix'` | Destination folder missing, or mistyped — read the path in the message back carefully, `C:\ccoder` is not `C:\coder` | Rerun the whole route block; each one creates the folder first |
| `cannot find parameter name LO` | `curl` is an alias for `Invoke-WebRequest` | Route 1, or Route 5 spelled `curl.exe` |
| `Invoke-WebRequest : Not Found` | Placeholder left in the URL, or a `$` variable set in another window | Route 1 — one line, no variables |
| `(404) Not Found` | Wrong tag or asset name | Copy from the releases page |
| `(407) Proxy Authentication Required` | Proxy wants credentials | Route 2, then Route 3 |
| `(403) Forbidden` from a proxy | Host denied by policy | Route 6, then Route 7 |
| `Could not establish trust relationship for the SSL/TLS secure channel` | TLS inspection | Import the corporate root CA, or Route 6 |
| `The term 'Invoke-WebRequest' is not recognized` | Old or constrained PowerShell | Route 5 or Route 6 |
| `Unable to connect to the remote server` | Host blocked or no route | Run the diagnostics above |
| Downloaded file is a few KB | Proxy block page saved as `.vsix` | Switch routes; do not retry the same one |
| Hash mismatch | Truncated or altered download | Delete it and use another route |
| `'code' is not recognized` | VS Code CLI not on `PATH` | Part 3, `PATH` line or the UI install |
| `is not compatible with VS Code <version>` | VS Code older than 1.95.0 | Update VS Code |
| `Unable to install extension ... platform` | Wrong platform asset | Use the `win32-x64` file |

---

## Notes

Release download URLs redirect to a **signed address that expires roughly an
hour after it is issued**. Always start from the `github.com/…` link. A redirect
URL copied out of a browser's network tools will fail later and look like an
intermittent fault.

The SHA-256 above pins one exact build. When a new VSIX is published — which it
must be, once the model weights are available — that value changes. Take the
digest from the `.sha256` file beside the asset rather than reusing this one.
