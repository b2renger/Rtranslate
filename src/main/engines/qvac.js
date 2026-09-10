/**
 * The QVAC engine: Tether's on-device SDK behind the contract.
 *
 * whisper.cpp (or Parakeet) through `@qvac/sdk`, wrapped in a WebSocket server
 * that speaks docs/engine-contract.md, so the shell cannot tell it apart from
 * the Python one.
 *
 * ---------------------------------------------------------------------------
 * What this engine is, honestly
 * ---------------------------------------------------------------------------
 *
 * It is NOT in-process. `@qvac/sdk` depends on `bare-runtime`, not Node: the
 * addons are `.bare` binaries and inference runs in a Bare worker over
 * `bare-rpc`. So this is still a sidecar. The win over the incumbent is not
 * "no subprocess", it is "no Python, no CUDA toolkit, no cuDNN PATH fix, no
 * 4 GB resolver dance" - `npm install` and the binaries are there.
 *
 * Three facts, measured rather than read off the marketing page, that decide
 * whether this engine is worth having. All are re-checkable per SDK version.
 *
 * 1. ON WINDOWS IT RUNS VULKAN, NOT CUDA - on an NVIDIA card. The published
 *    docs say "NVIDIA CUDA via use_gpu: true"; the shipped packages disagree.
 *    `@qvac/inference/dist/resources/model-fit/assess.js` says so itself:
 *
 *      "the NVIDIA calibration host advertises both CUDA and Vulkan, and every
 *       load on it reports `ggml_vulkan`, never `ggml_cuda`"
 *
 *    and its GPU_BACKENDS list puts vulkan ahead of cuda. The only Windows
 *    calibrations that ship are win32-x64, win32-x64-vulkan and
 *    win32-x64-vulkan-shared. There is no CUDA build. Vulkan-vs-CUDA on the
 *    same card is the central thing spike/profile.mjs is for.
 *
 * 2. LANGUAGE IS SET AT MODEL LOAD, NOT PER REQUEST. `language` and `translate`
 *    live in `modelConfig` for `loadModel()`; `TranscribeStreamClientParams`
 *    has neither. The incumbent takes `language` as a query parameter, so
 *    changing the spoken language there is a socket reconnect with the model
 *    still warm. Here it is a model reload. The contract allows this - an
 *    engine may take longer to produce its first line after a language change
 *    - but the whole UI was designed around that being cheap, so `plan()` puts
 *    the language IN the profile key and the UI warns before the switch.
 *
 * 3. THERE IS NO FRENCH<->ENGLISH TRANSLATION MODEL IN THE REGISTRY. What
 *    ships is Marian Indic (EN<->Hindi and Indic languages) and one African
 *    translation LLM. For this app that splits the two directions:
 *
 *      FR -> EN  Whisper's own translate task (`translate: true`). No second
 *                model, no sentence gate, no extra VRAM. This is exactly the
 *                fast path the incumbent's open question #1 was about, and
 *                QVAC gets it for free.
 *      EN -> FR  nothing bundled. Either a custom NMT GGUF via `modelSrc`
 *                (`qvacTranslationModelSrc`), or a general LLM asked to
 *                translate (`qvacTranslationModelType: 'llm'`), which costs
 *                VRAM and whose quality is a separate question from latency.
 *
 *    So a fair comparison must report the two directions separately. An
 *    EN->FR plan with nothing configured says so rather than silently
 *    transcribing.
 */

const { EventEmitter } = require('node:events');

const { MiniWsServer } = require('../miniws');
const { byId } = require('../../shared/languages.cjs');

const RATE = 16000;
const BYTES_PER_SAMPLE = 2;

/**
 * Whisper sizes we offer, smallest first, with rough VRAM needs.
 *
 * These are whisper.cpp GGUF weights rather than the incumbent's PyTorch
 * checkpoints, so the same nominal size costs meaningfully less - part of what
 * the comparison is measuring. `large` is `large-v3-turbo`: the registry ships
 * no plain large-v3.
 */
const MODELS = [
  { id: 'tiny', label: 'tiny', minVramGiB: 1, constant: 'WHISPER_TINY_Q8_0' },
  { id: 'base', label: 'base', minVramGiB: 1, constant: 'WHISPER_BASE_Q8_0' },
  { id: 'small', label: 'small', minVramGiB: 2, constant: 'WHISPER_SMALL_Q8_0' },
  { id: 'large-v3', label: 'large-v3-turbo', minVramGiB: 5, constant: 'WHISPER_LARGE_V3_TURBO' },
];

