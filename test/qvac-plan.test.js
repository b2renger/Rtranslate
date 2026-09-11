/**
 * The QVAC engine's session planning.
 *
 * `plan()` is pure - no SDK, no Bare worker, no GPU - so the two behaviours
 * that decide how this engine feels can be pinned down on any machine:
 *
 *   1. changing the spoken language is a MODEL RELOAD here, not a reconnect
 *   2. EN -> FR has no model and must say so rather than transcribe
 *
 * Everything past `plan()` needs the 4.8 GB SDK and weights, so it is covered
 * by spike/profile.mjs and docs/TESTING.md instead.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const qvac = require('../src/main/engines/qvac');

test('the engine registers without the SDK being reachable', () => {
  // require() must never touch @qvac/sdk - it is ESM and 4.8 GB, and the
  // registry has to be able to list this engine on a machine that lacks it.
  assert.equal(qvac.id, 'qvac');
  assert.equal(typeof qvac.plan, 'function');
  assert.ok(qvac.models().length > 0);
});

test('same language transcribes, and asks for no translation', () => {
  const plan = qvac.plan({}, 'fr', 'fr');
  assert.equal(plan.route.translate, false);
  assert.equal(plan.display.primaryField, 'text');
  assert.ok(!plan.query.includes('target_language'));
  assert.equal(plan.qvac.translate, false);
});

test('FR->EN takes the native translate task, not a second model', () => {
  // This is QVAC's strong suit: the English rides inside the ASR output, so
  // there is no NMT model to load and no sentence gate to wait for.
  const plan = qvac.plan({}, 'fr', 'en');
  assert.equal(plan.route.useNative, true);
  assert.equal(plan.route.useNllb, false);
  assert.equal(plan.qvac.translate, true, 'must set whisper translate:true');
  assert.equal(plan.qvac.translationSrc, '', 'must not want a translation model');
  assert.match(plan.route.reason, /native translate task/i);
});

test('EN->FR says there is no model rather than quietly transcribing', () => {
  // The failure that matters: handing someone an English transcript while the
  // UI implies they are reading French.
  const plan = qvac.plan({}, 'en', 'fr');
  assert.equal(plan.route.useNative, false, 'the native task only goes TO English');
  assert.equal(plan.route.useNllb, true);
  assert.match(plan.route.reason, /ships no en→fr translation model/i);
  assert.match(plan.route.reason, /Settings/);
});

test('EN->FR uses a translation model once one is configured', () => {
  const plan = qvac.plan({ qvacTranslationModelSrc: 'file:///models/nmt.gguf' }, 'en', 'fr');
  assert.equal(plan.qvac.translationSrc, 'file:///models/nmt.gguf');
  assert.equal(plan.display.primaryField, 'translation');
  assert.doesNotMatch(plan.route.reason, /ships no/i);
});

test('the spoken language is part of the profile key, because it is a reload', () => {
  // The incumbent takes `language` as a query parameter, so switching is a
  // socket reconnect with the model still warm. Here it is a loadModel()
  // argument. If these keys ever compare equal, `ensure()` becomes a no-op and
  // the engine keeps transcribing in the wrong language.
  const fr = qvac.plan({}, 'fr', 'fr');
  const en = qvac.plan({}, 'en', 'en');
  assert.notEqual(fr.profileKey, en.profileKey);
});

test('the translate flag is part of the profile key too', () => {
  // Same reason: `translate` is a load-time argument, so FR->FR and FR->EN are
  // different processes even though only the target changed.
  const transcribe = qvac.plan({}, 'fr', 'fr');
  const translate = qvac.plan({}, 'fr', 'en');
  assert.notEqual(transcribe.profileKey, translate.profileKey);
});

test('the same request twice is the same key, so it does not reload', () => {
  assert.equal(qvac.plan({}, 'fr', 'en').profileKey, qvac.plan({}, 'fr', 'en').profileKey);
});

test('model and GPU choice change the key; display-only settings do not', () => {
  const base = qvac.plan({ qvacModel: 'base' }, 'fr', 'fr');
  assert.notEqual(base.profileKey, qvac.plan({ qvacModel: 'small' }, 'fr', 'fr').profileKey);
  assert.notEqual(base.profileKey, qvac.plan({ qvacUseGpu: false }, 'fr', 'fr').profileKey);
});

test('model recommendation tracks VRAM and is conservative when unknown', () => {
  assert.equal(qvac.recommendModel(null), 'base');
  assert.equal(qvac.recommendModel(NaN), 'base');
  assert.equal(qvac.recommendModel(1), 'base');
  assert.equal(qvac.recommendModel(8), 'large-v3');
});

test('unknown languages are rejected loudly', () => {
  assert.throws(() => qvac.plan({}, 'fr', 'klingon'), /Unknown language/);
});

test('the engine declares vulkan, not cuda', () => {
  // Documented in the descriptor so the UI can show it. On Windows QVAC ships
  // no CUDA build whatever the driver advertises; if a future SDK adds one,
  // this test is where the claim gets updated.
  assert.equal(qvac.capabilities.gpuBackend, 'vulkan');
});
