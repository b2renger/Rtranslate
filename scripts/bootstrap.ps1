<#
.SYNOPSIS
    Create the Python environment WhisperLive's sidecar runs in.

.DESCRIPTION
    Same recipe as spike/setup.ps1, but it builds the environment at the repo
    root where the app looks for it. If you have already run the spike setup,
    you do not need this: the app falls back to spike\.venv.

    Pulls 3-4 GB of CUDA PyTorch. Verifies the GPU is visible before finishing,
    so a broken environment fails here rather than at the first Start click.

.EXAMPLE
    npm run bootstrap
    powershell -ExecutionPolicy Bypass -File scripts\bootstrap.ps1 -CudaTag cu128
#>
[CmdletBinding()]
param(
    [string]$CudaTag = "cu129",
    [string]$PythonVersion = "3.12",
    [switch]$SkipTranslation
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

function Say([string]$m) { Write-Host "`n=== $m" -ForegroundColor Cyan }
function Warn([string]$m) { Write-Host "  !  $m" -ForegroundColor Yellow }

Say "Checking prerequisites"
if ($null -eq (Get-Command uv -ErrorAction SilentlyContinue)) {
    throw "uv is not on PATH. Install it: https://docs.astral.sh/uv/getting-started/installation/"
}
Write-Host "  uv    $((& uv --version) -replace 'uv ', '')"

$spikeVenv = Join-Path $root "spike\.venv\Scripts\python.exe"
if (Test-Path $spikeVenv) {
    Write-Host "`n  Note: spike\.venv already exists and the app will use it as a fallback." -ForegroundColor Gray
    Write-Host "  Continuing will build a second environment at .\.venv (another 3-4 GB)." -ForegroundColor Gray
}

if ($null -eq (Get-Command nvidia-smi -ErrorAction SilentlyContinue)) {
    Warn "nvidia-smi not found. Setup will continue, but CUDA will not work."
} else {
    Write-Host "  gpu   $(& nvidia-smi --query-gpu=name,memory.total --format=csv,noheader)"
}

Say "Creating Python $PythonVersion virtual environment at .\.venv"
& uv python install $PythonVersion
& uv venv --python $PythonVersion .venv
$py = Join-Path $root ".venv\Scripts\python.exe"
if (-not (Test-Path $py)) { throw "venv creation failed: $py missing" }

Say "Installing WhisperLiveKit with the $CudaTag CUDA stack (3-4 GB)"
$spec = "whisperlivekit[$CudaTag]"
if (-not $SkipTranslation) { $spec = "whisperlivekit[$CudaTag,translation,sentence_tokenizer]" }

& uv pip install --python $py $spec
if (-not $?) {
    Warn "Falling back to an explicit torch index."
    & uv pip install --python $py torch torchaudio --index-url "https://download.pytorch.org/whl/$CudaTag"
    if (-not $?) { throw "torch install failed for $CudaTag. Try -CudaTag cu128 or cu126, matching your driver." }
    if ($SkipTranslation) { & uv pip install --python $py whisperlivekit }
    else { & uv pip install --python $py "whisperlivekit[translation,sentence_tokenizer]" }
}

# The Windows cuDNN fix. src/main/pythonEnv.js puts these directories on PATH
# when it spawns the server, which is why installing them here is enough.
Say "Installing cuDNN 9 wheels (fixes 'Could not locate cudnn_ops64_9.dll')"
& uv pip install --python $py nvidia-cudnn-cu12 nvidia-cublas-cu12

Say "Verifying CUDA"
$probe = @'
import torch, sys
print(f"  torch          {torch.__version__} (cuda {torch.version.cuda})")
ok = torch.cuda.is_available()
print(f"  cuda available {ok}")
if ok:
    p = torch.cuda.get_device_properties(0)
    print(f"  device         {p.name}")
    print(f"  vram           {p.total_memory/1024**3:.1f} GiB")
else:
    print("  !! torch cannot see the GPU. WhisperLive will refuse to start.")
    sys.exit(1)
import whisperlivekit
print("  whisperlivekit ok")
'@
$probe | & $py -
if (-not $?) { Warn "Verification failed - fix the above before running the app." }

Say "Done"
Write-Host "  Start the app with:  npm start`n" -ForegroundColor Green
