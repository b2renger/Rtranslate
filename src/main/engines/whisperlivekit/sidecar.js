/**
 * Sidecar lifecycle: spawn whisperlivekit-server, know when it is ready, notice
 * when it dies, and - the one that actually matters - guarantee it is gone when
 * the app quits.
 *
 * An orphaned CUDA process holding 8 GB of VRAM is the classic failure mode of
 * this architecture. Everything about the shutdown path here is written for that.
 */

const { EventEmitter } = require('node:events');
const { spawn, execFile } = require('node:child_process');
const net = require('node:net');
const http = require('node:http');

const { buildEnv } = require('./pythonEnv');

const IS_WIN = process.platform === 'win32';
const LOG_LINES = 400;

/** @typedef {'idle'|'starting'|'ready'|'stopping'|'stopped'|'error'} SidecarState */

class Sidecar extends EventEmitter {
  constructor({ pythonExe }) {
    super();
    this.pythonExe = pythonExe;
    this.proc = null;
    this.port = null;
    this.state = 'idle';
    this.currentKey = null;
    this.currentArgs = null;
    this.log = [];
    this.lastError = null;
    this.restarts = 0;
    this.intentionalStop = false;
    this.startPromise = null;
  }

  // --- plumbing ------------------------------------------------------------

  setState(state, detail) {
    this.state = state;
    this.emit('state', { state, detail: detail || null, port: this.port, key: this.currentKey });
  }

  pushLog(stream, chunk) {
    const text = chunk.toString('utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const entry = { stream, line, at: Date.now() };
      this.log.push(entry);
      if (this.log.length > LOG_LINES) this.log.shift();
      this.emit('log', entry);

      // Surface the failures we already know how to explain in plain language.
      const diagnosis = diagnose(line);
      if (diagnosis) {
        this.lastError = diagnosis;
        this.emit('diagnosis', diagnosis);
      }
    }
  }

  // --- start / stop --------------------------------------------------------

  /**
   * Make sure a server matching `serverArgs` is running.
   * Same profile -> no-op. Different profile -> stop and restart.
   * @returns {Promise<{port:number, restarted:boolean}>}
   */
  async ensure(serverArgs) {
    const key = serverArgs.join(' ');

    if (this.state === 'ready' && this.currentKey === key && this.proc) {
      return { port: this.port, restarted: false };
    }

    // Coalesce concurrent callers so two rapid language changes cannot race
    // two servers onto the GPU at once.
    if (this.startPromise) {
      await this.startPromise.catch(() => {});
      if (this.state === 'ready' && this.currentKey === key) {
        return { port: this.port, restarted: false };
      }
    }

    const restarted = Boolean(this.proc);
    this.startPromise = this._restart(serverArgs, key);
    try {
      const port = await this.startPromise;
      return { port, restarted };
    } finally {
      this.startPromise = null;
    }
  }

