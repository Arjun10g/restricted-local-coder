<#
.SYNOPSIS
    Collect everything needed to diagnose a runtime failure, in one pass.

.DESCRIPTION
    Preflight reports that the native runtime failed, but not why. This runs the
    server directly, captures the real loader error and its exit code, and checks
    the things that commonly block execution on a managed workstation: missing
    libraries, Mark of the Web, and application allow-listing policy.

    It reads only. Nothing is installed, changed, or uploaded. The report is
    printed and also written to a file so it can be pasted somewhere.

.EXAMPLE
    .\Get-Diagnostics.ps1
#>
[CmdletBinding()]
param(
    [string]$ReportPath = "$env:TEMP\localcoder-diagnostics.txt"
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$Lines = New-Object 'System.Collections.Generic.List[string]'
function Add-Line([string]$Text = '') {
    $Lines.Add($Text)
    Write-Host $Text
}
function Add-Section([string]$Title) {
    Add-Line ''
    Add-Line ('=' * 70)
    Add-Line $Title
    Add-Line ('=' * 70)
}

Add-Line 'Restricted Local Coder - diagnostics'
Add-Line ("collected: " + (Get-Date).ToString('u'))

# ------------------------------------------------------------------- machine
Add-Section '1. Machine'
try {
    $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
    Add-Line ("windows       : {0} (build {1})" -f $os.Caption, $os.BuildNumber)
    Add-Line ("memory        : {0:N1} GiB" -f ($os.TotalVisibleMemorySize / 1MB))
} catch {
    Add-Line "windows       : could not query ($($_.Exception.Message))"
}
Add-Line ("powershell    : {0}" -f $PSVersionTable.PSVersion)
Add-Line ("architecture  : {0}" -f $env:PROCESSOR_ARCHITECTURE)

# ----------------------------------------------------------------- extension
Add-Section '2. Installed extension'
$Home2 = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
$ExtensionRoot = if ($Home2) { Join-Path $Home2 '.vscode\extensions' } else { '' }
$Installed = @()
if ($ExtensionRoot -and (Test-Path -LiteralPath $ExtensionRoot)) {
    $Installed = @(Get-ChildItem -LiteralPath $ExtensionRoot -Directory -Filter 'restricted-local.restricted-local-coder-*' |
                   Sort-Object Name)
}
if ($Installed.Count -eq 0) {
    Add-Line 'No installed copy found under .vscode\extensions.'
} else {
    foreach ($item in $Installed) { Add-Line ("found         : " + $item.Name) }
    if ($Installed.Count -gt 1) {
        Add-Line 'NOTE: more than one version is present. VS Code runs the highest;'
        Add-Line '      an older folder left behind is harmless but confusing.'
    }
}

$Selected = $Installed | Sort-Object Name -Descending | Select-Object -First 1
if (-not $Selected) {
    Add-Line ''
    Add-Line 'Cannot continue without an installed extension.'
    Set-Content -LiteralPath $ReportPath -Value $Lines -Encoding UTF8
    Add-Line ("report written to " + $ReportPath)
    return
}

$RuntimeDir = Join-Path $Selected.FullName 'runtime\win32-x64'
$Server = Join-Path $RuntimeDir 'llama-server.exe'
Add-Line ("using         : " + $Selected.Name)
Add-Line ("runtime dir   : " + $RuntimeDir)

# ------------------------------------------------------------------ contents
Add-Section '3. Runtime directory contents'
if (-not (Test-Path -LiteralPath $RuntimeDir)) {
    Add-Line 'The runtime directory does not exist. The wrong platform VSIX is installed.'
} else {
    foreach ($file in Get-ChildItem -LiteralPath $RuntimeDir | Sort-Object Name) {
        Add-Line ("  {0,-32} {1,12:N0}" -f $file.Name, $file.Length)
    }
}

Add-Section '4. Required libraries'
$Required = @('llama-server.exe', 'ggml.dll', 'ggml-base.dll',
              'msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll',
              'libomp140.x86_64.dll')
foreach ($name in $Required) {
    $beside = Test-Path -LiteralPath (Join-Path $RuntimeDir $name)
    $system = Test-Path -LiteralPath (Join-Path $env:SystemRoot "System32\$name")
    $where = if ($beside) { 'bundled' } elseif ($system) { 'System32' } else { 'MISSING' }
    Add-Line ("  {0,-32} {1}" -f $name, $where)
}

# --------------------------------------------------------- mark of the web
Add-Section '5. Mark of the Web'
# A file extracted from a downloaded archive can carry a zone identifier, and
# some policies refuse to execute anything that does.
$Blocked = @()
if (Test-Path -LiteralPath $RuntimeDir) {
    foreach ($file in Get-ChildItem -LiteralPath $RuntimeDir -Include *.exe, *.dll -Recurse) {
        try {
            $zone = Get-Content -LiteralPath $file.FullName -Stream Zone.Identifier -ErrorAction Stop
            if ($zone) { $Blocked += $file.Name }
        } catch {
            # No zone stream is the normal, healthy case.
        }
    }
}
if ($Blocked.Count -eq 0) {
    Add-Line 'No files carry a zone identifier.'
} else {
    Add-Line ('Files marked as downloaded from the internet: ' + ($Blocked -join ', '))
    Add-Line 'Fix with:  Get-ChildItem -Recurse <runtime dir> | Unblock-File'
}

# --------------------------------------------------------------- run it
Add-Section '6. Running llama-server.exe --version'
if (-not (Test-Path -LiteralPath $Server)) {
    Add-Line 'llama-server.exe is not present, so there is nothing to run.'
} else {
    try {
        $psi = New-Object Diagnostics.ProcessStartInfo
        $psi.FileName = $Server
        $psi.Arguments = '--version'
        $psi.UseShellExecute = $false
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.WorkingDirectory = $RuntimeDir
        $process = [Diagnostics.Process]::Start($psi)
        $stdout = $process.StandardOutput.ReadToEnd()
        $stderr = $process.StandardError.ReadToEnd()
        $exited = $process.WaitForExit(60000)
        if (-not $exited) {
            Add-Line 'TIMED OUT after 60 seconds.'
            $process.Kill()
        } else {
            $code = $process.ExitCode
            Add-Line ("exit code     : {0}  (0x{1:X8})" -f $code, $code)
            switch ($code) {
                0            { Add-Line 'meaning       : started normally' }
                -1073741515  { Add-Line 'meaning       : STATUS_DLL_NOT_FOUND - a dependent DLL is missing' }
                -1073741502  { Add-Line 'meaning       : STATUS_DLL_INIT_FAILED - a DLL failed to initialise' }
                -1073741795  { Add-Line 'meaning       : STATUS_ILLEGAL_INSTRUCTION - CPU lacks a required instruction' }
                -1073741819  { Add-Line 'meaning       : ACCESS_VIOLATION - crashed while starting' }
                default      { Add-Line 'meaning       : see stdout and stderr below' }
            }
        }
        Add-Line ''
        Add-Line '--- stdout ---'
        if ($stdout) { Add-Line $stdout.Trim() } else { Add-Line '(empty)' }
        Add-Line '--- stderr ---'
        if ($stderr) { Add-Line $stderr.Trim() } else { Add-Line '(empty)' }
    } catch {
        Add-Line 'The process could not be started at all.'
        Add-Line ("error         : " + $_.Exception.Message)
        if ($_.Exception.InnerException) {
            Add-Line ("inner         : " + $_.Exception.InnerException.Message)
        }
        Add-Line 'A denial here usually means policy is blocking execution rather than'
        Add-Line 'anything being wrong with the file. Section 7 covers that.'
    }
}

# ------------------------------------------------------------------ policy
Add-Section '7. Execution policy and application control'
Add-Line ("PowerShell execution policy : " + (Get-ExecutionPolicy))
try {
    $applocker = Get-ChildItem 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\SrpV2' -ErrorAction Stop
    Add-Line ('AppLocker rules present     : ' + (($applocker | ForEach-Object { $_.PSChildName }) -join ', '))
    Add-Line 'AppLocker can block executables outside Program Files, which is'
    Add-Line 'exactly where a VS Code extension lives. If section 6 reported a'
    Add-Line 'denial, this is the most likely cause and needs an IT exception.'
} catch {
    Add-Line 'AppLocker rules present     : none found'
}
try {
    $wdac = Get-CimInstance -ClassName Win32_DeviceGuard -Namespace root\Microsoft\Windows\DeviceGuard -ErrorAction Stop
    $policies = @($wdac.CodeIntegrityPolicyEnforcementStatus)
    Add-Line ('Device Guard code integrity : ' + ($policies -join ', '))
} catch {
    Add-Line 'Device Guard code integrity : not queryable'
}

# ------------------------------------------------------------------- finish
Add-Section 'Done'
Set-Content -LiteralPath $ReportPath -Value $Lines -Encoding UTF8
Add-Line ("A copy of everything above was written to:")
Add-Line ("  " + $ReportPath)
Add-Line ''
Add-Line 'Paste that file, or the output above, to get a diagnosis.'
