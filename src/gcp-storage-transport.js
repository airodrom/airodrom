'use strict';
// Narrow Storage JSON API client for exact-scope bucket CREATE/GET/IAM only.
// No shell, no gcloud CLI, no arbitrary URLs. Credentials never enter logs.
const https = require('node:https');
const { URL } = require('node:url');

const ALLOWED_HOST = 'storage.googleapis.com';

function redact(value) {
  if (value == null) return value;
  const text = String(value);
  return text
    .replace(/ya29\.[0-9A-Za-z._-]+/g, '[REDACTED_TOKEN]')
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED_KEY]');
}

class GcpStorageTransport {
  constructor({ accessToken, requestImpl = null, timeout_ms = 30_000 } = {}) {
    if (typeof accessToken !== 'string' || accessToken.length < 8) {
      const err = Error('GCP access token unavailable for Storage API.');
      err.code = 'gcp_credential_missing';
      throw err;
    }
    this.accessToken = accessToken;
    this.requestImpl = requestImpl;
    this.timeout_ms = timeout_ms;
  }

  async #request(method, path, body = null, query = {}) {
    if (this.requestImpl) {
      return this.requestImpl({ method, path, body, query });
    }
    const url = new URL(`https://${ALLOWED_HOST}${path}`);
    for (const [k, v] of Object.entries(query || {})) {
      if (v != null) url.searchParams.set(k, String(v));
    }
    if (url.hostname !== ALLOWED_HOST) {
      const err = Error('Refusing non-Storage API host.');
      err.code = 'gcp_transport_host_forbidden';
      throw err;
    }
    const payload = body == null ? null : JSON.stringify(body);
    const headers = {
      Authorization: `Bearer ${this.accessToken}`,
      Accept: 'application/json',
    };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    return new Promise((resolve, reject) => {
      const req = https.request({
        protocol: url.protocol,
        hostname: url.hostname,
        path: url.pathname + url.search,
        method,
        headers,
        timeout: this.timeout_ms,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = raw ? JSON.parse(raw) : null; } catch { json = { raw: redact(raw.slice(0, 500)) }; }
          resolve({ status: res.statusCode, body: json, headers: res.headers });
        });
      });
      req.on('timeout', () => {
        req.destroy();
        const err = Error('Storage API request timed out.');
        err.code = 'gcp_transport_timeout';
        reject(err);
      });
      req.on('error', (error) => {
        const err = Error(redact(error.message || 'transport error'));
        err.code = 'gcp_transport_error';
        reject(err);
      });
      if (payload) req.write(payload);
      req.end();
    });
  }

  async getBucket(bucket) {
    return this.#request('GET', `/storage/v1/b/${encodeURIComponent(bucket)}`);
  }

  async insertBucket(project_id, resource) {
    return this.#request('POST', '/storage/v1/b', resource, { project: project_id });
  }

  async getBucketIam(bucket) {
    return this.#request('GET', `/storage/v1/b/${encodeURIComponent(bucket)}/iam`);
  }

  async setBucketIam(bucket, policy) {
    return this.#request('PUT', `/storage/v1/b/${encodeURIComponent(bucket)}/iam`, policy);
  }
}

module.exports = { GcpStorageTransport, redact, ALLOWED_HOST };
