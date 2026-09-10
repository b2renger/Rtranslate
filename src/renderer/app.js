/**
 * Rtranslate renderer: wires the three selectors to a sidecar session and a
 * WebSocket, and keeps the caption surface honest about what is happening.
 *
 * The one structural decision worth knowing: audio capture and the WebSocket
 * have independent lifetimes. Changing language closes and reopens the socket
 * while the microphone keeps running, so a language switch costs a reconnect
 * (and, only if the server profile changed, a model reload) rather than
 * restarting capture and making the user re-grant permissions.
 */

import { AudioPipe } from './audio.js';
import { Transcript } from './transcript.js';

const $ = (id) => document.getElementById(id);

const el = {
  app: $('app'),
  liveDot: $('live-dot'),
  statusPill: $('status-pill'),
  statusDetail: $('status-detail'),
  routeNote: $('route-note'),
  selSource: $('sel-source'),
  selSpoken: $('sel-spoken'),
  selDisplay: $('sel-display'),
  btnStart: $('btn-start'),
  levelFill: $('level-fill'),
  captions: $('captions'),
  emptyState: $('empty-state'),
  banner: $('banner'),
  bannerTitle: $('banner-title'),
  bannerHint: $('banner-hint'),
  bannerClose: $('banner-close'),
  settings: $('settings'),
  logs: $('logs'),
  logBody: $('log-body'),
  scrim: $('scrim'),
  envKv: $('env-kv'),
  phone: $('phone'),
  phoneToggle: $('phone-toggle'),
  phoneDetails: $('phone-details'),
  phoneFirewall: $('phone-firewall'),
  phoneQr: $('phone-qr'),
  phoneAddress: $('phone-address'),
  phoneUrl: $('phone-url'),
  phoneKey: $('phone-key'),
  phoneClients: $('phone-clients'),
  phonePort: $('phone-port'),
  phoneCount: $('phone-count'),
  updateBar: $('update-bar'),
  updateText: $('update-text'),
  updateInstall: $('update-install'),
  updateDismiss: $('update-dismiss'),
  setup: $('setup'),
  setupSteps: $('setup-steps'),
  setupLead: $('setup-lead'),
  setupStart: $('setup-start'),
  setupCancel: $('setup-cancel'),
  setupSummary: $('setup-summary'),
  setupLog: $('setup-log'),
};

const state = {
  env: null,
  settings: null,
  languages: [],
  auto: null,
  models: [],
  running: false,
  busy: false,
  ws: null,
  wsGeneration: 0,
  audio: new AudioPipe(),
  transcript: new Transcript(el.captions),
  sidecarState: 'unavailable',
  lastRoute: null,
};

// ---------------------------------------------------------------- bootstrap

init().catch((err) => showBanner('Startup failed', err.message));

async function init() {
  const [langs, models, settings] = await Promise.all([
    window.rt.env.languages(),
    window.rt.env.models(),
    window.rt.settings.get(),
  ]);
  state.languages = langs.languages;
  state.auto = langs.auto;
  state.models = models;
  state.settings = settings;

  buildLanguageSelectors();
  bindControls();
  bindSettings();
  bindPhone();
  bindUpdates();
  await bindSetup();

  window.rt.engine.onState(onSidecarState);
  window.rt.engine.onLog(appendLog);
  window.rt.env.onReport(applyEnvReport);

  await refreshDevices();
  navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);

  setStatus('busy', 'Checking environment…');
  state.env = await window.rt.env.inspect();
  applyEnvReport(state.env);

  await updateRouteNote();
}

function applyEnvReport(env) {
  state.env = env;
  renderEnvTable(env);

  const health = env.health || { ok: false, message: 'No engine reported in.' };
  const problem = health.ok ? null : (health.problem || 'engine-unavailable');

  // A broken engine is one problem from the user's side, whatever the engine
  // says went wrong, and it has one fix: run that engine's setup. Offer the
  // button rather than describing a command to type somewhere else. Engines
  // with nothing to install have no setup, and then there is nothing to offer.
  if (problem && env.hasSetup) {
    setStatus('bad', errorLabel(health));
    showBanner(
      health.title || 'Rtranslate needs to finish setting up',
      health.fixHint || 'A one-time download installs the transcription engine into this app’s own folder.',
      { label: 'Set up', onClick: () => openDrawer(el.setup) },
    );
    el.btnStart.disabled = true;
    openDrawer(el.setup);
    return;
  }

  if (problem) {
    setStatus('bad', errorLabel(health));
    showBanner(errorLabel(health), health.message || 'See the log for details.');
    el.btnStart.disabled = true;
    return;
  }

  setStatus('ok', 'Ready');
  el.btnStart.disabled = false;

  const vram = env.vramGiB;
  if (vram && vram < 7.5) {
    showBanner(
      `${env.gpu?.name || 'This GPU'} has ${vram.toFixed(1)} GiB of VRAM`,
      'The largest models will not fit. The model has been set to something that will load; change it in Settings if you disagree.',
    );
  }
}

