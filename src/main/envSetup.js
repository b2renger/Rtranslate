/**
 * First-run environment setup: build the Python sidecar environment from
 * nothing, inside the app, with visible progress.
 *
 * This is what makes an installed build usable. The CUDA PyTorch stack is 3-4 GB
 * - far too much to put in an installer - so it is fetched on first run into
 * userData/pyenv instead, which is exactly where pythonEnv.js already looks.
 *
 * Everything is driven through `uv`: it resolves and installs a private Python
 * 3.12 without touching whatever Python the machine already has, and it is
 * dramatically faster than pip at this size. If uv is not on PATH, its official
 * standalone build is downloaded into userData/tools first.
 *
 * Steps are deliberately coarse and named. A 4 GB download with a spinner and no
 * explanation is indistinguishable from a hang.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

const UV_URL = 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip';
const PYTHON_VERSION = '3.12';

/** CUDA wheel tags to try, newest first. Drivers vary; falling back is normal. */
const CUDA_TAGS = ['cu129', 'cu128', 'cu126'];

const EXTRAS = 'translation,sentence_tokenizer';

class SetupCancelled extends Error {
  constructor() {
    super('Setup was cancelled.');
    this.name = 'SetupCancelled';
  }
}

class EnvSetup extends EventEmitter {
  constructor({ userDataDir, cudaTag = null }) {
    super();
    this.userDataDir = userDataDir;
    this.toolsDir = path.join(userDataDir, 'tools');
    this.pyenvDir = path.join(userDataDir, 'pyenv');
    this.pythonExe = path.join(this.pyenvDir, 'Scripts', 'python.exe');
    this.cudaTag = cudaTag;
    this.child = null;
    this.cancelled = false;
    this.running = false;
    this.steps = [
      { id: 'uv', label: 'Preparing the installer' },
      { id: 'python', label: `Installing Python ${PYTHON_VERSION}` },
      { id: 'venv', label: 'Creating the environment' },
      { id: 'wheels', label: 'Downloading PyTorch and WhisperLiveKit (3-4 GB)' },
      { id: 'cudnn', label: 'Installing CUDA libraries' },
      { id: 'verify', label: 'Checking the GPU' },
    ];
  }

  // --- reporting -----------------------------------------------------------

  emitStep(index, status, detail) {
    this.emit('progress', {
      index,
      total: this.steps.length,
      id: this.steps[index].id,
      label: this.steps[index].label,
      status,
      detail: detail || null,
    });
  }

  log(line) {
    if (line && line.trim()) this.emit('log', { line: line.trim(), at: Date.now() });
  }

  throwIfCancelled() {
    if (this.cancelled) throw new SetupCancelled();
  }

  // --- process helpers -----------------------------------------------------

