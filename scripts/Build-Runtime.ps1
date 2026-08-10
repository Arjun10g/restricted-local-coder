<#
.SYNOPSIS
    Deprecated. The runtime is no longer compiled here.

.DESCRIPTION
    Official llama.cpp release binaries are repackaged instead, pinned by tag and
    verified against the SHA-256 recorded for every asset in
    vendor/llama.cpp.lock.json. That is both faster and stronger: the binaries
    used to ship unhashed.

        python tools/fetch-runtime.py --key win32-x64 --verify

    Building from source is still supported for governed rebuilds, but the flags
    live in one place now rather than being duplicated here, where they silently
    rotted: this script passed BUILD_SHARED_LIBS=OFF and LLAMA_BUILD_TOOLS=OFF,
    either of which makes the build fail outright.
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest

Write-Warning 'scripts\Build-Runtime.ps1 is deprecated and no longer builds anything.'
Write-Host ''
Write-Host 'Fetch the pinned, verified runtime instead:' -ForegroundColor Cyan
Write-Host '  python tools/fetch-runtime.py --key <runtime-key> --verify'
Write-Host ''
Write-Host 'Runtime keys: win32-x64, win32-x64-cuda, darwin-arm64, linux-x64, linux-arm64.'
Write-Host 'For a governed source rebuild, see docs/ENTERPRISE_DEPLOYMENT.md.'
exit 2
