[CmdletBinding()]
param(
    [string]$ProfileId = 'qwen3-coder-30b-a3b-iq2m',
    [string]$DestinationDirectory = '',
    [string]$MirrorBaseUrl = '',
    [switch]$DisablePublicModelScope,
    [switch]$AcceptLicense
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Manifest = Get-Content (Join-Path $Root 'extension\models\manifest.json') -Raw | ConvertFrom-Json
$Model = $Manifest.models | Where-Object { $_.id -eq $ProfileId } | Select-Object -First 1
if (-not $Model) { throw "Unknown profile '$ProfileId'." }
if (-not $AcceptLicense) {
    throw "The model is licensed under $($Model.license). Re-run with -AcceptLicense after organizational approval."
}
if (-not $DestinationDirectory) {
    $DestinationDirectory = Join-Path $env:LOCALAPPDATA 'RestrictedLocalCoder\models'
}
New-Item -ItemType Directory -Path $DestinationDirectory -Force | Out-Null
$Destination = Join-Path $DestinationDirectory $Model.fileName
$Part = "$Destination.part"

function Assert-AllowedUri([Uri]$Uri) {
    if ($Uri.Scheme -notin @('http', 'https')) {
        throw "Unsupported URI scheme: $($Uri.Scheme)"
    }
    if ($Uri.Scheme -eq 'http' -and -not $Uri.IsLoopback) {
        throw 'Model downloads require HTTPS except for a loopback development server.'
    }
    $HostName = $Uri.DnsSafeHost.ToLowerInvariant().TrimEnd('.')
    foreach ($Blocked in $Manifest.prohibitedHosts) {
        $BlockedName = ([string]$Blocked).ToLowerInvariant().TrimEnd('.')
        if ($HostName -eq $BlockedName -or $HostName.EndsWith(".$BlockedName")) {
            throw "Blocked model host: $HostName"
        }
    }
}

function Test-ApprovedModel([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    $File = Get-Item -LiteralPath $Path
    if ($null -ne $Model.expectedBytes -and [int64]$Model.expectedBytes -gt 0 -and $File.Length -ne [int64]$Model.expectedBytes) {
        return $false
    }
    $Stream = [IO.File]::OpenRead($Path)
    try {
        $Magic = New-Object byte[] 4
        if ($Stream.Read($Magic, 0, 4) -ne 4) { return $false }
        if ([Text.Encoding]::ASCII.GetString($Magic) -ne 'GGUF') { return $false }
    }
    finally {
        $Stream.Dispose()
    }
    Write-Host "Verifying SHA-256 for $([IO.Path]::GetFileName($Path))..."
    $Hash = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    $Approved = @($Model.acceptedSha256 | ForEach-Object { ([string]$_).ToLowerInvariant() })
    return $Approved -contains $Hash
}

if (Test-ApprovedModel -Path $Destination) {
    Write-Host "Approved model is already present: $Destination" -ForegroundColor Green
    exit 0
}
if (Test-Path -LiteralPath $Destination -PathType Leaf) {
    $Quarantine = "$Destination.invalid-$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
    Move-Item -LiteralPath $Destination -Destination $Quarantine -Force
    Write-Warning "Existing unapproved model was quarantined as $Quarantine"
}

$Urls = New-Object 'System.Collections.Generic.List[string]'
if ($MirrorBaseUrl) {
    $Base = [Uri]$MirrorBaseUrl
    if (-not $MirrorBaseUrl.EndsWith('/')) { $Base = [Uri]("$MirrorBaseUrl/") }
    $Urls.Add(([Uri]::new($Base, [Uri]::EscapeDataString([string]$Model.fileName))).AbsoluteUri)
}
if (-not $DisablePublicModelScope) {
    foreach ($Url in $Model.downloadUrls) { $Urls.Add([string]$Url) }
}
if ($Urls.Count -eq 0) {
    throw 'No model URL is enabled. Supply -MirrorBaseUrl or allow the approved ModelScope source.'
}

Add-Type -AssemblyName System.Net.Http
$Failures = New-Object 'System.Collections.Generic.List[string]'
foreach ($RawUrl in $Urls) {
    $Uri = [Uri]$RawUrl
    Assert-AllowedUri $Uri
    $Handler = New-Object System.Net.Http.HttpClientHandler
    # Redirects are followed manually so every hop is checked against the HTTPS and host policy.
    $Handler.AllowAutoRedirect = $false
    $Client = New-Object System.Net.Http.HttpClient($Handler)
    $Client.Timeout = [TimeSpan]::FromHours(12)
    $Request = $null
    $Response = $null
    try {
        $Existing = if (Test-Path -LiteralPath $Part) { (Get-Item -LiteralPath $Part).Length } else { 0L }
        $CurrentUri = $Uri
        $RedirectCount = 0
        while ($true) {
            Assert-AllowedUri $CurrentUri
            $Request = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Get, $CurrentUri)
            if ($Existing -gt 0) {
                $Request.Headers.Range = New-Object System.Net.Http.Headers.RangeHeaderValue($Existing, $null)
            }
            Write-Host "Downloading from $($CurrentUri.GetLeftPart([UriPartial]::Path))"
            $Response = $Client.SendAsync($Request, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
            $Code = [int]$Response.StatusCode
            if ($Code -notin @(301, 302, 303, 307, 308)) { break }

            $Location = $Response.Headers.Location
            if ($null -eq $Location) { throw "HTTP $Code redirect did not include a Location header." }
            if ($RedirectCount -ge 10) { throw 'Too many model-download redirects.' }
            $NextUri = if ($Location.IsAbsoluteUri) { $Location } else { [Uri]::new($CurrentUri, [string]$Location) }
            Assert-AllowedUri $NextUri
            $Response.Dispose()
            $Response = $null
            $Request.Dispose()
            $Request = $null
            $CurrentUri = $NextUri
            $RedirectCount++
        }
        $FinalUri = $CurrentUri
        Assert-AllowedUri $FinalUri
        if ($Code -eq 416 -and $Existing -gt 0) {
            Write-Host 'Server reports the partial file is already complete; validating it.'
        }
        elseif ($Code -notin @(200, 206)) {
            throw "HTTP $Code ($($Response.ReasonPhrase))"
        }
        else {
            $Append = ($Code -eq 206 -and $Existing -gt 0)
            if ($Append) {
                $Range = $Response.Content.Headers.ContentRange
                if ($null -eq $Range -or $null -eq $Range.From -or [int64]$Range.From -ne $Existing) {
                    throw "Invalid Content-Range while resuming at byte $Existing."
                }
            }
            else {
                $Existing = 0L
            }
            $Mode = if ($Append) { [IO.FileMode]::Append } else { [IO.FileMode]::Create }
            $Output = New-Object IO.FileStream($Part, $Mode, [IO.FileAccess]::Write, [IO.FileShare]::None, 1048576, [IO.FileOptions]::SequentialScan)
            $Input = $Response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
            try {
                $Buffer = New-Object byte[] 1048576
                $Received = $Existing
                $Length = $Response.Content.Headers.ContentLength
                $Total = if ($null -ne $Length) { $Existing + [int64]$Length } else { 0L }
                while (($Read = $Input.Read($Buffer, 0, $Buffer.Length)) -gt 0) {
                    $Output.Write($Buffer, 0, $Read)
                    $Received += $Read
                    if ($Total -gt 0) {
                        $Percent = [Math]::Min(99, [int](100.0 * $Received / $Total))
                        Write-Progress -Activity "Downloading $($Model.shortName)" -Status ("{0:N2} / {1:N2} GiB" -f ($Received / 1GB), ($Total / 1GB)) -PercentComplete $Percent
                    }
                    else {
                        Write-Progress -Activity "Downloading $($Model.shortName)" -Status ("{0:N2} GiB" -f ($Received / 1GB))
                    }
                }
            }
            finally {
                $Input.Dispose()
                $Output.Dispose()
                Write-Progress -Activity "Downloading $($Model.shortName)" -Completed
            }
        }

        if (-not (Test-ApprovedModel -Path $Part)) {
            $Quarantine = "$Part.invalid-$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
            Move-Item -LiteralPath $Part -Destination $Quarantine -Force
            throw "GGUF header, size, or SHA-256 validation failed. Quarantined as $Quarantine"
        }
        Remove-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue
        Move-Item -LiteralPath $Part -Destination $Destination
        Write-Host "Verified model ready: $Destination" -ForegroundColor Green
        exit 0
    }
    catch {
        $Failures.Add("$RawUrl -> $($_.Exception.Message)")
        Write-Warning $Failures[$Failures.Count - 1]
    }
    finally {
        if ($null -ne $Response) { $Response.Dispose() }
        if ($null -ne $Request) { $Request.Dispose() }
        $Client.Dispose()
        $Handler.Dispose()
    }
}
throw "Every approved source failed:`n$($Failures -join "`n")"
