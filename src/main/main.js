const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, ipcMain, session, desktopCapturer, dialog, shell } = require('electron');

const { Sidecar } = require('./sidecar');
const { Settings } = require('./settings');
const { resolvePython, detectGpu, probe } = require('./pythonEnv');
const { planSession, recommendModel, MODELS } = require('./profiles');
const { PhoneServer } = require('./phoneServer');
const { Updater } = require('./updater');
const { LANGUAGES, AUTO_SOURCE } = require('../shared/languages.cjs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const IS_DEV = process.argv.includes('--dev') || !app.isPackaged;

let win = null;
let settings = null;
let sidecar = null;
let envReport = null;
let loopbackEnabled = false;
let phone = null;
let updater = null;
let sessionActive = false;

// Single instance: two copies of this app would fight over the GPU.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(bootstrap);
}

async function bootstrap() {
  settings = new Settings();

  phone = new PhoneServer();
  phone.on('clients', (count) => send('phone:clients', { clientCount: count, ...phone.info() }));
  phone.on('error', (err) => send('phone:error', { message: err.message }));

  updater = new Updater({ isSessionActive: () => sessionActive });
  updater.on('status', (status) => send('update:status-changed', status));

  // Handlers must exist before the window loads: loadFile() resolves only after
  // the page's module script has already run, and that script calls IPC on its
  // first line. Registering afterwards is a race the renderer always wins.
  registerIpc();
  await createWindow();

  if (process.argv.includes('--smoke')) {
    const code = await runSmoke();
    app.exit(code);
    return;
  }

  updater.init();

  // Inspecting the environment spawns Python, so do it after the window exists -
  // the UI can show "checking..." instead of a blank screen.
  inspectEnvironment().then((report) => send('env:report', report));
}

/**
 * Renderer smoke test: proves the pieces that cannot be unit-tested in Node -
 * the preload bridge, ES module wiring, the AudioContext, and above all that
 * the AudioWorklet actually loads and instantiates under our CSP. Losing the
 * worklet means losing all audio, so it is worth checking without a microphone
 * in the room.
 *
 *   npm start -- --smoke
 */
/**
 * Optional --smoke-ws=<url>: run the full socket path against a stand-in server.
 * spike/mock_server.py speaks the documented protocol, so this exercises CSP,
 * binary frames and caption rendering without a GPU anywhere in sight.
 */
function smokeWsUrl() {
  const arg = process.argv.find((a) => a.startsWith('--smoke-ws='));
  return arg ? arg.slice('--smoke-ws='.length) : null;
}

