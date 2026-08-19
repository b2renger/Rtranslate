/**
 * Auto-update, wired so it can never interrupt a live session.
 *
 * Downloads happen quietly in the background; installing is always the user's
 * click. Nothing about this app should ever restart itself mid-sentence while
 * someone is relying on it to caption a conversation.
 */

const { app } = require('electron');
const { EventEmitter } = require('node:events');

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // six hours

class Updater extends EventEmitter {
  constructor({ isSessionActive } = {}) {
    super();
    this.isSessionActive = isSessionActive || (() => false);
    this.autoUpdater = null;
    this.timer = null;
    this.status = { state: 'idle', version: app.getVersion(), info: null, progress: null, error: null };
    this.enabled = false;
  }

  init() {
    // In development there is no app-update.yml and no signed artefact, so
    // electron-updater would only ever produce noise.
    if (!app.isPackaged) {
      this.setStatus({ state: 'disabled', error: 'Updates are disabled when running from source.' });
      return this;
    }

    try {
      ({ autoUpdater: this.autoUpdater } = require('electron-updater'));
    } catch (err) {
      this.setStatus({ state: 'disabled', error: `electron-updater unavailable: ${err.message}` });
      return this;
    }

    const u = this.autoUpdater;
    u.autoDownload = true;          // fetch quietly...
    u.autoInstallOnAppQuit = true;  // ...and apply on a quit the user chose
    u.allowPrerelease = false;
    u.logger = null;

    u.on('checking-for-update', () => this.setStatus({ state: 'checking', error: null }));
    u.on('update-not-available', (info) => this.setStatus({ state: 'current', info, error: null }));
    u.on('update-available', (info) => this.setStatus({ state: 'downloading', info, progress: 0, error: null }));
    u.on('download-progress', (p) =>
      this.setStatus({ state: 'downloading', progress: Math.round(p.percent) }),
    );
    u.on('update-downloaded', (info) => this.setStatus({ state: 'ready', info, progress: 100, error: null }));
    u.on('error', (err) =>
      this.setStatus({
        state: 'error',
        // Offline is the overwhelmingly common case and is not worth alarming
        // anyone about in an app whose whole point is working without a network.
        error: isOffline(err) ? 'No connection to the update server.' : String(err?.message || err),
      }),
    );

    this.enabled = true;
    this.check({ silent: true });
    this.timer = setInterval(() => this.check({ silent: true }), CHECK_INTERVAL_MS);
    this.timer.unref?.();
    return this;
  }

  setStatus(partial) {
    this.status = { ...this.status, ...partial };
    this.emit('status', this.status);
  }

  async check({ silent = false } = {}) {
    if (!this.enabled) {
      if (!silent) this.emit('status', this.status);
      return this.status;
    }
    try {
      await this.autoUpdater.checkForUpdates();
    } catch (err) {
      this.setStatus({
        state: 'error',
        error: isOffline(err) ? 'No connection to the update server.' : String(err?.message || err),
      });
    }
    return this.status;
  }

  /**
   * Install and restart. Refuses while a session is live unless the caller
   * explicitly insists, so a stray click cannot cut someone off mid-conversation.
   */
  installNow({ force = false } = {}) {
    if (this.status.state !== 'ready') {
      return { ok: false, message: 'No downloaded update is waiting.' };
    }
    if (this.isSessionActive() && !force) {
      return { ok: false, needsConfirm: true, message: 'A session is running. Installing will stop it and restart the app.' };
    }
    // isSilent false, isForceRunAfter true: show the installer, come back after.
    setImmediate(() => this.autoUpdater.quitAndInstall(false, true));
    return { ok: true };
  }

  dispose() {
    clearInterval(this.timer);
    this.timer = null;
  }
}

function isOffline(err) {
  const text = String(err?.message || err || '');
  return /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|net::ERR_INTERNET_DISCONNECTED/i.test(text);
}

module.exports = { Updater, isOffline, CHECK_INTERVAL_MS };