/**
 * Engines name their own failures, because only they know them. The shell
 * translates the handful it can act on, and otherwise repeats what it was told
 * rather than flattening everything to "Environment problem".
 */
function errorLabel(health) {
  const code = typeof health === 'string' ? health : health?.problem;
  return (
    {
      'engine-broken': 'This engine failed to load',
      'engine-unavailable': 'No engine available',
    }[code] || (typeof health === 'object' && health?.label) || code || 'Engine problem'
  );
}

function renderEnvTable(env) {
  // The engine decides what is worth showing about itself; the shell adds only
  // what it measured for itself.
  const rows = [
    ['Engine', env.engine?.label || '—'],
    ...Object.entries(env.health?.info || {}).map(([k, v]) => [k, v == null || v === '' ? '—' : String(v)]),
    ['GPU', env.gpu?.name || 'none detected'],
    ['VRAM', env.gpu ? `${(env.gpu.vramTotalGiB || 0).toFixed(1)} GiB` : '—'],
    ['Driver', env.gpu?.driver || '—'],
  ];
  el.envKv.replaceChildren();
  for (const [key, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = key;
    const dd = document.createElement('dd');
    dd.textContent = String(value);
    if (value === '—' || value === 'not found' || value === 'none detected') dd.className = 'bad';
    el.envKv.append(dt, dd);
  }
}

// ------------------------------------------------------------- selectors

function buildLanguageSelectors() {
  // Source language may be auto-detected; the display language may not.
  fillSelect(el.selSpoken, [state.auto, ...state.languages], state.settings.sourceId);
  fillSelect(el.selDisplay, state.languages, state.settings.targetId);
}

function fillSelect(select, items, selected) {
  select.replaceChildren();
  for (const item of items) {
    const opt = document.createElement('option');
    opt.value = item.id;
    opt.textContent = item.experimental ? `${item.label} — experimental` : item.label;
    select.append(opt);
  }
  if (items.some((i) => i.id === selected)) select.value = selected;
}

async function refreshDevices() {
  const devices = await AudioPipe.listDevices();
  const options = [
    { id: 'default', label: 'Default microphone' },
    ...devices
      .filter((d) => d.deviceId !== 'default')
      .map((d) => ({ id: d.deviceId, label: d.label })),
    { id: '__system__', label: 'System audio — experimental' },
  ];
  const previous = state.settings.deviceId === 'system' ? '__system__' : state.settings.deviceId;
  fillSelect(el.selSource, options, previous);
}

// -------------------------------------------------------------- controls

function bindControls() {
  el.btnStart.addEventListener('click', () => (state.running ? stopSession() : startSession()));

  el.selSpoken.addEventListener('change', async () => {
    await window.rt.settings.patch({ sourceId: el.selSpoken.value });
    state.settings.sourceId = el.selSpoken.value;
    await updateRouteNote();
    if (state.running) await retarget();
  });

  el.selDisplay.addEventListener('change', async () => {
    await window.rt.settings.patch({ targetId: el.selDisplay.value });
    state.settings.targetId = el.selDisplay.value;
    await updateRouteNote();
    if (state.running) await retarget();
  });

  el.selSource.addEventListener('change', async () => {
    const value = el.selSource.value;
    const patch = value === '__system__'
      ? { captureMode: 'system', deviceId: 'system' }
      : { captureMode: 'mic', deviceId: value };
    await window.rt.settings.patch(patch);
    Object.assign(state.settings, patch);
    if (state.running) {
      // Changing the input device means re-opening the capture graph.
      await stopSession({ keepTranscript: true });
      await startSession();
    }
  });

  el.bannerClose.addEventListener('click', () => (el.banner.hidden = true));

  $('btn-present').addEventListener('click', () => {
    el.app.classList.toggle('presenting');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && el.app.classList.contains('presenting')) el.app.classList.remove('presenting');
    if (e.key === 'Escape') closeDrawers();
  });

  $('btn-copy').addEventListener('click', async () => {
    const text = state.transcript.toPlainText();
    if (!text) return;
    await navigator.clipboard.writeText(text);
    flashStatus('Transcript copied');
  });

  $('btn-save').addEventListener('click', async () => {
    const text = state.transcript.toPlainText();
    if (!text) return flashStatus('Nothing to save yet');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const res = await window.rt.shell.saveTranscript({ text, suggestedName: `rtranslate-${stamp}.txt` });
    if (res.ok) flashStatus(`Saved to ${res.filePath}`);
  });

  $('btn-logs').addEventListener('click', async () => {
    const logs = await window.rt.engine.logs();
    el.logBody.replaceChildren();
    logs.forEach(appendLog);
    openDrawer(el.logs);
  });
  $('btn-logs-close').addEventListener('click', closeDrawers);
  $('btn-settings').addEventListener('click', () => openDrawer(el.settings));
  $('btn-settings-close').addEventListener('click', closeDrawers);
  el.scrim.addEventListener('click', closeDrawers);
}

