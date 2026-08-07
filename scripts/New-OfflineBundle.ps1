[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$VsixPath,
    [Parameter(Mandatory = $true)][string]$ModelPath,
    [string]$ProfileId = 'qwen3-coder-30b-a3b-iq2m',
    [string]$OutputDirectory = '',
    [switch]$CreateZip
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$VsixPath = (Resolve-Path -LiteralPath $VsixPath).Path
$ModelPath = (Resolve-Path -LiteralPath $ModelPath).Path
$Manifest = Get-Content (Join-Path $Root 'extension\models\manifest.json') -Raw | ConvertFrom-Json
$Model = $Manifest.models | Where-Object { $_.id -eq $ProfileId } | Select-Object -First 1
if (-not $Model) { throw "Unknown profile '$ProfileId'." }
if ((Split-Path -Leaf $ModelPath) -ne $Model.fileName) { Write-Warning "Model filename differs from manifest; it will be renamed to $($Model.fileName) in the bundle." }
$ModelHash = (Get-FileHash -LiteralPath $ModelPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($Model.acceptedSha256 -notcontains $ModelHash) { throw "Model SHA-256 is not approved: $ModelHash" }

if (-not $OutputDirectory) { $OutputDirectory = Join-Path $Root 'artifacts\offline-bundle' }
Remove-Item -LiteralPath $OutputDirectory -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$VsixTarget = Join-Path $OutputDirectory (Split-Path -Leaf $VsixPath)
$ModelTarget = Join-Path $OutputDirectory $Model.fileName
Copy-Item -LiteralPath $VsixPath -Destination $VsixTarget
Copy-Item -LiteralPath $ModelPath -Destination $ModelTarget
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Install-Vsix.ps1') -Destination $OutputDirectory
Copy-Item -LiteralPath (Join-Path $Root 'extension\models\manifest.json') -Destination $OutputDirectory

$BundleManifest = [ordered]@{
    createdUtc = [DateTime]::UtcNow.ToString('o')
    profileId = $Model.id
    modelFile = $Model.fileName
    modelSha256 = $ModelHash
    modelLicense = $Model.license
    vsixFile = (Split-Path -Leaf $VsixTarget)
    vsixSha256 = (Get-FileHash -LiteralPath $VsixTarget -Algorithm SHA256).Hash.ToLowerInvariant()
}
$BundleManifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'bundle-manifest.json') -Encoding UTF8
@"
1. Review bundle-manifest.json and the Apache-2.0 model license approval.
2. Run: powershell -ExecutionPolicy Bypass -File .\Install-Vsix.ps1 -VsixPath .\$((Split-Path -Leaf $VsixTarget))
3. In VS Code choose the manifest profile and run: Local Coder: Import Existing GGUF Model. Select .\$($Model.fileName).
4. Run: Local Coder: Run Preflight, then Local Coder: Start Local Runtime.
5. The extension rechecks the model SHA-256 before first load.
"@ | Set-Content -LiteralPath (Join-Path $OutputDirectory 'INSTALL.txt') -Encoding UTF8

Write-Host "Offline staging directory created: $OutputDirectory" -ForegroundColor Green
if ($CreateZip) {
    $Tar = Get-Command tar.exe -ErrorAction SilentlyContinue
    if (-not $Tar) { throw 'tar.exe is required for a Zip64-capable archive of the multi-gigabyte model.' }
    $ZipPath = "$OutputDirectory.zip"
    Remove-Item -LiteralPath $ZipPath -Force -ErrorAction SilentlyContinue
    Push-Location (Split-Path -Parent $OutputDirectory)
    try { & $Tar.Source -a -c -f $ZipPath (Split-Path -Leaf $OutputDirectory) }
    finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw 'Offline ZIP creation failed.' }
    Write-Host "Created $ZipPath" -ForegroundColor Green
}
