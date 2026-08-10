<#
.SYNOPSIS
    Split an approved GGUF and publish the parts as GitHub release assets.

.DESCRIPTION
    Runs on the governed staging machine that is allowed to reach the model
    source. Splits the verified weight file into parts below the 2 GB release
    asset limit, uploads them to an immutable release tag, and prints the
    manifest block to paste into extension/models/manifest.json.

    The target workstation never runs this script. It only downloads the parts.

.EXAMPLE
    .\scripts\Publish-ModelParts.ps1 `
      -ModelPath .\Qwen3-Coder-30B-A3B-Instruct-1M-UD-IQ2_M.gguf `
      -Repository Arjun10g/restricted-local-coder `
      -Tag model-iq2m-v1
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ModelPath,
    [Parameter(Mandatory = $true)][string]$Repository,
    [Parameter(Mandatory = $true)][string]$Tag,
    [string]$ProfileId = 'qwen3-coder-30b-a3b-iq2m',
    [long]$PartSize = 1900000000,
    [string]$OutputDirectory = '',
    [switch]$SkipUpload
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$ModelPath = (Resolve-Path -LiteralPath $ModelPath).Path
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $Root 'artifacts\model-parts' }

foreach ($tool in @('node', 'gh')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        throw "$tool is required on the staging machine but was not found on PATH."
    }
}

Write-Host "Splitting $(Split-Path -Leaf $ModelPath) for profile $ProfileId" -ForegroundColor Cyan
$BaseUrl = "https://github.com/$Repository/releases/download/$Tag/"
& node (Join-Path $Root 'tools\split-model.js') `
    --input $ModelPath `
    --output $OutputDirectory `
    --profile $ProfileId `
    --part-size $PartSize `
    --base-url $BaseUrl
if ($LASTEXITCODE -ne 0) { throw 'split-model.js failed; nothing was published.' }

$PartFiles = Get-ChildItem -LiteralPath $OutputDirectory -Filter '*.part-*' | Sort-Object Name
if (-not $PartFiles) { throw "No parts were produced in $OutputDirectory." }
foreach ($part in $PartFiles) {
    if ($part.Length -gt 2000000000) {
        throw "$($part.Name) is $($part.Length) bytes, above the 2 GB release asset limit."
    }
}

if ($SkipUpload) {
    Write-Host "SkipUpload was set. $($PartFiles.Count) parts remain in $OutputDirectory." -ForegroundColor Yellow
    exit 0
}

$existing = & gh release view $Tag --repo $Repository 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Creating release $Tag" -ForegroundColor Cyan
    & gh release create $Tag --repo $Repository --title $Tag `
        --notes "Approved model parts for profile $ProfileId. Verify SHA-256 against extension/models/manifest.json before use."
    if ($LASTEXITCODE -ne 0) { throw "Unable to create release $Tag." }
} else {
    Write-Host "Reusing existing release $Tag" -ForegroundColor Yellow
}

foreach ($part in $PartFiles) {
    Write-Host "Uploading $($part.Name) ($($part.Length) bytes)" -ForegroundColor Cyan
    & gh release upload $Tag $part.FullName --repo $Repository --clobber
    if ($LASTEXITCODE -ne 0) { throw "Upload failed for $($part.Name)." }
}

Write-Host "`nPublished $($PartFiles.Count) parts to $BaseUrl" -ForegroundColor Green
Write-Host "Paste this into the `"parts`" field of profile $ProfileId in extension/models/manifest.json:`n" -ForegroundColor Green
Get-Content -LiteralPath (Join-Path $OutputDirectory 'parts.json') -Raw | Write-Host
Write-Host 'Then run: npm run validate' -ForegroundColor Green