const DRAWERS = () => [el.settings, el.logs, el.phone, el.setup];

function openDrawer(drawer) {
  DRAWERS().forEach((d) => (d.hidden = true));
  drawer.hidden = false;
  el.scrim.hidden = false;
}

function closeDrawers() {
  DRAWERS().forEach((d) => (d.hidden = true));
  el.scrim.hidden = true;
}

// --------------------------------------------------------------- settings

function bindSettings() {
  const s = state.settings;

  fillSelect($('set-model'), state.models.map((m) => ({ id: m.id, label: m.label })), s.model);
  $('set-policy').value = s.policy;
  $('set-backend').value = s.backend;
  $('set-ft').value = String(s.frameThreshold);
  $('ft-value').textContent = `${s.frameThreshold} · ${(s.frameThreshold * 0.02).toFixed(2)} s`;
  $('set-translation').checked = s.translationEnabled;
  $('set-nllb-size').value = s.nllbSize;
  $('set-dual').checked = s.dualPane;
  $('set-native').checked = s.preferNativeEnglish;
  $('set-coexist').checked = s.nativeAndNllbCoexist;
  updateModelHelp();

  const wire = (id, key, read) =>
    $(id).addEventListener('change', async () => {
      const value = read($(id));
      state.settings = await window.rt.settings.patch({ [key]: value });
      updateModelHelp();
      await updateRouteNote();
      if (state.running) await retarget();
    });

  wire('set-model', 'model', (n) => n.value);
  wire('set-policy', 'policy', (n) => n.value);
  wire('set-backend', 'backend', (n) => n.value);
  wire('set-translation', 'translationEnabled', (n) => n.checked);
  wire('set-nllb-size', 'nllbSize', (n) => n.value);
  wire('set-dual', 'dualPane', (n) => n.checked);
  wire('set-native', 'preferNativeEnglish', (n) => n.checked);
  wire('set-coexist', 'nativeAndNllbCoexist', (n) => n.checked);

  $('set-ft').addEventListener('input', (e) => {
    $('ft-value').textContent = `${e.target.value} · ${(Number(e.target.value) * 0.02).toFixed(2)} s`;
  });
  $('set-ft').addEventListener('change', async (e) => {
    state.settings = await window.rt.settings.patch({ frameThreshold: Number(e.target.value) });
    await updateRouteNote();
    if (state.running) await retarget();
  });

  $('btn-reset').addEventListener('click', async () => {
    state.settings = await window.rt.settings.reset();
    bindSettingsValues();
    buildLanguageSelectors();
    await updateRouteNote();
  });
}

function bindSettingsValues() {
  const s = state.settings;
  $('set-model').value = s.model;
  $('set-policy').value = s.policy;
  $('set-backend').value = s.backend;
  $('set-ft').value = String(s.frameThreshold);
  $('ft-value').textContent = `${s.frameThreshold} · ${(s.frameThreshold * 0.02).toFixed(2)} s`;
  $('set-translation').checked = s.translationEnabled;
  $('set-nllb-size').value = s.nllbSize;
  $('set-dual').checked = s.dualPane;
  $('set-native').checked = s.preferNativeEnglish;
  $('set-coexist').checked = s.nativeAndNllbCoexist;
}

