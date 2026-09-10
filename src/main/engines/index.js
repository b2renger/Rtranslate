/**
 * The engine registry.
 *
 * Engines are found by reading this directory, not by being listed anywhere.
 * That is deliberate: `engine/whisperlivekit` and `engine/qvac` each add one
 * file here, so the two branches can be developed, profiled and merged without
 * ever touching the same line.
 *
 * The contract every module in here satisfies is docs/engine-contract.md.
 */

const fs = require('node:fs');
const path = require('node:path');

const REQUIRED = ['id', 'label', 'inspect', 'plan', 'ensure', 'stop'];

/** @type {Map<string, object>|null} */
let cache = null;

function load() {
  if (cache) return cache;
  cache = new Map();

  const dir = __dirname;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.js') && f !== 'index.js')
    .sort();

  for (const file of files) {
    let mod;
    try {
      mod = require(path.join(dir, file));
    } catch (err) {
      // A broken engine must not take the app down with it: the shell can still
      // run every other engine, and the UI can explain this one.
      cache.set(file.replace(/\.js$/, ''), brokenEngine(file, err));
      continue;
    }

    const missing = REQUIRED.filter((k) => typeof mod?.[k] === 'undefined');
    if (missing.length) {
      throw new Error(`engines/${file} is not an engine: missing ${missing.join(', ')}`);
    }
    if (cache.has(mod.id)) {
      throw new Error(`engines/${file} reuses the id "${mod.id}"`);
    }
    cache.set(mod.id, mod);
  }

  if (cache.size === 0) {
    throw new Error('No engines found in src/main/engines - this branch cannot transcribe.');
  }
  return cache;
}

/** An engine that exists but could not be loaded; it reports why. */
function brokenEngine(file, err) {
  const id = file.replace(/\.js$/, '');
  return {
    id,
    label: id,
    description: 'failed to load',
    broken: true,
    async inspect() {
      return { ok: false, problem: 'engine-broken', message: `${file}: ${err.message}`, info: {} };
    },
    plan() { throw new Error(`engine "${id}" failed to load: ${err.message}`); },
    async ensure() { throw new Error(`engine "${id}" failed to load: ${err.message}`); },
    async stop() {},
    state: () => 'error',
    logs: () => [],
  };
}

/** Every engine this build ships, in id order. */
function list() {
  return [...load().values()].map((e) => ({
    id: e.id,
    label: e.label,
    description: e.description || '',
    broken: Boolean(e.broken),
    capabilities: e.capabilities || {},
  }));
}

/**
 * Resolve an engine by id.
 *
 * An unknown id is a downgrade, not a crash: a settings file written by the
 * other branch names an engine this build does not have, and the honest
 * response is to fall back and say so rather than refuse to start.
 */
function get(id) {
  const engines = load();
  if (engines.has(id)) return engines.get(id);

  const fallback = preferred();
  if (!fallback) throw new Error(`No engine "${id}" and no fallback available.`);
  return fallback;
}

/** True when `id` names an engine this build actually has. */
function has(id) {
  return load().has(id);
}

/** The engine to use when settings say nothing useful: any real one, else mock. */
function preferred() {
  const engines = [...load().values()].filter((e) => !e.broken);
  return engines.find((e) => e.id !== 'mock') || engines[0] || null;
}

/** Tests mutate the directory; let them start clean. */
function reset() {
  cache = null;
}

module.exports = { list, get, has, preferred, reset };
