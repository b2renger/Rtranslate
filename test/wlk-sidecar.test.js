const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

const { diagnose, freePort, waitForHttp } = require('../src/main/engines/whisperlivekit/sidecar');
const { nvidiaDllDirs } = require('../src/main/engines/whisperlivekit/pythonEnv');

test('the cuDNN failure is recognised and explained', () => {
  // The single most likely first-run failure on Windows, filed against
  // WhisperLiveKit #286 and faster-whisper #1080.
  const d = diagnose('RuntimeError: Could not locate cudnn_ops64_9.dll. Please make sure it is in your library path!');
  assert.ok(d, 'should be recognised');
  assert.match(d.message, /cuDNN/);
  assert.match(d.hint, /bootstrap|PATH/);
});

test('out of memory is explained as a model-size problem, not a crash', () => {
  const d = diagnose('torch.cuda.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB');
  assert.ok(d);
  assert.match(d.hint, /smaller model/);
});

test('a missing whisperlivekit points at bootstrap', () => {
  const d = diagnose("ModuleNotFoundError: No module named 'whisperlivekit'");
  assert.ok(d);
  assert.match(d.hint, /bootstrap/);
});

test('an FFmpeg mention means --pcm-input did not take effect', () => {
  const d = diagnose('INFO: starting ffmpeg decoder process');
  assert.ok(d);
  assert.match(d.hint, /pcm-input/);
});

test('a rejected flag is surfaced rather than swallowed', () => {
  const d = diagnose('basic_server.py: error: unrecognized arguments: --direct-english-translation');
  assert.ok(d);
  assert.match(d.message, /rejected a command-line flag/);
});

test('ordinary log noise is not diagnosed', () => {
  assert.equal(diagnose('INFO:     Uvicorn running on http://127.0.0.1:8765'), null);
  assert.equal(diagnose('Loading model large-v3...'), null);
});

test('freePort returns a port that can actually be bound', async () => {
  const port = await freePort();
  assert.ok(port > 1024 && port < 65536, `implausible port ${port}`);
  await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(port, '127.0.0.1', () => srv.close(resolve));
  });
});

test('freePort does not hand out the same port twice in a row', async () => {
  const ports = await Promise.all([freePort(), freePort(), freePort()]);
  assert.equal(new Set(ports).size, ports.length);
});

test('waitForHttp gives up rather than hanging forever', async () => {
  const started = Date.now();
  const ok = await waitForHttp(1, 1500); // port 1 will never answer
  assert.equal(ok, false);
  assert.ok(Date.now() - started >= 1000, 'should have actually waited');
  assert.ok(Date.now() - started < 8000, 'should not have overrun the timeout badly');
});

test('waitForHttp aborts early when the process is already gone', async () => {
  const started = Date.now();
  const ok = await waitForHttp(1, 30_000, () => false);
  assert.equal(ok, false);
  assert.ok(Date.now() - started < 2000, 'should not wait out the full timeout for a dead process');
});

test('nvidiaDllDirs is safe on an environment that has none', () => {
  // No venv here, so this must return an empty list rather than throwing -
  // otherwise a CPU-only machine cannot even reach the friendly error message.
  assert.deepEqual(nvidiaDllDirs('C:\\nope\\Scripts\\python.exe'), []);
  assert.deepEqual(nvidiaDllDirs(null), []);
});
