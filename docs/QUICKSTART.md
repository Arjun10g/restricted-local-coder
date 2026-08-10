# Quickstart — clone and run on another machine

Getting from nothing to a running chat on a development or evaluation machine.

For the locked-down 32 GB target workstation, follow
[WORKSTATION_SETUP.md](WORKSTATION_SETUP.md) instead — it covers staging the
model, publishing parts, and the governed install.

**No GitHub account is needed for any step except downloading a CI artifact.**
The repository is public, so cloning works with any account signed in, or none.

---

## Step 1 — Prerequisites

| To do this | You need |
|---|---|
| Clone and run the test suite | git, Node.js 20+ |
| Download a prebuilt VSIX | the `gh` CLI, signed in to any GitHub account |
| Build the VSIX yourself | additionally Python 3, CMake, a C++ toolchain |
| Only run the extension | VS Code 1.95.0 or newer |

There is **no `npm install` step anywhere**. The extension ships zero runtime
dependencies, and the checks and tests run on Node's built-in test runner.

Windows, without administrator rights:

```powershell
winget install -e --id Git.Git -s winget
winget install -e --id OpenJS.NodeJS.LTS -s winget
winget install -e --id Microsoft.VisualStudioCode -s winget
winget install -e --id GitHub.cli -s winget
```

macOS:

```bash
brew install git node gh
brew install --cask visual-studio-code
```

Confirm the versions — Node must be 20 or newer:

```bash
git --version
node --version
code --version
```

---

## Step 2 — Clone

```bash
git clone https://github.com/<owner>/restricted-local-coder.git
cd restricted-local-coder
git log --oneline -1
```

If the machine already has an older checkout, update it rather than cloning
again:

```bash
git checkout main
git pull origin main
npm run validate
```

---

## Step 3 — Verify the clone

```bash
npm run validate
```

Expected output ends with:

```
Manifest OK: 6 approved profiles; default=muse-glimmer-30b-kquant
Source policy OK: N JavaScript files checked
# pass N
# fail 0
```

What matters is `# fail 0` and that both `OK` lines appear; the counts grow as
the suite does.

This runs entirely offline and takes under a second. If it passes, the checkout
is good and the manifest, download policy, runtime hardening rules, and parted
assembly logic are all intact.

---

## Step 4 — Obtain a VSIX

Pick one route.

### 4a. Download a release asset (no account)

Release assets download anonymously over plain HTTPS, with no sign-in and no
`gh`. This is the route to prefer behind a proxy that interferes with the git
protocol, because it is an ordinary file download.

Browse the releases page and take the asset matching your platform, together
with its `.sha256` sidecar:

```
https://github.com/<owner>/restricted-local-coder/releases
```

> **Substitute every placeholder before running anything.** `<owner>` and
> `<tag>` are not literal. Pasting them unchanged produces
> `Invoke-WebRequest : The remote server returned an error: (404) Not Found`,
> which looks like a missing file but is a malformed URL. Copy the real values
> from the releases page.

Asset names follow `restricted-local-coder-<version>-<runtime-key>.vsix`, where
the runtime key is one of `win32-x64`, `darwin-arm64`, `linux-x64`, or
`linux-arm64`.

**Windows (PowerShell).** `curl` in PowerShell is an alias for
`Invoke-WebRequest`, which does not understand curl's flags — `curl -LO` fails
with *"cannot find parameter name LO"*. Use the native command instead. Setting
`$ProgressPreference` is not cosmetic: the progress bar makes downloads several
times slower.

```powershell
$ProgressPreference = 'SilentlyContinue'

# Replace the owner and tag with the real ones from the releases page.
$base = "https://github.com/<owner>/restricted-local-coder/releases/download/<tag>"
$name = "restricted-local-coder-0.2.0-win32-x64.vsix"

Invoke-WebRequest -Uri "$base/$name"        -OutFile $name
Invoke-WebRequest -Uri "$base/$name.sha256" -OutFile "$name.sha256"
```

Behind an HTTP proxy, add `-Proxy http://proxy.yourorg.com:8080` to both calls.

Real curl also works on Windows 10 1803 and later, but the `.exe` is required
so the alias is bypassed:

```powershell
curl.exe -L -O "$base/$name"
```

**macOS and Linux:**