const DEFAULT_SETTINGS = {
  qvacModel: 'base',
  qvacUseGpu: true,
  // VAD is not optional on this engine - whisper streaming refuses to start
  // without it - so there is no switch, only a tuning knob. This is what
  // decides when a line commits, so it is the closest thing here to the
  // incumbent's frame-threshold.
  qvacVadSilenceMs: 0,              // 0 = the addon's own default
  qvacEndOfTurnSilenceMs: 700,

  // EN -> FR, which the registry does not cover. Empty means "refuse rather
  // than pretend": see note 3 above.
  qvacTranslationModelSrc: '',
  qvacTranslationModelType: 'nmt',  // nmt | llm
};

const events = new EventEmitter();

let sdk = null;                     // the imported ESM namespace, once
let server = null;
let currentKey = null;
let state = 'idle';
let loaded = { asrModelId: null, translationModelId: null, vadModelId: null };
const log = [];

function note(line, stream = 'app') {
  const entry = { stream, line, at: Date.now() };
  log.push(entry);
  if (log.length > 400) log.shift();
  events.emit('log', entry);
}

function setState(next, detail) {
  state = next;
  events.emit('state', { state: next, detail: detail || null, port: server?.port ?? null, key: currentKey });
}

/**
 * `@qvac/sdk` is ESM and this file is CJS, so it can only be reached through a
 * dynamic import - which is also what lets the engine register on a machine
 * where it is not installed and report that as health rather than as a crash.
 */
async function loadSdk() {
  if (sdk) return sdk;
  sdk = await import('@qvac/sdk');
  return sdk;
}

/**
 * Which backend QVAC will actually use for this GPU.
 *
 * Mirrors `backendOf` in @qvac/inference's model-fit/assess.js, including the
 * order, because that order is the answer: it tracks the backends the ADDON
 * builds, not the ones the driver advertises. This machine's driver reports
 * `cuda: true` and `vulkan: true`; QVAC picks vulkan, and every load reports
 * `ggml_vulkan`. Reimplemented here rather than imported because it is not
 * part of the public surface - re-check it when bumping the SDK.
 */
const GPU_BACKENDS = ['metal', 'vulkan', 'rocm', 'cuda', 'levelZero', 'opencl'];

function backendOf(gpu) {
  const drivers = gpu?.drivers || {};
  for (const name of GPU_BACKENDS) {
    const driver = drivers[name];
    if (driver?.status === 'supported' && driver.value) return name;
  }
  return null;
}

