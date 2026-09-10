/**
 * The WhisperLiveKit engine: the incumbent, behind the contract.
 *
 * Python 3.12 + CUDA PyTorch + SimulStreaming/AlignAtt + NLLB-200, supervised
 * as a child process that already speaks docs/engine-contract.md natively -
 * the contract was lifted from this server's API, so there is no shim here,
 * only an adapter from its shape to the descriptor's.
 *
 * Everything specific to it lives in ./whisperlivekit/:
 *
 *   sidecar.js     spawn / health / crash / guaranteed kill, failure diagnosis
 *   pythonEnv.js   env discovery, the cuDNN PATH fix, the torch probe
 *   envSetup.js    the 4 GB first-run install, with the CUDA resolution check
 *   profiles.js    session planning - which flags, which route, and whether
 *                  a change means restarting the process
 *
 * Those four are why this engine is a candidate rather than a certainty: about
 * 1400 lines exist to make a Python CUDA stack install reliably on Windows.
 */

const path = require('node:path');
const { EventEmitter } = require('node:events');

const { Sidecar } = require('./whisperlivekit/sidecar');
const { resolvePython, probe } = require('./whisperlivekit/pythonEnv');
const { EnvSetup } = require('./whisperlivekit/envSetup');
const {
  DEFAULT_SETTINGS, MODELS, recommendModel, planSession,
} = require('./whisperlivekit/profiles');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const events = new EventEmitter();

let sidecar = null;
let boundPythonExe = null;
let setupRun = null;

/**
 * The sidecar is bound to a specific interpreter, and first-run setup creates
 * one where there was none - so it is built lazily and rebuilt when the
 * interpreter changes, rather than once at load.
 */
function sidecarFor(pythonExe) {
  if (sidecar && boundPythonExe === pythonExe) return sidecar;

  if (sidecar) {
    sidecar.stop().catch(() => {});
    sidecar.removeAllListeners();
  }

  sidecar = new Sidecar({ pythonExe });
  boundPythonExe = pythonExe;

  sidecar.on('state', (s) => events.emit('state', s));
  sidecar.on('log', (l) => events.emit('log', l));
  sidecar.on('diagnosis', (d) =>
    events.emit('log', { stream: 'app', line: `${d.message} ${d.hint || ''}`, at: Date.now() }));
  sidecar.on('crashed', () => events.emit('crashed', {}));

  return sidecar;
}

/** Human labels for the failures this engine knows how to have. */
const PROBLEM_LABELS = {
  'no-python': 'No Python environment',
  'no-whisperlivekit': 'WhisperLiveKit not installed',
  'no-torch': 'PyTorch not installed',
  'no-cuda': 'No CUDA device',
  'probe-failed': 'Python could not start',
  'probe-unparseable': 'Unexpected Python output',
};

module.exports = {
  id: 'whisperlivekit',
  label: 'WhisperLiveKit',
  description: 'Python + CUDA PyTorch. SimulStreaming/AlignAtt with NLLB-200 translation.',

  capabilities: {
    real: true,
    diarization: true,        // the server supports it; not surfaced in the UI yet
    vad: false,
    nativeEnglish: true,      // Whisper's own translate task, for X -> EN
    gpuBackend: 'cuda',
  },

  defaultSettings: DEFAULT_SETTINGS,
  events,

  models: () => MODELS,
  recommendModel,

  async inspect() {
    const pythonExe = resolvePython(REPO_ROOT);
    if (!pythonExe) {
      return {
        ok: false,
        problem: 'no-python',
        label: PROBLEM_LABELS['no-python'],
        title: 'Rtranslate needs to finish setting up',
        setupLead:
          'This engine needs a private Python environment with CUDA PyTorch. It is about ' +
          '4 GB and lives in this app’s own folder — your system Python, if you have ' +
          'one, is not touched. This runs once.',
        fixHint: 'A one-time download of about 4 GB installs the transcription engine into this app’s own folder.',
        message: 'No interpreter found.',
        info: {},
      };
    }

    const py = await probe(pythonExe);
    if (py.ok) sidecarFor(pythonExe);

    return {
      ok: py.ok,
      problem: py.ok ? null : py.error,
      label: py.ok ? null : (PROBLEM_LABELS[py.error] || 'Environment problem'),
      title: 'Rtranslate needs to finish setting up',
      setupLead:
        'This engine needs a private Python environment with CUDA PyTorch. It is about ' +
        '4 GB and lives in this app’s own folder — your system Python, if you have ' +
        'one, is not touched. This runs once.',
      fixHint: 'A one-time download of about 4 GB installs the transcription engine into this app’s own folder.',
      message: py.message || '',
      info: {
        Python: py.info?.python || '',
        torch: py.info?.torch ? `${py.info.torch} (cuda ${py.info.cudaBuild})` : '',
        whisperlivekit: py.info?.whisperlivekit || '',
        Device: py.info?.device || '',
        'Env path': pythonExe,
        // The engine's own VRAM reading beats nvidia-smi's: it is what torch
        // will actually be allowed to allocate.
        vramGiB: py.info?.vramGiB ?? null,
      },
    };
  },

  plan(settings, sourceId, targetId) {
    return planSession(settings, sourceId, targetId);
  },

  async ensure(plan) {
    const pythonExe = resolvePython(REPO_ROOT);
    if (!pythonExe) throw new Error('No Python environment. Run setup first.');
    return sidecarFor(pythonExe).ensure(plan.serverArgs);
  },

  async stop() {
    if (sidecar) await sidecar.stop();
  },

  /** Synchronous, for the exit handlers: an orphaned CUDA process holds 8 GB. */
  killNow() {
    sidecar?.killNow();
  },

  state: () => sidecar?.state || 'idle',
  port: () => sidecar?.port ?? null,
  currentKey: () => sidecar?.currentKey ?? null,
  lastError: () => sidecar?.lastError ?? null,
  logs: () => sidecar?.log || [],

  setup: {
    steps: ({ userDataDir }) => new EnvSetup({ userDataDir }).steps,
    running: () => Boolean(setupRun?.running),

    async start({ userDataDir, cudaTag, onProgress, onLog }) {
      setupRun = new EnvSetup({ userDataDir, cudaTag: cudaTag || null });
      setupRun.on('progress', (p) => onProgress?.(p));
      setupRun.on('log', (l) => onLog?.(l));
      return setupRun.start();
    },

    cancel() {
      setupRun?.cancel();
    },
  },
};