```bash
base=https://github.com/<owner>/restricted-local-coder/releases/download/<tag>
curl -LO "$base/restricted-local-coder-0.2.0-linux-x64.vsix"
curl -LO "$base/restricted-local-coder-0.2.0-linux-x64.vsix.sha256"
```

**Confirm you downloaded a VSIX and not an error page.** A proxy that blocks the
request often returns an HTML page with status 200, which saves happily under a
`.vsix` name and then fails to install. A real VSIX is megabytes and is a zip,
so it starts with `PK`:

```powershell
(Get-Item $name).Length          # expect millions of bytes, not a few thousand
Get-Content $name -TotalCount 1  # a VSIX begins with "PK"; a block page shows HTML
```

```bash
ls -l restricted-local-coder-*.vsix
file restricted-local-coder-*.vsix   # expect: Zip archive data
```

### 4b. Download a CI artifact (any signed-in account)

Workflow artifacts require authentication, but any account works on a public
repository. Artifacts expire 30 days after the run.

```bash
gh auth login --hostname github.com --web

# Find the most recent successful build:
gh run list --workflow=build-vsix.yml --status success --limit 1 \
  --repo <owner>/restricted-local-coder

gh run download <run-id> --repo <owner>/restricted-local-coder \
  --name restricted-local-coder-win32-x64 --dir ./vsix
```

Substitute `darwin-arm64`, `linux-x64`, or `linux-arm64` for other platforms.

### 4c. Build it yourself

```bash
python tools/checkout-runtime-source.py --destination third_party/llama.cpp

cmake -S third_party/llama.cpp -B build/llama \
  -DCMAKE_BUILD_TYPE=Release \
  -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF \
  -DLLAMA_BUILD_SERVER=ON -DLLAMA_BUILD_TOOLS=ON \
  -DLLAMA_BUILD_APP=OFF -DLLAMA_BUILD_UI=OFF -DLLAMA_USE_PREBUILT_UI=OFF \
  -DLLAMA_OPENSSL=OFF -DBUILD_SHARED_LIBS=ON \
  -DGGML_NATIVE=OFF -DGGML_BACKEND_DL=ON \
  -DGGML_CPU_ALL_VARIANTS=ON -DGGML_CPU_KLEIDIAI=OFF

cmake --build build/llama --config Release --target llama-server -j 4

python tools/collect-runtime.py --build-dir build/llama \
  --destination extension/runtime/<runtime-key> \
  --source-dir third_party/llama.cpp --verify
```

`BUILD_SHARED_LIBS=ON` and `LLAMA_BUILD_TOOLS=ON` are load-bearing. With shared
libraries off, the pinned llama.cpp rejects `GGML_BACKEND_DL`; with tools off,
the `llama-server` target does not exist at all.

On Windows only, add the MSVC runtime that the VSIX must carry (CI does this
automatically; a local build does not):

```powershell
$crt = Get-ChildItem 'C:\Program Files*\Microsoft Visual Studio\*\*\VC\Redist\MSVC\*\x64\Microsoft.VC*.CRT' `
  -Directory | Sort-Object FullName -Descending | Select-Object -First 1
'msvcp140.dll','vcruntime140.dll','vcruntime140_1.dll' | ForEach-Object {
  Copy-Item (Join-Path $crt.FullName $_) "extension\runtime\win32-x64\$_" -Force
}
```

Package:

```bash
cd extension
npx --yes @vscode/vsce@3.9.2 package --target win32-x64 \
  --out ../artifacts/restricted-local-coder-0.2.0-win32-x64.vsix --no-dependencies