/** Match the contract's timestamp format: str(timedelta). */
function timestamp(seconds) {
  const whole = Math.floor(seconds);
  const frac = seconds - whole;
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const base = `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return frac < 1e-6 ? base : `${base}.${String(Math.round(frac * 1e6)).padStart(6, '0')}`;
}

// ---------------------------------------------------------------------------
// model loading
// ---------------------------------------------------------------------------

async function ensureModels(plan) {
  const api = await loadSdk();
  const models = await import('@qvac/sdk/models');

  const entry = MODELS.find((m) => m.id === plan.qvac.model) || MODELS[1];
  const modelSrc = models[entry.constant];
  if (!modelSrc) throw new Error(`QVAC registry has no model named ${entry.constant}`);

  note(`loading whisper ${entry.label} (language=${plan.qvac.language}, translate=${plan.qvac.translate}, gpu=${plan.qvac.useGpu})`);

  const modelConfig = {
    language: plan.qvac.language,
    // Whisper's own X -> English task. Free where it applies; see note 3.
    translate: plan.qvac.translate,

    // THE ONE THAT MATTERS MOST. `audio_format` is how the addon interprets the
    // raw bytes we write, and the contract's format is s16le. Leave it unset
    // and 16-bit samples get read as 32-bit floats: no error, no warning, just
    // an empty transcript, because what the model hears is noise. This cost an
    // entire debugging session - a run that "worked" end to end and produced
    // zero captions.
    audio_format: 's16le',

    // Not optional, despite the docs calling it recommended: whisper duplex
    // streaming refuses to start without it ("VAD model name is required for
    // Whisper transcription"). It also does the segmentation, which is what
    // decides when a line commits - so it is doing the job AlignAtt does on the
    // other engine, far more bluntly.
    vadModelSrc: models.VAD_SILERO_5_1_2,

    // GPU selection is nested under contextParams, not top level - the config
    // schema rejects a stray `use_gpu` outright, which is the good kind of
    // failure. Note the default is FALSE: forget this and the engine quietly
    // runs on CPU and looks far slower than it is.
    contextParams: {
      use_gpu: plan.qvac.useGpu,
      flash_attn: plan.qvac.useGpu,
    },
  };

  if (plan.qvac.vadThresholdMs) {
    modelConfig.vad_params = { min_silence_duration_ms: plan.qvac.vadThresholdMs };
  }

  loaded.asrModelId = await api.loadModel({
    modelSrc,
    modelType: 'whisper',
    modelConfig,
    onProgress: (p) => {
      if (p?.percent != null) note(`  weights ${Math.round(p.percent)}%`);
    },
  });
  note(`whisper ready: ${loaded.asrModelId}`);

  if (plan.qvac.translationSrc) {
    note(`loading translation model (${plan.qvac.translationType})`);
    loaded.translationModelId = await api.loadModel({
      modelSrc: plan.qvac.translationSrc,
      modelType: plan.qvac.translationType === 'llm' ? 'llm' : 'nmt',
    });
    note(`translation ready: ${loaded.translationModelId}`);
  }
}

async function unloadModels() {
  if (!sdk) return;
  for (const key of ['asrModelId', 'translationModelId', 'vadModelId']) {
    const id = loaded[key];
    if (!id) continue;
    try {
      await sdk.unloadModel({ modelId: id });
    } catch (err) {
      note(`unloadModel(${id}) failed: ${err.message}`, 'err');
    }
    loaded[key] = null;
  }
}

// ---------------------------------------------------------------------------
// one client session
// ---------------------------------------------------------------------------

async function onConnection(ws, url, plan) {
  const api = await loadSdk();
  ws.sendJson({ type: 'config', useAudioWorklet: true, mode: 'full' });

  // Contract state: `lines` is a full snapshot, so the engine keeps the whole
  // transcript and re-sends it. QVAC hands us segments; the mapping is
  // one segment -> one line.
  const lines = [];
  let buffer = '';
  let samples = 0;
  let ended = false;

  // QVAC restarts its timestamps at every VAD segment; these rebuild a session
  // timeline from them. See the comment where they are used.
  let segmentOffsetSec = 0;
  let lastSegmentEndSec = 0;
  let lastSegmentId = -1;

  // `metadata: true` is what makes the segments carry timings, which the
  // contract needs for `start`/`end`.
  //
  // `emitVadEvents: true` is deliberately NOT passed. On @qvac/sdk 0.19 it
  // makes the iterator yield nothing at all - no events, no error, the loop
  // simply never produces - so the whole transcript silently disappears. The
  // VAD still runs and still does the segmentation; we just do not ask to be
  // told about it. Re-test on an SDK bump before adding it back.
  const session = await api.transcribeStream({
    modelId: loaded.asrModelId,
    metadata: true,
  });

  const publish = () => {
    ws.sendJson({
      status: 'active_transcription',
      lines,
      buffer_transcription: buffer,
      buffer_translation: '',
      buffer_diarization: '',
      remaining_time_transcription: 0,
    });
  };

  ws.on('message', ({ binary, data }) => {
    if (!binary) return;
    if (data.length === 0) {
      ended = true;
      session.end();                          // the contract's end-of-audio
      return;
    }
    samples += data.length / BYTES_PER_SAMPLE;
    // Raw 16 kHz mono s16le, exactly what the AudioWorklet produces. QVAC lists
    // `.raw` among its supported formats, so no container and no FFmpeg.
    session.write(new Uint8Array(data.buffer, data.byteOffset, data.length));
  });

  ws.on('close', () => {
    try { session.destroy(); } catch { /* already gone */ }
  });

  // Drain the session. Events are a discriminated union; `metadata: true` makes
  // the transcript arm carry timings.
  (async () => {
    try {
      for await (const event of session) {
        // With metadata the iterator yields segments; with emitVadEvents it can
        // also yield VAD and end-of-turn events. Discriminate on shape rather
        // than trusting one to be present.
        if (typeof event === 'string') {
          lines.push({ speaker: 1, text: event, start: timestamp(0), end: timestamp(samples / RATE) });
          publish();
          continue;
        }

        if (event?.type === 'vad') {
          // Not part of the contract; carried along as an extra field is not
          // worth it, but it is worth showing in the log while comparing how
          // the two engines decide a segment ended.
          continue;
        }
        if (event?.type === 'endOfTurn') continue;

        if (event?.text != null) {
          // startMs/endMs are relative to the VAD SEGMENT, not to the session:
          // both reset to 0 every time the VAD closes a segment, and so does
          // `id`. Taken at face value every line claims to start at 0:00:00,
          // which makes the contract's timeline meaningless and every latency
          // measurement wrong. Track where each segment began and add it back.
          if ((event.id ?? 0) <= lastSegmentId && (event.startMs ?? 0) === 0) {
            segmentOffsetSec = lastSegmentEndSec;
          }
          lastSegmentId = event.id ?? 0;

          const startSec = segmentOffsetSec + (event.startMs ?? 0) / 1000;
          const endSec = segmentOffsetSec + (event.endMs ?? 0) / 1000;
          lastSegmentEndSec = Math.max(lastSegmentEndSec, endSec);

          const start = timestamp(startSec);
          const end = timestamp(endSec);

          // `append` means this segment extends the previous one rather than
          // starting a new line.
          if (event.append && lines.length) {
            lines[lines.length - 1].text += event.text;
            lines[lines.length - 1].end = end;
          } else {
            lines.push({ speaker: 1, text: event.text, start, end, detected_language: plan.qvac.language });
          }

          if (plan.qvac.translationSrc && loaded.translationModelId) {
            translateLine(api, lines[lines.length - 1], plan).then(publish).catch((err) => {
              note(`translate failed: ${err.message}`, 'err');
            });
          }
          publish();
        }
      }

      if (ended) {
        buffer = '';
        publish();
        ws.sendJson({ type: 'ready_to_stop' });
      }
    } catch (err) {
      // A failed stream must not look like a quiet one. Sending only
      // ready_to_stop here turned "VAD model name is required" into a clean run
      // with zero captions, which is the single worst way this app can fail:
      // the UI says Ready and the screen stays blank. Put it in the log, put it
      // on the wire, and let the shell surface it.
      note(`transcription failed: ${err.message}`, 'err');
      events.emit('log', { stream: 'err', line: err.message, at: Date.now() });
      ws.sendJson({ status: 'error', message: err.message, lines, buffer_transcription: '' });
      ws.sendJson({ type: 'ready_to_stop' });
    }
  })();
}

async function translateLine(api, line, plan) {
  const result = api.translate({
    modelId: loaded.translationModelId,
    text: line.text,
    from: plan.qvac.language,
    to: plan.qvac.targetLanguage,
    modelType: plan.qvac.translationType,
    stream: false,
  });
  line.translation = await result.text;
}

// ---------------------------------------------------------------------------

module.exports = {
  id: 'qvac',
  label: 'QVAC',
  description: 'Tether QVAC SDK: whisper.cpp on a Bare worker. No Python. Vulkan on Windows.',

  capabilities: {
    real: true,
    diarization: false,        // Parakeet Sortformer could; not wired up
    vad: true,
    nativeEnglish: true,       // and it is the ONLY translation path that ships
    gpuBackend: 'vulkan',      // on win32-x64. Not CUDA - see the note at the top.
  },

  defaultSettings: DEFAULT_SETTINGS,
  events,

  models: () => MODELS.map(({ id, label, minVramGiB }) => ({ id, label, minVramGiB })),

  recommendModel(vramGiB) {
    if (!vramGiB || Number.isNaN(vramGiB)) return 'base';
    let choice = MODELS[0].id;
    for (const m of MODELS) if (vramGiB >= m.minVramGiB) choice = m.id;
    return choice;
  },

  async inspect() {
    let api;
    try {
      api = await loadSdk();
    } catch (err) {
      return {
        ok: false,
        problem: 'no-qvac-sdk',
        label: '@qvac/sdk is not installed',
        title: 'Rtranslate needs to finish setting up',
        setupLead:
          'This engine needs the QVAC runtime — prebuilt binaries, no Python and no ' +
          'CUDA toolkit. About 800 MB for this platform, once.',
        fixHint: 'Run npm install to fetch the QVAC runtime.',
        message: err.message,
        info: {},
      };
    }

    // Ask QVAC what it thinks the machine can do, rather than asserting it.
    // This is also where the Vulkan-not-CUDA claim can be confirmed per box.
    let resources = null;
    try {
      resources = await api.getSystemResources?.();
    } catch (err) {
      note(`getSystemResources failed: ${err.message}`, 'err');
    }

    const gpu = resources?.capabilities?.gpus?.value?.[0] || null;
    const backend = backendOf(gpu);
    const vram = gpu?.memoryTotalBytes?.value ?? gpu?.memoryTotalBytes ?? null;

    return {
      ok: true,
      problem: null,
      message: '',
      info: {
        SDK: '@qvac/sdk',
        // Worth spelling out where it will be read: a box whose driver
        // advertises CUDA still runs Vulkan here, because the shipped addon
        // has no CUDA build. Verified on an RTX PRO 6000 whose driver reports
        // cuda:true and which QVAC nonetheless places on Vulkan.
        Backend: backend ? `${backend}${backend === 'vulkan' ? ' (no CUDA build ships)' : ''}` : 'CPU',
        'GPU (QVAC)': gpu?.name?.value || '—',
        vramGiB: typeof vram === 'number' ? Number((vram / 1024 ** 3).toFixed(1)) : null,
      },
    };
  },

  /**
   * The profile key carries the model, the spoken language and the translate
   * flag, because all three are `loadModel()` arguments here - changing any of
   * them is a reload, and the UI needs to say so before the user does it.
   */
  plan(settings, sourceId, targetId) {
    const merged = { ...DEFAULT_SETTINGS, ...settings };
    const source = byId(sourceId);
    const target = byId(targetId);
    if (!source || !target) throw new Error(`Unknown language: ${sourceId} -> ${targetId}`);

    const translate = target.id !== source.id;

    // Whisper's native task only goes TO English. That is the whole of what
    // ships, so it is the preferred route whenever it applies.
    const useNative = translate && target.id === 'en' && source.id !== 'en';
    const needsNmt = translate && !useNative;

    let reason;
    if (!translate) {
      reason = 'transcription only';
    } else if (useNative) {
      reason = "Whisper's native translate task — no second model, no sentence gate";
    } else if (merged.qvacTranslationModelSrc) {
      reason = `${merged.qvacTranslationModelType.toUpperCase()} translation model`;
    } else {
      // Say it rather than quietly transcribing and letting someone believe
      // they are reading a translation.
      reason =
        `QVAC ships no ${source.id}→${target.id} translation model. ` +
        'Set a translation model in Settings, or read the source language.';
    }

    const params = new URLSearchParams();
    params.set('language', source.whisper);
    if (translate && target.nllb) params.set('target_language', target.nllb);

    const qvac = {
      model: merged.qvacModel,
      language: source.whisper === 'auto' ? 'auto' : source.id,
      targetLanguage: target.id,
      translate: useNative,
      useGpu: Boolean(merged.qvacUseGpu),
      vadThresholdMs: Number(merged.qvacVadSilenceMs) || 0,
      endOfTurnSilenceMs: Number(merged.qvacEndOfTurnSilenceMs),
      translationSrc: needsNmt ? merged.qvacTranslationModelSrc || '' : '',
      translationType: merged.qvacTranslationModelType,
    };

    return {
      route: { translate, useNative, useNllb: needsNmt, reason },
      qvac,
      // Everything in here is a loadModel() argument.
      profileKey: [
        'qvac', qvac.model, qvac.language, qvac.translate, qvac.useGpu, qvac.vadThresholdMs, qvac.translationSrc,
      ].join(' '),
      query: params.toString(),
      display: {
        primaryField: needsNmt ? 'translation' : 'text',
        secondaryField: null,
        bufferField: 'buffer_transcription',
        note: reason,
      },
    };
  },

  async ensure(plan) {
    if (server && currentKey === plan.profileKey) {
      return { port: server.port, restarted: false };
    }

    const restarted = Boolean(server);
    if (server) await this.stop();

    setState('starting');
    try {
      // Models load before the port is handed back, so the first socket does
      // not sit waiting on a download.
      await ensureModels(plan);

      server = new MiniWsServer({ path: '/asr' });
      server.on('connection', (ws, url) => {
        onConnection(ws, url, plan).catch((err) => {
          note(`session failed: ${err.message}`, 'err');
          try { ws.close(); } catch { /* gone */ }
        });
      });

      const port = await server.listen(0);
      currentKey = plan.profileKey;
      setState('ready');
      note(`qvac engine listening on ws://127.0.0.1:${port}/asr`);
      return { port, restarted };
    } catch (err) {
      setState('error', err.message);
      await this.stop();
      throw err;
    }
  },

  async stop() {
    if (!server && !loaded.asrModelId && !sdk) return;
    setState('stopping');

    const s = server;
    server = null;
    currentKey = null;
    if (s) await s.close();

    // Unload before saying stopped: the whole point is not to leave weights on
    // the GPU, which is the same failure the Python engine guards against.
    await unloadModels();

    // And close the Bare worker itself. Importing @qvac/sdk starts a worker
    // process that holds the event loop open - without this the app never
    // quits and a one-shot script hangs forever after its last await.
    if (sdk) {
      try {
        await sdk.close();
      } catch (err) {
        note(`sdk.close() failed: ${err.message}`, 'err');
      }
      sdk = null;
    }

    setState('stopped');
  },

  state: () => state,
  port: () => server?.port ?? null,
  currentKey: () => currentKey,
  logs: () => log.slice(),
};
