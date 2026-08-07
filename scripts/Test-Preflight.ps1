[CmdletBinding()]
param(
    [string]$ProfileId = 'qwen3-coder-30b-a3b-iq2m',
    [string]$ModelPath = '',
    [string]$RuntimePath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$ManifestCandidates = @(
    (Join-Path $PSScriptRoot 'manifest.json'),
    (Join-Path $Root 'extension\models\manifest.json')
)
$ManifestPath = $ManifestCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $ManifestPath) { throw 'Could not locate manifest.json beside the script or in the source tree.' }
$Manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
$Model = $Manifest.models | Where-Object { $_.id -eq $ProfileId } | Select-Object -First 1
if (-not $Model) { throw "Unknown profile '$ProfileId'." }
if (-not $ModelPath) { $ModelPath = Join-Path $env:LOCALAPPDATA "RestrictedLocalCoder\models\$($Model.fileName)" }
if (-not $RuntimePath) { $RuntimePath = Join-Path $Root 'extension\runtime\win32-x64\llama-server.exe' }
$Failures = 0

function Result([string]$Status, [string]$Name, [string]$Detail) {
    $Color = if ($Status -eq 'PASS') { 'Green' } elseif ($Status -eq 'WARN') { 'Yellow' } else { 'Red' }
    Write-Host ("[{0}] {1}: {2}" -f $Status, $Name, $Detail) -ForegroundColor $Color
    if ($Status -eq 'FAIL') { $script:Failures++ }
}

try {
    $Memory = (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
    $GiB = [Math]::Round($Memory / 1GB, 1)
    if ($GiB -ge [double]$Model.recommendedRamGiB - 0.5) {
        Result PASS 'RAM' "$GiB GiB detected"
    }
    elseif ($GiB -ge [double]$Model.minimumRamGiB - 0.5) {
        Result WARN 'RAM' "$GiB GiB detected; close heavy applications and keep context small"
    }
    else {
        Result FAIL 'RAM' "$GiB GiB detected; profile minimum is $($Model.minimumRamGiB) GiB"
    }
}
catch {
    Result WARN 'RAM' "Unable to query physical RAM: $($_.Exception.Message)"
}

if (Test-Path -LiteralPath $RuntimePath -PathType Leaf) {
    try {
        $Version = (& $RuntimePath --version 2>&1 | Select-Object -First 2) -join ' · '
        if ($LASTEXITCODE -eq 0) { Result PASS 'Runtime' "$RuntimePath · $Version" }
        else { Result FAIL 'Runtime' "--version exited $LASTEXITCODE" }
    }
    catch { Result FAIL 'Runtime' $_.Exception.Message }
}
else { Result FAIL 'Runtime' "Not found: $RuntimePath" }

if (Test-Path -LiteralPath $ModelPath -PathType Leaf) {
    $File = Get-Item -LiteralPath $ModelPath
    $MagicStream = [IO.File]::OpenRead($ModelPath)
    try {
        $Magic = New-Object byte[] 4
        $null = $MagicStream.Read($Magic, 0, 4)
        $MagicOk = [Text.Encoding]::ASCII.GetString($Magic) -eq 'GGUF'
    }
    finally { $MagicStream.Dispose() }
    if (-not $MagicOk) {
        Result FAIL 'Model' 'File does not have a GGUF header'
    }
    elseif ($null -ne $Model.expectedBytes -and [int64]$Model.expectedBytes -gt 0 -and $File.Length -ne [int64]$Model.expectedBytes) {
        Result FAIL 'Model' 'Exact size mismatch'
    }
    else {
        Write-Host '[INFO] Model: computing mandatory SHA-256; this can take several minutes for a large GGUF.'
        $Hash = (Get-FileHash -LiteralPath $ModelPath -Algorithm SHA256).Hash.ToLowerInvariant()
        $Approved = @($Model.acceptedSha256 | ForEach-Object { ([string]$_).ToLowerInvariant() })
        if ($Approved -contains $Hash) {
            Result PASS 'Model' "Approved SHA-256; $([Math]::Round($File.Length / 1GB, 2)) GiB"
        }
        else {
            Result FAIL 'Model' "Unapproved SHA-256: $Hash"
        }
    }
}
else { Result FAIL 'Model' "Not found: $ModelPath" }

$RootName = [IO.Path]::GetPathRoot($ModelPath)
if ($RootName) {
    $DriveName = $RootName.TrimEnd('\').TrimEnd(':')
    $Drive = Get-PSDrive -Name $DriveName -ErrorAction SilentlyContinue
    if ($Drive) {
        $FreeGiB = [Math]::Round($Drive.Free / 1GB, 1)
        if ($FreeGiB -ge 3) { Result PASS 'Disk' "$FreeGiB GiB free after model placement" }
        else { Result WARN 'Disk' "$FreeGiB GiB free; leave room for logs, page file, and updates" }
    }
}

if ($Failures -gt 0) {
    Write-Host "$Failures blocking preflight failure(s)." -ForegroundColor Red
    exit 1
}
Write-Host 'Preflight completed without blocking failures.' -ForegroundColor Green
