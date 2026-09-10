/**
 * Engine profiler.
 *
 * Measures anything that speaks docs/engine-contract.md, which is what makes a
 * WhisperLiveKit-vs-QVAC comparison meaningful: one client, one clock, one set
 * of definitions, pointed at two engines.
 *
 * The Python `measure_latency.py` it replaces did the same job for one engine,
 * but needed the sidecar's own venv to run - so it could never have measured
 * the candidate. This needs only Node >= 22 (for a global WebSocket) and a WAV.
 *
 * Usage:
 *
 *   # against an engine this branch ships, started for you
 *   node spike/profile.mjs --engine mock --wav spike/samples/fr_60s.wav
 *
 *   # against something already running
 *   node spike/profile.mjs --endpoint ws://127.0.0.1:8799/asr --wav fr_60s.wav
 *
 *   # transcribe only, no translation
 *   node spike/profile.mjs --engine mock --wav fr_60s.wav --source fr --target fr
 *
 * Output is a summary table on stdout and, with --json <path>, the full record
 * including every commit event - so two runs can be diffed rather than eyeballed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const RATE = 16000;
const FRAME_MS = 20;                      // what the AudioWorklet sends
const FRAME_SAMPLES = (RATE * FRAME_MS) / 1000;
const FRAME_BYTES = FRAME_SAMPLES * 2;

// ---------------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    engine: null, endpoint: null, wav: null,
    source: 'fr', target: 'en',
    json: null, gpu: true, realtime: true, settings: {},
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--engine': args.engine = next(); break;
      case '--endpoint': args.endpoint = next(); break;
      case '--wav': args.wav = next(); break;
      case '--source': args.source = next(); break;
      case '--target': args.target = next(); break;
      case '--json': args.json = next(); break;
      case '--no-gpu': args.gpu = false; break;
      case '--fast': args.realtime = false; break;   // send as fast as possible
      case '--set': {                                 // --set model=medium
        const [k, v] = next().split('=');
        args.settings[k] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v === 'true' ? true : v === 'false' ? false : v;
        break;
      }
      case '--help': case '-h': args.help = true; break;
      default: throw new Error(`Unknown argument: ${a}`);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// audio
// ---------------------------------------------------------------------------

/**
 * Read a WAV and return its PCM payload, insisting on the one format the
 * contract allows. Being strict here is deliberate: a 44.1 kHz stereo file
 * would "work" and quietly report latency against the wrong clock.
 */
