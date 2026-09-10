/**
 * The mock engine: the contract with known, deliberate lags and no inference.
 *
 * It is a real engine, not a test double - it registers like the others, the
 * UI can select it, and `spike/profile.mjs` profiles it. Two things fall out of
 * that:
 *
 *   1. `main` is runnable and testable on any machine. No GPU, no Python, no
 *      4 GB download, no Bare runtime.
 *   2. The harness can be validated against known answers. Inject a 1.20 s
 *      transcript lag and a 2.50 s translation lag and check the numbers come
 *      back - which is how we know a measured difference between the two real
 *      engines is real.
 *
 * A port of spike/mock_server.py, which needed Python and a `websockets`
 * install to do the same job.
 *
 * It counts received PCM samples to know what "now" is in audio time, and
 * commits fixed segments once they fall far enough behind that clock. No audio
 * is ever decoded.
 */

const { MiniWsServer } = require('../miniws');
const { byId } = require('../../shared/languages.cjs');

const RATE = 16000;
const BYTES_PER_SAMPLE = 2;
const SEGMENT_SECONDS = 2.0;
const TICK_MS = 200;

/** Defaults chosen to be obviously not-real, so nobody mistakes mock for measured. */
const DEFAULTS = {
  transcriptLagSec: 1.2,
  translationLagSec: 2.5,
};

let server = null;
let currentKey = null;
let state = 'idle';
const log = [];

function note(line) {
  log.push({ stream: 'app', line, at: Date.now() });
  if (log.length > 400) log.shift();
}

/** Match the server's format: str(timedelta), e.g. '0:00:04' or '0:00:03.250000'. */
function timestamp(seconds) {
  const whole = Math.floor(seconds);
  const frac = seconds - whole;
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const base = `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  if (frac < 1e-6) return base;
  return `${base}.${String(Math.round(frac * 1e6)).padStart(6, '0')}`;
}

function onConnection(ws, url, opts) {
  const wantsTranslation = url.searchParams.has('target_language');

  ws.sendJson({ type: 'config', useAudioWorklet: true, mode: 'full' });

  let samples = 0;
  let eos = false;
  let lastCommitted = null;

  const timer = setInterval(() => {
    let audioT = samples / RATE;
    if (eos) audioT += 99;                    // flush everything after end-of-audio

    const nCommit = Math.max(0, Math.floor((audioT - opts.transcriptLagSec) / SEGMENT_SECONDS));
    const nTrans = wantsTranslation
      ? Math.max(0, Math.floor((audioT - opts.translationLagSec) / SEGMENT_SECONDS))
      : 0;

    if (nCommit === 0) return;

    // Deduplicate on both counts, not just the commit count. A translation
    // arriving for a line that was already committed is a state change the
    // client must see - suppressing it made translations look one whole
    // segment slower than the lag we injected.
    const shape = `${nCommit}:${nTrans}`;
    if (shape === lastCommitted && !eos) return;
    lastCommitted = shape;

    const lines = [];
    for (let i = 0; i < nCommit; i++) {
      const line = {
        speaker: 1,
        text: `segment ${i} spoken words`,
        start: timestamp(i * SEGMENT_SECONDS),
        end: timestamp((i + 1) * SEGMENT_SECONDS),
        detected_language: 'fr',
      };
      if (i < nTrans) line.translation = `traduction du segment ${i}`;
      lines.push(line);
    }

    ws.sendJson({
      status: 'active_transcription',
      lines,
      buffer_transcription: eos ? '' : 'mots en cours',
      buffer_translation: eos || !wantsTranslation ? '' : 'words in flight',
      buffer_diarization: '',
      remaining_time_transcription: opts.transcriptLagSec,
    });

    if (eos) {
      clearInterval(timer);
      ws.sendJson({ type: 'ready_to_stop' });
    }
  }, TICK_MS);

  ws.on('message', ({ binary, data }) => {
    if (!binary) return;
    if (data.length === 0) { eos = true; return; }   // the contract's end-of-audio
    samples += data.length / BYTES_PER_SAMPLE;
  });

  ws.on('close', () => clearInterval(timer));
}

module.exports = {
  id: 'mock',
  label: 'Mock engine',
  description: 'Fixed captions with known lags. No GPU, no models, no inference.',

  capabilities: { diarization: false, vad: false, nativeEnglish: false, real: false },

  async inspect() {
    return { ok: true, problem: null, message: 'Mock engine needs nothing.', info: { engine: 'mock' } };
  },

  /**
   * Every pair is servable and nothing forces a restart, so the plan is almost
   * entirely display. It still routes `translation` vs `text` the same way a
   * real engine does, which is what keeps the renderer honest.
   */
  plan(settings, sourceId, targetId) {
    const source = byId(sourceId);
    const target = byId(targetId);
    if (!source || !target) throw new Error(`Unknown language: ${sourceId} -> ${targetId}`);

    const translate = target.id !== source.id;
    const params = new URLSearchParams();
    params.set('language', source.whisper);
    if (translate && target.nllb) params.set('target_language', target.nllb);

    const opts = {
      transcriptLagSec: Number(settings?.mockTranscriptLagSec ?? DEFAULTS.transcriptLagSec),
      translationLagSec: Number(settings?.mockTranslationLagSec ?? DEFAULTS.translationLagSec),
    };

    return {
      route: { translate, useNative: false, useNllb: translate, reason: 'mock engine' },
      opts,
      profileKey: `mock ${opts.transcriptLagSec} ${opts.translationLagSec}`,
      query: params.toString(),
      display: {
        primaryField: translate ? 'translation' : 'text',
        secondaryField: null,
        bufferField: translate ? 'buffer_translation' : 'buffer_transcription',
        note: `mock: ${opts.transcriptLagSec}s transcript lag, ${opts.translationLagSec}s translation lag`,
      },
    };
  },

  async ensure(plan) {
    if (server && currentKey === plan.profileKey) {
      return { port: server.port, restarted: false };
    }

    const restarted = Boolean(server);
    if (server) await this.stop();

    state = 'starting';
    server = new MiniWsServer({ path: '/asr' });
    server.on('connection', (ws, url) => onConnection(ws, url, plan.opts));
    const port = await server.listen(0);

    currentKey = plan.profileKey;
    state = 'ready';
    note(`mock engine listening on ws://127.0.0.1:${port}/asr`);
    return { port, restarted };
  },

  async stop() {
    if (!server) return;
    state = 'stopping';
    const s = server;
    server = null;
    currentKey = null;
    await s.close();
    state = 'stopped';
    note('mock engine stopped');
  },

  state: () => state,
  logs: () => log.slice(),
};
