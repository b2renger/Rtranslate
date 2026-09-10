/** Persisted settings. Small enough that a JSON file beats a dependency. */

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const engines = require('./engines');

const SESSION_DEFAULTS = {
  // null means "whichever engine this build considers best". Naming one here
  // would bake a branch's engine into the shell, which is the coupling the
  // registry exists to remove.
  engine: null,

  sourceId: 'fr',
  targetId: 'fr',
  deviceId: 'default',
  captureMode: 'mic', // mic | system
  presentationMode: false,

  // Phone display. Off by default: starting it binds to 0.0.0.0, which is when
  // the Windows firewall prompt appears, and that should follow a deliberate
  // click rather than ambush someone on first launch.
  phoneEnabled: false,
  phonePort: 8420,
};

class Settings {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'settings.json');
    this.data = { ...engines.defaults(), ...SESSION_DEFAULTS };
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      // Merge rather than replace, so a new setting added in a later version
      // gets its default instead of undefined.
      this.data = { ...engines.defaults(), ...SESSION_DEFAULTS, ...parsed };
    } catch {
      /* first run, or the file was hand-edited into invalid JSON */
    }
    return this.data;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      console.error('[settings] could not save:', err.message);
    }
  }

  get() {
    return { ...this.data };
  }

  patch(partial) {
    this.data = { ...this.data, ...partial };
    this.save();
    return this.get();
  }

  reset() {
    this.data = { ...engines.defaults(), ...SESSION_DEFAULTS };
    this.save();
    return this.get();
  }
}

module.exports = { Settings, SESSION_DEFAULTS };