function readWav(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${file} is not a WAV file`);
  }

  let offset = 12;
  let fmt = null;
  let data = null;

  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = buf.subarray(offset + 8, offset + 8 + size);

    if (id === 'fmt ') {
      fmt = {
        format: body.readUInt16LE(0),
        channels: body.readUInt16LE(2),
        rate: body.readUInt32LE(4),
        bits: body.readUInt16LE(14),
      };
    } else if (id === 'data') {
      data = body;
    }
    offset += 8 + size + (size % 2);      // chunks are word-aligned
  }

  if (!fmt || !data) throw new Error(`${file}: missing fmt or data chunk`);
  if (fmt.format !== 1 || fmt.bits !== 16 || fmt.channels !== 1 || fmt.rate !== RATE) {
    throw new Error(
      `${file} is ${fmt.rate} Hz, ${fmt.channels}ch, ${fmt.bits}-bit (format ${fmt.format}). ` +
      'The contract requires 16 kHz mono s16le. Convert it first.',
    );
  }
  return data;
}

// ---------------------------------------------------------------------------
// GPU sampling
// ---------------------------------------------------------------------------

function sampleGpu() {
  return new Promise((resolve) => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=memory.used,utilization.gpu', '--format=csv,noheader,nounits'],
      { timeout: 4000 },
      (err, stdout) => {
        if (err) return resolve(null);
        const [mem, util] = String(stdout).trim().split('\n')[0].split(',').map((s) => Number(s.trim()));
        resolve({ vramMiB: mem, utilPct: util });
      },
    );
  });
}

// ---------------------------------------------------------------------------
// timestamps
// ---------------------------------------------------------------------------

/** '0:00:03' / '0:00:03.250000' -> 3.25. Tolerant by design; engines vary. */
function parseTimestamp(value) {
  if (value == null) return null;
  if (typeof value === 'number') return value;
  const parts = String(value).split(':');
  if (parts.length !== 3) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  const [h, m, s] = parts;
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

async function profile({ endpoint, pcm, source, target, realtime, gpu }) {
  const url = new URL(endpoint);
  url.searchParams.set('language', source);
  if (target && target !== source) {
    url.searchParams.set('target_language', nllbCode(target));
  }

  const record = {
    endpoint: url.toString(),
    audioSeconds: pcm.length / 2 / RATE,
    realtime,
    config: null,
    events: [],          // every state change we can time
    commits: [],         // { index, audioEnd, wallAt, latency, kind }
    gpuSamples: [],
    firstPartialAt: null,
    firstCommitAt: null,
    readyToStopAt: null,
    warnings: [],
  };

  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';

  const seenText = new Map();          // line index -> committed wall time
  const seenTranslation = new Map();
  let started = 0;
  let finished = null;

  const done = new Promise((resolve, reject) => {
    ws.onerror = () => reject(new Error(`Cannot reach ${url.origin} - is the engine running?`));
    ws.onclose = () => resolve('closed');
    finished = resolve;
  });

  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return;
    const now = performance.now();
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.type === 'config') {
      record.config = msg;
      if (msg.useAudioWorklet === false) {
        record.warnings.push(
          'Engine reported useAudioWorklet:false while being sent raw PCM. ' +
          'Everything downstream is garbage - it is trying to decode our samples as a container.',
        );
      }
      return;
    }

    if (msg.type === 'ready_to_stop') {
      record.readyToStopAt = now - started;
      finished('ready_to_stop');
      return;
    }

    // Provisional text: the first sign of life the user actually sees.
    const buffer = msg.buffer_transcription || msg.buffer_translation || '';
    if (buffer && record.firstPartialAt === null) {
      record.firstPartialAt = now - started;
      record.events.push({ at: record.firstPartialAt, what: 'first partial' });
    }

    const lines = Array.isArray(msg.lines) ? msg.lines : [];
    lines.forEach((line, i) => {
      if (line?.speaker === -2 || line?.text == null) return;   // silence marker

      const audioEnd = parseTimestamp(line.end);

      if (line.text && !seenText.has(i)) {
        seenText.set(i, now);
        if (record.firstCommitAt === null) {
          record.firstCommitAt = now - started;
          record.events.push({ at: record.firstCommitAt, what: 'first commit' });
        }
        record.commits.push({
          index: i, kind: 'text', audioEnd,
          wallAt: (now - started) / 1000,
          latency: audioEnd == null ? null : (now - started) / 1000 - audioEnd,
        });
      }

      if (line.translation && !seenTranslation.has(i)) {
        seenTranslation.set(i, now);
        record.commits.push({
          index: i, kind: 'translation', audioEnd,
          wallAt: (now - started) / 1000,
          latency: audioEnd == null ? null : (now - started) / 1000 - audioEnd,
        });
      }
    });
  };

  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    setTimeout(() => reject(new Error('Timed out waiting for the engine to accept a socket')), 30000);
  });

  started = performance.now();

  const gpuTimer = gpu
    ? setInterval(async () => {
        const s = await sampleGpu();
        if (s) record.gpuSamples.push({ at: (performance.now() - started) / 1000, ...s });
      }, 1000)
    : null;

  // Feed the audio. In realtime mode we pace to the wall clock, because a
  // streaming engine's latency is only meaningful against real-time input -
  // firehosing the file measures throughput, which is a different question.
  for (let off = 0; off < pcm.length; off += FRAME_BYTES) {
    const frame = pcm.subarray(off, Math.min(off + FRAME_BYTES, pcm.length));
    ws.send(frame);

    if (realtime) {
      const shouldBeAt = ((off + frame.length) / 2 / RATE) * 1000;
      const drift = shouldBeAt - (performance.now() - started);
      if (drift > 1) await new Promise((r) => setTimeout(r, drift));
    }
  }

  ws.send(new ArrayBuffer(0));                    // end-of-audio
  record.audioSentAt = (performance.now() - started) / 1000;

  const outcome = await Promise.race([
    done,
    new Promise((r) => setTimeout(() => r('timeout'), 60000)),
  ]);
  record.outcome = outcome;

  if (gpuTimer) clearInterval(gpuTimer);
  try { ws.close(); } catch { /* already closing */ }

  return summarise(record);
}

/** Minimal ISO 639-1 -> NLLB. The shell has the full table; the harness needs four. */
function nllbCode(id) {
  const table = { en: 'eng_Latn', fr: 'fra_Latn', es: 'spa_Latn', de: 'deu_Latn' };
  return table[id] || id;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function summarise(record) {
  // Commits arriving after end-of-audio are real latency, but distorted by
  // flush semantics rather than representative of live use. Keep them, report
  // them apart.
  const live = record.commits.filter((c) => c.latency != null && c.wallAt <= record.audioSentAt);
  const textLive = live.filter((c) => c.kind === 'text').map((c) => c.latency);
  const transLive = live.filter((c) => c.kind === 'translation').map((c) => c.latency);

  // Only live commits, for the same reason the latency stats exclude the flush:
  // after end-of-audio the engine dumps every remaining line at once, text and
  // translation together, so those pairs all have a lag of zero. Include them
  // and a long tail of flushed segments drags the median to 0 - which reads as
  // "translation is instant" when it is nothing of the kind.
  const translationLag = [];
  const byIndex = new Map();
  for (const c of live) {
    if (!byIndex.has(c.index)) byIndex.set(c.index, {});
    byIndex.get(c.index)[c.kind] = c.wallAt;
  }
  for (const pair of byIndex.values()) {
    if (pair.text != null && pair.translation != null) translationLag.push(pair.translation - pair.text);
  }

  record.summary = {
    audioSeconds: Number(record.audioSeconds.toFixed(2)),
    firstPartialSec: record.firstPartialAt == null ? null : Number((record.firstPartialAt / 1000).toFixed(3)),
    firstCommitSec: record.firstCommitAt == null ? null : Number((record.firstCommitAt / 1000).toFixed(3)),
    commitsDuringAudio: live.length,
    commitsAfterAudio: record.commits.length - live.length,
    textLatency: {
      median: round(percentile(textLive, 50)),
      p90: round(percentile(textLive, 90)),
      max: round(textLive.length ? Math.max(...textLive) : null),
    },
    translationLatency: {
      median: round(percentile(transLive, 50)),
      p90: round(percentile(transLive, 90)),
    },
    translationLagMedian: round(percentile(translationLag, 50)),
    flushSec: record.readyToStopAt == null ? null : round(record.readyToStopAt / 1000 - record.audioSentAt),
    peakVramMiB: record.gpuSamples.length ? Math.max(...record.gpuSamples.map((s) => s.vramMiB)) : null,
    meanGpuUtilPct: record.gpuSamples.length
      ? Math.round(record.gpuSamples.reduce((a, s) => a + s.utilPct, 0) / record.gpuSamples.length)
      : null,
  };
  return record;
}

function round(v) {
  return v == null || Number.isNaN(v) ? null : Number(v.toFixed(3));
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

function report(record, label) {
  const s = record.summary;
  const row = (k, v, unit = 's') => console.log(`  ${k.padEnd(28)} ${v == null ? '—' : `${v}${unit}`}`);

  console.log(`\n${label}`);
  console.log('  ' + '-'.repeat(46));
  row('audio length', s.audioSeconds);
  row('time to first partial', s.firstPartialSec);
  row('time to first commit', s.firstCommitSec);
  console.log('');
  row('commit latency (median)', s.textLatency.median);
  row('commit latency (p90)', s.textLatency.p90);
  row('commit latency (max)', s.textLatency.max);
  if (s.translationLatency.median != null) {
    row('translation latency (median)', s.translationLatency.median);
    row('translation behind text', s.translationLagMedian);
  }
  console.log('');
  row('commits during audio', s.commitsDuringAudio, '');
  row('commits after end-of-audio', s.commitsAfterAudio, '');
  row('flush after end-of-audio', s.flushSec);
  if (s.peakVramMiB != null) {
    row('peak VRAM', s.peakVramMiB, ' MiB');
    row('mean GPU utilisation', s.meanGpuUtilPct, '%');
  }
  if (record.outcome !== 'ready_to_stop') {
    console.log(`\n  ! run ended as "${record.outcome}", not ready_to_stop`);
  }
  for (const w of record.warnings) console.log(`\n  ! ${w}`);
  console.log('');
}

// ---------------------------------------------------------------------------

const USAGE = `
Profile any engine that speaks docs/engine-contract.md.

  --engine <id>        start an engine this branch ships (mock, whisperlivekit, qvac)
  --endpoint <ws url>  profile something already running instead
  --wav <path>         16 kHz mono s16le WAV to speak (required)
  --source <iso>       spoken language        (default fr)
  --target <iso>       display language       (default en; same as source = no translation)
  --set k=v            engine setting override, repeatable
  --fast               send audio as fast as possible (throughput, not latency)
  --no-gpu             skip nvidia-smi sampling
  --json <path>        write the full record, including every commit event
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.engine && !args.endpoint)) {
    console.log(USAGE);
    process.exit(args.help ? 0 : 1);
  }
  if (!args.wav) throw new Error('--wav is required: latency against silence is not a measurement.');

  const wavPath = path.isAbsolute(args.wav) ? args.wav : path.resolve(ROOT, args.wav);
  const pcm = readWav(wavPath);

  let endpoint = args.endpoint;
  let engine = null;
  let label = `${args.endpoint} · ${path.basename(wavPath)} · ${args.source}->${args.target}`;

  if (args.engine) {
    const registry = require('../src/main/engines');
    engine = registry.get(args.engine);
    if (engine.id !== args.engine) {
      throw new Error(`This branch has no engine "${args.engine}". It ships: ${registry.list().map((e) => e.id).join(', ')}`);
    }

    const health = await engine.inspect();
    if (!health.ok) throw new Error(`Engine "${engine.id}" cannot run here: ${health.message}`);

    const plan = engine.plan(args.settings, args.source, args.target);
    process.stdout.write(`starting ${engine.label}… `);
    const { port } = await engine.ensure(plan);
    console.log(`ready on ${port}`);
    console.log(`  route: ${plan.display.note}`);

    endpoint = `ws://127.0.0.1:${port}/asr`;
    label = `${engine.label} · ${path.basename(wavPath)} · ${args.source}->${args.target}`;
  }

  try {
    const record = await profile({ ...args, endpoint, pcm });
    record.engine = engine?.id || 'external';
    record.label = label;
    report(record, label);

    if (args.json) {
      fs.writeFileSync(path.resolve(ROOT, args.json), JSON.stringify(record, null, 2));
      console.log(`  full record -> ${args.json}\n`);
    }
  } finally {
    if (engine) await engine.stop();
  }
}

// Exported so the summary maths can be unit-tested against hand-built records.
// The stats are the whole point of this file; a quiet arithmetic error here
// would not crash anything, it would just make one engine look better.
export { summarise, parseTimestamp, readWav, percentile, nllbCode };

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((err) => {
    console.error(`\nprofile: ${err.message}\n`);
    process.exit(1);
  });
}
