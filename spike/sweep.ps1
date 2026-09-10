<#
.SYNOPSIS
    Run the whole Phase 0 measurement sweep unattended.

.DESCRIPTION
    For each profile in profiles.json: starts the server, waits for it to load,
    records peak VRAM, streams every sample through the latency harness, then
    stops the server and moves on. Results accumulate in results.jsonl and a
    human-readable table lands in RESULTS.md.

    Expect this to take a while - each profile downloads its model on first use.

.EXAMPLE
    .\sweep.ps1
    .\sweep.ps1 -Only large-simul,nllb
    .\sweep.ps1 -Port 8770
#>
[CmdletBinding()]
param(
    [string[]]$Only = @(),
    [int]$Port = 8765,
    [int]$LoadTimeoutSeconds = 600
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

. (Join-Path $root "_common.ps1")

$py = Get-VenvPython
Add-CudnnToPath

$logDir = Join-Path $root "logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory $logDir | Out-Null }

$samplesDir = Join-Path $root "samples"
$resultsPath = Join-Path $root "results.jsonl"

$profiles = Get-Profiles
if ($Only.Count -gt 0) {
    $profiles = $profiles | Where-Object { $Only -contains $_.name }
    if ($profiles.Count -eq 0) { throw "No profiles matched: $($Only -join ', ')" }
}

$idleVram = Get-VramUsedMiB
Write-Host "`nBaseline VRAM in use before we start: $idleVram MiB" -ForegroundColor DarkGray

$summary = @()

foreach ($prof in $profiles) {

    Write-Host "`n============================================================" -ForegroundColor Cyan
    Write-Host " $($prof.name)" -ForegroundColor Cyan
    Write-Host " $($prof.why)" -ForegroundColor Gray
    Write-Host "============================================================" -ForegroundColor Cyan

    # --- check the samples this profile needs exist before paying for a load ---
    $missing = @()
    foreach ($run in $prof.runs) {
        $wav = Join-Path $samplesDir $run.wav
        if (-not (Test-Path $wav)) { $missing += $run.wav }
    }
    if ($missing.Count -gt 0) {
        Write-Host "  SKIPPED - missing sample(s): $($missing -join ', ')" -ForegroundColor Yellow
        Write-Host "  Record them with: .\.venv\Scripts\python.exe record_sample.py --out samples\$($missing[0]) --seconds 60" -ForegroundColor Yellow
        continue
    }

    $serverArgs = Get-ServerArgs -Profile $prof -Port $Port
    $stdout = Join-Path $logDir "$($prof.name).out.log"
    $stderr = Join-Path $logDir "$($prof.name).err.log"

    Write-Host "`n  starting server..." -ForegroundColor DarkGray
    Write-Host "  args: $($serverArgs -join ' ')" -ForegroundColor DarkGray

    $procArgs = @("-m", "whisperlivekit.basic_server") + $serverArgs
    $server = Start-Process -FilePath $py -ArgumentList $procArgs -PassThru `
                            -RedirectStandardOutput $stdout -RedirectStandardError $stderr `
                            -WindowStyle Hidden

    try {
        if (-not (Wait-ForServer -Port $Port -TimeoutSeconds $LoadTimeoutSeconds)) {
            Write-Host "  server did not come up in $LoadTimeoutSeconds s - see $stderr" -ForegroundColor Red
            $summary += [pscustomobject]@{ profile = $prof.name; run = "-"; status = "server failed to start" }
            continue
        }

        Start-Sleep -Seconds 3    # let the warmup pass settle before reading VRAM
        $loadedVram = Get-VramUsedMiB
        $modelVram = $null
        if ($null -ne $loadedVram -and $null -ne $idleVram) { $modelVram = $loadedVram - $idleVram }
        Write-Host "  loaded. VRAM in use: $loadedVram MiB (delta $modelVram MiB)" -ForegroundColor Green

        foreach ($run in $prof.runs) {
            $wav = Join-Path $samplesDir $run.wav
            $label = "$($prof.name)/$($run.label)"

            $harnessArgs = @(
                (Join-Path $root "measure_latency.py"),
                "--wav", $wav,
                "--url", "ws://127.0.0.1:$Port/asr",
                "--language", $run.language,
                "--label", $label,
                "--json", $resultsPath
            )
            if ($run.PSObject.Properties.Name -contains "target_language" -and $run.target_language) {
                $harnessArgs += @("--target-language", $run.target_language)
            }

            & $py @harnessArgs
            if ($?) {
                $summary += [pscustomobject]@{ profile = $prof.name; run = $run.label; status = "ok"; vram = $modelVram }
            } else {
                $summary += [pscustomobject]@{ profile = $prof.name; run = $run.label; status = "harness error"; vram = $modelVram }
            }
        }
    }
    finally {
        if ($null -ne $server -and -not $server.HasExited) {
            Write-Host "  stopping server (pid $($server.Id))" -ForegroundColor DarkGray
            Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
            $server.WaitForExit(15000) | Out-Null
        }
        Start-Sleep -Seconds 4    # let CUDA actually release the memory
    }
}

Write-Host "`n============================================================" -ForegroundColor Cyan
Write-Host " Sweep complete" -ForegroundColor Cyan
Write-Host "============================================================`n" -ForegroundColor Cyan
$summary | Format-Table -AutoSize

Write-Host "Raw results: $resultsPath" -ForegroundColor Green
Write-Host "Now render the table:  .\.venv\Scripts\python.exe report.py`n" -ForegroundColor Green
