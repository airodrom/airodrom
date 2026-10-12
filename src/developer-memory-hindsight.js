'use strict';

/**
 * Loopback HTTP transport for Hindsight API 0.10.x.
 * Paths use /v1/default/banks/{bank_id}/… Retain uses { items: [...] }.
 * Does not launch daemons, install agent plugins, or fall back to cloud hosts.
 */
const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const API_PREFIX = '/v1/default';

function classifyError(error) {
  const message = String(error?.message || error || '');
  if (/timeout|ETIMEDOUT|ABORT/i.test(message)) return 'timeout';
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|unavailable/i.test(message)) return 'unavailable';
  if (/401|403|auth/i.test(message)) return 'auth';
  if (/circuit/i.test(message)) return 'circuit_open';
  if (/external|loopback|allow_external/i.test(message)) return 'policy';
  return 'transport';
}

function bankPath(bankId, suffix = '') {
  if (typeof bankId !== 'string' || !/^airo-dev-[a-f0-9]{32}$/.test(bankId)) {
    throw new Error('Invalid Hindsight bank id');
  }
  return `${API_PREFIX}/banks/${encodeURIComponent(bankId)}${suffix}`;
}

class HindsightHttpTransport {
  constructor({
    baseUrl = 'http://127.0.0.1:8888',
    apiToken = null,
    timeoutMs = 4000,
    maxRetries = 1,
    circuitFailures = 3,
    circuitCooldownMs = 30_000,
    allowExternal = false,
    fetchImpl = null,
    now = Date.now
  } = {}) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.apiToken = apiToken || null;
    this.timeoutMs = Math.max(250, Math.min(30_000, Number(timeoutMs) || 4000));
    this.maxRetries = Math.max(0, Math.min(3, Number(maxRetries) || 0));
    this.circuitFailures = Math.max(1, Math.min(20, Number(circuitFailures) || 3));
    this.circuitCooldownMs = Math.max(1000, Number(circuitCooldownMs) || 30_000);
    this.allowExternal = allowExternal === true;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this._failures = 0;
    this._openUntil = 0;
    this._lastErrorClass = null;
  }

  _assertUrl() {
    let url;
    try { url = new URL(this.baseUrl); } catch { throw new Error('Invalid Hindsight base URL'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Hindsight URL must be http(s)');
    const host = url.hostname.toLowerCase();
    if (!this.allowExternal && !LOOPBACK.has(host)) throw new Error('Hindsight host is not loopback; allow_external is false');
    if (this.allowExternal !== true && url.protocol === 'https:' && !LOOPBACK.has(host)) {
      throw new Error('External Hindsight HTTPS requires allow_external');
    }
    return url;
  }

  _circuitCheck() {
    if (this._openUntil && this.now() < this._openUntil) throw new Error('Hindsight circuit open');
    if (this._openUntil && this.now() >= this._openUntil) {
      this._openUntil = 0;
      this._failures = 0;
    }
  }

  _recordFailure(error) {
    this._failures += 1;
    this._lastErrorClass = classifyError(error);
    if (this._failures >= this.circuitFailures) this._openUntil = this.now() + this.circuitCooldownMs;
  }

  _recordSuccess() {
    this._failures = 0;
    this._openUntil = 0;
    this._lastErrorClass = null;
  }

  async request(method, pathname, body = undefined, { signal } = {}) {
    this._circuitCheck();
    const base = this._assertUrl();
    const url = new URL(pathname.replace(/^\//, ''), base.href.endsWith('/') ? base.href : `${base.href}/`);
    let attempt = 0;
    let lastError;
    while (attempt <= this.maxRetries) {
      attempt += 1;
      try {
        const result = await this._once(method, url, body, signal);
        this._recordSuccess();
        return result;
      } catch (error) {
        lastError = error;
        const kind = classifyError(error);
        if (kind === 'policy' || kind === 'auth' || kind === 'circuit_open') {
          this._recordFailure(error);
          throw error;
        }
        if (attempt > this.maxRetries) {
          this._recordFailure(error);
          throw error;
        }
      }
    }
    this._recordFailure(lastError);
    throw lastError;
  }

  _once(method, url, body, signal) {
    if (this.fetchImpl) return this._fetchOnce(method, url, body, signal);
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
      const lib = url.protocol === 'https:' ? https : http;
      const headers = { Accept: 'application/json' };
      if (payload) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = String(payload.length);
      }
      if (this.apiToken) headers.Authorization = `Bearer ${this.apiToken}`;
      const req = lib.request({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method,
        headers,
        timeout: this.timeoutMs
      }, res => {
        const chunks = [];
        let size = 0;
        res.on('data', chunk => {
          size += chunk.length;
          if (size > 512 * 1024) {
            req.destroy(new Error('Hindsight response exceeds size bound'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode === 404) return resolve({ status: res.statusCode, body: null, raw: text });
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`Hindsight HTTP ${res.statusCode}`));
          }
          if (!text) return resolve({ status: res.statusCode, body: null, raw: '' });
          try { resolve({ status: res.statusCode, body: JSON.parse(text), raw: text }); }
          catch { reject(new Error('Hindsight response is not JSON')); }
        });
      });
      req.on('timeout', () => req.destroy(new Error('Hindsight timeout')));
      req.on('error', reject);
      if (signal) {
        if (signal.aborted) {
          req.destroy(new Error('Hindsight aborted'));
          return;
        }
        const onAbort = () => req.destroy(new Error('Hindsight aborted'));
        signal.addEventListener('abort', onAbort, { once: true });
        req.on('close', () => signal.removeEventListener('abort', onAbort));
      }
      if (payload) req.write(payload);
      req.end();
    });
  }

  async _fetchOnce(method, url, body, signal) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.apiToken) headers.Authorization = `Bearer ${this.apiToken}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onOuterAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        throw new Error('Hindsight aborted');
      }
      signal.addEventListener('abort', onOuterAbort, { once: true });
    }
    try {
      const response = await this.fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      });
      const text = await response.text();
      if (response.status === 404) return { status: response.status, body: null, raw: text };
      if (!response.ok) throw new Error(`Hindsight HTTP ${response.status}`);
      if (!text) return { status: response.status, body: null, raw: '' };
      return { status: response.status, body: JSON.parse(text), raw: text };
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('Hindsight timeout');
      throw error;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onOuterAbort);
    }
  }

  async health() {
    try {
      const result = await this.request('GET', '/v1/version');
      const body = result.body || {};
      return {
        status: 'available',
        api_version: body.api_version || body.version || null,
        features: body.features || null,
        error_class: null
      };
    } catch (error) {
      return {
        status: 'unavailable',
        api_version: null,
        features: null,
        error_class: classifyError(error)
      };
    }
  }

  async recall(bankId, query, options = {}) {
    const result = await this.request('POST', bankPath(bankId, '/memories/recall'), {
      query,
      budget: options.budget || 'low',
      max_tokens: options.maxTokens || 1024,
      ...(options.types ? { types: options.types } : {})
    }, { signal: options.signal });
    const body = result.body || {};
    return {
      results: Array.isArray(body.results) ? body.results : [],
      ...body
    };
  }

  async retain(bankId, content, options = {}) {
    const item = {
      content,
      context: options.context || undefined,
      document_id: options.documentId || undefined,
      metadata: options.metadata || undefined,
      timestamp: options.timestamp || undefined,
      tags: options.tags || undefined
    };
    const result = await this.request('POST', bankPath(bankId, '/memories'), {
      items: [item],
      async: false
    }, { signal: options.signal });
    return result.body || {};
  }

  async deleteDocument(bankId, documentId, options = {}) {
    if (typeof documentId !== 'string' || !documentId || documentId.includes('/') || documentId.includes('..')) {
      throw new Error('Invalid document id');
    }
    return this.request(
      'DELETE',
      bankPath(bankId, `/documents/${encodeURIComponent(documentId)}`),
      undefined,
      { signal: options.signal }
    );
  }

  async ensureBank(bankId, options = {}) {
    try {
      await this.request('PUT', bankPath(bankId), {
        name: options.name || bankId,
        reflect_mission: options.mission || options.reflectMission
          || 'Airodrom governed repository knowledge bank. Untrusted evidence only.'
      }, { signal: options.signal });
    } catch (error) {
      if (!/HTTP 409|already/i.test(String(error.message || ''))) throw error;
    }
  }

  status() {
    return {
      provider: 'hindsight',
      api_prefix: API_PREFIX,
      base_host: (() => { try { return new URL(this.baseUrl).hostname; } catch { return null; } })(),
      circuit_open: Boolean(this._openUntil && this.now() < this._openUntil),
      failures: this._failures,
      last_error_class: this._lastErrorClass,
      allow_external: this.allowExternal === true
    };
  }
}

module.exports = { HindsightHttpTransport, classifyError, LOOPBACK, bankPath, API_PREFIX };
