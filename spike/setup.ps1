<#
.SYNOPSIS
    Phase 0 environment setup for the Rtranslate spike.

.DESCRIPTION
    Creates a Python 3.12 venv with uv, installs WhisperLiveKit with the CUDA
    stack, installs the cuDNN wheel that fixes the classic Windows
    "cudnn_ops64_9.dll not found" error, and verifies that torch actually sees
    the GPU.

    Nothing here touches your system Python. Everything lands in .\.venv.

.EXAMPLE
    .\setup.ps1
    .\setup.ps1 -CudaTag cu128        # if the cu129 wheels 404 for your driver
    .\setup.ps1 -SkipTranslation      # transcription only, smaller install
#>
[CmdletBinding()]
param(
    [string]$CudaTag = "cu129",
    [string]$PythonVersion = "3.12",
    [switch]$SkipTranslation
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

function Say([string]$m) { Write-Host "`n=== $m" -ForegroundColor Cyan }
function Warn([string]$m) { Write-Host "  !  $m" -ForegroundColor Yellow }

# --- 0. prerequisites ------------------------------------------------------
Say "Checking prerequisites"

$uv = Get-Command uv -ErrorAction SilentlyContinue
if ($null -eq $uv) {
    throw "uv is not on PATH. Install it: https://docs.astral.sh/uv/getting-started/installation/"
}
Write-Host "  uv    $((& uv --version) -replace 'uv ', '')"

$smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if ($null -eq $smi) {
    Warn "nvidia-smi not found. This machine may have no NVIDIA GPU; setup will continue but CUDA will not work."
} else {
    $gpu = & nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader
    Write-Host "  gpu   $gpu"
}

# --- 1. venv ---------------------------------------------------------------
Say "Creating Python $PythonVersion virtual environment"
& uv python install $PythonVersion
& uv venv --python $PythonVersion .venv
$py = Join-Path $root ".venv\Scripts\python.exe"
if (-not (Test-Path $py)) { throw "venv creation failed: $py missing" }

$env:VIRTUAL_ENV = Join-Path $root ".venv"

# --- 2. whisperlivekit + CUDA ---------------------------------------------
Say "Installing WhisperLiveKit with the $CudaTag CUDA stack (this pulls 3-4 GB)"

$spec = "whisperlivekit[$CudaTag]"
if (-not $SkipTranslation) { $spec = "whisperlivekit[$CudaTag,translation,sentence_tokenizer]" }

Write-Host "  installing $spec"
& uv pip install --python $py $spec
if (-not $?) {
    Warn "That failed. Falling back to an explicit torch index, then plain whisperlivekit."
    & uv pip install --python $py torch torchaudio --index-url "https://download.pytorch.org/whl/$CudaTag"
    if (-not $?) {
        throw "torch install failed for $CudaTag. Try -CudaTag cu128 or cu126, matching your driver."
    }
    if ($SkipTranslation) {
        & uv pip install --python $py whisperlivekit
    } else {
        & uv pip install --python $py "whisperlivekit[translation,sentence_tokenizer]"
    }
}

# --- 3. the Windows cuDNN fix ---------------------------------------------
Say "Installing cuDNN 9 wheels (fixes 'Could not locate cudnn_ops64_9.dll')"
& uv pip install --python $py nvidia-cudnn-cu12 nvidia-cublas-cu12

$cudnnBin = Join-Path $root ".venv\Lib\site-packages\nvidia\cudnn\bin"
if (Test-Path $cudnnBin) {
    Write-Host "  cuDNN DLLs at $cudnnBin"
    Write-Host "  serve.ps1 prepends this to PATH automatically - do the same in Electron later."
} else {
    Warn "cuDNN bin directory not found; faster-whisper may fail until it is on PATH."
}

# --- 4. harness deps -------------------------------------------------------
Say "Installing latency harness dependencies"
& uv pip install --python $py websockets numpy sounddevice

# --- 5. verify -------------------------------------------------------------
Say "Verifying CUDA"
$probe = @'
import torch, sys
print(f"  torch          {torch.__version__}")
print(f"  cuda build     {torch.version.cuda}")
ok = torch.cuda.is_available()
print(f"  cuda available {ok}")
if ok:
    p = torch.cuda.get_device_properties(0)
    print(f"  device         {p.name}")
    print(f"  vram           {p.total_memory/1024**3:.1f} GiB")
    if p.total_memory/1024**3 < 7.5:
        print("  !! Under 8 GiB. large-v3 on SimulStreaming will not fit here.")
        print("     Use --model small or medium, or run the spike on the 3070 box.")
else:
    print("  !! torch cannot see the GPU. Everything will run on CPU and be far too slow.")
    sys.exit(1)
'@
$probe | & $py -
if (-not $?) { Warn "CUDA verification failed - see the message above before running the spike." }

# --- 6. samples ------------------------------------------------------------
$samples = Join-Path $root "samples"
if (-not (Test-Path $samples)) { New-Item -ItemType Directory $samples | Out-Null }

Say "Done"
Write-Host @"
  Next:
    1. Record two ~60 s samples (or drop your own WAVs into .\samples\):
         .\.venv\Scripts\python.exe record_sample.py --out samples\fr_60s.wav --seconds 60
         .\.venv\Scripts\python.exe record_sample.py --out samples\en_60s.wav --seconds 60
    2. Run the whole sweep:
         .\sweep.ps1
    3. Or drive one profile by hand:
         .\serve.ps1 -Profile large-simul
"@ -ForegroundColor Green