function updateModelHelp() {
  const model = state.models.find((m) => m.id === state.settings.model);
  const vram = state.env?.vramGiB;
  const help = $('model-help');
  if (!model) return;
  let text = `Wants roughly ${model.minVramGiB} GiB of VRAM on the AlignAtt path.`;
  if (vram && model.minVramGiB > vram) {
    text += ` This card reports ${vram} GiB — expect an out-of-memory error.`;
    help.className = 'help warn';
  } else {
    help.className = 'help';
  }
  help.textContent = text;
}

// ------------------------------------------------------------- route note

async function updateRouteNote() {
  const plan = await window.rt.session.plan(el.selSpoken.value, el.selDisplay.value);
  state.lastRoute = plan;

  const fast = !plan.route.useNllb;
  const cls = fast ? 'fast' : 'slow';
  const estimate = plan.route.translate
    ? fast
      ? '≈1–1.5 s expected'
      : '≈2–3 s expected — sentence-gated'
    : '≈1–1.5 s expected';

  el.routeNote.replaceChildren();
  const span = document.createElement('span');
  span.className = cls;
  span.textContent = `${plan.route.reason} · ${estimate}`;
  el.routeNote.append(span);

  if (plan.needsRestart) {
    const extra = document.createElement('span');
    extra.textContent = '  ·  changing this reloads the model';
    el.routeNote.append(extra);
  }
  return plan;
}

// ---------------------------------------------------------------- session

async function startSession() {
  if (state.busy) return;
  state.busy = true;
  el.btnStart.disabled = true;
  el.banner.hidden = true;

  try {
    setStatus('busy', 'Starting server…');
    const res = await window.rt.session.start(el.selSpoken.value, el.selDisplay.value);
    if (!res.ok) {
      setStatus('bad', 'Server failed');
      showBanner(
        res.diagnosis?.message || 'The transcription server did not start',
        res.diagnosis?.hint || res.message || 'Open Logs for the full output.',
      );
      return;
    }

    state.transcript.setDisplay(res.display);
    await openSocket(res.url);

    setStatus('busy', 'Opening microphone…');
    await state.audio.start({
      deviceId: state.settings.captureMode === 'system' ? undefined : state.settings.deviceId,
      mode: state.settings.captureMode,
      onPcm: (buffer) => {
        const ws = state.ws;
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(buffer);
      },
      onLevel: (rms) => {
        // Perceptual-ish curve: raw RMS spends its life near zero.
        const pct = Math.min(100, Math.sqrt(rms) * 190);
        el.levelFill.style.width = `${pct}%`;
      },
      onInfo: (info) => {
        setDetail(
          `capture ${info.inputRate} Hz → ${info.targetRate} Hz${info.ratio === 1 ? ' (native)' : ''} · ${state.settings.model}`,
        );
      },
    });

    state.running = true;
    window.rt.setSessionActive(true);
    el.btnStart.textContent = 'Stop';
    el.btnStart.classList.add('stop');
    el.liveDot.classList.add('live');
    el.emptyState.hidden = true;
    setStatus('ok', 'Listening');
  } catch (err) {
    setStatus('bad', 'Could not start');
    showBanner('Could not start capture', err.message);
    await stopSession({ silent: true });
  } finally {
    state.busy = false;
    el.btnStart.disabled = false;
  }
}

async function stopSession({ keepTranscript = true, silent = false } = {}) {
  state.running = false;
  window.rt.setSessionActive(false);
  // Tell any phones the room went quiet, rather than leaving them showing a
  // live-looking screen that has silently stopped updating.
  if (broadcastPending || !state.transcript.isEmpty()) {
    window.rt.phone.broadcast({
      lines: state.transcript.lines.map((l) => ({ speaker: l.speaker, text: l.text || '', translation: l.translation || '' })),
      bufferText: '',
      bufferTranslation: '',
      hasTranslation: state.transcript.display.primaryField === 'translation',
      status: 'Stopped',
    });
  }
  el.btnStart.textContent = 'Start';
  el.btnStart.classList.remove('stop');
  el.liveDot.classList.remove('live');
  el.levelFill.style.width = '0%';

  await state.audio.stop();
  await closeSocket();

  if (!keepTranscript) state.transcript.clear();
  el.emptyState.hidden = !state.transcript.isEmpty();
  if (!silent) setStatus('ok', 'Stopped');
  // The sidecar stays warm on purpose: restarting a session should not pay for
  // a model load again. It is torn down on quit.
}

