[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$RuntimePath,
    [Parameter(Mandatory = $true)][string]$ModelPath,
    [string]$TaskFile = '',
    [string]$OutputDirectory = '',
    [int]$Port = 18082,
    [int]$StartupTimeoutSeconds = 600,
    [int]$ContextSize = 4096,
    [int]$Threads = 0,
    [int]$MaxTokens = 512,
    # Benchmarking with different acceleration settings is the point of these
    # two, since speculative decoding changes throughput but not output.
    [string]$GpuLayers = 'auto',
    [string]$DraftPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$RuntimePath = (Resolve-Path -LiteralPath $RuntimePath).Path
$ModelPath = (Resolve-Path -LiteralPath $ModelPath).Path
if (-not $TaskFile) { $TaskFile = Join-Path $Root 'bench\coding-smoke.json' }
$TaskFile = (Resolve-Path -LiteralPath $TaskFile).Path
if (-not $OutputDirectory) {
    $Stamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')
    $OutputDirectory = Join-Path $Root "artifacts\benchmarks\$Stamp"
}
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$Tasks = @(Get-Content -LiteralPath $TaskFile -Raw | ConvertFrom-Json)
if ($Tasks.Count -eq 0) { throw 'Benchmark task file is empty.' }
if ($Threads -le 0) { $Threads = [Math]::Max(2, [Math]::Min(12, [Environment]::ProcessorCount - 1)) }
$ApiKey = [Convert]::ToBase64String([byte[]](1..32 | ForEach-Object { Get-Random -Minimum 0 -Maximum 256 }))

function Quote-Argument([string]$Value) {
    if ($Value -notmatch '[\s"]') { return $Value }
    return '"' + ($Value -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

function Test-Patterns([string]$Text, [object[]]$Patterns, [bool]$ExpectedMatch) {
    $Details = New-Object 'System.Collections.Generic.List[object]'
    $AllPassed = $true
    foreach ($PatternValue in @($Patterns)) {
        $Pattern = [string]$PatternValue
        $Matched = [regex]::IsMatch($Text, $Pattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase -bor [Text.RegularExpressions.RegexOptions]::Singleline)
        $Passed = if ($ExpectedMatch) { $Matched } else { -not $Matched }
        if (-not $Passed) { $AllPassed = $false }
        $Details.Add([ordered]@{ pattern = $Pattern; matched = $Matched; passed = $Passed })
    }
    return [ordered]@{ passed = $AllPassed; details = @($Details) }
}

$Arguments = @(
    '--model', $ModelPath, '--alias', 'local-coder-benchmark',
    '--host', '127.0.0.1', '--port', [string]$Port,
    '--ctx-size', [string]$ContextSize,
    '--threads', [string]$Threads, '--threads-batch', [string]$Threads,
    '--batch-size', '256', '--ubatch-size', '64', '--parallel', '1',
    '--cache-ram', '0', '--no-cache-idle-slots',
    '--cache-type-k', 'q8_0', '--cache-type-v', 'q8_0',
    '--load-mode', 'mmap', '--flash-attn', 'auto'
)

if ($GpuLayers -ne 'off') {
    $Layers = if ($GpuLayers -eq 'auto') { '-1' } else { [string]([int]$GpuLayers) }
    $Arguments += @('--n-gpu-layers', $Layers)
}

if ($DraftPath) {
    $DraftPath = (Resolve-Path -LiteralPath $DraftPath).Path
    $Arguments += @('--model-draft', $DraftPath, '--spec-draft-n-max', '16')
    if ($GpuLayers -ne 'off') { $Arguments += @('--n-gpu-layers-draft', '-1') }
}

$Arguments += @(
    '--jinja',
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
$Results = New-Object 'System.Collections.Generic.List[object]'

try {
    $Deadline = [DateTime]::UtcNow.AddSeconds($StartupTimeoutSeconds)
    do {
        if ($Process.HasExited) { throw "llama-server exited early with code $($Process.ExitCode)." }
        try {
            $Health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 3
            if ($Health.status -eq 'ok') { break }
        }
        catch { Start-Sleep -Seconds 1 }
    } while ([DateTime]::UtcNow -lt $Deadline)
    if ([DateTime]::UtcNow -ge $Deadline) { throw 'Timed out waiting for the benchmark model to load.' }

    $Headers = @{ Authorization = "Bearer $ApiKey" }
    $Index = 0
    foreach ($Task in $Tasks) {
        $Index++
        Write-Progress -Activity 'Local coding benchmark' -Status "$Index / $($Tasks.Count): $($Task.id)" -PercentComplete ([int](100.0 * ($Index - 1) / $Tasks.Count))
        $Body = [ordered]@{
            model = 'local-coder-benchmark'
            stream = $false
            seed = 42
            temperature = 0
            max_tokens = $MaxTokens
            messages = @(
                @{ role = 'system'; content = 'You are being evaluated on coding correctness. Follow the requested output format exactly.' },
                @{ role = 'user'; content = [string]$Task.prompt }
            )
        } | ConvertTo-Json -Depth 10
        $Stopwatch = [Diagnostics.Stopwatch]::StartNew()
        $Response = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port/v1/chat/completions" -Headers $Headers -ContentType 'application/json' -Body $Body -TimeoutSec 600
        $Stopwatch.Stop()
        $Text = [string]$Response.choices[0].message.content
        $Required = Test-Patterns -Text $Text -Patterns @($Task.mustMatch) -ExpectedMatch $true
        $Forbidden = Test-Patterns -Text $Text -Patterns @($Task.mustNotMatch) -ExpectedMatch $false
        $Passed = [bool]$Required.passed -and [bool]$Forbidden.passed
        $Results.Add([ordered]@{
            id = [string]$Task.id
            language = [string]$Task.language
            category = [string]$Task.category
            passed = $Passed
            latencyMs = $Stopwatch.ElapsedMilliseconds
            promptTokens = $Response.usage.prompt_tokens
            completionTokens = $Response.usage.completion_tokens
            requiredChecks = $Required.details
            forbiddenChecks = $Forbidden.details
            response = $Text
        })
        Write-Host ("[{0}] {1} - {2} ms" -f $(if ($Passed) { 'PASS' } else { 'FAIL' }), $Task.id, $Stopwatch.ElapsedMilliseconds)
    }
    Write-Progress -Activity 'Local coding benchmark' -Completed
}
finally {
    if (-not $Process.HasExited) {
        $Process.Kill()
        $Process.WaitForExit(10000) | Out-Null
    }
    $Stdout = $StdoutTask.GetAwaiter().GetResult()
    $Stderr = $StderrTask.GetAwaiter().GetResult()
    Set-Content -LiteralPath (Join-Path $OutputDirectory 'runtime-stdout.log') -Value $Stdout
    Set-Content -LiteralPath (Join-Path $OutputDirectory 'runtime-stderr.log') -Value $Stderr
    $Process.Dispose()
}

$PassedCount = @($Results | Where-Object { $_.passed }).Count
$Summary = [ordered]@{
    createdUtc = [DateTime]::UtcNow.ToString('o')
    runtimePath = $RuntimePath
    modelPath = $ModelPath
    taskFile = $TaskFile
    contextSize = $ContextSize
    threads = $Threads
    maxTokens = $MaxTokens
    # Latency is only comparable between runs that used the same acceleration,
    # so record it rather than leaving two result sets indistinguishable.
    gpuLayers = $GpuLayers
    draftModel = if ($DraftPath) { $DraftPath } else { $null }
    passed = $PassedCount
    total = $Results.Count
    passRate = if ($Results.Count -gt 0) { [Math]::Round($PassedCount / $Results.Count, 4) } else { 0 }
    note = 'Static regex screening only; generated code was not executed.'
    results = @($Results)
}
$Summary | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'benchmark-results.json') -Encoding UTF8
$Results | Select-Object id, language, category, passed, latencyMs, promptTokens, completionTokens | Export-Csv -LiteralPath (Join-Path $OutputDirectory 'benchmark-summary.csv') -NoTypeInformation -Encoding UTF8
Write-Host "Benchmark result: $PassedCount / $($Results.Count) static checks passed." -ForegroundColor Green
Write-Host "Results: $OutputDirectory"
