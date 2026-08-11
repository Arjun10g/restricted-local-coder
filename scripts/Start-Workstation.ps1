<#
.SYNOPSIS
    One-shot workstation setup: download, verify, install, and configure.

.DESCRIPTION
    Everything needed to go from an empty Windows machine to a configured
    extension, without typing anything by hand. It downloads the release VSIX,
    verifies it against the published .sha256 sidecar, installs it, and merges
    the recommended settings into the VS Code user settings file.

    It does not download the weights. That is done from inside VS Code with
    "Local Coder: Download or Repair Model", which reports progress, resumes,
    and verifies the digest.

    Existing settings are backed up before anything is written, and if the
    current settings file cannot be parsed the script prints the block to paste
    rather than overwriting work it does not understand.

.EXAMPLE
    .\Start-Workstation.ps1

.EXAMPLE
    .\Start-Workstation.ps1 -Version 0.4.0 -WorkDir C:\coder
#>
[CmdletBinding()]
param(
    # Empty means "whatever the newest release is". A hardcoded default silently
    # rots: this script kept installing 0.3.0 after 0.3.1 shipped, which
    # reinstalled the exact build that could not start. The version is resolved
    # at run time, and FallbackVersion below is only used when the API cannot be
    # reached. check-source.js keeps that fallback equal to the packaged version.
    [string]$Version = '',
    [string]$Repository = 'Arjun10g/restricted-local-coder',
    [string]$WorkDir = 'C:\coder',
    [string]$RuntimeKey = 'win32-x64',
    [string]$MirrorBaseUrl = 'https://storage.googleapis.com/restricted-local-coder-dazzling-howl-491904/',
    [string]$ModelProfile = 'muse-glimmer-30b-kquant',
    [string]$SettingsPath = '',
    [switch]$SkipSettings,
    [switch]$SkipInstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # a visible progress bar makes Invoke-WebRequest far slower

function Write-Step([string]$Text) { Write-Host "`n==> $Text" -ForegroundColor Cyan }

<#
    Run an external program and return its exit code and combined output.

    This exists because $ErrorActionPreference = 'Stop' makes PowerShell treat
    anything a native program writes to stderr as a terminating error --
    surfacing as "NativeCommandError" / RemoteException -- even when the program
    succeeded. The VS Code CLI writes to stderr routinely, so installing would
    abort on a message that was not an error at all.

    Exit codes are the reliable signal from a native tool, so the preference is
    lowered around the call and the code is checked explicitly afterwards.
#>
function Invoke-Native {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @()
    )
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $FilePath @ArgumentList 2>&1 | ForEach-Object { [string]$_ }
        return [pscustomobject]@{
            ExitCode = $LASTEXITCODE
            Output   = ($output -join [Environment]::NewLine)
        }
    } finally {
        $ErrorActionPreference = $previous
    }
}

<#
    True when the JSON text uses VS Code's JSONC extensions - comments or a
    trailing comma.

    This cannot be left to ConvertFrom-Json. PowerShell 7 accepts comments and
    silently discards them, so round-tripping a settings file through it would
    delete a user's notes without a word; Windows PowerShell 5.1 instead throws.
    Detecting it here makes the behaviour identical on both, and the safe answer
    is to leave the file alone.

    Quoted strings are skipped so a URL containing "//" is not mistaken for a
    comment.
