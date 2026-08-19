const { contextBridge, ipcRenderer } = require('electron');

/**
 * The whole surface the renderer is allowed to touch. Deliberately small:
 * everything that spawns a process, reads the filesystem or talks to the GPU
 * lives in main.
 */
contextBridge.exposeInMainWorld('wl', {
  // --- environment ---------------------------------------------------------
  env: {
    inspect: () => ipcRenderer.invoke('env:inspect'),
    languages: () => ipcRenderer.invoke('env:languages'),
    models: () => ipcRenderer.invoke('env:models'),
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
