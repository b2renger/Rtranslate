const { contextBridge, ipcRenderer } = require('electron');

/**
 * The whole surface the renderer is allowed to touch. Deliberately small:
 * everything that spawns a process, reads the filesystem or talks to the GPU
 * lives in main.
 */
contextBridge.exposeInMainWorld('rt', {
  // --- environment ---------------------------------------------------------
  env: {
    inspect: () => ipcRenderer.invoke('env:inspect'),
    languages: () => ipcRenderer.invoke('env:languages'),
    models: () => ipcRenderer.invoke('env:models'),
    onReport: (cb) => subscribe('env:report', cb),

    // First-run setup: builds the Python sidecar environment from nothing.
    setupSteps: () => ipcRenderer.invoke('env:setup-steps'),
    setupStart: (opts) => ipcRenderer.invoke('env:setup-start', opts),
    setupCancel: () => ipcRenderer.invoke('env:setup-cancel'),
    onSetupProgress: (cb) => subscribe('env:setup-progress', cb),
    onSetupLog: (cb) => subscribe('env:setup-log', cb),
  },

  // --- settings ------------------------------------------------------------
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    patch: (partial) => ipcRenderer.invoke('settings:patch', partial),
    reset: () => ipcRenderer.invoke('settings:reset'),
  },

  // --- session -------------------------------------------------------------
  session: {
    /** What would happen for this pair, without doing it. */
    plan: (sourceId, targetId) => ipcRenderer.invoke('session:plan', { sourceId, targetId }),
    /** Make the sidecar match this pair; resolves with the port and query. */
    start: (sourceId, targetId) => ipcRenderer.invoke('session:start', { sourceId, targetId }),
    stop: () => ipcRenderer.invoke('session:stop'),
  },

  // --- sidecar telemetry ---------------------------------------------------
  sidecar: {
    state: () => ipcRenderer.invoke('sidecar:state'),
    logs: () => ipcRenderer.invoke('sidecar:logs'),
    onState: (cb) => subscribe('sidecar:state-changed', cb),
    onLog: (cb) => subscribe('sidecar:log', cb),
  },

  // --- system audio (experimental on Windows) ------------------------------
  capture: {
    enableLoopback: () => ipcRenderer.invoke('capture:enable-loopback'),
    disableLoopback: () => ipcRenderer.invoke('capture:disable-loopback'),
  },

  // --- phone display -------------------------------------------------------
  phone: {
    start: (port) => ipcRenderer.invoke('phone:start', { port }),
    stop: () => ipcRenderer.invoke('phone:stop'),
    info: () => ipcRenderer.invoke('phone:info'),
    qr: (url) => ipcRenderer.invoke('phone:qr', { url }),
    /** Fire-and-forget: this runs several times a second. */
    broadcast: (payload) => ipcRenderer.send('phone:broadcast', payload),
    onClients: (cb) => subscribe('phone:clients', cb),
    onError: (cb) => subscribe('phone:error', cb),
  },

  // --- updates -------------------------------------------------------------
  update: {
    status: () => ipcRenderer.invoke('update:status'),
    check: () => ipcRenderer.invoke('update:check'),
    install: (opts) => ipcRenderer.invoke('update:install', opts),
    onStatus: (cb) => subscribe('update:status-changed', cb),
  },

  // Lets main refuse to install an update while someone is being captioned.
  setSessionActive: (active) => ipcRenderer.send('session:set-active', active),

  // --- misc ----------------------------------------------------------------
  shell: {
    saveTranscript: (payload) => ipcRenderer.invoke('shell:save-transcript', payload),
  },
});

function subscribe(channel, cb) {
  const handler = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}