async function runSmoke() {
  const script = `(async () => {
    const results = [];
    const check = async (name, fn) => {
      try { results.push({ name, ok: true, detail: String((await fn()) ?? '') }); }
      catch (e) { results.push({ name, ok: false, detail: e.message }); }
    };

    await check('preload bridge', () => {
      if (!window.wl) throw new Error('window.wl is missing');
      return Object.keys(window.wl).join(', ');
    });

    await check('renderer modules import', async () => {
      const a = await import('./audio.js');
      const t = await import('./transcript.js');
      if (!a.AudioPipe || !t.Transcript) throw new Error('expected exports missing');
      return 'AudioPipe, Transcript';
    });

    let ctx = null;
    await check('AudioContext at 16 kHz', () => {
      ctx = new AudioContext({ sampleRate: 16000 });
      if (ctx.sampleRate !== 16000) return 'refused 16k, got ' + ctx.sampleRate + ' Hz (worklet will resample)';
      return '16000 Hz native';
    });

    await check('audioWorklet.addModule', async () => {
      const { loadWorklet } = await import('./audio.js');
      return 'loaded via ' + (await loadWorklet(ctx));
    });

    await check('worklet instantiates and reports', async () => {
      const node = new AudioWorkletNode(ctx, 'pcm-downsampler', {
        numberOfInputs: 1, numberOfOutputs: 0,
        processorOptions: { targetRate: 16000, chunkMs: 40 },
      });
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no ready message within 3 s')), 3000);
        node.port.onmessage = (e) => {
          if (e.data && e.data.type === 'ready') {
            clearTimeout(timer);
            resolve('ratio ' + e.data.ratio + ' (' + e.data.inputRate + ' Hz in)');
          }
        };
      });
    });

    await check('transcript renders both fields', async () => {
      const { Transcript } = await import('./transcript.js');
      const host = document.createElement('div');
      const t = new Transcript(host);
      const msg = { lines: [{ speaker: 1, text: 'bonjour le monde', start: '0:00:00', end: '0:00:02', translation: 'hello world' }], buffer_transcription: 'et ensuite', buffer_translation: 'and then' };
      t.ingest(msg);
      if (!host.textContent.includes('bonjour')) throw new Error('source line not rendered');
      t.setDisplay({ primaryField: 'translation', bufferField: 'buffer_translation' });
      t.ingest(msg);
      if (!host.textContent.includes('hello world')) throw new Error('translation not rendered');
      if (!host.textContent.includes('and then')) throw new Error('translation buffer not rendered');
      return 'committed + provisional, both fields';
    });

    const wsUrl = ${JSON.stringify(smokeWsUrl())};
    if (wsUrl) {
      let socket = null;
      await check('WebSocket connects (CSP allows localhost)', () => new Promise((resolve, reject) => {
        socket = new WebSocket(wsUrl);
        socket.binaryType = 'arraybuffer';
        const timer = setTimeout(() => reject(new Error('no open within 8 s')), 8000);
        socket.addEventListener('open', () => { clearTimeout(timer); resolve(wsUrl); });
        socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('socket error')); });
      }));

      await check('end-to-end: PCM in, captions out', async () => {
        const { Transcript } = await import('./transcript.js');
        const host = document.createElement('div');
        const t = new Transcript(host);
        t.setDisplay({ primaryField: 'translation', bufferField: 'buffer_translation' });

        const got = new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('no captions within 10 s')), 10000);
          socket.addEventListener('message', (e) => {
            if (typeof e.data !== 'string') return;
            let msg; try { msg = JSON.parse(e.data); } catch { return; }
            t.ingest(msg);
            if (host.textContent.includes('traduction')) { clearTimeout(timer); resolve(host.textContent.trim().slice(0, 60)); }
          });
        });

        // 10 s of silence as real s16le frames: 250 chunks of 640 samples. Has
        // to exceed the mock's translation lag plus one segment, or nothing with
        // a translation field is ever emitted and we would be testing nothing.
        for (let i = 0; i < 250; i++) socket.send(new Int16Array(640).buffer);
        const text = await got;
        socket.close();
        return text;
      });
    }

    if (ctx) await ctx.close();
    return results;
  })()`;

  let results;
  try {
    results = await win.webContents.executeJavaScript(script, true);
  } catch (err) {
    console.error('smoke: renderer threw:', err.message);
    return 1;
  }

  if (process.argv.includes('--smoke-phone')) {
    results.push(...(await runPhoneSmoke()));
  }

  let failed = 0;
  console.log('\n  renderer smoke test\n  ' + '-'.repeat(58));
  for (const r of results) {
    if (!r.ok) failed++;
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.name.padEnd(34)} ${r.detail}`);
  }
  console.log('  ' + '-'.repeat(58));
  console.log(`  ${results.length - failed}/${results.length} passed\n`);
  return failed === 0 ? 0 : 1;
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 720,
    minHeight: 460,
    backgroundColor: '#12161a',
    autoHideMenuBar: true,
    title: 'WhisperLive',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.on('closed', () => {
    win = null;
  });

  // Microphone permission: this is a captioning app, the mic is the whole point.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media');
  });

  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (IS_DEV && process.argv.includes('--devtools')) win.webContents.openDevTools({ mode: 'detach' });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/**
 * QR for the phone URL. Dark modules on a near-white card: scanners want the
 * contrast that way round, however dark the surrounding UI is.
 */
async function qrFor(url) {
  if (!url) return null;
  try {
    const QRCode = require('qrcode');
    return await QRCode.toDataURL(url, {
      margin: 1,
      width: 320,
      errorCorrectionLevel: 'M',
      color: { dark: '#0e1215ff', light: '#f2f6f7ff' },
    });
  } catch {
    return null; // the URL is shown as text regardless
  }
}

// --------------------------------------------------------------------------
// environment
// --------------------------------------------------------------------------

async function inspectEnvironment() {
  const pythonExe = resolvePython(REPO_ROOT);
  const [gpu, py] = await Promise.all([detectGpu(), probe(pythonExe)]);

  const vramGiB = py.info?.vramGiB ?? gpu?.vramTotalGiB ?? null;
  envReport = {
    pythonExe,
    gpu,
    python: py,
    vramGiB,
    recommendedModel: recommendModel(vramGiB),
    repoRoot: REPO_ROOT,
    isDev: IS_DEV,
  };

  if (py.ok && pythonExe) {
    sidecar = new Sidecar({ pythonExe });
    sidecar.on('state', (s) => send('sidecar:state-changed', s));
    sidecar.on('log', (l) => send('sidecar:log', l));
    sidecar.on('diagnosis', (d) => send('sidecar:log', { stream: 'app', line: `${d.message} ${d.hint || ''}`, at: Date.now() }));
    sidecar.on('crashed', () => send('sidecar:crashed', {}));
  }

  // First run on an unknown card: pick a model that will actually load rather
  // than letting the user meet an out-of-memory error mid-sentence.
  if (!settings.get()._modelChosen && envReport.recommendedModel) {
    settings.patch({ model: envReport.recommendedModel, _modelChosen: true });
  }

  return envReport;
}

// --------------------------------------------------------------------------
// IPC
// --------------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle('env:inspect', async () => envReport || (await inspectEnvironment()));
  ipcMain.handle('env:languages', () => ({ languages: LANGUAGES, auto: AUTO_SOURCE }));
  ipcMain.handle('env:models', () => MODELS);

  ipcMain.handle('settings:get', () => settings.get());
  ipcMain.handle('settings:patch', (_e, partial) => settings.patch(partial || {}));
  ipcMain.handle('settings:reset', () => settings.reset());

  ipcMain.handle('session:plan', (_e, { sourceId, targetId }) => {
    const plan = planSession(settings.get(), sourceId, targetId);
    const needsRestart = Boolean(sidecar) && sidecar.state === 'ready' && sidecar.currentKey !== plan.profileKey;
    return { ...plan, needsRestart, sidecarState: sidecar?.state || 'unavailable' };
  });

  ipcMain.handle('session:start', async (_e, { sourceId, targetId }) => {
    if (!sidecar) {
      return { ok: false, error: envReport?.python?.error || 'no-python', message: envReport?.python?.message };
    }
    const plan = planSession(settings.get(), sourceId, targetId);
    try {
      const { port, restarted } = await sidecar.ensure(plan.serverArgs);
      return {
        ok: true,
        port,
        restarted,
        url: `ws://127.0.0.1:${port}/asr?${plan.query}`,
        display: plan.display,
        route: plan.route,
      };
    } catch (err) {
      return {
        ok: false,
        error: 'start-failed',
        message: err.message,
        diagnosis: sidecar.lastError || null,
        recentLog: sidecar.log.slice(-25),
      };
    }
  });

  ipcMain.handle('session:stop', async () => {
    if (sidecar) await sidecar.stop();
    return { ok: true };
  });

  ipcMain.handle('sidecar:state', () => ({
    state: sidecar?.state || 'unavailable',
    port: sidecar?.port || null,
    key: sidecar?.currentKey || null,
  }));
  ipcMain.handle('sidecar:logs', () => sidecar?.log || []);

  // --- system audio loopback ---------------------------------------------
  // The modern, supported path: a display-media handler that asks Chromium for
  // loopback audio. Far more reliable than the old chromeMediaSource constraint
  // hack, but still Windows-only and still worth marking experimental.
  ipcMain.handle('capture:enable-loopback', async () => {
    if (process.platform !== 'win32') {
      return { ok: false, message: 'System audio capture is only wired up for Windows.' };
    }
    try {
      session.defaultSession.setDisplayMediaRequestHandler(
        async (_request, callback) => {
          const sources = await desktopCapturer.getSources({ types: ['screen'] });
          callback({ video: sources[0], audio: 'loopback' });
        },
        { useSystemPicker: false },
      );
      loopbackEnabled = true;
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  });

  ipcMain.handle('capture:disable-loopback', () => {
    if (loopbackEnabled) {
      session.defaultSession.setDisplayMediaRequestHandler(null);
      loopbackEnabled = false;
    }
    return { ok: true };
  });

  // --- phone display ------------------------------------------------------
  ipcMain.handle('phone:start', async (_e, opts) => {
    try {
      const port = Number(opts?.port) || settings.get().phonePort || 8420;
      const info = await phone.start({ port });
      settings.patch({ phoneEnabled: true, phonePort: port });
      return { ok: true, ...info, qr: await qrFor(info.url) };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  });

  ipcMain.handle('phone:stop', async () => {
    await phone.stop();
    settings.patch({ phoneEnabled: false });
    return { ok: true, ...phone.info() };
  });

  ipcMain.handle('phone:info', async () => {
    const info = phone.info();
    return { ...info, qr: info.url ? await qrFor(info.url) : null };
  });

  ipcMain.handle('phone:qr', async (_e, { url }) => ({ qr: await qrFor(url) }));

  // Fire-and-forget: caption updates arrive several times a second and a round
  // trip per frame would be pure overhead.
  ipcMain.on('phone:broadcast', (_e, payload) => {
    if (phone?.running) phone.broadcast(payload);
  });

  ipcMain.on('session:set-active', (_e, active) => {
    sessionActive = Boolean(active);
  });

  // --- updates ------------------------------------------------------------
  ipcMain.handle('update:status', () => updater.status);
  ipcMain.handle('update:check', () => updater.check({ silent: false }));
  ipcMain.handle('update:install', (_e, opts) => updater.installNow(opts || {}));

  ipcMain.handle('shell:save-transcript', async (_e, { text, suggestedName }) => {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Save transcript',
      defaultPath: path.join(app.getPath('documents'), suggestedName || 'transcript.txt'),
      filters: [{ name: 'Text', extensions: ['txt'] }, { name: 'Markdown', extensions: ['md'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    try {
      fs.writeFileSync(filePath, text, 'utf8');
      return { ok: true, filePath };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  });
}

/**
 * End-to-end test of the phone display: start the LAN server, load the page it
 * serves in a real browser window, push captions, and read back what a phone
 * would actually be showing. Proves SSE delivery, the access key, rendering and
 * the source/translation toggle without anyone picking up a phone.
 *
 *   npm start -- --smoke --smoke-phone
 */
async function runPhoneSmoke() {
  const results = [];
  const check = async (name, fn) => {
    try {
      results.push({ name, ok: true, detail: String((await fn()) ?? '') });
    } catch (err) {
      results.push({ name, ok: false, detail: err.message });
    }
  };

  const server = new PhoneServer();
  let viewer = null;

  try {
    const info = await server.start({ port: 8533 });

    await check('phone server starts and reports a URL', () => {
      if (!info.url || !info.key) throw new Error('no URL or key');
      return info.url.replace(/k=.*/, 'k=******');
    });

    await check('phone page loads in a browser', async () => {
      viewer = new BrowserWindow({ show: false, width: 420, height: 800 });
      await viewer.loadURL(info.url);
      const title = await viewer.webContents.executeJavaScript('document.title');
      if (!/captions/i.test(title)) throw new Error(`unexpected title: ${title}`);
      return title;
    });

    await check('SSE stream connects from the page', async () => {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if (server.clientCount > 0) return `${server.clientCount} client`;
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error('page never opened the event stream');
    });

    await check('captions reach the phone and render', async () => {
      server.broadcast({
        lines: [
          { speaker: 1, text: 'bonjour tout le monde', translation: 'hello everyone' },
          { speaker: 1, text: 'ceci est un test', translation: 'this is a test' },
        ],
        bufferText: 'et ensuite',
        bufferTranslation: 'and then',
        hasTranslation: true,
        sourceLabel: 'FR',
        targetLabel: 'EN',
        status: 'Live',
      });
      const text = await waitForText(viewer, /hello everyone/, 6000);
      if (!/and then/.test(text)) throw new Error('provisional buffer not rendered');
      return 'translation + buffer visible';
    });

    await check('the phone can switch to what was actually spoken', async () => {
      await viewer.webContents.executeJavaScript("document.getElementById('btn-lang').click()");
      const text = await waitForText(viewer, /bonjour tout le monde/, 4000);
      if (/hello everyone/.test(text)) throw new Error('still showing the translation');
      return 'source text shown';
    });

    await check('a wrong key is refused', async () => {
      const bad = new BrowserWindow({ show: false });
      try {
        await bad.loadURL(`http://127.0.0.1:8533/?k=WRONG1`);
        const body = await bad.webContents.executeJavaScript('document.body.innerText');
        if (!/access key/i.test(body)) throw new Error(`unexpected body: ${body.slice(0, 80)}`);
        return 'rejected with an explanation';
      } finally {
        bad.destroy();
      }
    });
  } catch (err) {
    results.push({ name: 'phone smoke setup', ok: false, detail: err.message });
  } finally {
    if (viewer && !viewer.isDestroyed()) viewer.destroy();
    await server.stop();
  }

  return results;
}

async function waitForText(window, pattern, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let text = '';
  while (Date.now() < deadline) {
    text = await window.webContents.executeJavaScript('document.getElementById("captions").innerText');
    if (pattern.test(text)) return text;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`never matched ${pattern} (saw: ${text.slice(0, 80)})`);
}

// --------------------------------------------------------------------------
// shutdown - the part that matters
// --------------------------------------------------------------------------

let quitting = false;

app.on('before-quit', async (event) => {
  if (quitting) return;
  if (!sidecar?.proc && !phone?.running) return;
  event.preventDefault();
  quitting = true;
  try {
    await Promise.allSettled([sidecar?.stop(), phone?.stop()]);
  } finally {
    updater?.dispose();
    app.quit();
  }
});

// Belt and braces: if we are torn down without before-quit completing (crash,
// SIGINT in dev, Windows session end), still take the CUDA process with us.
app.on('will-quit', () => sidecar?.killNow());
process.on('exit', () => sidecar?.killNow());
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    sidecar?.killNow();
    process.exit(0);
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