/** Language or settings changed while running: reconnect, keep the mic open. */
async function retarget() {
  if (!state.running || state.busy) return;
  state.busy = true;
  try {
    const plan = await updateRouteNote();
    setStatus('busy', plan.needsRestart ? 'Reloading model…' : 'Switching…');
    await closeSocket();

    const res = await window.rt.session.start(el.selSpoken.value, el.selDisplay.value);
    if (!res.ok) {
      setStatus('bad', 'Server failed');
      showBanner(
        res.diagnosis?.message || 'The transcription server did not restart',
        res.diagnosis?.hint || res.message || 'Open Logs for the full output.',
      );
      await stopSession({ silent: true });
      return;
    }
    // A new server profile means a new transcript context; the old lines refer
    // to a different configuration and merging them would be a lie.
    if (res.restarted) state.transcript.clear();
    state.transcript.setDisplay(res.display);
    await openSocket(res.url);
    setStatus('ok', 'Listening');
  } finally {
    state.busy = false;
  }
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const generation = ++state.wsGeneration;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    state.ws = ws;

    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('The server accepted no WebSocket connection.'));
    }, 15000);

    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });

    ws.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === 'config' && msg.useAudioWorklet === false) {
        // We are sending raw PCM; if the server is not expecting it, every
        // downstream word is noise. Say so rather than showing gibberish.
        showBanner(
          'The server is not in PCM mode',
          'It expects encoded audio, so raw samples will be decoded as noise. This means --pcm-input did not take effect.',
        );
        return;
      }
      if (state.transcript.ingest(msg)) {
        el.emptyState.hidden = true;
        queueBroadcast(msg);
      }
    });

    ws.addEventListener('error', () => {
      clearTimeout(timer);
      if (generation === state.wsGeneration) reject(new Error('WebSocket error.'));
    });

    ws.addEventListener('close', () => {
      clearTimeout(timer);
      if (generation === state.wsGeneration && state.running) {
        setStatus('bad', 'Connection lost');
        showBanner('The connection to the transcription server closed', 'Open Logs to see why, then press Start again.');
        stopSession({ silent: true });
      }
    });
  });
}

async function closeSocket() {
  const ws = state.ws;
  state.ws = null;
  state.wsGeneration++;
  if (!ws) return;
  try {
    if (ws.readyState === WebSocket.OPEN) {
      // Documented end-of-audio signal: an empty binary frame. Gives the server
      // the chance to flush its final commits before we hang up.
      ws.send(new ArrayBuffer(0));
      await new Promise((r) => setTimeout(r, 250));
    }
    ws.close();
  } catch {
    /* already closing */
  }
}

// ------------------------------------------------------- first-run setup

async function bindSetup() {
  const steps = await window.rt.env.setupSteps();
  renderSetupSteps(steps);

  // The engine describes its own install. The shell knows neither what it
  // downloads nor how big it is, and guessing would age badly the moment the
  // other engine ships.
  const lead = state.env?.health?.setupLead;
  if (lead && el.setupLead) el.setupLead.textContent = lead;

  $('btn-setup-close').addEventListener('click', closeDrawers);

  el.setupStart.addEventListener('click', async () => {
    el.setupStart.disabled = true;
    el.setupCancel.hidden = false;
    el.setupSummary.textContent = 'Working…';
    el.setupLog.replaceChildren();
    renderSetupSteps(steps);

    const result = await window.rt.env.setupStart({});

    el.setupStart.disabled = false;
    el.setupCancel.hidden = true;

    if (result.ok) {
      const device = result.info?.device ? ` on ${result.info.device}` : '';
      el.setupSummary.textContent = `Ready${device}. You can close this.`;
      el.setupStart.textContent = 'Reinstall';
      el.banner.hidden = true;
      flashStatus('Transcription engine installed');
    } else if (result.cancelled) {
      el.setupSummary.textContent = 'Cancelled. Nothing was left running.';
    } else {
      el.setupSummary.textContent = result.message || 'Setup failed. See the output below.';
    }
  });

  el.setupCancel.addEventListener('click', async () => {
    el.setupCancel.disabled = true;
    await window.rt.env.setupCancel();
    el.setupCancel.disabled = false;
  });

  window.rt.env.onSetupProgress((p) => {
    if (p.index < 0) {
      // A whole-run failure, not a step failure.
      el.setupSummary.textContent = p.detail || 'Setup stopped.';
      return;
    }
    const node = el.setupSteps.children[p.index];
    if (!node) return;
    node.className = `step ${p.status}`;
    node.querySelector('.mark').textContent =
      p.status === 'done' ? '✓' : p.status === 'failed' ? '✕' : '·';
    const detail = node.querySelector('.detail');
    detail.textContent = p.detail || '';
    detail.hidden = !p.detail;
  });

  window.rt.env.onSetupLog((entry) => {
    const line = document.createElement('span');
    line.textContent = `${entry.line}\n`;
    el.setupLog.append(line);
    while (el.setupLog.childElementCount > 400) el.setupLog.firstElementChild.remove();
    el.setupLog.scrollTop = el.setupLog.scrollHeight;
  });
}

