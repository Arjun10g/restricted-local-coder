[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$VsixPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Resolved = (Resolve-Path -LiteralPath $VsixPath).Path
if ([IO.Path]::GetExtension($Resolved) -ne '.vsix') { throw 'The input must be a .vsix file.' }

$Code = Get-Command code -ErrorAction SilentlyContinue
if (-not $Code) {
    $Candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\bin\code.cmd'),
        (Join-Path $env:ProgramFiles 'Microsoft VS Code\bin\code.cmd')
    )
    $CodePath = $Candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $CodePath) {
        throw 'VS Code command-line launcher was not found. In VS Code, use Extensions > ... > Install from VSIX instead.'
    }
} else {
    $CodePath = $Code.Source
}

& $CodePath --install-extension $Resolved --force
if ($LASTEXITCODE -ne 0) { throw "VS Code failed to install $Resolved" }
Write-Host 'Restricted Local Coder was installed. Reload VS Code, then run Local Coder: Run Preflight.' -ForegroundColor Green
