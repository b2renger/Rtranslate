const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  EnvSetup, CUDA_TAGS, PYTHON_VERSION, UV_URL, which, download, verifyCudaResolution,
} = require('../src/main/envSetup');

// Verbatim from real `uv pip compile` runs against each index, 19 Aug 2026.
// These are the resolutions the installer will actually be handed.
const REAL = {
  cu129: 'torch==2.13.0\ntorchaudio==2.11.0\nwhisperlivekit==0.2.24\n',
  cu128: 'torch==2.13.0\ntorchaudio==2.11.0+cu128\nwhisperlivekit==0.2.24\n',
  cu126: 'torch==2.13.0+cu126\ntorchaudio==2.11.0+cu126\nwhisperlivekit==0.2.24\n',
};

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `wl-${name}-`));
}

test('the step list is coherent and ordered', () => {
  const setup = new EnvSetup({ userDataDir: tempDir('steps') });
  const ids = setup.steps.map((s) => s.id);
  assert.deepEqual(ids, ['uv', 'python', 'venv', 'wheels', 'cudnn', 'verify']);
  for (const step of setup.steps) {
    assert.ok(step.label.length > 4, `step ${step.id} needs a human label`);
  }
  // The big one has to say so: a silent 4 GB download reads as a hang.
  assert.match(setup.steps[3].label, /GB/);
});

test('paths land inside the app folder, never a system Python', () => {
  const dir = tempDir('paths');
  const setup = new EnvSetup({ userDataDir: dir });
  assert.ok(setup.pyenvDir.startsWith(dir));
  assert.ok(setup.pythonExe.startsWith(dir));
  assert.match(setup.pythonExe, /pyenv[\\/]Scripts[\\/]python\.exe$/);
});

test('CUDA tags are ordered newest first, so an old driver falls back', () => {
  assert.deepEqual(CUDA_TAGS, ['cu129', 'cu128', 'cu126']);
  assert.equal(PYTHON_VERSION, '3.12', 'pinned: inside every dependency supported range');
});

test('cancelling before starting is harmless', () => {
  const setup = new EnvSetup({ userDataDir: tempDir('cancel') });
  assert.doesNotThrow(() => setup.cancel());
  assert.equal(setup.cancelled, true);
});

test('a second start while running is refused rather than racing', async () => {
  const setup = new EnvSetup({ userDataDir: tempDir('double') });
  setup.running = true;
  const result = await setup.start();
  assert.equal(result.ok, false);
  assert.match(result.message, /already running/i);
});

test('progress events carry everything the UI needs', () => {
  const setup = new EnvSetup({ userDataDir: tempDir('events') });
  const seen = [];
  setup.on('progress', (p) => seen.push(p));
  setup.emitStep(3, 'running', 'cu129');
  assert.equal(seen.length, 1);
  assert.deepEqual(
    { index: seen[0].index, id: seen[0].id, status: seen[0].status, detail: seen[0].detail, total: seen[0].total },
    { index: 3, id: 'wheels', status: 'running', detail: 'cu129', total: 6 },
  );
});

test('a CPU resolution is rejected before anything is downloaded', () => {
  // The trap this whole design exists for: point uv at both PyPI and a CUDA
  // index, and it picks by version number. cu129's newest torch trails PyPI's,
  // so the plain CPU wheel wins - and the only symptom, 2.5 GB later, is
  // "PyTorch cannot see a CUDA device".
  const verdict = verifyCudaResolution(REAL.cu129, 'cu129');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.short, 'CPU torch');
  assert.match(verdict.reason, /CPU build/);
});

test('a mismatched torch/torchaudio pair is rejected', () => {
  // cu128 produced exactly this: CPU torch beside a CUDA torchaudio. Checking
  // only torchaudio would have waved through an unusable environment.
  const verdict = verifyCudaResolution(REAL.cu128, 'cu128');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.short, 'CPU torch');
});

test('a genuinely matched CUDA resolution is accepted', () => {
  const verdict = verifyCudaResolution(REAL.cu126, 'cu126');
  assert.equal(verdict.ok, true);
  assert.equal(verdict.torch, '2.13.0+cu126');
});

test('torchaudio disagreeing with torch is caught', () => {
  const lock = 'torch==2.11.0+cu128\ntorchaudio==2.11.0+cu126\n';
  const verdict = verifyCudaResolution(lock, 'cu128');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.short, 'mismatched torchaudio');
});

test('a resolution with no torch at all is rejected', () => {
  const verdict = verifyCudaResolution('whisperlivekit==0.2.24\n', 'cu126');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.short, 'no torch');
});

test('the tag must match, not merely be some CUDA build', () => {
  // A cu126 wheel resolved while asking for cu129 would mean the index fell
  // back somewhere unexpected; do not silently accept it.
  assert.equal(verifyCudaResolution(REAL.cu126, 'cu129').ok, false);
});

test('which() finds a real command and returns null for nonsense', async () => {
  const found = await which('cmd');
  assert.ok(found, 'cmd.exe should be findable on Windows');
  const missing = await which('definitely-not-a-real-command-xyz');
  assert.equal(missing, null);
});

test('the uv download URL resolves to a real zip', { timeout: 120000 }, async (t) => {
  // Network-dependent, and the whole first-run flow rests on it, so it is worth
  // one real request. Skipped rather than failed when offline.
  const dest = path.join(tempDir('uv'), 'uv.zip');
  try {
    await download(UV_URL, dest, () => {});
  } catch (err) {
    return t.skip(`offline or unreachable: ${err.message}`);
  }
  const stat = fs.statSync(dest);
  assert.ok(stat.size > 1_000_000, `implausibly small: ${stat.size} bytes`);
  const magic = fs.readFileSync(dest).subarray(0, 2).toString('latin1');
  assert.equal(magic, 'PK', 'should be a zip archive');
});