function renderSetupSteps(steps) {
  el.setupSteps.replaceChildren();
  for (const step of steps) {
    const li = document.createElement('li');
    li.className = 'step';

    const mark = document.createElement('span');
    mark.className = 'mark';
    mark.textContent = '·';

    const body = document.createElement('span');
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = step.label;
    const detail = document.createElement('span');
    detail.className = 'detail';
    detail.hidden = true;
    body.append(label, detail);

    li.append(mark, body);
    el.setupSteps.append(li);
  }
}

// ----------------------------------------------------------- phone display

/**
 * Caption updates arrive several times a second and each carries the full line
 * list. Coalescing to ~7 fps is well under the threshold where a reader would
 * notice, and keeps a room full of phones from turning into a fan.
 */
let broadcastPending = null;
let broadcastTimer = null;

function queueBroadcast(msg) {
  broadcastPending = msg;
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    const pending = broadcastPending;
    broadcastPending = null;
    if (pending) sendBroadcast(pending);
  }, 140);
}

function sendBroadcast(msg) {
  const display = state.transcript.display;
  const hasTranslation = display.primaryField === 'translation';
  const label = (id) => state.languages.find((l) => l.id === id)?.short || id.toUpperCase();

  window.rt.phone.broadcast({
    lines: (msg.lines || []).map((l) => ({
      speaker: l.speaker,
      text: l.text || '',
      translation: l.translation || '',
    })),
    bufferText: msg.buffer_transcription || '',
    bufferTranslation: msg.buffer_translation || '',
    hasTranslation,
    sourceLabel: label(el.selSpoken.value),
    targetLabel: label(el.selDisplay.value),
    status: state.running ? 'Live' : 'Paused',
  });
}

function bindPhone() {
  el.phonePort.value = String(state.settings.phonePort || 8420);

  $('btn-phone').addEventListener('click', async () => {
    await refreshPhone();
    openDrawer(el.phone);
  });
  $('btn-phone-close').addEventListener('click', closeDrawers);

  el.phoneToggle.addEventListener('change', async () => {
    if (el.phoneToggle.checked) {
      el.phoneFirewall.hidden = false;
      const res = await window.rt.phone.start(Number(el.phonePort.value) || 8420);
      if (!res.ok) {
        el.phoneToggle.checked = false;
        showBanner('Could not start the phone display', res.message);
        return;
      }
      applyPhoneInfo(res);
    } else {
      await window.rt.phone.stop();
      applyPhoneInfo({ running: false });
    }
  });

  el.phoneAddress.addEventListener('change', async () => {
    const url = el.phoneAddress.value;
    el.phoneUrl.textContent = url;
    const { qr } = await window.rt.phone.qr(url);
    if (qr) el.phoneQr.src = qr;
  });

  $('phone-copy').addEventListener('click', async () => {
    await navigator.clipboard.writeText(el.phoneUrl.textContent);
    flashStatus('Address copied');
  });

  el.phonePort.addEventListener('change', async () => {
    const port = Number(el.phonePort.value) || 8420;
    state.settings = await window.rt.settings.patch({ phonePort: port });
    if (el.phoneToggle.checked) {
      await window.rt.phone.stop();
      const res = await window.rt.phone.start(port);
      if (!res.ok) {
        el.phoneToggle.checked = false;
        showBanner('Could not restart the phone display', res.message);
        return;
      }
      applyPhoneInfo(res);
    }
  });

  window.rt.phone.onClients((info) => applyPhoneInfo(info));
  window.rt.phone.onError((e) => showBanner('Phone display error', e.message));
}

async function refreshPhone() {
  applyPhoneInfo(await window.rt.phone.info());
}

