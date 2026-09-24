/**
 * The R2T2 engine: NetEase Youdao's Confucius4-R2T2 behind the contract.
 *
 * A 1.7B streaming ASR model trained to commit a "longest stable prefix": every
 * 160 ms it fixes the words it will never revise and holds back about one
 * token. It is here because it attacks exactly what measurably failed on the
 * QVAC engine - text that exists only once a whole VAD segment is over - and on
 * the first French run it streamed near word-perfect text at ~34 ms of compute
 * per 160 ms chunk.
 *
 * ---------------------------------------------------------------------------
 * What it costs, honestly
 * ---------------------------------------------------------------------------
 *
 * 1. IT RUNS ON LINUX. Streaming needs vLLM (the transformers backend refuses
 *    it outright), and its llama.cpp route ships Linux-only prebuilt binaries.
 *    On Windows this engine therefore runs inside WSL2 - fine for measuring,
 *    not something to hand a user as-is. A shippable Windows build means either
 *    rebuilding its llama.cpp extension for Windows or bundling a WSL distro;
 *    neither is done. This file spawns `wsl.exe` and says so.
 *
 * 2. IT TRANSCRIBES; IT DOES NOT TRANSLATE. Its companion SiMT model,
 *    Confucius4-T3PO, is 14B and documented for Chinese<->English only. Any
 *    translating pair reports that plainly rather than handing over a
 *    transcript dressed as a translation.
 *
 * 3. FRENCH IS NOT WHAT IT WAS TUNED FOR. Upstream optimises for Chinese and
 *    English and publishes no French numbers. The one French run so far was
 *    near word-perfect, on clean synthetic speech; real voices are the open
 *    question, and docs/TESTING.md is how it gets answered.
 *
 * The weights are under the NetEase Youdao Model Use License Agreement:
 * royalty-free, commercial use allowed below 100M MAU / RMB 1B revenue, notice
 * retained, governed by PRC law. More permissive than the SimulStreaming
 * backend's noncommercial licence on the incumbent engine.
 *
 * The server itself is ./r2t2/server.py - read its header for why it is ours
 * rather than upstream's.
 */

const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawn, execFile } = require('node:child_process');

const { byId } = require('../../shared/languages.cjs');

const IS_WIN = process.platform === 'win32';
const SERVER_PY = path.join(__dirname, 'r2t2', 'server.py');

/** Qwen3-ASR's languages that the shell's language table can also name. */
const SUPPORTED = new Set(['auto', 'en', 'fr', 'de', 'es', 'it', 'pt', 'ru', 'ja', 'ko', 'ar', 'zh']);

const DEFAULT_SETTINGS = {
  r2t2Distro: 'Ubuntu',                              // WSL distro holding the runtime
  r2t2Home: '~/r2t2',                                // upstream repo + its .venv
  r2t2Model: '~/models/Confucius4-R2T2',
  r2t2Vad: '~/models/vad/Stream-VAD',
  // An absolute budget, not a share of the card: weights are ~3.9 GiB, and the
  // KV cache is sized exactly (1.5 GiB holds one 8k-token stream with room).
  r2t2VramGiB: 6,
  r2t2KvGiB: 1.5,
  // Compilation and CUDA graphs cost ~2 minutes of startup and buy per-chunk
  // speed. Eager mode is the other side of that trade; both are worth timing.
  r2t2EnforceEager: false,
};

const READY_TIMEOUT_MS = 6 * 60 * 1000;             // first start compiles; later ones hit the cache

const events = new EventEmitter();

let child = null;
let port = null;
let currentKey = null;
let state = 'idle';
let lastError = null;
const log = [];

function note(line, stream = 'app') {
  const entry = { stream, line, at: Date.now() };
  log.push(entry);
  if (log.length > 400) log.shift();
  events.emit('log', entry);
}

function setState(next, detail) {
  state = next;
  events.emit('state', { state: next, detail: detail || null, port, key: currentKey });
}

/** C:\Users\x\file -> /mnt/c/Users/x/file, for handing a Windows path to WSL. */
function toWslPath(p) {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (!m) return p.replace(/\\/g, '/');
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
}

