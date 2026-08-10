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
Manifest OK: 4 approved profiles; default=qwen3-coder-30b-a3b-iq2m
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

**Windows (PowerShell).** `curl` in PowerShell is an alias for
`Invoke-WebRequest`, which does not understand curl's flags — `curl -LO` fails
with *"cannot find parameter name LO"*. Use the native command instead. Setting
`$ProgressPreference` is not cosmetic: the progress bar makes downloads several
times slower.

```powershell
$ProgressPreference = 'SilentlyContinue'
$base = "https://github.com/<owner>/restricted-local-coder/releases/download/<tag>"
$name = "restricted-local-coder-0.1.0-win32-x64.vsix"

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
curl -LO "$base/restricted-local-coder-0.1.0-linux-x64.vsix"
curl -LO "$base/restricted-local-coder-0.1.0-linux-x64.vsix.sha256"
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
  --out ../artifacts/restricted-local-coder-0.1.0-win32-x64.vsix --no-dependencies
cd ..
```

### Verify before installing

Never install a VSIX whose digest you have not checked. The two values printed
here must be identical.

```powershell
(Get-FileHash .\restricted-local-coder-0.1.0-win32-x64.vsix -Algorithm SHA256).Hash.ToLower()
Get-Content .\restricted-local-coder-0.1.0-win32-x64.vsix.sha256
```

```bash
shasum -a 256 restricted-local-coder-0.1.0-linux-x64.vsix
cat restricted-local-coder-0.1.0-linux-x64.vsix.sha256
```

---

## Step 5 — Install

```bash
code --install-extension ./vsix/restricted-local-coder-0.1.0-win32-x64.vsix
code --list-extensions
```

---

## Step 6 — Configure

Open your project folder and choose **Yes, I trust the authors**. The extension
refuses to start in an untrusted workspace by design.

`Ctrl+Shift+P` → `Preferences: Open User Settings (JSON)`:

```json
{
  "localCoder.modelProfile": "qwen3-coder-30b-a3b-iq2m",
  "localCoder.runtime.contextSize": 8192,
  "localCoder.runtime.promptCacheMiB": 512,
  "localCoder.runtime.autoStart": false,
  "localCoder.inlineCompletions.enabled": false
}
```

Begin at 8K context and with inline completions off. Raise either only after
measuring memory under real use.

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
