'use strict';
const { SDK_VERSION } = require('./index');
const ID = /^[a-z][a-z0-9.-]{1,63}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
function supports(range, version = SDK_VERSION) {
  if (typeof range !== 'string' || typeof version !== 'string') return false;
  const current = VERSION.exec(version), target = VERSION.exec(range.replace(/^\^/, ''));
  if (!current || !target) return false;
  if (!range.startsWith('^')) return range === version;
  const a = current.slice(1).map(Number), b = target.slice(1).map(Number);
  if (a[0] !== b[0]) return false;
  if (b[0] === 0) return a[1] === b[1] && (b[1] === 0 ? a[2] === b[2] : a[2] >= b[2]);
  return a[1] > b[1] || a[1] === b[1] && a[2] >= b[2];
}
class AppRegistry {
  #apps = new Map();
  #capabilities = new Map();
  register({ manifest, capabilities = {} }) {
    if (!manifest || Object.keys(manifest).some(k => !['id', 'version', 'sdk'].includes(k)) || typeof manifest.id !== 'string' || typeof manifest.version !== 'string' || !ID.test(manifest.id) || !VERSION.test(manifest.version) || !supports(manifest.sdk)) throw Error('Invalid or incompatible Pi App manifest');
    if (this.#apps.has(manifest.id)) throw Error('Duplicate Pi App');
    if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) throw Error('Invalid app capabilities');
    // Validate the entire registration before changing the registry.
    for (const [name, definition] of Object.entries(capabilities)) {
      if (!/^[a-z][a-z0-9_]{1,63}$/.test(name) || this.#capabilities.has(name) || !definition || typeof definition.validate !== 'function' || typeof definition.perform !== 'function') throw Error('Invalid or duplicate app capability');
    }
    const record = Object.freeze({ ...manifest });
    for (const [name, definition] of Object.entries(capabilities)) this.#capabilities.set(name, Object.freeze({ ...definition }));
    this.#apps.set(record.id, record);
    return record;
  }
  list() { return [...this.#apps.values()]; }
  definitions() { return Object.freeze(Object.fromEntries(this.#capabilities)); }
}
module.exports = { AppRegistry, supports };
