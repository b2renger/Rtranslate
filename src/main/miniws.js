/**
 * A WebSocket server in about two hundred lines, because the engine contract
 * needs one and `ws` would be the only runtime dependency in the main process
 * that is not Electron's own.
 *
 * Scope is deliberately the contract and nothing else (docs/engine-contract.md):
 * one client at a time per port, binary in, text out, no permessage-deflate, no
 * extensions. If a use appears that this cannot serve, take the dependency
 * rather than growing this file.
 *
 * RFC 6455 is small when you only need this much of it.
 */

const http = require('node:http');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/**
 * One connected client.
 *
 * @fires message  ({ binary: boolean, data: Buffer })
 * @fires close
 */
class MiniSocket extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.closed = false;
    this.buffer = Buffer.alloc(0);
    /** Accumulates a fragmented message across continuation frames. */
    this.fragments = null;
    this.fragmentOp = null;

    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('close', () => this.onClose());
    socket.on('error', () => this.onClose());
  }

  onClose() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;

    // Decode as many whole frames as the buffer currently holds.
    for (;;) {
      const frame = decodeFrame(this.buffer);
      if (!frame) return;             // need more bytes
      this.buffer = this.buffer.subarray(frame.consumed);
      this.handleFrame(frame);
      if (this.closed) return;
    }
  }

  handleFrame(frame) {
    switch (frame.opcode) {
      case OP_PING:
        this.sendFrame(OP_PONG, frame.payload);
        return;
      case OP_PONG:
        return;
      case OP_CLOSE:
        this.sendFrame(OP_CLOSE, Buffer.alloc(0));
        this.socket.end();
        this.onClose();
        return;
      case OP_CONT: {
        if (this.fragments === null) return;   // continuation with no start; ignore
        this.fragments.push(frame.payload);
        if (!frame.fin) return;
        const data = Buffer.concat(this.fragments);
        const op = this.fragmentOp;
        this.fragments = null;
        this.fragmentOp = null;
        this.emit('message', { binary: op === OP_BINARY, data });
        return;
      }
      case OP_TEXT:
      case OP_BINARY: {
        if (!frame.fin) {
          this.fragments = [frame.payload];
          this.fragmentOp = frame.opcode;
          return;
        }
        this.emit('message', { binary: frame.opcode === OP_BINARY, data: frame.payload });
        return;
      }
      default:
        // Reserved opcode: the spec says fail the connection.
        this.close();
    }
  }

  /** Send a JSON object as a text frame. */
  sendJson(obj) {
    this.sendText(JSON.stringify(obj));
  }

  sendText(text) {
    this.sendFrame(OP_TEXT, Buffer.from(text, 'utf8'));
  }

  sendBinary(buf) {
    this.sendFrame(OP_BINARY, buf);
  }

  sendFrame(opcode, payload) {
    if (this.closed || this.socket.destroyed) return;
    this.socket.write(encodeFrame(opcode, payload));
  }

  close() {
    if (this.closed) return;
    this.sendFrame(OP_CLOSE, Buffer.alloc(0));
    this.socket.end();
    this.onClose();
  }
}

/**
 * @returns {{fin:boolean, opcode:number, payload:Buffer, consumed:number}|null}
 *   null when `buf` does not yet hold a whole frame.
 */
function decodeFrame(buf) {
  if (buf.length < 2) return null;

  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;

  if (len === 126) {
    if (buf.length < offset + 2) return null;
    len = buf.readUInt16BE(offset);
    offset += 2;
  } else if (len === 127) {
    if (buf.length < offset + 8) return null;
    const big = buf.readBigUInt64BE(offset);
    // A frame larger than this is not something the contract produces, and
    // Number() would start losing precision at 2^53.
    if (big > 0x7fffffffn) throw new Error('websocket frame too large');
    len = Number(big);
    offset += 8;
  }

  let mask = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    mask = buf.subarray(offset, offset + 4);
    offset += 4;
  }

  if (buf.length < offset + len) return null;

  const payload = Buffer.from(buf.subarray(offset, offset + len));
  if (mask) {
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  }

  return { fin, opcode, payload, consumed: offset + len };
}

/** Server frames are never masked. */
function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;

  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;         // FIN + opcode

  return Buffer.concat([header, payload]);
}

/**
 * A WebSocket server bound to loopback.
 *
 * @param {(socket: MiniSocket, url: URL) => void} onConnection
 * @fires listening
 */
class MiniWsServer extends EventEmitter {
  constructor({ path: wsPath = '/asr', host = '127.0.0.1' } = {}) {
    super();
    this.wsPath = wsPath;
    this.host = host;
    this.port = null;
    this.sockets = new Set();

    this.http = http.createServer((req, res) => {
      // Anything that is not an upgrade is not part of the contract, but a
      // plain 200 here makes "is it up yet?" a one-liner for callers.
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }
      res.writeHead(426, { 'content-type': 'text/plain' });
      res.end('Upgrade required');
    });

    this.http.on('upgrade', (req, socket) => this.onUpgrade(req, socket));
    this.http.on('error', (err) => this.emit('error', err));
  }

  onUpgrade(req, socket) {
    const url = new URL(req.url, `http://${this.host}`);
    const key = req.headers['sec-websocket-key'];

    if (url.pathname !== this.wsPath || !key || req.headers.upgrade?.toLowerCase() !== 'websocket') {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }

    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    // Audio frames arrive continuously and small; Nagle would batch them into
    // exactly the latency we are here to measure.
    socket.setNoDelay(true);

    const ws = new MiniSocket(socket);
    this.sockets.add(ws);
    ws.on('close', () => this.sockets.delete(ws));
    this.emit('connection', ws, url);
  }

  /** @param {number} port 0 picks a free one; read `.port` afterwards. */
  listen(port = 0) {
    return new Promise((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(port, this.host, () => {
        this.http.removeListener('error', reject);
        this.port = this.http.address().port;
        this.emit('listening', this.port);
        resolve(this.port);
      });
    });
  }

  close() {
    for (const ws of this.sockets) ws.close();
    this.sockets.clear();
    return new Promise((resolve) => this.http.close(resolve));
  }
}

module.exports = { MiniWsServer, MiniSocket, decodeFrame, encodeFrame };