function applyPhoneInfo(info) {
  const running = Boolean(info?.running);
  el.phoneToggle.checked = running;
  el.phoneDetails.hidden = !running;
  el.phoneFirewall.hidden = !running;

  const count = info?.clientCount || 0;
  el.phoneCount.hidden = !running || count === 0;
  el.phoneCount.textContent = String(count);
  el.phoneClients.textContent = `${count} device${count === 1 ? '' : 's'}`;

  if (!running) return;

  el.phoneKey.textContent = info.key || '—';
  if (info.qr) el.phoneQr.src = info.qr;

  if (Array.isArray(info.addresses) && info.addresses.length) {
    const current = el.phoneAddress.value;
    el.phoneAddress.replaceChildren();
    for (const addr of info.addresses) {
      const opt = document.createElement('option');
      opt.value = addr.url;
      opt.textContent = `${addr.address} — ${addr.name}`;
      el.phoneAddress.append(opt);
    }
    el.phoneAddress.value =
      info.addresses.some((a) => a.url === current) ? current : info.addresses[0].url;
    el.phoneUrl.textContent = el.phoneAddress.value;
  } else if (info.url) {
    el.phoneUrl.textContent = info.url;
  }
}

// --------------------------------------------------------------- updates

function bindUpdates() {
  window.rt.update.onStatus(applyUpdateStatus);
  window.rt.update.status().then(applyUpdateStatus);

  el.updateDismiss.addEventListener('click', () => {
    el.updateBar.hidden = true;
  });

  el.updateInstall.addEventListener('click', async () => {
    let res = await window.rt.update.install();
    if (res.needsConfirm) {
      // Never cut someone off mid-conversation without asking.
      if (!confirm(`${res.message}\n\nInstall now anyway?`)) return;
      res = await window.rt.update.install({ force: true });
    }
    if (!res.ok) showBanner('Could not install the update', res.message);
  });
}

function applyUpdateStatus(status) {
  if (!status || status.state === 'idle' || status.state === 'disabled' || status.state === 'current') {
    el.updateBar.hidden = true;
    return;
  }
  if (status.state === 'checking') return; // too transient to be worth a bar

  if (status.state === 'error') {
    // Offline is normal for an app designed to work without a network. Do not
    // nag about it.
    el.updateBar.hidden = true;
    return;
  }

  const version = status.info?.version ? ` ${status.info.version}` : '';
  if (status.state === 'downloading') {
    el.updateBar.hidden = false;
    el.updateInstall.hidden = true;
    el.updateText.textContent = `Downloading update${version}… ${status.progress ?? 0}%`;
  } else if (status.state === 'ready') {
    el.updateBar.hidden = false;
    el.updateInstall.hidden = false;
    el.updateText.textContent = `Update${version} is ready to install.`;
  }
}

// --------------------------------------------------------------- feedback

function onSidecarState({ state: s, detail }) {
  state.sidecarState = s;
  if (s === 'starting') setStatus('busy', 'Loading model…');
  if (s === 'error' && detail?.message) {
    setStatus('bad', 'Server error');
    showBanner(detail.message, detail.hint || 'Open Logs for the full output.');
  }
}

function setStatus(kind, text) {
  el.statusPill.className = `pill pill-${kind === 'ok' ? 'ok' : kind === 'busy' ? 'busy' : 'bad'}`;
  el.statusPill.textContent = text;
  el.liveDot.classList.toggle('ready', kind === 'ok');
}

let detailTimer = null;
function setDetail(text) {
  el.statusDetail.textContent = text;
}
function flashStatus(text) {
  const previous = el.statusDetail.textContent;
  el.statusDetail.textContent = text;
  clearTimeout(detailTimer);
  detailTimer = setTimeout(() => {
    el.statusDetail.textContent = previous;
  }, 2600);
}

function showBanner(title, hint, action) {
  el.bannerTitle.textContent = title;
  el.bannerHint.textContent = hint || '';
  const button = $('banner-action');
  button.hidden = !action;
  if (action) {
    button.textContent = action.label;
    button.onclick = action.onClick;
  }
  el.banner.hidden = false;
}

function appendLog(entry) {
  if (!entry) return;
  const line = document.createElement('span');
  line.className = entry.stream || 'out';
  line.textContent = `${entry.line}\n`;
  el.logBody.append(line);
  while (el.logBody.childElementCount > 600) el.logBody.firstElementChild.remove();
  el.logBody.scrollTop = el.logBody.scrollHeight;
}
