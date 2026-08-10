[CmdletBinding()]
param(
    [ValidateSet('win32-x64', 'linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64')]
    [string]$Target = 'win32-x64',
    [string]$OutputDirectory = '',
    [string]$VsceVersion = '3.9.2'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $Root 'artifacts' }
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null

$Package = Get-Content (Join-Path $Root 'extension\package.json') -Raw | ConvertFrom-Json
$RuntimeName = if ($Target -like 'win32-*') { 'llama-server.exe' } else { 'llama-server' }
$Runtime = Join-Path $Root "extension\runtime\$Target\$RuntimeName"
if (-not (Test-Path -LiteralPath $Runtime -PathType Leaf)) {
    throw "Missing runtime $Runtime. Build it before packaging."
}
$Out = Join-Path $OutputDirectory ("restricted-local-coder-{0}-{1}.vsix" -f $Package.version, $Target)
Push-Location (Join-Path $Root 'extension')
try {
    & npx --yes "@vscode/vsce@$VsceVersion" package --target $Target --out $Out --no-dependencies
    if ($LASTEXITCODE -ne 0) { throw 'VSIX packaging failed.' }
}
finally {
    Pop-Location
}
Write-Host "Created $Out" -ForegroundColor Green
