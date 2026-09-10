/**
 * Session planning: turn (settings + chosen languages) into server flags and a
 * WebSocket query, and decide whether the sidecar has to restart.
 *
 * This is the module that absorbs the biggest Phase 0 unknown, so it is pure
 * and unit-tested: no Electron, no I/O.
 *
 * ---------------------------------------------------------------------------
 * The unknown
 * ---------------------------------------------------------------------------
 * `--direct-english-translation` is a SERVER flag. `language` and
 * `target_language` are PER-SESSION query parameters. It is undocumented
 * whether one server can honour both paths at once, and if it cannot, turning
 * the flag on would make *every* session emit English - including FR->FR, which
 * would silently break plain transcription.
 *
 * So the default is the safe one: everything routes through NLLB. All four
 * pairs are correct, one server profile covers them, and the sidecar never
 * restarts during normal use. EN->FR and FR->EN both cost the sentence gate.
 *
 * `preferNativeEnglish: true` opts into the fast FR->EN path. Because we cannot
 * assume coexistence, that toggles a server flag and therefore forces a restart
 * when the user switches direction - which the UI shows honestly.
 *
 * If Phase 0 proves the two coexist, set `nativeAndNllbCoexist: true` and the
 * restart disappears: both flags ship in one profile and only the query changes.
 */

const { byId } = require('../../../shared/languages.cjs');

const DEFAULT_SETTINGS = {
  // --- model ---------------------------------------------------------------
  model: 'large-v3',           // tiny | base | small | medium | large-v3
  backend: 'simulstreaming',   // simulstreaming | faster-whisper
  policy: 'simulstreaming',    // simulstreaming | localagreement
  frameThreshold: 20,          // AlignAtt lookahead, in 0.02 s frames
  pauseSegmentationSeconds: 5.0,

  // --- translation ---------------------------------------------------------
  translationEnabled: true,
  nllbSize: '600M',            // 600M | 1.3B
  nllbBackend: 'ctranslate2',  // ctranslate2 | transformers

  // --- the Phase 0 unknowns, as settings rather than assumptions -----------
  preferNativeEnglish: false,  // use Whisper's own translate task for X->EN
  nativeAndNllbCoexist: false, // set true once P0 proves one server does both

  // --- display -------------------------------------------------------------
  dualPane: false,             // show source transcript alongside translation
};

/** Model sizes we will offer, smallest first, with rough VRAM needs. */
const MODELS = [
  { id: 'small', label: 'small', minVramGiB: 2 },
  { id: 'medium', label: 'medium', minVramGiB: 5 },
  { id: 'large-v3', label: 'large-v3', minVramGiB: 10 },
];

/**
 * Pick a default model for the detected card rather than letting the user
 * discover the limit as an out-of-memory crash two minutes into a session.
 * The large-v3 threshold is UFAL's >=10 GB guidance for the SimulStreaming
 * path; Phase 0 may well show it is conservative.
 */
function recommendModel(vramGiB) {
  if (!vramGiB || Number.isNaN(vramGiB)) return 'medium';
  let choice = MODELS[0].id;
  for (const m of MODELS) {
    if (vramGiB >= m.minVramGiB) choice = m.id;
  }
  return choice;
}

/**
 * Decide how a given source->target pair should be served.
 * @returns {{translate:boolean, useNative:boolean, useNllb:boolean, reason:string}}
 */
function routeFor(settings, sourceId, targetId) {
  const source = byId(sourceId);
  const target = byId(targetId);
  if (!source || !target) throw new Error(`Unknown language: ${sourceId} -> ${targetId}`);

  // Auto source with a fixed target is ambiguous: if the speaker happens to be
  // speaking the target language we would be "translating" en->en. The server
  // handles that harmlessly, so we allow it, but there is no native shortcut.
  const translate = target.id !== source.id;

  if (!translate) {
    return { translate: false, useNative: false, useNllb: false, reason: 'same language, transcription only' };
  }

  const nativeEligible =
    settings.preferNativeEnglish &&
    target.id === 'en' &&
    source.id !== 'en' &&
    !settings.dualPane; // native mode replaces the source text; it cannot show both

  if (nativeEligible) {
    return {
      translate: true,
      useNative: true,
      useNllb: false,
      reason: "Whisper's native translate task - no second model, no sentence gate",
    };
  }

  let reason = 'NLLB-200, sentence-gated';
  if (settings.preferNativeEnglish && target.id === 'en' && settings.dualPane) {
    reason = 'NLLB - native English mode cannot show the source text alongside';
  }
  return { translate: true, useNative: false, useNllb: true, reason };
}

/**
 * Build the server argument list for a session. The port is appended later by
 * the sidecar, which owns port selection.
 */
function serverArgsFor(settings, route) {
  const args = [
    '--model', String(settings.model),
    '--backend', String(settings.backend),
    '--backend-policy', String(settings.policy),
    '--pcm-input',
    '--host', '127.0.0.1',
    '--pause-segmentation-seconds', String(settings.pauseSegmentationSeconds),
  ];

  // frame-threshold only means anything under the AlignAtt policy.
  if (settings.policy === 'simulstreaming') {
    args.push('--frame-threshold', String(settings.frameThreshold));
  }

  // Load NLLB whenever translation is enabled at all, not only when this
  // particular session needs it. Keeping it resident means switching direction
  // never reloads a model - and on the ctranslate2 backend it is CPU-friendly,
  // so it is not competing for VRAM.
  if (settings.translationEnabled) {
    args.push(
      '--translation-backend', 'nllb',
      '--nllb-backend', String(settings.nllbBackend),
      '--nllb-size', String(settings.nllbSize),
    );
  }

  if (route.useNative || (settings.preferNativeEnglish && settings.nativeAndNllbCoexist)) {
    args.push('--direct-english-translation');
  }

  return args;
}

/** Args that define the *process*. Change one and the sidecar must restart. */
function profileKey(args) {
  return args.join(' ');
}

/** Query parameters for the /asr WebSocket - changing these is just a reconnect. */
function queryFor(settings, route, sourceId, targetId) {
  const source = byId(sourceId);
  const target = byId(targetId);
  const params = new URLSearchParams();
  params.set('language', source.whisper);

  // Native mode carries the translation inside the ASR output, so it must NOT
  // also ask for a target_language - that would hand the job to NLLB as well.
  if (route.useNllb && target.nllb) {
    params.set('target_language', target.nllb);
  }
  return params.toString();
}

/**
 * Full plan for a session.
 * @returns {{route, serverArgs, profileKey, query, display}}
 */
function planSession(settings, sourceId, targetId) {
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  const route = routeFor(merged, sourceId, targetId);
  const serverArgs = serverArgsFor(merged, route);

  return {
    route,
    serverArgs,
    profileKey: profileKey(serverArgs),
    query: queryFor(merged, route, sourceId, targetId),
    display: {
      // Which field of each line carries the text the user asked to read.
      // In native mode the ASR output IS the English, so it is `text`.
      primaryField: route.useNllb ? 'translation' : 'text',
      secondaryField: merged.dualPane && route.useNllb ? 'text' : null,
      bufferField: route.useNllb ? 'buffer_translation' : 'buffer_transcription',
      note: route.reason,
    },
  };
}

module.exports = {
  DEFAULT_SETTINGS,
  MODELS,
  recommendModel,
  routeFor,
  serverArgsFor,
  profileKey,
  queryFor,
  planSession,
};
