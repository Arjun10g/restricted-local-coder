[CmdletBinding()]
param(
    [ValidateSet('Release', 'RelWithDebInfo')]
    [string]$Configuration = 'Release',
    [switch]$Clean
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$SourceDir = Join-Path $Root 'third_party\llama.cpp'
$BuildDir = Join-Path $Root 'build\llama'

if (-not [Environment]::Is64BitOperatingSystem) {
    throw 'A 64-bit operating system is required.'
}
if ($env:PROCESSOR_ARCHITECTURE -notmatch 'AMD64|x86_64') {
    throw "This script currently packages win32-x64; detected $env:PROCESSOR_ARCHITECTURE."
}
if ($Clean) {
    Remove-Item -LiteralPath $SourceDir, $BuildDir -Recurse -Force -ErrorAction SilentlyContinue
}

& python (Join-Path $Root 'tools\checkout-runtime-source.py') --destination 'third_party/llama.cpp'
if ($LASTEXITCODE -ne 0) { throw 'Failed to checkout the pinned llama.cpp source.' }

$ConfigureArgs = @(
    '-S', $SourceDir,
    '-B', $BuildDir,
    "-DCMAKE_BUILD_TYPE=$Configuration",
    '-DLLAMA_BUILD_TESTS=OFF',
    '-DLLAMA_BUILD_EXAMPLES=OFF',
    '-DLLAMA_BUILD_SERVER=ON',
    '-DLLAMA_BUILD_TOOLS=OFF',
    '-DLLAMA_BUILD_APP=OFF',
    '-DLLAMA_BUILD_UI=OFF',
    '-DLLAMA_USE_PREBUILT_UI=OFF',
    '-DLLAMA_OPENSSL=OFF',
    '-DBUILD_SHARED_LIBS=OFF',
    '-DGGML_NATIVE=OFF',
    '-DGGML_BACKEND_DL=ON',
    '-DGGML_CPU_ALL_VARIANTS=ON',
    '-DGGML_CPU_KLEIDIAI=OFF'
)
& cmake @ConfigureArgs
if ($LASTEXITCODE -ne 0) { throw 'CMake configuration failed.' }

$Jobs = [Math]::Max(2, [Environment]::ProcessorCount)
& cmake --build $BuildDir --config $Configuration --target llama-server -j $Jobs
if ($LASTEXITCODE -ne 0) { throw 'llama-server build failed.' }

& python (Join-Path $Root 'tools\collect-runtime.py') `
    --build-dir $BuildDir `
    --destination (Join-Path $Root 'extension\runtime\win32-x64') `
    --source-dir $SourceDir `
    --verify
if ($LASTEXITCODE -ne 0) { throw 'Runtime collection or verification failed.' }

Write-Host 'Runtime ready in extension\runtime\win32-x64' -ForegroundColor Green