/** Quote for a bash -lc string. The values are ours, but paths have spaces. */
function sh(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * The command that starts the server, as [file, args].
 *
 * On Windows it goes through `wsl.exe`, which stays in the FOREGROUND as the
 * server's parent. That is deliberate: WSL tears down a session's processes
 * when the wsl.exe that started them exits, so the server's life is tied to a
 * process the shell can kill. server.py also exits when its stdin closes, for
 * the case where killing wsl.exe does not reach the Linux side.
 */
function commandFor(settings) {
  const python = `${settings.r2t2Home}/.venv/bin/python`;
  const script = IS_WIN ? toWslPath(SERVER_PY) : SERVER_PY;
  const args = [
    '--model', settings.r2t2Model,
    '--vad', settings.r2t2Vad,
    '--host', '127.0.0.1',
    '--port', '0',
    '--vram-gib', String(settings.r2t2VramGiB),
    '--kv-gib', String(settings.r2t2KvGiB),
  ];
  if (settings.r2t2EnforceEager) args.push('--enforce-eager');

  // `~` must reach bash unquoted to expand, so model paths are left to it;
  // the script path is ours and may contain spaces, so it is quoted.
  const line = ['cd', settings.r2t2Home, '&&', 'PYTHONWARNINGS=ignore', 'exec',
    python, sh(script), ...args].join(' ');

  if (IS_WIN) return ['wsl.exe', ['-d', settings.r2t2Distro, '--', 'bash', '-lc', line]];
  return ['bash', ['-lc', line]];
}

function runQuiet(file, args, timeout = 20000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

// ---------------------------------------------------------------------------

module.exports = {
  id: 'r2t2',
  label: 'Confucius4-R2T2',
  description: 'Streaming ASR that commits word by word. Linux/vLLM: runs through WSL2 on Windows.',

  capabilities: {
    real: true,
    diarization: false,
    vad: true,
    nativeEnglish: false,
    translation: false,     // ASR only; see note 2 at the top
    provisional: true,      // the unfixed tail is sent as buffer_transcription
    gpuBackend: 'cuda',
  },

  defaultSettings: DEFAULT_SETTINGS,
  events,

  models: () => [{ id: 'confucius4-r2t2', label: 'Confucius4-R2T2 (1.7B, bf16)', minVramGiB: 6 }],
  recommendModel: () => 'confucius4-r2t2',

  async inspect(settings = {}) {
    const s = { ...DEFAULT_SETTINGS, ...settings };
    const check = [
      `test -x ${s.r2t2Home}/.venv/bin/python || { echo no-runtime; exit 0; }`,
      `test -f ${s.r2t2Model}/model.safetensors || { echo no-weights; exit 0; }`,
      `test -f ${s.r2t2Vad}/model.pth.tar || { echo no-vad; exit 0; }`,
      'echo ok',
    ].join('; ');

    const res = IS_WIN
      ? await runQuiet('wsl.exe', ['-d', s.r2t2Distro, '--', 'bash', '-lc', check])
      : await runQuiet('bash', ['-lc', check]);
    const verdict = res.stdout.replace(/\0/g, '').trim().split(/\r?\n/).pop();

    const setupLead =
      'This engine runs in Linux. On Windows that means WSL2 with the upstream ' +
      'Confucius4-R2T2 repository and its vLLM environment installed, plus the ' +
      'model (~4 GB) and FireRedVAD weights. See docs/TESTING.md, Part 2C.';

    if (!res.ok && IS_WIN) {
      return {
        ok: false, problem: 'no-wsl', label: `WSL distro "${s.r2t2Distro}" is not available`,
        message: res.stderr.replace(/\0/g, '').trim() || 'wsl.exe failed', setupLead, info: {},
      };
    }
    const problems = {
      'no-runtime': 'R2T2 runtime not installed',
      'no-weights': 'R2T2 weights not downloaded',
      'no-vad': 'FireRedVAD weights not downloaded',
    };
    if (verdict !== 'ok') {
      return {
        ok: false, problem: verdict || 'r2t2-unknown', label: problems[verdict] || 'R2T2 is not ready',
        message: problems[verdict] || res.stdout, setupLead, info: {},
      };
    }
    return {
      ok: true, problem: null, message: '',
      info: {
        Runtime: IS_WIN ? `WSL2 (${s.r2t2Distro}) · vLLM` : 'vLLM',
        Model: 'Confucius4-R2T2 1.7B',
        'VRAM budget': `${s.r2t2VramGiB} GiB`,
      },
    };
  },

  /**
   * Language is a per-connection parameter here, as on the incumbent: the
   * server calls init_streaming_state(language=...) for each socket. So a
   * language change is a reconnect with the model warm, and the profile key
   * holds only what the process was started with.
   */
  plan(settings, sourceId, targetId) {
    const merged = { ...DEFAULT_SETTINGS, ...settings };
    const source = byId(sourceId);
    const target = byId(targetId);
    if (!source || !target) throw new Error(`Unknown language: ${sourceId} -> ${targetId}`);

    const lang = source.whisper === 'auto' ? 'auto' : source.id;
    if (!SUPPORTED.has(lang)) throw new Error(`R2T2 does not support spoken language "${source.id}"`);

    const translate = target.id !== source.id;
    const reason = translate
      ? `Confucius4-R2T2 transcribes only - no ${source.id}→${target.id} translation on this engine. ` +
        'Showing what was said.'
      : 'Confucius4-R2T2 streaming - committed word by word, provisional tail dimmed';

    const params = new URLSearchParams();
    params.set('language', lang);

    return {
      route: { translate, useNative: false, useNllb: false, reason },
      r2t2: merged,
      profileKey: ['r2t2', merged.r2t2Distro, merged.r2t2Model, merged.r2t2VramGiB,
        merged.r2t2KvGiB, merged.r2t2EnforceEager].join(' '),
      query: params.toString(),
      display: {
        // Always the source: there is no translation to show, and showing an
        // empty translation pane would read as broken.
        primaryField: 'text',
        secondaryField: null,
        bufferField: 'buffer_transcription',
        note: reason,
      },
    };
  },

  async ensure(plan) {
    if (child && currentKey === plan.profileKey && state === 'ready') {
      return { port, restarted: false };
    }
    const restarted = Boolean(child);
    if (child) await this.stop();

    const [file, args] = commandFor(plan.r2t2);
    note(`spawn: ${file} ${args.join(' ')}`);
    setState('starting');
    lastError = null;

    child = spawn(file, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const proc = child;

    try {
      port = await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`R2T2 did not become ready within ${READY_TIMEOUT_MS / 60000} minutes`)),
          READY_TIMEOUT_MS,
        );
        let out = '';
        proc.stdout.on('data', (d) => {
          out += d.toString('utf8');
          const m = /^READY (\d+)$/m.exec(out);
          if (m) { clearTimeout(timer); resolve(Number(m[1])); }
        });
        proc.stderr.on('data', (d) => {
          // wsl.exe's own messages are UTF-16; the Linux side's are UTF-8.
          for (const line of d.toString('utf8').replace(/\0/g, '').split(/\r?\n/)) {
            if (!line.trim()) continue;
            note(line, 'err');
            if (/refusing to start|Traceback|Error:/.test(line) && !/repo_utils/.test(line)) lastError = line;
          }
        });
        proc.on('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`R2T2 exited during startup (code ${code})${lastError ? `: ${lastError}` : ''}`));
        });
      });
    } catch (err) {
      setState('error', err.message);
      this.killNow();
      throw err;
    }

    proc.removeAllListeners('exit');
    proc.on('exit', (code) => {
      if (child !== proc) return;
      child = null;
      port = null;
      note(`R2T2 exited (code ${code})`, 'err');
      setState('stopped');
      if (code !== 0) events.emit('crashed', {});
    });

    currentKey = plan.profileKey;
    setState('ready');
    note(`R2T2 listening on ws://127.0.0.1:${port}/asr`);
    return { port, restarted };
  },

  async stop() {
    const proc = child;
    if (!proc) return;
    setState('stopping');
    child = null;
    currentKey = null;
    port = null;

    // Closing stdin is the server's signal to kill its own process group -
    // vLLM's engine core included. Give it a moment, then make sure.
    try { proc.stdin.end(); } catch { /* already closed */ }
    await new Promise((resolve) => {
      const timer = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } resolve(); }, 5000);
      proc.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    setState('stopped');
  },

  /** Synchronous, for the exit handlers: an orphaned vLLM process holds ~6 GiB. */
  killNow() {
    const proc = child;
    child = null;
    if (!proc) return;
    try { proc.stdin.destroy(); } catch { /* gone */ }
    try { proc.kill(); } catch { /* gone */ }
  },

  state: () => state,
  port: () => port,
  currentKey: () => currentKey,
  lastError: () => lastError,
  logs: () => log.slice(),
};

// Exposed for tests.
module.exports._internal = { toWslPath, commandFor, sh };