  async _restart(serverArgs, key) {
    if (this.proc) await this.stop();

    this.currentArgs = serverArgs;
    this.currentKey = key;
    this.lastError = null;
    this.intentionalStop = false;
    this.setState('starting');

    const port = await freePort();
    this.port = port;

    const args = ['-m', 'whisperlivekit.basic_server', ...serverArgs, '--port', String(port)];
    this.emit('log', { stream: 'app', line: `spawn: ${this.pythonExe} ${args.join(' ')}`, at: Date.now() });

    const proc = spawn(this.pythonExe, args, {
      env: buildEnv(this.pythonExe),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc = proc;

    proc.stdout.on('data', (c) => this.pushLog('out', c));
    proc.stderr.on('data', (c) => this.pushLog('err', c));

    proc.on('exit', (code, signal) => {
      const wasReady = this.state === 'ready';
      this.proc = null;
      if (this.intentionalStop) {
        this.setState('stopped');
        return;
      }
      this.setState('error', {
        message: this.lastError?.message || `Server exited unexpectedly (code ${code}${signal ? `, ${signal}` : ''}).`,
        hint: this.lastError?.hint || null,
        recentLog: this.log.slice(-25),
      });
      if (wasReady) this.emit('crashed', { code, signal });
    });

    proc.on('error', (err) => {
      this.proc = null;
      this.setState('error', { message: `Could not start Python: ${err.message}` });
    });

    // Model download plus load. Generous, because the first run of a profile
    // fetches weights, and a spurious timeout here looks like a crash.
    const ready = await waitForHttp(port, 600_000, () => this.proc !== null);
    if (!ready) {
      const message = this.lastError?.message || 'Server did not become ready in time.';
      await this.stop();
      this.setState('error', { message, hint: this.lastError?.hint || null, recentLog: this.log.slice(-25) });
      throw new Error(message);
    }

    this.setState('ready');
    return port;
  }

  async stop() {
    if (!this.proc) {
      this.setState('stopped');
      return;
    }
    this.intentionalStop = true;
    this.setState('stopping');
    const proc = this.proc;

    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      proc.once('exit', done);

      // On Windows a plain kill() leaves uvicorn's children behind, and with
      // them the CUDA context. Kill the whole tree.
      if (IS_WIN && proc.pid) {
        execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
      } else {
        proc.kill('SIGTERM');
        setTimeout(() => proc.kill('SIGKILL'), 4000).unref?.();
      }
      setTimeout(done, 12_000).unref?.();
    });

    this.proc = null;
    this.port = null;
    this.currentKey = null;
    this.setState('stopped');
  }

  /** Last-resort synchronous-ish teardown for app quit. */
  killNow() {
    if (!this.proc) return;
    this.intentionalStop = true;
    try {
      if (IS_WIN && this.proc.pid) {
        // Detached and unref'd so it survives our own exit long enough to work.
        const killer = spawn('taskkill', ['/pid', String(this.proc.pid), '/T', '/F'], {
          windowsHide: true,
          detached: true,
          stdio: 'ignore',
        });
        killer.unref();
      } else {
        this.proc.kill('SIGKILL');
      }
    } catch {
      /* nothing useful left to do at this point */
    }
    this.proc = null;
  }
}

// --- helpers ---------------------------------------------------------------

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function pingOnce(port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

async function waitForHttp(port, timeoutMs, stillAlive) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (typeof stillAlive === 'function' && !stillAlive()) return false;
    if (await pingOnce(port)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/**
 * Translate the failures we have already researched into something a person can
 * act on. Everything else falls through to the raw log.
 */
const PATTERNS = [
  {
    test: /cudnn_ops64_9\.dll|Could not locate cudnn|Cannot load symbol cudnnCreate/i,
    message: 'CUDA cuDNN libraries were not found.',
    hint:
      'The nvidia-cudnn-cu12 wheel is missing from the Python environment, or its bin directory is not on PATH. Re-run npm run bootstrap.',
  },
  {
    test: /CUDA out of memory|torch\.cuda\.OutOfMemoryError|CUBLAS_STATUS_ALLOC_FAILED/i,
    message: 'The GPU ran out of memory loading this model.',
    hint: 'Choose a smaller model in Settings, or turn translation off to free VRAM.',
  },
  {
    test: /No module named ['"]?whisperlivekit/i,
    message: 'WhisperLiveKit is not installed in the Python environment.',
    hint: 'Run npm run bootstrap.',
  },
  {
    test: /unrecognized arguments?: (.*)/i,
    message: 'The server rejected a command-line flag.',
    hint:
      'This build may be pinned to a different WhisperLiveKit version than the flags assume - check the log line for which flag.',
  },
  {
    test: /Address already in use|WinError 10048/i,
    message: 'The chosen port was taken between selection and launch.',
    hint: 'Try starting again; a fresh port will be picked.',
  },
  {
    test: /ffmpeg|FFmpeg/,
    message: 'The server is trying to use FFmpeg.',
    hint: 'That means --pcm-input did not take effect. Audio will not decode correctly.',
  },
];

function diagnose(line) {
  for (const p of PATTERNS) {
    if (p.test.test(line)) return { message: p.message, hint: p.hint, line };
  }
  return null;
}

module.exports = { Sidecar, diagnose, freePort, waitForHttp };
