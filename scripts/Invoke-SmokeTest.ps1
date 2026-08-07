[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$RuntimePath,
    [Parameter(Mandatory = $true)][string]$ModelPath,
    [int]$Port = 18081,
    [int]$StartupTimeoutSeconds = 600
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$RuntimePath = (Resolve-Path -LiteralPath $RuntimePath).Path
$ModelPath = (Resolve-Path -LiteralPath $ModelPath).Path
$ApiKey = [Convert]::ToBase64String([byte[]](1..32 | ForEach-Object { Get-Random -Minimum 0 -Maximum 256 }))
$LogDir = Join-Path $env:TEMP ("local-coder-smoke-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

function Quote-Argument([string]$Value) {
    if ($Value -notmatch '[\s"]') { return $Value }
    return '"' + ($Value -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

$Arguments = @(
    '--model', $ModelPath, '--alias', 'local-coder',
    '--host', '127.0.0.1', '--port', [string]$Port,
    '--ctx-size', '2048', '--threads', [string][Math]::Max(2, [Math]::Min(12, [Environment]::ProcessorCount - 1)),
    '--threads-batch', [string][Math]::Max(2, [Math]::Min(12, [Environment]::ProcessorCount - 1)),
    '--batch-size', '256', '--ubatch-size', '64', '--parallel', '1',
    '--cache-ram', '512', '--no-cache-idle-slots',
    '--cache-type-k', 'q8_0', '--cache-type-v', 'q8_0',
    '--load-mode', 'mmap', '--flash-attn', 'auto', '--jinja',
    '--no-webui', '--no-agent', '--offline', '--cors-origins', 'localhost',
    '--no-cors-credentials', '--no-slots', '--log-colors', 'off', '--log-timestamps'
)
$Info = New-Object Diagnostics.ProcessStartInfo
$Info.FileName = $RuntimePath
$Info.Arguments = ($Arguments | ForEach-Object { Quote-Argument ([string]$_) }) -join ' '
$Info.WorkingDirectory = Split-Path -Parent $ModelPath
$Info.UseShellExecute = $false
$Info.CreateNoWindow = $true
$Info.RedirectStandardOutput = $true
$Info.RedirectStandardError = $true
$Info.EnvironmentVariables['LLAMA_API_KEY'] = $ApiKey
$Process = New-Object Diagnostics.Process
$Process.StartInfo = $Info
$null = $Process.Start()
$StdoutTask = $Process.StandardOutput.ReadToEndAsync()
$StderrTask = $Process.StandardError.ReadToEndAsync()

try {
    $Deadline = [DateTime]::UtcNow.AddSeconds($StartupTimeoutSeconds)
    do {
        if ($Process.HasExited) { throw "llama-server exited early with code $($Process.ExitCode)." }
        try {
            $Health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 3
            if ($Health.status -eq 'ok') { break }
        } catch { Start-Sleep -Seconds 1 }
    } while ([DateTime]::UtcNow -lt $Deadline)
    if ([DateTime]::UtcNow -ge $Deadline) { throw 'Timed out waiting for the model to load.' }

    $Headers = @{ Authorization = "Bearer $ApiKey" }
    $Body = @{
        model = 'local-coder'
        stream = $false
        max_tokens = 32
        temperature = 0
        messages = @(@{ role = 'user'; content = 'Reply with exactly: LOCAL_RUNTIME_READY' })
    } | ConvertTo-Json -Depth 8
    $Response = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port/v1/chat/completions" -Headers $Headers -ContentType 'application/json' -Body $Body -TimeoutSec 300
    $Text = ([string]$Response.choices[0].message.content).Trim()
    Write-Host "Model response: $Text" -ForegroundColor Green
    if ($Text -notmatch 'LOCAL_RUNTIME_READY') {
        throw 'The model endpoint responded, but the expected smoke-test marker was not returned.'
    }
    Write-Host 'Loopback server, authentication, chat template, and inference path are operational.' -ForegroundColor Green
}
finally {
    if (-not $Process.HasExited) {
        $Process.Kill()
        $Process.WaitForExit(10000) | Out-Null
    }
    $Stdout = $StdoutTask.GetAwaiter().GetResult()
    $Stderr = $StderrTask.GetAwaiter().GetResult()
    Set-Content -LiteralPath (Join-Path $LogDir 'stdout.log') -Value $Stdout
    Set-Content -LiteralPath (Join-Path $LogDir 'stderr.log') -Value $Stderr
    Write-Host "Runtime logs: $LogDir"
    $Process.Dispose()
}
