/**
 * The R2T2 engine's planning and launch command.
 *
 * Everything past plan() needs WSL, vLLM, 4 GB of weights and a GPU, so it is
 * covered by spike/profile.mjs and docs/TESTING.md. What is pinned here is the
 * behaviour that decides how the engine feels and the command that decides
 * whether it can ever leak a GPU process.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const r2t2 = require('../src/main/engines/r2t2');
const { toWslPath, commandFor, sh } = r2t2._internal;

test('the engine registers without starting anything', () => {
  assert.equal(r2t2.id, 'r2t2');
  assert.equal(r2t2.state(), 'idle');
  assert.equal(r2t2.capabilities.provisional, true);
  assert.equal(r2t2.capabilities.translation, false);
});

test('a language change is a reconnect, not a restart', () => {
  // The contrast with QVAC, where language is a loadModel() argument. Here the
  // server takes it per connection, so the process - and its warm model -
  // must survive the switch. If these keys ever differ, every dropdown change
  // costs a model load.
  const fr = r2t2.plan({}, 'fr', 'fr');
  const en = r2t2.plan({}, 'en', 'en');
  assert.equal(fr.profileKey, en.profileKey);
  assert.match(fr.query, /language=fr/);
  assert.match(en.query, /language=en/);
});

test('process settings do change the key', () => {
  const base = r2t2.plan({}, 'fr', 'fr').profileKey;
  assert.notEqual(base, r2t2.plan({ r2t2VramGiB: 8 }, 'fr', 'fr').profileKey);
  assert.notEqual(base, r2t2.plan({ r2t2EnforceEager: true }, 'fr', 'fr').profileKey);
});

test('a translating pair shows the source and says why', () => {
  // The failure worth guarding against is an English transcript presented as
  // a French translation.
  const plan = r2t2.plan({}, 'en', 'fr');
  assert.equal(plan.display.primaryField, 'text');
  assert.match(plan.route.reason, /transcribes only/);
  assert.ok(!plan.query.includes('target_language'), 'no translation is requested from a server that has none');
});

test('same language is plain streaming with a provisional tail', () => {
  const plan = r2t2.plan({}, 'fr', 'fr');
  assert.equal(plan.display.bufferField, 'buffer_transcription');
  assert.equal(plan.route.translate, false);
});

test('unknown languages are rejected loudly', () => {
  assert.throws(() => r2t2.plan({}, 'fr', 'klingon'), /Unknown language/);
});

test('Windows paths become WSL paths', () => {
  assert.equal(toWslPath('C:\\Users\\a b\\server.py'), '/mnt/c/Users/a b/server.py');
  assert.equal(toWslPath('E:/x/y.py'), '/mnt/e/x/y.py');
  assert.equal(toWslPath('/already/linux.py'), '/already/linux.py');
});

test('shell quoting survives spaces and single quotes', () => {
  assert.equal(sh("it's here"), `'it'\\''s here'`);
  assert.equal(sh('/mnt/c/a b/c.py'), `'/mnt/c/a b/c.py'`);
});

test('the launch command execs the server in the foreground with a VRAM budget', () => {
  const settings = { ...r2t2.defaultSettings, r2t2VramGiB: 7, r2t2KvGiB: 2 };
  const [file, args] = commandFor(settings);
  const line = args[args.length - 1];

  if (process.platform === 'win32') {
    // wsl.exe must be the direct parent: WSL tears a session down when the
    // wsl.exe that started it exits, which is what ties the server's life to
    // a process the shell can kill.
    assert.equal(file, 'wsl.exe');
    assert.deepEqual(args.slice(0, 3), ['-d', 'Ubuntu', '--']);
  }
  // `exec`, so the Python server replaces bash and receives stdin EOF itself.
  assert.match(line, /\bexec\b/);
  assert.match(line, /--vram-gib 7\b/);
  assert.match(line, /--kv-gib 2\b/);
  assert.match(line, /--port 0\b/, 'the port is chosen by the OS and read from READY');
  assert.doesNotMatch(line, /--enforce-eager/);
  assert.match(commandFor({ ...settings, r2t2EnforceEager: true })[1].slice(-1)[0], /--enforce-eager/);
});
