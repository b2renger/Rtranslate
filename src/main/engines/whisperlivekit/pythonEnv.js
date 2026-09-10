/**
 * Locating the Python environment, and the Windows CUDA fixes that have to
 * happen in spawn code rather than in a README.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');

// Tolerate running outside Electron so this module - and everything that
// depends on it - stays unit-testable under plain node.
let app = null;
try {
  ({ app } = require('electron'));
} catch {
  /* not in Electron; packaged-path lookups are skipped below */
}

const IS_WIN = process.platform === 'win32';
const PY_REL = IS_WIN ? path.join('Scripts', 'python.exe') : path.join('bin', 'python');

/**
 * Candidate environments, most specific first.
 *
 * The spike venv is included on purpose: if Phase 0 has already been run on
 * this machine, the app just works with no second 3-4 GB download.
 */
function candidates(repoRoot) {
  const list = [];
  if (process.env.RTRANSLATE_PYTHON) list.push(process.env.RTRANSLATE_PYTHON);

  // An environment shipped alongside a packaged build, if one is ever bundled.
  if (app && app.isPackaged) {
    list.push(path.join(process.resourcesPath, 'pyenv', PY_REL));
  }

  // What first-run setup builds. Checked in development too, so the setup flow
  // can be exercised without packaging.
  if (app) list.push(path.join(app.getPath('userData'), 'pyenv', PY_REL));

  list.push(path.join(repoRoot, '.venv', PY_REL));
  list.push(path.join(repoRoot, 'spike', '.venv', PY_REL));
  return list;
}

function resolvePython(repoRoot) {
  for (const candidate of candidates(repoRoot)) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/**
 * The cuDNN fix, done properly.
 *
 * CTranslate2 loads cudnn_ops64_9.dll by name and will not find it unless the
 * wheel's bin directory is on PATH. Rather than special-casing cudnn and cublas,
 * add every nvidia/<pkg>/bin the environment actually has - the set differs
 * between torch versions and it costs nothing to be thorough.
 *
 * Filed against WhisperLiveKit #286, faster-whisper #1080, CTranslate2 #1780.
 */
function nvidiaDllDirs(pythonExe) {
  if (!pythonExe || !IS_WIN) return [];
  const venvRoot = path.resolve(path.dirname(pythonExe), '..');
  const sitePackages = path.join(venvRoot, 'Lib', 'site-packages');
  const nvidiaRoot = path.join(sitePackages, 'nvidia');
  const dirs = [];
  try {
    for (const entry of fs.readdirSync(nvidiaRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const bin = path.join(nvidiaRoot, entry.name, 'bin');
      if (fs.existsSync(bin)) dirs.push(bin);
    }
  } catch {
    /* no nvidia packages installed; CPU-only or a non-standard layout */
  }

  // On Windows the CUDA runtime usually ships inside the torch wheel rather than
  // as separate nvidia-* packages, so this is where cudnn_ops64_9.dll actually
  // lives most of the time. Adding both covers either layout.
  const torchLib = path.join(sitePackages, 'torch', 'lib');
  if (fs.existsSync(torchLib)) dirs.push(torchLib);

  return dirs;
}

/** Environment for the sidecar process, with the DLL directories prepended. */
function buildEnv(pythonExe) {
  const dirs = nvidiaDllDirs(pythonExe);
  const env = { ...process.env };
  if (dirs.length) {
    env.PATH = dirs.join(path.delimiter) + path.delimiter + (env.PATH || '');
  }
  // Unbuffered, so our log ring buffer sees the server's output as it happens
  // rather than in 8 KB bursts after something has already gone wrong.
  env.PYTHONUNBUFFERED = '1';
  env.PYTHONIOENCODING = 'utf-8';
  return env;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 20000, windowsHide: true, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), err });
    });
  });
}

/** GPU inventory via nvidia-smi. Null when there is no NVIDIA driver at all. */
async function detectGpu() {
  const res = await run('nvidia-smi', [
    '--query-gpu=name,memory.total,memory.used,driver_version',
    '--format=csv,noheader,nounits',
  ]);
  if (!res.ok || !res.stdout.trim()) return null;

  const [line] = res.stdout.trim().split(/\r?\n/);
  const [name, totalMiB, usedMiB, driver] = line.split(',').map((s) => s.trim());
  const total = Number(totalMiB);
  return {
    name,
    vramTotalMiB: total,
    vramUsedMiB: Number(usedMiB),
    vramTotalGiB: Number.isFinite(total) ? total / 1024 : null,
    driver,
  };
}

const PROBE = `
import json, sys
out = {"python": sys.version.split()[0]}
try:
    import torch
    out["torch"] = torch.__version__
    out["cudaBuild"] = torch.version.cuda
    out["cudaAvailable"] = bool(torch.cuda.is_available())
    if out["cudaAvailable"]:
        p = torch.cuda.get_device_properties(0)
        out["device"] = p.name
        out["vramGiB"] = round(p.total_memory / 1024**3, 2)
except Exception as e:
    out["torchError"] = f"{type(e).__name__}: {e}"
try:
    import whisperlivekit
    out["whisperlivekit"] = getattr(whisperlivekit, "__version__", "unknown")
except Exception as e:
    out["whisperlivekitError"] = f"{type(e).__name__}: {e}"
print(json.dumps(out))
`;

/**
 * Ask the environment what it can actually do, before we try to start a server
 * with it. Everything the UI needs to explain a failure in plain language comes
 * from here.
 */
async function probe(pythonExe) {
  if (!pythonExe) {
    return { ok: false, error: 'no-python', message: 'No Python environment found. Run npm run bootstrap.' };
  }
  const res = await run(pythonExe, ['-c', PROBE], { env: buildEnv(pythonExe) });
  if (!res.ok) {
    return {
      ok: false,
      error: 'probe-failed',
      message: (res.stderr || res.stdout || 'Python could not be started.').trim().slice(0, 800),
    };
  }
  let info;
  try {
    info = JSON.parse(res.stdout.trim().split(/\r?\n/).pop());
  } catch {
    return { ok: false, error: 'probe-unparseable', message: res.stdout.slice(0, 800) };
  }

  if (info.whisperlivekitError) {
    return { ok: false, error: 'no-whisperlivekit', message: info.whisperlivekitError, info };
  }
  if (info.torchError) {
    return { ok: false, error: 'no-torch', message: info.torchError, info };
  }
  if (!info.cudaAvailable) {
    return {
      ok: false,
      error: 'no-cuda',
      message:
        'PyTorch cannot see a CUDA device. Everything would run on the CPU and be far too slow for live captions.',
      info,
    };
  }
  return { ok: true, info };
}

module.exports = {
  resolvePython,
  buildEnv,
  nvidiaDllDirs,
  detectGpu,
  probe,
  candidates,
  IS_WIN,
  PY_REL,
  tmpdir: os.tmpdir,
};