#>
function Test-JsonHasComments([string]$Text) {
    $inString = $false
    $escaped = $false
    for ($i = 0; $i -lt $Text.Length; $i++) {
        $ch = $Text[$i]
        if ($inString) {
            if ($escaped) { $escaped = $false; continue }
            if ($ch -eq '\') { $escaped = $true; continue }
            if ($ch -eq '"') { $inString = $false }
            continue
        }
        if ($ch -eq '"') { $inString = $true; continue }
        if ($ch -eq '/' -and $i + 1 -lt $Text.Length) {
            $next = $Text[$i + 1]
            if ($next -eq '/' -or $next -eq '*') { return $true }
        }
        # A trailing comma before a closing brace or bracket is equally invalid
        # in strict JSON and equally something we must not silently rewrite.
        if ($ch -eq ',') {
            for ($j = $i + 1; $j -lt $Text.Length; $j++) {
                $after = $Text[$j]
                if ([char]::IsWhiteSpace($after)) { continue }
                if ($after -eq '}' -or $after -eq ']') { return $true }
                break
            }
        }
    }
    return $false
}
function Write-Good([string]$Text) { Write-Host "    $Text" -ForegroundColor Green }
function Write-Warn([string]$Text) { Write-Host "    $Text" -ForegroundColor Yellow }

# Used only when the release API is unreachable. Kept equal to the packaged
# version by tools/check-source.js.
$FallbackVersion = '0.5.3'

if (-not $Version) {
    try {
        $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repository/releases/latest" -UseBasicParsing -TimeoutSec 20
        $Version = ([string]$release.tag_name).TrimStart('v')
        if (-not $Version) { throw 'the API returned no tag name' }
        Write-Host "Resolved the latest release: v$Version"
    } catch {
        $Version = $FallbackVersion
        Write-Host "Could not reach the release API ($($_.Exception.Message))."
        Write-Host "Falling back to v$Version. Pass -Version to choose another."
    }
}

$VsixName = "restricted-local-coder-$Version-$RuntimeKey.vsix"
$BaseUrl = "https://github.com/$Repository/releases/download/v$Version"
$VsixPath = Join-Path $WorkDir $VsixName

Write-Host "Restricted Local Coder - workstation setup" -ForegroundColor White
Write-Host "  release   : v$Version"
Write-Host "  package   : $VsixName"
Write-Host "  workdir   : $WorkDir"

# ---------------------------------------------------------------- locate code
# The CLI is not on PATH for a default Windows install, which is the single most
# common reason these steps fail with "code is not recognised".
function Resolve-CodeCommand {
    $found = Get-Command code -ErrorAction SilentlyContinue
    if ($found) { return $found.Source }
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\bin\code.cmd'),
        'C:\Program Files\Microsoft VS Code\bin\code.cmd',
        'C:\Program Files (x86)\Microsoft VS Code\bin\code.cmd'
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    return $null
}

$CodeCommand = Resolve-CodeCommand
if (-not $CodeCommand -and -not $SkipInstall) {
    Write-Warn 'The VS Code CLI was not found. The VSIX will still be downloaded and verified.'
    Write-Warn 'Install it afterwards with: Extensions -> ... -> Install from VSIX...'
}

# ------------------------------------------------------------------- download
Write-Step "Downloading $VsixName"
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
Invoke-WebRequest -Uri "$BaseUrl/$VsixName" -OutFile $VsixPath -UseBasicParsing
$Size = (Get-Item -LiteralPath $VsixPath).Length
Write-Good "downloaded $Size bytes"

# A proxy block page saved under a .vsix name is a few kilobytes of HTML, and
# the digest check below would catch it, but this gives a clearer message.
if ($Size -lt 1MB) {
    throw "The download is only $Size bytes. That is a proxy block page, not the extension. See docs/INSTALL_WINDOWS.md for alternate routes."
}

# --------------------------------------------------------------------- verify
Write-Step 'Verifying the published SHA-256'
$Expected = $null
try {
    # GitHub serves .sha256 as application/octet-stream, so PowerShell 7 hands
    # back a byte array rather than a string. Splitting that on whitespace
    # silently yields the first byte value - 51, the character code of "3" -
    # which then fails the comparison against a perfectly good download.
    $SidecarContent = (Invoke-WebRequest -Uri "$BaseUrl/$VsixName.sha256" -UseBasicParsing).Content
    if ($SidecarContent -is [byte[]]) {
        $SidecarContent = [System.Text.Encoding]::UTF8.GetString($SidecarContent)
    }
    $Expected = (([string]$SidecarContent -split '\s+') | Where-Object { $_ })[0]
} catch {
    Write-Warn "Could not fetch the .sha256 sidecar: $($_.Exception.Message)"
}

$Actual = (Get-FileHash -LiteralPath $VsixPath -Algorithm SHA256).Hash.ToLower()
Write-Host "    actual   $Actual"
if ($Expected) {
    Write-Host "    expected $Expected"
    if ($Actual -ne $Expected.ToLower()) {
        throw 'SHA-256 MISMATCH. Do not install this file. Delete it and download again, ideally over a different route.'
    }
    Write-Good 'matches the published digest'
} else {
    Write-Warn 'No sidecar was reachable. Compare the value above against the release page before trusting this file.'
}

# -------------------------------------------------------------------- install
if ($SkipInstall) {
    Write-Step 'Skipping installation as requested'
} elseif ($CodeCommand) {
    Write-Step 'Installing the extension'
    # Remove any earlier build first. Leaving one behind is not fatal, but it
    # makes diagnosing the next problem harder, and an older folder is what a
    # still-running VS Code keeps using.
    $profileRoot = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
    $extensionRoot = if ($profileRoot) { Join-Path $profileRoot '.vscode\extensions' } else { '' }
    if ($extensionRoot -and (Test-Path -LiteralPath $extensionRoot)) {
        $existing = @(Get-ChildItem -LiteralPath $extensionRoot -Directory -Filter 'restricted-local.restricted-local-coder-*')
        foreach ($item in $existing) {
            if ($item.Name -notlike "*-$Version-*") {
                Write-Warn "removing older install $($item.Name)"
            }
        }
        if ($existing.Count -gt 0) {
            # An uninstall of something not present is not a problem worth
            # stopping for, so its exit code is deliberately not checked.
            $null = Invoke-Native -FilePath $CodeCommand -ArgumentList @('--uninstall-extension', 'restricted-local.restricted-local-coder')
        }
    }

    $install = Invoke-Native -FilePath $CodeCommand -ArgumentList @('--install-extension', $VsixPath, '--force')
    if ($install.Output) { Write-Host $install.Output }
    if ($install.ExitCode -ne 0) {
        throw "code --install-extension exited with $($install.ExitCode)"
    }
    Write-Good "installed v$Version"

    # Verify what is actually on disk, rather than trusting the exit code.
    $installed = @()
    if ($extensionRoot -and (Test-Path -LiteralPath $extensionRoot)) {
        $installed = @(Get-ChildItem -LiteralPath $extensionRoot -Directory -Filter 'restricted-local.restricted-local-coder-*' |
                       ForEach-Object { $_.Name })
    }
    foreach ($name in $installed) { Write-Good "on disk: $name" }
    if ($installed.Count -gt 0 -and -not ($installed -like "*-$Version-*")) {
        Write-Warn "v$Version is not on disk despite a successful install. Close VS Code entirely and re-run."
    }
}

# ------------------------------------------------------------------- settings
if (-not $SkipSettings) {
    Write-Step 'Applying the recommended settings'

    if (-not $SettingsPath) {
        $SettingsPath = Join-Path $env:APPDATA 'Code\User\settings.json'
    }

    $Desired = [ordered]@{
        'localCoder.modelProfile'                    = $ModelProfile
        'localCoder.modelMirrorBaseUrl'              = $MirrorBaseUrl
        'localCoder.network.allowPublicModelDownload' = $false
        'localCoder.runtime.contextSize'             = 8192
        'localCoder.runtime.promptCacheMiB'          = 512
        'localCoder.runtime.autoStart'               = $false
        'localCoder.runtime.gpuLayers'               = 'auto'
        'localCoder.runtime.enableDraftModel'        = $true
        'localCoder.inlineCompletions.enabled'       = $false
    }

    $Existing = $null
    $CanMerge = $true
    if (Test-Path -LiteralPath $SettingsPath) {
        $Raw = Get-Content -LiteralPath $SettingsPath -Raw
        if ([string]::IsNullOrWhiteSpace($Raw)) {
            $Existing = [ordered]@{}
        } elseif (Test-JsonHasComments $Raw) {
            # Rewriting would drop the comments, so the file is left untouched.
            $CanMerge = $false
        } else {
            try {
                $Parsed = $Raw | ConvertFrom-Json -ErrorAction Stop
                $Existing = [ordered]@{}
                foreach ($property in $Parsed.PSObject.Properties) {
                    $Existing[$property.Name] = $property.Value
                }
            } catch {
                $CanMerge = $false
            }
        }
    } else {
        $Existing = [ordered]@{}
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $SettingsPath) | Out-Null
    }

    if ($CanMerge) {
        $Backup = ''
        if (Test-Path -LiteralPath $SettingsPath) {
            $Backup = "$SettingsPath.bak-$([DateTime]::Now.ToString('yyyyMMdd-HHmmss'))"
            Copy-Item -LiteralPath $SettingsPath -Destination $Backup -Force
        }
        foreach ($key in $Desired.Keys) { $Existing[$key] = $Desired[$key] }
        ($Existing | ConvertTo-Json -Depth 20) | Set-Content -LiteralPath $SettingsPath -Encoding UTF8
        Write-Good "written to $SettingsPath"
        if ($Backup) { Write-Good "previous settings saved as $(Split-Path -Leaf $Backup)" }
    } else {
        Write-Warn 'Your settings.json contains comments or trailing commas, which this script cannot rewrite safely.'
        Write-Warn 'Nothing was changed. Paste the block below into it by hand:'
        Write-Host ''
        Write-Host (($Desired | ConvertTo-Json -Depth 20))
        Write-Host ''
    }
}

# ----------------------------------------------------------------- next steps
Write-Host ''
Write-Host 'IMPORTANT: quit VS Code completely and reopen it.' -ForegroundColor Yellow
Write-Host 'Installing over a running instance leaves the previous version loaded,'
Write-Host 'so the runtime that starts is the old one.'
Write-Host ''
Write-Host 'Done. In VS Code, open a project folder and trust it, then run:' -ForegroundColor White
Write-Host '  1. Local Coder: Run Preflight'
Write-Host '  2. Local Coder: Download or Repair Model    (about 17.1 GiB, resumable)'
Write-Host '  3. Local Coder: Start Local Runtime'
Write-Host '  4. Local Coder: Open Chat'
Write-Host ''
Write-Host 'Expected warnings on the first preflight, none of which is a blocker:' -ForegroundColor White
Write-Host '  Model file / Draft model  - nothing is downloaded yet'
Write-Host '  GPU offload               - the Windows runtime is a CPU-only build'
