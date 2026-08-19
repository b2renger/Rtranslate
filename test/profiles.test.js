const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_SETTINGS,
  planSession,
  recommendModel,
  routeFor,
} = require('../src/main/profiles');

const base = { ...DEFAULT_SETTINGS };

function query(plan) {
  return new URLSearchParams(plan.query);
}

test('same language is transcription only', () => {
  const plan = planSession(base, 'fr', 'fr');
  assert.equal(plan.route.translate, false);
  assert.equal(plan.route.useNllb, false);
  assert.equal(plan.route.useNative, false);
  assert.equal(query(plan).get('language'), 'fr');
  assert.equal(query(plan).has('target_language'), false);
  assert.equal(plan.display.primaryField, 'text');
  assert.equal(plan.display.bufferField, 'buffer_transcription');
});

test('by default FR->EN goes through NLLB, not the native path', () => {
  // The safe default: we have not verified that --direct-english-translation
  // can coexist with per-session target_language, and getting it wrong would
  // silently turn FR->FR transcription into English.
  const plan = planSession(base, 'fr', 'en');
  assert.equal(plan.route.useNllb, true);
  assert.equal(plan.route.useNative, false);
  assert.equal(query(plan).get('target_language'), 'eng_Latn');
  assert.equal(plan.serverArgs.includes('--direct-english-translation'), false);
  assert.equal(plan.display.primaryField, 'translation');
  assert.equal(plan.display.bufferField, 'buffer_translation');
});

test('opting into native English uses the server flag and drops target_language', () => {
  const settings = { ...base, preferNativeEnglish: true };
  const plan = planSession(settings, 'fr', 'en');
  assert.equal(plan.route.useNative, true);
  assert.equal(plan.route.useNllb, false);
  assert.ok(plan.serverArgs.includes('--direct-english-translation'));
  // Critical: asking for target_language as well would hand the job to NLLB too.
  assert.equal(query(plan).has('target_language'), false);
  // In native mode the ASR output IS the English, so it arrives in `text`.
  assert.equal(plan.display.primaryField, 'text');
});

test('EN->FR always needs NLLB - there is no native path to French', () => {
  const settings = { ...base, preferNativeEnglish: true };
  const plan = planSession(settings, 'en', 'fr');
  assert.equal(plan.route.useNllb, true);
  assert.equal(plan.route.useNative, false);
  assert.equal(query(plan).get('target_language'), 'fra_Latn');
});

test('dual pane forces NLLB even when native was requested', () => {
  // Native mode replaces the source text instead of adding a translation, so it
  // cannot show both. Falling back keeps the display honest.
  const settings = { ...base, preferNativeEnglish: true, dualPane: true };
  const plan = planSession(settings, 'fr', 'en');
  assert.equal(plan.route.useNative, false);
  assert.equal(plan.route.useNllb, true);
  assert.equal(plan.display.secondaryField, 'text');
  assert.match(plan.route.reason, /alongside/);
});

test('switching direction changes the profile key when native is on', () => {
  const settings = { ...base, preferNativeEnglish: true };
  const frEn = planSession(settings, 'fr', 'en');
  const enFr = planSession(settings, 'en', 'fr');
  assert.notEqual(frEn.profileKey, enFr.profileKey, 'should require a sidecar restart');
});

test('with coexist enabled the profile key is stable across directions', () => {
  // This is the Phase 0 payoff: prove one server serves both paths and the
  // model reload on direction change disappears.
  const settings = { ...base, preferNativeEnglish: true, nativeAndNllbCoexist: true };
  const frEn = planSession(settings, 'fr', 'en');
  const enFr = planSession(settings, 'en', 'fr');
  const frFr = planSession(settings, 'fr', 'fr');
  assert.equal(frEn.profileKey, enFr.profileKey);
  assert.equal(frEn.profileKey, frFr.profileKey);
  assert.ok(frEn.serverArgs.includes('--direct-english-translation'));
});

test('language-only changes never change the profile key', () => {
  const frFr = planSession(base, 'fr', 'fr');
  const enEn = planSession(base, 'en', 'en');
  const frEn = planSession(base, 'fr', 'en');
  assert.equal(frFr.profileKey, enEn.profileKey);
  assert.equal(frFr.profileKey, frEn.profileKey, 'default routing keeps one server profile');
});

test('auto source is accepted and carries no NLLB code of its own', () => {
  const plan = planSession(base, 'auto', 'fr');
  assert.equal(query(plan).get('language'), 'auto');
  assert.equal(plan.route.useNllb, true);
  assert.equal(query(plan).get('target_language'), 'fra_Latn');
});

test('disabling translation drops the NLLB flags entirely', () => {
  const settings = { ...base, translationEnabled: false };
  const plan = planSession(settings, 'fr', 'fr');
  assert.equal(plan.serverArgs.includes('--translation-backend'), false);
  assert.equal(plan.serverArgs.includes('--nllb-size'), false);
});

test('frame-threshold is only passed under the AlignAtt policy', () => {
  const simul = planSession(base, 'fr', 'fr');
  assert.ok(simul.serverArgs.includes('--frame-threshold'));

  const local = planSession({ ...base, policy: 'localagreement', backend: 'faster-whisper' }, 'fr', 'fr');
  assert.equal(local.serverArgs.includes('--frame-threshold'), false);
  assert.ok(local.serverArgs.includes('--backend-policy'));
});

test('server args always include the Windows-critical flags', () => {
  const plan = planSession(base, 'fr', 'fr');
  assert.ok(plan.serverArgs.includes('--pcm-input'), 'PCM input avoids the FFmpeg dependency');
  const hostIndex = plan.serverArgs.indexOf('--host');
  assert.equal(plan.serverArgs[hostIndex + 1], '127.0.0.1', 'never bind beyond localhost');
});

test('model recommendation tracks VRAM', () => {
  assert.equal(recommendModel(4), 'small');
  assert.equal(recommendModel(8), 'medium');
  assert.equal(recommendModel(12), 'large-v3');
  assert.equal(recommendModel(16), 'large-v3');
  assert.equal(recommendModel(null), 'medium', 'unknown VRAM gets a safe middle default');
});

test('unknown languages are rejected loudly', () => {
  assert.throws(() => routeFor(base, 'zh', 'fr'), /Unknown language/);
});
