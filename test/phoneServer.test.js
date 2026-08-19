const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { PhoneServer, scoreAddress, makeKey, MAX_LINES } = require('../src/main/phoneServer');

const PORT = 8531;

function get(path, { raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path, timeout: 4000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        body += c;
        if (raw && body.length > 0) resolve({ status: res.statusCode, headers: res.headers, body, res });
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

/** Open an SSE stream and collect `data:` payloads until `count` arrive. */
function stream(path, count) {
  return new Promise((resolve, reject) => {
    const payloads = [];
    const req = http.get({ host: '127.0.0.1', port: PORT, path, timeout: 6000 }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`status ${res.statusCode}`));
      res.setEncoding('utf8');
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const line = frame.split('\n').find((l) => l.startsWith('data: '));
          if (line) payloads.push(JSON.parse(line.slice(6)));
          if (payloads.length >= count) {
            req.destroy();
            resolve(payloads);
            return;
          }
        }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('stream timeout')); });
    req.on('error', (err) => { if (payloads.length < count) reject(err); });
  });
}

test('phone server', async (t) => {
  const server = new PhoneServer();
  const info = await server.start({ port: PORT });
  t.after(async () => { await server.stop(); });

  await t.test('hands out a readable access key', () => {
    assert.equal(info.key.length, 6);
    // No characters that get misread off a screen.
    assert.doesNotMatch(info.key, /[O0I1L]/);
    assert.notEqual(makeKey(), makeKey(), 'keys should not repeat');
  });

  await t.test('refuses everything without the key', async () => {
    const page = await get('/');
    assert.equal(page.status, 403);
    const events = await get('/events');
    assert.equal(events.status, 403);
    const wrong = await get(`/?k=${info.key === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA'}`);
    assert.equal(wrong.status, 403);
  });

  await t.test('health needs no key, so a firewall problem is diagnosable', async () => {
    const res = await get('/health');
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).ok, true);
  });

  await t.test('serves the phone page and its assets with the key', async () => {
    const page = await get(`/?k=${info.key}`);
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /text\/html/);
    assert.match(page.body, /WhisperLive captions/);

    // Every path is key-gated, so the page's own asset URLs must carry the key
    // or the browser fetches them bare, gets a 403, and the page never runs.
    assert.match(page.body, new RegExp(`src="phone\\.js\\?k=${info.key}"`));
    assert.match(page.body, new RegExp(`href="phone\\.css\\?k=${info.key}"`));

    const js = await get(`/phone.js?k=${info.key}`);
    assert.equal(js.status, 200);
    assert.match(js.headers['content-type'], /javascript/);
    assert.match(js.body, /EventSource/);

    const css = await get(`/phone.css?k=${info.key}`);
    assert.equal(css.status, 200);
    assert.match(css.headers['content-type'], /text\/css/);
  });

  await t.test('an SSE client receives broadcasts', async () => {
    const pending = stream(`/events?k=${info.key}`, 1);
    // Give the stream a moment to register before broadcasting.
    await new Promise((r) => setTimeout(r, 200));
    server.broadcast({ lines: [{ text: 'bonjour', translation: 'hello' }], bufferText: 'et', hasTranslation: true });
    const [payload] = await pending;
    assert.equal(payload.lines[0].text, 'bonjour');
    assert.equal(payload.hasTranslation, true);
  });

  await t.test('a phone joining mid-conversation gets the backlog immediately', async () => {
    // Broadcast first, connect afterwards: the newcomer should still see it
    // rather than staring at a blank screen until the next utterance.
    server.broadcast({ lines: [{ text: 'deja dit' }], bufferText: '' });
    const [payload] = await stream(`/events?k=${info.key}`, 1);
    assert.equal(payload.lines[0].text, 'deja dit');
  });

  await t.test('the transcript sent to phones is capped', async () => {
    const many = Array.from({ length: MAX_LINES + 40 }, (_, i) => ({ text: `line ${i}` }));
    // Two frames: the backlog replay this connection gets on join, then ours.
    const pending = stream(`/events?k=${info.key}`, 2);
    await new Promise((r) => setTimeout(r, 200));
    server.broadcast({ lines: many });
    const payload = (await pending).at(-1);
    assert.equal(payload.lines.length, MAX_LINES);
    // Keeps the newest, which is what a caption reader cares about.
    assert.equal(payload.lines.at(-1).text, `line ${MAX_LINES + 39}`);
  });

  await t.test('disconnected clients are reaped', async () => {
    // The streams above were destroyed client-side; the server should notice.
    const deadline = Date.now() + 3000;
    while (server.clientCount > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(server.clientCount, 0, 'closed streams should not leak');
  });

  await t.test('reports a usable URL containing the key', () => {
    const current = server.info();
    assert.match(current.url, /^http:\/\/[\d.]+:8531\/\?k=[A-Z2-9]{6}$/);
  });
});

test('a busy port fails with an actionable message, not a stack trace', async () => {
  const first = new PhoneServer();
  await first.start({ port: 8532 });
  const second = new PhoneServer();
  await assert.rejects(() => second.start({ port: 8532 }), /already in use/i);
  await first.stop();
});

test('virtual adapters rank below real ones', () => {
  // A phone cannot reach a WSL or Hyper-V address, so those must never be the
  // default suggestion.
  assert.ok(scoreAddress('Wi-Fi', '192.168.1.20') > scoreAddress('vEthernet (WSL)', '172.20.1.1'));
  assert.ok(scoreAddress('Wi-Fi', '192.168.1.20') > scoreAddress('Ethernet', '169.254.10.2'));
  assert.ok(scoreAddress('Wi-Fi 2', '10.0.0.5') > scoreAddress('VMware Network Adapter', '192.168.56.1'));
});
