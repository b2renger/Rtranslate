# Shared helpers for the Phase 0 spike scripts. Dot-source this.

# Captured at dot-source time so every helper resolves paths against spike/,
# whichever script called it.
$script:SpikeRoot = $PSScriptRoot

function Get-SpikeRoot {
    return $script:SpikeRoot
}

function Get-VenvPython {
    $py = Join-Path (Get-SpikeRoot) ".venv\Scripts\python.exe"
    if (-not (Test-Path $py)) {
        throw "No venv found. Run .\setup.ps1 first."
    }
    return $py
}

function Get-Profiles {
    $path = Join-Path (Get-SpikeRoot) "profiles.json"
    if (-not (Test-Path $path)) { throw "profiles.json missing at $path" }
    $json = Get-Content $path -Raw -Encoding UTF8 | ConvertFrom-Json
    return $json.profiles
}

# The Windows cuDNN fix: CTranslate2 (faster-whisper) loads cudnn_ops64_9.dll by
# name and will not find it unless the wheel's bin directory is on PATH. Doing it
# here, in the launcher, is the pattern Electron should copy in Phase 1.
function Add-CudnnToPath {
    $bin = Join-Path (Get-SpikeRoot) ".venv\Lib\site-packages\nvidia\cudnn\bin"
    $cublas = Join-Path (Get-SpikeRoot) ".venv\Lib\site-packages\nvidia\cublas\bin"
    foreach ($dir in @($bin, $cublas)) {
        if ((Test-Path $dir) -and ($env:PATH -notlike "*$dir*")) {
            $env:PATH = "$dir;$env:PATH"
        }
    }
}

function Get-ServerArgs {
    param($Profile, [int]$Port)
    $common = @("--pcm-input", "--host", "127.0.0.1", "--port", "$Port")
    return @($Profile.server_args) + $common
}

function Get-VramUsedMiB {
    $smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
    if ($null -eq $smi) { return $null }
    try {
        $v = & nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits
        return [int]($v | Select-Object -First 1).Trim()
    } catch {
        return $null
    }
}

function Wait-ForServer {
    param([int]$Port, [int]$TimeoutSeconds = 300)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 3
            if ($r.StatusCode -eq 200) { return $true }
        } catch {
            Start-Sleep -Milliseconds 1500
        }
    }
    return $false
}
