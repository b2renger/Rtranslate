<#
.SYNOPSIS
    Launch one WhisperLiveKit profile in the foreground.

.DESCRIPTION
    Reads profiles.json, applies the Windows cuDNN PATH fix, and starts the
    server with --pcm-input bound to localhost. Use this to drive a profile by
    hand (browser UI at http://127.0.0.1:8765) rather than through the sweep.

.EXAMPLE
    .\serve.ps1 -List
    .\serve.ps1 -Profile large-simul
    .\serve.ps1 -Profile nllb -Port 8770
#>
[CmdletBinding()]
param(
    [string]$ProfileName = "large-simul",
    [int]$Port = 8765,
    [switch]$List
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

. (Join-Path $root "_common.ps1")

$profiles = Get-Profiles

if ($List) {
    Write-Host "`nAvailable profiles:`n" -ForegroundColor Cyan
    foreach ($p in $profiles) {
        Write-Host ("  {0,-22} {1}" -f $p.name, $p.why) -ForegroundColor Gray
    }
    Write-Host ""
    return
}

# NB: $profile is an automatic PowerShell variable - do not shadow it.
$prof = $profiles | Where-Object { $_.name -eq $ProfileName }
if ($null -eq $prof) {
    throw "Unknown profile '$ProfileName'. Run .\serve.ps1 -List to see the options."
}

$py = Get-VenvPython
Add-CudnnToPath

$serverArgs = Get-ServerArgs -Profile $prof -Port $Port

Write-Host "`n=== $($prof.name)" -ForegroundColor Cyan
Write-Host "  $($prof.why)`n" -ForegroundColor Gray
Write-Host "  whisperlivekit-server $($serverArgs -join ' ')`n" -ForegroundColor DarkGray
Write-Host "  UI: http://127.0.0.1:$Port   (Ctrl+C to stop)`n" -ForegroundColor Green

& $py -m whisperlivekit.basic_server @serverArgs