  run(command, args, { env, onLine } = {}) {
    return new Promise((resolve, reject) => {
      this.throwIfCancelled();
      this.log(`> ${path.basename(command)} ${args.join(' ')}`);

      const child = spawn(command, args, {
        windowsHide: true,
        env: { ...process.env, ...(env || {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.child = child;

      const handle = (chunk) => {
        // uv redraws progress with carriage returns; split on both.
        for (const line of chunk.toString('utf8').split(/[\r\n]+/)) {
          if (!line.trim()) continue;
          this.log(line);
          onLine?.(line);
        }
      };
      child.stdout.on('data', handle);
      child.stderr.on('data', handle);

      child.on('error', (err) => {
        this.child = null;
        reject(err);
      });
      child.on('exit', (code) => {
        this.child = null;
        if (this.cancelled) return reject(new SetupCancelled());
        if (code === 0) return resolve();
        reject(new Error(`${path.basename(command)} exited with code ${code}`));
      });
    });
  }

  cancel() {
    this.cancelled = true;
    if (this.child) {
      try {
        spawn('taskkill', ['/pid', String(this.child.pid), '/T', '/F'], { windowsHide: true });
      } catch { /* already gone */ }
    }
  }

  // --- steps ---------------------------------------------------------------

  /** uv from PATH if present, otherwise the official standalone build. */
  async ensureUv() {
    const onPath = await which('uv');
    if (onPath) {
      this.log(`Found uv on PATH: ${onPath}`);
      return onPath;
    }

    const local = path.join(this.toolsDir, 'uv.exe');
    if (fs.existsSync(local)) {
      this.log(`Using previously downloaded uv: ${local}`);
      return local;
    }

    await fsp.mkdir(this.toolsDir, { recursive: true });
    const zipPath = path.join(this.toolsDir, 'uv.zip');
    this.log(`Downloading uv from ${UV_URL}`);

    await download(UV_URL, zipPath, (pct, received, total) => {
      this.emitStep(0, 'running', total ? `${pct}% of ${mb(total)} MB` : `${mb(received)} MB`);
      this.throwIfCancelled();
    });

    // No unzip in Node, and Windows always has this one.
    await this.run('powershell', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${this.toolsDir}' -Force`,
    ]);
    await fsp.rm(zipPath, { force: true });

    if (!fs.existsSync(local)) throw new Error('uv.exe was not found after extraction.');
    return local;
  }

  /**
   * Install the wheels: resolve first, verify the resolution is actually CUDA,
   * and only then download.
   *
   * This order matters more than it looks. On Windows the plain PyPI `torch`
   * wheel is CPU-only; CUDA builds live on download.pytorch.org and carry a
   * `+cuXXX` local version. Point uv at both indexes and it picks by version
   * number, so a CUDA index whose newest torch trails PyPI's loses - measured:
   * with cu128 the resolver chose `torch==2.13.0` (CPU) over `2.11.0+cu128`.
   *
   * Installing that takes 2.5 GB and twenty minutes to arrive at an environment
   * whose only symptom is "PyTorch cannot see a CUDA device". `uv pip compile`
   * answers the same question in about three seconds, so every candidate is
   * resolved and inspected before anything is downloaded.
   *
   * The accepted resolution is a fully pinned lock file, which is also what
   * gets installed - so the environment is reproducible rather than
   * whatever-resolved-that-day.
   */
  async installWheels(uv) {
    const tags = this.cudaTag ? [this.cudaTag] : CUDA_TAGS;
    const requirementsIn = path.join(this.pyenvDir, 'requirements.in');
    await fsp.writeFile(
      requirementsIn,
      `whisperlivekit[${EXTRAS}]\ntorch\ntorchaudio\n`,
      'utf8',
    );

    const rejected = [];
    let lastError = null;

    for (const tag of tags) {
      this.throwIfCancelled();
      this.emitStep(3, 'running', `checking ${tag}`);

      const lockPath = path.join(this.pyenvDir, `requirements-${tag}.txt`);
      const indexUrl = `https://download.pytorch.org/whl/${tag}`;

      try {
        await this.run(uv, [
          'pip', 'compile', requirementsIn,
          '--python', this.pythonExe,
          '--extra-index-url', indexUrl,
          '--index-strategy', 'unsafe-best-match',
          '-o', lockPath,
        ]);
      } catch (err) {
        if (err instanceof SetupCancelled) throw err;
        lastError = err;
        this.log(`${tag}: could not resolve (${err.message}).`);
        rejected.push(`${tag} (unresolvable)`);
        continue;
      }

      const lock = await fsp.readFile(lockPath, 'utf8');
      const verdict = verifyCudaResolution(lock, tag);
      if (!verdict.ok) {
        this.log(`${tag}: ${verdict.reason} Skipping before downloading it.`);
        rejected.push(`${tag} (${verdict.short})`);
        await fsp.rm(lockPath, { force: true });
        continue;
      }

      this.log(`${tag}: resolved to torch ${verdict.torch} — installing.`);
      this.emitStep(3, 'running', `${tag} · torch ${verdict.torch}`);

      try {
        await this.run(uv, [
          'pip', 'install',
          '--python', this.pythonExe,
          '-r', lockPath,
          '--extra-index-url', indexUrl,
          '--index-strategy', 'unsafe-best-match',
        ], {
          onLine: (line) => {
            if (/Downloading|Prepared|Installed/.test(line)) {
              this.emitStep(3, 'running', `${tag} · ${line.slice(0, 64)}`);
            }
          },
        });
        this.lockPath = lockPath;
        return tag;
      } catch (err) {
        if (err instanceof SetupCancelled) throw err;
        lastError = err;
        this.log(`${tag}: install failed (${err.message}).`);
        rejected.push(`${tag} (install failed)`);
      }
    }

    throw new Error(
      `No CUDA build of PyTorch could be installed. Tried: ${rejected.join(', ') || tags.join(', ')}.` +
        (lastError ? ` Last error: ${lastError.message}` : ''),
    );
  }

  /** Record exactly what got installed, so a known-good set can be pinned later. */
  async writeManifest(uv, cudaTag) {
    try {
      let freeze = '';
      await this.run(uv, ['pip', 'freeze', '--python', this.pythonExe], {
        onLine: (line) => {
          if (/^[A-Za-z0-9_.-]+==/.test(line)) freeze += `${line}\n`;
        },
      });
      await fsp.writeFile(path.join(this.pyenvDir, 'freeze.txt'), freeze, 'utf8');
      await fsp.writeFile(
        path.join(this.pyenvDir, 'manifest.json'),
        JSON.stringify({ cudaTag, pythonVersion: PYTHON_VERSION, installedAt: new Date().toISOString() }, null, 2),
        'utf8',
      );
      this.log('Wrote freeze.txt and manifest.json for reproducibility.');
    } catch (err) {
      // Not worth failing a successful install over.
      this.log(`Could not write the manifest: ${err.message}`);
    }
  }

  // --- orchestration -------------------------------------------------------

  async start() {
    if (this.running) return { ok: false, message: 'Setup is already running.' };
    this.running = true;
    this.cancelled = false;

    try {
      this.emitStep(0, 'running');
      const uv = await this.ensureUv();
      this.emitStep(0, 'done');

      this.emitStep(1, 'running');
      await this.run(uv, ['python', 'install', PYTHON_VERSION]);
      this.emitStep(1, 'done');

      this.emitStep(2, 'running');
      // Remove a half-built environment from an interrupted attempt, or uv will
      // reuse it and inherit whatever state it was left in.
      if (fs.existsSync(this.pyenvDir) && !fs.existsSync(this.pythonExe)) {
        await fsp.rm(this.pyenvDir, { recursive: true, force: true });
      }
      await this.run(uv, ['venv', '--python', PYTHON_VERSION, this.pyenvDir]);
      this.emitStep(2, 'done');

      this.emitStep(3, 'running');
      const cudaTag = await this.installWheels(uv);
      this.emitStep(3, 'done', cudaTag);

      // The Windows cuDNN fix, installed here and put on PATH by pythonEnv.js
      // when the sidecar is spawned.
      this.emitStep(4, 'running');
      await this.run(uv, ['pip', 'install', '--python', this.pythonExe, 'nvidia-cudnn-cu12', 'nvidia-cublas-cu12']);
      this.emitStep(4, 'done');

      this.emitStep(5, 'running');
      const { probe } = require('./pythonEnv');
      const result = await probe(this.pythonExe);
      if (!result.ok) {
        this.emitStep(5, 'failed', result.message);
        return { ok: false, pythonExe: this.pythonExe, error: result.error, message: result.message };
      }
      this.emitStep(5, 'done', result.info.device ? `${result.info.device}, ${result.info.vramGiB} GiB` : 'ok');

      await this.writeManifest(uv, cudaTag);
      return { ok: true, pythonExe: this.pythonExe, cudaTag, info: result.info };
    } catch (err) {
      const cancelled = err instanceof SetupCancelled;
      this.emit('progress', {
        index: -1,
        total: this.steps.length,
        status: cancelled ? 'cancelled' : 'failed',
        detail: err.message,
      });
      return { ok: false, cancelled, message: err.message };
    } finally {
      this.running = false;
      this.child = null;
    }
  }
}

// --- resolution verification -----------------------------------------------

/**
 * Decide whether a resolved lock file is genuinely a CUDA install.
 *
 * Both halves matter, and measured behaviour proves it: with cu128 the resolver
 * produced `torch==2.13.0` (plain PyPI, CPU) alongside `torchaudio==2.11.0+cu128`.
 * Checking only torch would reject it correctly here, but checking only
 * torchaudio would have waved through an environment that cannot work. Require
 * both, on the same tag.
 *
 * @returns {{ok: boolean, torch?: string, reason?: string, short?: string}}
 */
function verifyCudaResolution(lock, tag) {
  const torch = /^torch==(\S+)/m.exec(lock)?.[1];
  const torchaudio = /^torchaudio==(\S+)/m.exec(lock)?.[1];

  if (!torch) return { ok: false, reason: 'no torch in the resolution.', short: 'no torch' };

  const wanted = `+${tag}`;
  const torchOk = torch.includes(wanted);
  const audioOk = !torchaudio || torchaudio.includes(wanted);

  if (!torchOk) {
    return {
      ok: false,
      torch,
      reason: `resolved to torch ${torch}, which is the CPU build (the CUDA index trails PyPI on version).`,
      short: 'CPU torch',
    };
  }
  if (!audioOk) {
    return {
      ok: false,
      torch,
      reason: `resolved to torch ${torch} but torchaudio ${torchaudio} — a mismatched pair.`,
      short: 'mismatched torchaudio',
    };
  }
  return { ok: true, torch };
}

// --- small helpers ---------------------------------------------------------

function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(0);
}

function which(command) {
  return new Promise((resolve) => {
    const child = spawn('where', [command], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (c) => (out += c.toString('utf8')));
    child.on('error', () => resolve(null));
    child.on('exit', (code) => {
      if (code !== 0) return resolve(null);
      const first = out.split(/\r?\n/).find((l) => l.trim());
      resolve(first ? first.trim() : null);
    });
  });
}

/** GET to a file, following redirects, reporting progress. */
function download(url, dest, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error('Too many redirects.'));

    https
      .get(url, { headers: { 'User-Agent': 'Rtranslate' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(download(new URL(res.headers.location, url).toString(), dest, onProgress, redirects + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`Download failed with HTTP ${res.statusCode}`));
        }

        const total = Number(res.headers['content-length']) || 0;
        let received = 0;
        let lastReport = 0;

        const file = fs.createWriteStream(dest);
        res.on('data', (chunk) => {
          received += chunk.length;
          const now = Date.now();
          if (now - lastReport > 250) {
            lastReport = now;
            try {
              onProgress?.(total ? Math.round((received / total) * 100) : 0, received, total);
            } catch (err) {
              res.destroy();
              file.destroy();
              reject(err);
            }
          }
        });
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(dest)));
        file.on('error', reject);
      })
      .on('error', reject);
  });
}

module.exports = {
  EnvSetup, SetupCancelled, CUDA_TAGS, PYTHON_VERSION, UV_URL,
  which, download, verifyCudaResolution,
};
