/**
 * The engine seam: the registry, the WebSocket server every engine serves the
 * contract with, and the mock engine that proves `main` works without a GPU.
 *
 * These run on any machine. That is the point of the seam.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');

const registry = require('../src/main/engines');
const mock = require('../src/main/engines/mock');
const { MiniWsServer, encodeFrame, decodeFrame } = require('../src/main/miniws');

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

test('the registry finds engines by reading the directory', () => {
  const ids = registry.list().map((e) => e.id);
  assert.ok(ids.includes('mock'), `expected mock among ${ids.join(', ')}`);
});

test('every registered engine satisfies the descriptor contract', () => {
  for (const summary of registry.list()) {
    const engine = registry.get(summary.id);
    for (const key of ['id', 'label', 'inspect', 'plan', 'ensure', 'stop']) {
      assert.ok(engine[key] !== undefined, `${summary.id} is missing ${key}`);
    }
    assert.equal(typeof engine.state, 'function', `${summary.id}.state must be callable`);
  }
});

test('an unknown engine id falls back rather than throwing', () => {
  // A settings file written on the other branch names an engine this build
  // does not ship. Refusing to start would be the wrong answer.
  const engine = registry.get('an-engine-from-another-branch');
  assert.ok(engine);
  assert.notEqual(engine.id, 'an-engine-from-another-branch');
  assert.equal(registry.has('an-engine-from-another-branch'), false);
});

// ---------------------------------------------------------------------------
// framing
// ---------------------------------------------------------------------------

test('frames round-trip through encode and decode', () => {
  for (const len of [0, 5, 125, 126, 200, 70000]) {
    const payload = crypto.randomBytes(len);
    const encoded = encodeFrame(0x2, payload);
    const decoded = decodeFrame(encoded);
    assert.equal(decoded.consumed, encoded.length, `len ${len}`);
    assert.equal(decoded.opcode, 0x2);
    assert.ok(decoded.fin);
    assert.deepEqual(decoded.payload, payload, `len ${len}`);
  }
});

test('decode returns null until a whole frame has arrived', () => {
  const full = encodeFrame(0x1, Buffer.from('hello there'));
  for (let cut = 1; cut < full.length; cut++) {
    assert.equal(decodeFrame(full.subarray(0, cut)), null, `partial at ${cut} should not decode`);
  }
  assert.ok(decodeFrame(full));
});

test('a masked client frame is unmasked correctly', () => {
  // Client -> server frames are always masked; getting the XOR wrong would turn
  // audio into noise, which is very hard to see and impossible to hear.
  const payload = Buffer.from('audio bytes pretending to be pcm');
  const mask = Buffer.from([0x37, 0xfa, 0x21, 0x3d]);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];

  const frame = Buffer.concat([
    Buffer.from([0x82, 0x80 | payload.length]), mask, masked,
  ]);
  const decoded = decodeFrame(frame);
  assert.deepEqual(decoded.payload, payload);
});

// ---------------------------------------------------------------------------
// the server, driven by a real client
// ---------------------------------------------------------------------------

test('MiniWsServer completes a handshake and carries messages both ways', async () => {
  const server = new MiniWsServer({ path: '/asr' });
  const received = [];

  server.on('connection', (ws, url) => {
    ws.sendJson({ type: 'config', useAudioWorklet: true, mode: 'full', lang: url.searchParams.get('language') });
    ws.on('message', ({ binary, data }) => {
      received.push({ binary, length: data.length });
      if (binary && data.length === 0) ws.sendJson({ type: 'ready_to_stop' });
    });
  });

  const port = await server.listen(0);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/asr?language=fr`);
  const messages = [];

  await new Promise((resolve, reject) => {
    ws.onerror = reject;
    ws.onmessage = (ev) => {
      messages.push(JSON.parse(ev.data));
      if (messages.length === 2) resolve();
    };
    ws.onopen = () => {
      ws.send(new Uint8Array(640));      // a 20 ms frame of silence
      ws.send(new ArrayBuffer(0));       // end-of-audio
    };
  });

  assert.equal(messages[0].type, 'config');
  assert.equal(messages[0].useAudioWorklet, true);
  assert.equal(messages[0].lang, 'fr', 'query parameters must reach the engine');
  assert.equal(messages[1].type, 'ready_to_stop');
  assert.deepEqual(received, [{ binary: true, length: 640 }, { binary: true, length: 0 }]);

  ws.close();
  await server.close();
});

test('the server refuses a path that is not the contract endpoint', async () => {
  const server = new MiniWsServer({ path: '/asr' });
  const port = await server.listen(0);

  const status = await new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(
        'GET /not-asr HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n' +
        'Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
        'Sec-WebSocket-Version: 13\r\n\r\n',
      );
    });
    socket.on('data', (d) => { resolve(String(d).split('\r\n')[0]); socket.destroy(); });
  });

  assert.match(status, /400/);
  await server.close();
});

// ---------------------------------------------------------------------------
// the mock engine
// ---------------------------------------------------------------------------

test('mock.plan routes translation only when the languages differ', () => {
  const same = mock.plan({}, 'fr', 'fr');
  assert.equal(same.route.translate, false);
  assert.equal(same.display.primaryField, 'text');
  assert.ok(!same.query.includes('target_language'));

  const cross = mock.plan({}, 'fr', 'en');
  assert.equal(cross.route.translate, true);
  assert.equal(cross.display.primaryField, 'translation');
  assert.equal(cross.display.bufferField, 'buffer_translation');
  assert.match(cross.query, /target_language=eng_Latn/);
});

test('mock.plan carries injected lags into the profile key', () => {
  const a = mock.plan({ mockTranscriptLagSec: 1.2 }, 'fr', 'en');
  const b = mock.plan({ mockTranscriptLagSec: 3.0 }, 'fr', 'en');
  assert.notEqual(a.profileKey, b.profileKey, 'a different lag is a different process');
  assert.equal(a.opts.transcriptLagSec, 1.2);
  assert.equal(b.opts.transcriptLagSec, 3.0);
});

test('mock engine serves the contract end to end', async () => {
  const plan = mock.plan({ mockTranscriptLagSec: 0.2, mockTranslationLagSec: 0.4 }, 'fr', 'en');
  const { port } = await mock.ensure(plan);

  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/asr?${plan.query}`);
    const seen = { config: null, lines: null, stopped: false };

    await new Promise((resolve, reject) => {
      ws.onerror = reject;
      setTimeout(() => reject(new Error('mock engine never reached ready_to_stop')), 10000);

      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'config') seen.config = msg;
        if (msg.status === 'active_transcription') seen.lines = msg;
        if (msg.type === 'ready_to_stop') { seen.stopped = true; resolve(); }
      };

      ws.onopen = () => {
        // Six seconds of audio, all at once: the mock counts samples, not time.
        ws.send(new Uint8Array(16000 * 2 * 6));
        ws.send(new ArrayBuffer(0));
      };
    });

    assert.equal(seen.config.useAudioWorklet, true);
    assert.ok(seen.lines, 'expected at least one transcription update');
    assert.ok(seen.lines.lines.length > 0);
    assert.ok(seen.lines.lines[0].translation, 'fr->en must carry a translation field');
    assert.match(seen.lines.lines[0].end, /^\d+:\d\d:\d\d/, 'timestamps are str(timedelta)');
    assert.ok(seen.stopped);
    ws.close();
  } finally {
    await mock.stop();
  }
});

test('ensure is a no-op for the same plan and restarts for a different one', async () => {
  const plan = mock.plan({ mockTranscriptLagSec: 1.0 }, 'fr', 'en');
  try {
    const first = await mock.ensure(plan);
    const again = await mock.ensure(plan);
    assert.equal(again.port, first.port);
    assert.equal(again.restarted, false, 'the same profile must not restart the process');

    const other = await mock.ensure(mock.plan({ mockTranscriptLagSec: 2.0 }, 'fr', 'en'));
    assert.equal(other.restarted, true, 'a different profile must restart');
    assert.notEqual(other.port, first.port);
  } finally {
    await mock.stop();
  }
});
