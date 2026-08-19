/**
 * Phone display: a small LAN server that pushes live captions to any browser on
 * the same network.
 *
 * Server-Sent Events rather than a second WebSocket stack. Captions only ever
 * travel one way, SSE needs no dependency, and - the part that actually matters
 * for a phone propped up on a table - browsers reconnect a dropped EventSource
 * on their own, through screen locks and Wi-Fi hiccups, with no client code.
 *
 * Access is gated by a short key in the URL. This is a room-scale tool, not a
 * public service, but "everything said in this room" is not something to leave
 * open to every device on a shared network by default.
 */

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const PHONE_DIR = path.join(__dirname, '..', 'phone');
const KEEPALIVE_MS = 15_000;
const MAX_LINES = 60;

/** Unambiguous alphabet: no O/0, no I/1/l. People read these off a screen. */
const KEY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function makeKey(length = 6) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += KEY_ALPHABET[bytes[i] % KEY_ALPHABET.length];
  return out;
}

/**
 * Candidate LAN addresses, best first.
 *
 * Windows machines routinely carry Hyper-V, WSL and VPN adapters whose
 * addresses are useless to a phone, so private home/office ranges are ranked
 * above everything else and obvious virtual adapters are pushed down.
 */
function lanAddresses() {
  const found = [];
  const interfaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs || []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      found.push({ name, address: addr.address, score: scoreAddress(name, addr.address) });
    }
  }
  return found.sort((a, b) => b.score - a.score);
}

function scoreAddress(name, address) {
  let score = 0;
  if (/^192\.168\./.test(address)) score += 40;
  else if (/^10\./.test(address)) score += 30;
  else if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) score += 20;
  if (/^169\.254\./.test(address)) score -= 60;               // link-local, no DHCP
  if (/wsl|hyper-v|virtual|vmware|vbox|loopback|docker|tap|tun/i.test(name)) score -= 50;
  if (/wi-?fi|wlan|wireless/i.test(name)) score += 10;         // the phone is on Wi-Fi
  if (/ethernet|eth/i.test(name)) score += 5;
  return score;
}

class PhoneServer extends EventEmitter {
  constructor() {
    super();
    this.server = null;
    this.port = null;
    this.key = null;
    this.clients = new Set();
    this.lastPayload = null;
    this.keepalive = null;
    this.assets = new Map();
  }

  get running() {
    return Boolean(this.server);
  }

  get clientCount() {
    return this.clients.size;
  }

  async start({ port = 8420 } = {}) {
    if (this.server) return this.info();

    this.key = makeKey();
    this.server = http.createServer((req, res) => this.handle(req, res));

    await new Promise((resolve, reject) => {
      const onError = (err) => {
        this.server = null;
        reject(
          err.code === 'EADDRINUSE'
            ? new Error(`Port ${port} is already in use. Pick another in Settings.`)
            : err,
        );
      };
      this.server.once('error', onError);
      // 0.0.0.0 on purpose: the whole point is other devices. On Windows this is
      // the moment the firewall prompt appears, so the UI warns beforehand.
      this.server.listen(port, '0.0.0.0', () => {
        this.server.off('error', onError);
        this.port = port;
        resolve();
      });
    });

    this.server.on('error', (err) => this.emit('error', err));

    this.keepalive = setInterval(() => {
      for (const res of this.clients) {
        try {
          res.write(': keepalive\n\n');
        } catch {
          this.drop(res);
        }
      }
    }, KEEPALIVE_MS);
    this.keepalive.unref?.();

    this.emit('started', this.info());
    return this.info();
  }

  async stop() {
    if (!this.server) return;
    clearInterval(this.keepalive);
    this.keepalive = null;

    for (const res of [...this.clients]) {
      try {
        res.write('event: bye\ndata: {}\n\n');
        res.end();
      } catch { /* already gone */ }
    }
    this.clients.clear();

    await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
    this.port = null;
    this.lastPayload = null;
    this.emit('stopped');
  }

  info() {
    const addresses = lanAddresses();
    const primary = addresses[0]?.address || '127.0.0.1';
    return {
      running: this.running,
      port: this.port,
      key: this.key,
      clientCount: this.clients.size,
      addresses: addresses.map((a) => ({ ...a, url: this.urlFor(a.address) })),
      url: this.urlFor(primary),
    };
  }

  urlFor(address) {
    if (!this.port || !this.key) return null;
    return `http://${address}:${this.port}/?k=${this.key}`;
  }

  // --- request handling ----------------------------------------------------

  handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/health') {
      return json(res, 200, { ok: true, clients: this.clients.size });
    }

    // Everything else needs the key. The stream carries it as a query param
    // because EventSource cannot set headers.
    if (url.searchParams.get('k') !== this.key) {
      return text(res, 403, 'Wrong or missing access key. Re-scan the code shown on the desktop.');
    }

    if (url.pathname === '/events') return this.openStream(req, res);
    if (url.pathname === '/' || url.pathname === '/index.html') return this.sendAsset(res, 'index.html', 'text/html; charset=utf-8');
    if (url.pathname === '/phone.css') return this.sendAsset(res, 'phone.css', 'text/css; charset=utf-8');
    if (url.pathname === '/phone.js') return this.sendAsset(res, 'phone.js', 'text/javascript; charset=utf-8');

    return text(res, 404, 'Not found');
  }

  sendAsset(res, name, type) {
    try {
      let body = this.assets.get(name);
      if (body === undefined) {
        body = fs.readFileSync(path.join(PHONE_DIR, name), 'utf8');
        this.assets.set(name, body);
      }

      // Every path is key-gated, and a relative <script src="phone.js"> would
      // arrive without one - so the page's own asset URLs are rewritten to
      // carry it. Done at send time, never cached: the key changes each start.
      if (name === 'index.html') {
        body = body
          .replace('href="phone.css"', `href="phone.css?k=${this.key}"`)
          .replace('src="phone.js"', `src="phone.js?k=${this.key}"`);
      }

      res.writeHead(200, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(body);
    } catch (err) {
      text(res, 500, `Could not read ${name}: ${err.message}`);
    }
  }

  openStream(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Without this, any proxy between phone and laptop may buffer the stream
      // into uselessness.
      'X-Accel-Buffering': 'no',
    });
    // Tell the browser to come back quickly after a drop.
    res.write('retry: 2000\n\n');

    this.clients.add(res);
    this.emit('clients', this.clients.size);

    // A phone joining mid-sentence should see the transcript so far, not a
    // blank screen until the next utterance.
    if (this.lastPayload) this.write(res, this.lastPayload);

    const cleanup = () => this.drop(res);
    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('error', cleanup);
  }

  drop(res) {
    if (!this.clients.delete(res)) return;
    try {
      res.end();
    } catch { /* already closed */ }
    this.emit('clients', this.clients.size);
  }

  write(res, payload) {
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      return true;
    } catch {
      this.drop(res);
      return false;
    }
  }

  /** Push a caption update to every connected phone. */
  broadcast(payload) {
    if (!this.server) return 0;
    const trimmed = {
      ...payload,
      lines: Array.isArray(payload.lines) ? payload.lines.slice(-MAX_LINES) : [],
    };
    this.lastPayload = trimmed;
    let delivered = 0;
    for (const res of [...this.clients]) {
      if (this.write(res, trimmed)) delivered++;
    }
    return delivered;
  }
}

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function text(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

module.exports = { PhoneServer, lanAddresses, scoreAddress, makeKey, MAX_LINES };
