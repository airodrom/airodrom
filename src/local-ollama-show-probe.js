'use strict';
// Non-generating Ollama /api/show probe shared by conversation qualification and OpenCode readiness.
// Never authorizes worker launch; digest/template checks remain mandatory. No model generation.
const http = require('node:http');
const capability = require('./local-model-capability');

const SUCCESS_TTL_MS = 5000;
const TRANSIENT_TTL_MS = 400;
const SHOW_TIMEOUT_MS = 1000;
const MAX_BYTES = 256000;

/** @type {Map<string, { at: number, ttl: number, value: object, key: string }>} */
const caches = new Map();
/** @type {Map<string, Promise<object>>} */
const inflights = new Map();
/** @type {WeakMap<Function, string>} */
const transportIds = new WeakMap();
let transportSeq = 0;

function denied(reason, probe_class) {
  return { allow: false, reason, probe_class, authority: false };
}

function transportIdentity(transport) {
  if (typeof transport !== 'function') return 'http';
  let id = transportIds.get(transport);
  if (!id) {
    id = 'transport:' + (++transportSeq);
    transportIds.set(transport, id);
  }
  return id;
}

function probeKey({ model, record, transport }) {
  const digest = typeof record?.digest === 'string' ? record.digest.slice(0, 128) : '';
  const template = typeof record?.template_hash === 'string' ? record.template_hash.slice(0, 64) : '';
  const status = typeof record?.qualification_status === 'string' ? record.qualification_status.slice(0, 40) : '';
  return [model, digest, template, status, transportIdentity(transport)].join('\0');
}

function probeOnce({ model, record, timeoutMs, transport }) {
  if (typeof transport === 'function') {
    return transport({ model, record, timeoutMs }).then(value => {
      if (!value || typeof value !== 'object') return denied('opencode_local_provider_unavailable', 'denied');
      if (value.allow === true) return { allow: true, reason: null, probe_class: 'ready', authority: false };
      const reason = typeof value.reason === 'string' && /^[a-z0-9_]{1,80}$/.test(value.reason)
        ? value.reason
        : 'opencode_local_provider_unavailable';
      const probe_class = ['timeout', 'unreachable', 'oversized', 'parse', 'denied', 'ready'].includes(value.probe_class)
        ? value.probe_class
        : 'denied';
      return denied(reason, probe_class);
    }).catch(() => denied('opencode_local_provider_unavailable', 'unreachable'));
  }
  return new Promise(resolve => {
    const body = JSON.stringify({ name: model });
    const request = http.request({
      hostname: '127.0.0.1',
      port: 11434,
      path: '/api/show',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: timeoutMs
    }, response => {
      let text = '', bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) {
          request.destroy();
          resolve(denied('opencode_local_provider_unavailable', 'oversized'));
        } else text += chunk;
      });
      response.on('end', () => {
        try {
          if (response.statusCode !== 200) return resolve(denied('opencode_local_provider_unavailable', 'denied'));
          const live = capability.inspectOllamaShow(JSON.parse(text));
          const assess = capability.assessQualification(record, live);
          if (!live.available || !live.digest || !live.templateHash || !assess.allow) {
            const reason = assess.reason === 'model_digest_changed' || assess.reason === 'template_hash_changed'
              ? assess.reason
              : 'opencode_local_provider_unavailable';
            return resolve(denied(reason, 'denied'));
          }
          resolve({ allow: true, reason: null, probe_class: 'ready', authority: false });
        } catch {
          resolve(denied('opencode_local_provider_unavailable', 'parse'));
        }
      });
      response.on('error', () => resolve(denied('opencode_local_provider_unavailable', 'unreachable')));
    });
    request.on('error', () => resolve(denied('opencode_local_provider_unavailable', 'unreachable')));
    request.on('timeout', () => {
      request.destroy();
      resolve(denied('opencode_local_provider_timeout', 'timeout'));
    });
    request.end(body);
  });
}

async function probeQualifiedShow({
  model,
  record,
  timeoutMs = SHOW_TIMEOUT_MS,
  allowRecheck = true,
  now = Date.now(),
  transport
} = {}) {
  if (typeof model !== 'string' || !model || model.length > 120) return denied('opencode_local_provider_unavailable', 'denied');
  const key = probeKey({ model, record, transport });
  const cached = caches.get(key);
  if (cached && cached.key === key && now - cached.at < cached.ttl) return { ...cached.value };
  const pending = inflights.get(key);
  if (pending) return pending;
  const run = (async () => {
    let result = await probeOnce({ model, record, timeoutMs, transport });
    // Exactly one recheck for transient probe timeout — never a loop, never generation.
    if (result.probe_class === 'timeout' && allowRecheck) {
      result = await probeOnce({ model, record, timeoutMs, transport });
      if (result.probe_class === 'timeout') result = denied('opencode_local_provider_timeout', 'timeout');
    }
    const ttl = result.allow || result.probe_class === 'denied' || result.probe_class === 'oversized' || result.probe_class === 'parse'
      ? SUCCESS_TTL_MS
      : TRANSIENT_TTL_MS;
    caches.set(key, { at: Date.now(), ttl, value: result, key });
    return { ...result };
  })().finally(() => { inflights.delete(key); });
  inflights.set(key, run);
  return run;
}

function resetShowProbeForTests() {
  caches.clear();
  inflights.clear();
}

module.exports = {
  SUCCESS_TTL_MS,
  TRANSIENT_TTL_MS,
  SHOW_TIMEOUT_MS,
  probeKey,
  probeQualifiedShow,
  resetShowProbeForTests
};