cd ..
```

### Verify before installing

Never install a VSIX whose digest you have not checked. The two values printed
here must be identical.

```powershell
(Get-FileHash .\restricted-local-coder-0.2.0-win32-x64.vsix -Algorithm SHA256).Hash.ToLower()
Get-Content .\restricted-local-coder-0.2.0-win32-x64.vsix.sha256
```

```bash
shasum -a 256 restricted-local-coder-0.2.0-linux-x64.vsix
cat restricted-local-coder-0.2.0-linux-x64.vsix.sha256
```

---

## Step 5 — Install

```bash
code --install-extension ./vsix/restricted-local-coder-0.2.0-win32-x64.vsix
code --list-extensions
```

---

## Step 6 — Configure

Open your project folder and choose **Yes, I trust the authors**. The extension
refuses to start in an untrusted workspace by design.

`Ctrl+Shift+P` → `Preferences: Open User Settings (JSON)`:

```json
{
  "localCoder.modelProfile": "muse-glimmer-30b-kquant",
  "localCoder.runtime.contextSize": 8192,
  "localCoder.runtime.promptCacheMiB": 512,
  "localCoder.runtime.autoStart": false,
  "localCoder.runtime.gpuLayers": "auto",
  "localCoder.runtime.enableDraftModel": true,
  "localCoder.inlineCompletions.enabled": false
}
```

Begin at 8K context and with inline completions off. Raise the context only
after measuring memory under real use, and never above the `n_ctx_train` value
the smoke test reports. The default profile has no fill-in-the-middle tokens, so
inline completion is unavailable for it whatever the setting says.

---

## Step 7 — Run

`Ctrl+Shift+P`, in order:

1. **Local Coder: Run Preflight** — every row should be PASS except *Model file*,
   which correctly warns that the weights are not installed yet.
2. **Local Coder: Download or Repair Model**
3. **Local Coder: Run Preflight** — *Model file* is now PASS.
4. **Local Coder: Start Local Runtime**
5. **Local Coder: Open Chat**

The model is stored per-user:

| Platform | Location |
|---|---|
| Windows | `%LOCALAPPDATA%\RestrictedLocalCoder\models\` |
| macOS | `~/Library/Application Support/RestrictedLocalCoder/models/` |
| Linux | `$XDG_DATA_HOME/restricted-local-coder/models/` |

Logs are under **Local Coder: Show Logs**.

---

## Step 7 fails until the model is published

Acquisition needs a source the machine can actually reach. Until a profile in
`extension/models/manifest.json` declares either a `parts` block or a reachable
mirror, step 7.2 reports that no model source is enabled.

Resolve it with one of the delivery paths in
[ENTERPRISE_DEPLOYMENT.md](ENTERPRISE_DEPLOYMENT.md) — an internal mirror, an
offline import, direct ModelScope, or split GitHub release parts.

The manifest is baked into the VSIX when it is packaged, so **publish the model
first, commit the manifest change, and only then build the VSIX.** A VSIX built
beforehand has no knowledge of the source.

---

## Troubleshooting the first few steps

Most first-run failures are environmental rather than defects in the build.

| Message | Cause | Fix |
|---|---|---|
| `cannot find parameter name LO` | PowerShell aliases `curl` to `Invoke-WebRequest` | Use `Invoke-WebRequest -OutFile`, or spell it `curl.exe` |
| `Invoke-WebRequest : ... (404) Not Found` | `<owner>` or `<tag>` pasted literally, or a wrong asset name | Copy the real URL from the releases page |
| `... (407) Proxy Authentication Required` | Proxy needs credentials | Add `-Proxy` and `-ProxyCredential (Get-Credential)` |
| `Could not establish trust relationship for the SSL/TLS secure channel` | TLS inspection with a private CA | Import the corporate root CA, or download through a browser |
| `The term 'Invoke-WebRequest' is not recognized` | Very old or constrained PowerShell | Use `curl.exe`, or a browser |
| Downloaded `.vsix` is a few KB | Proxy returned an HTML block page with status 200 | Check the size and `PK` header; fetch through a browser |
| `Get-FileHash` output differs from the sidecar | Truncated or tampered download | Delete and download again; never install on a mismatch |
| `'code' is not recognized` | VS Code CLI not on `PATH` | Install from the VSIX UI, or add VS Code's `bin` to `PATH` |
| `is not compatible with VS Code <version>` | VS Code older than 1.95.0 | Update VS Code |
| `Unable to install extension ... platform` | Wrong runtime key for the machine | Download the asset matching the OS and CPU |
| `Invoke-WebRequest : Not Found` when `$base` was set in another window | PowerShell variables do not survive a new terminal | Paste the whole URL on one line |
| Release asset download fails but the repository zip works | The two use different hosts | See below |
| `ENOENT ... package.json` (`errno -4058`) | Wrong working directory | See below |
| `The requested URL returned error: 400` on clone | Proxy or TLS inspector | See below |

### Release downloads fail while the repository zip works

They are not served by the same host, so a proxy can permit one and block the
other:

| Download | Redirects to |
|---|---|
| `…/archive/refs/heads/main.zip` | `codeload.github.com` |
| `…/releases/download/<tag>/<asset>` | `release-assets.githubusercontent.com` |

Determine which problem you have before changing commands. Any HTTP response,
even 400 or 403, means the host is reachable and the command is at fault. A
timeout, a refused connection, or a block page means the host itself is denied
and no command will fix it:

```powershell
Invoke-WebRequest -Uri "https://release-assets.githubusercontent.com" -Method Head
```

If the command is at fault, remove every moving part and put the whole URL on a
single line. Shell variables are a common culprit, because `$base` set in one
window does not exist in another, and the request then goes to a truncated URL
that returns 404:

```powershell
Invoke-WebRequest -Uri "https://github.com/<owner>/restricted-local-coder/releases/download/<tag>/<asset>.vsix" -OutFile "coder.vsix"
```

If the host is denied, a browser is the next thing to try, since it uses the
system proxy configuration and any stored credentials that PowerShell lacks.
Open the releases page and click the asset.

Failing that, ask for the file through whatever channel already works. Anything
reachable serves: an internal artifact repository, a file share, or a branch of
this repository containing the VSIX, which arrives over `codeload.github.com`
like the zip does. Verify the SHA-256 afterwards regardless of route.

> Release asset URLs redirect to a **signed, time-limited** address that expires
> about an hour after it is issued. Always start from the `github.com/…` link
> rather than reusing a redirect URL copied from a browser's network tools.

### VS Code CLI not on `PATH`

Installing from the command line is optional. In VS Code: **Extensions** view →
`…` menu → **Install from VSIX…** → pick the file. Or add the CLI to `PATH`:

```powershell
$env:PATH += ";$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin"
```

To make it permanent, run **Shell Command: Install 'code' command in PATH**
from the Command Palette.

### `git clone` fails with `The requested URL returned error: 400`

The repository is public, so a 400 comes from something between the machine and
GitHub — usually a proxy or TLS inspector, not the repository. Diagnose first:

```bash
GIT_TRACE=1 GIT_CURL_VERBOSE=1 git clone https://github.com/<owner>/restricted-local-coder.git
env | grep -i proxy
git config --global --get-regexp '^http\.'
```

Then try, in this order:

```bash
git config --global http.version HTTP/1.1     # fixes most proxy-induced 400s
git config --global protocol.version 0        # some proxies reject git protocol v2
git config --global http.proxy http://proxy.yourorg.com:8080
```

If the git protocol is blocked outright, download the tree as a zip instead. It
is one ordinary HTTPS GET and usually survives proxies that break git. You lose
history, which does not matter for building, testing, or installing:

```bash
curl -L -o main.zip https://github.com/<owner>/restricted-local-coder/archive/refs/heads/main.zip
unzip main.zip && cd restricted-local-coder-main && npm run validate
```

On Windows, prefer `Expand-Archive` over Explorer's *Extract All*, and keep the
destination path short — deep paths under `Downloads` can silently truncate an
extraction:

```powershell
Expand-Archive -Path .\main.zip -DestinationPath C:\coder -Force
cd C:\coder\restricted-local-coder-main
```

### `npm run validate` fails with `ENOENT ... package.json` (errno -4058)

You are in the wrong directory; nothing is broken. Extracting a zip through
Windows Explorer usually nests the project one level deeper than expected.

```powershell
Get-ChildItem -Recurse -Depth 3 -Filter package.json | Select-Object FullName
```

Two files match. Use the **shorter** path — only the repository root has the
`validate` script; `extension/package.json` is the extension manifest. Confirm
you are in the right place before rerunning:

```powershell
node -p "require('./package.json').name"     # must print restricted-local-coder-repo
```

The repository root contains exactly:

```
CONTRIBUTING.md  LICENSE  README.md  SECURITY.md  THIRD_PARTY_NOTICES.md
bench  docs  extension  package.json  scripts  tools  vendor
```

## Contributing from a different GitHub account

You cannot push to a repository you do not own. Fork it:

```bash
gh repo fork <owner>/restricted-local-coder --clone=false --remote=false
git remote add mine https://github.com/<your-username>/restricted-local-coder.git
git push mine <branch>
```

If a machine has several GitHub accounts cached and pushes fail with `403`,
point git at the `gh` credential helper for that repository only, leaving your
global configuration untouched:

```bash
git config --local credential.https://github.com.helper ""
git config --local --add credential.https://github.com.helper "!gh auth git-credential"
```

Run `npm run validate` before every push. CI runs the same command.
