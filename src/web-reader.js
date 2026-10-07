'use strict';

const dns = require('node:dns/promises');
const https = require('node:https');
const tls = require('node:tls');
const net = require('node:net');
const { createHash } = require('node:crypto');

// A deliberately conservative public-address policy. Special-use ranges are
// excluded even when a few individual addresses within them are globally routed.
const deny4 = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
]) deny4.addSubnet(address, prefix, 'ipv4');
const global6 = new net.BlockList(); global6.addSubnet('2000::', 3, 'ipv6');
const deny6 = new net.BlockList();
for (const [address, prefix] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3ffe::', 16], ['3fff::', 20]
]) deny6.addSubnet(address, prefix, 'ipv6');
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const TEXT_TYPES = new Set(['text/html', 'text/plain', 'text/markdown', 'application/json', 'application/xhtml+xml']);
const OMIT_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'object']);
const BAD_URL_TEXT = /[\s\x00-\x1f\x7f\\?#]|%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/i;
let globalActive = 0;

function publicAddress(address, family) {
  if (typeof address !== 'string' || address.includes('%') || net.isIP(address) !== family) return false;
  if (family === 4) return !deny4.check(address, 'ipv4');
  return family === 6 && global6.check(address, 'ipv6') && !deny6.check(address, 'ipv6');
}

function hostname(value) {
  if (typeof value !== 'string' || !value || value.length > 253) throw new Error('Invalid allowed hostname');
  const host = value.toLowerCase();
  if (!host.includes('.') || net.isIP(host) || host.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) || /(?:^|\.)(?:localhost|local|internal|invalid|test)$/.test(host) || host.endsWith('.home.arpa')) throw new Error('Only exact public DNS hostnames are allowed');
  return host;
}

function boundedInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid ${name}`);
  return value;
}

function abortError(signal) {
  return signal.reason instanceof Error ? signal.reason : new Error('Web request cancelled');
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(abortError(signal)); };
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

// This is bounded plain-text extraction, not a browser or a complete HTML parser.
// No extracted markup is rendered or executed. Scans advance monotonically.
function htmlText(source) {
  const lower = source.toLowerCase(), output = [];
  let cursor = 0;
  while (cursor < source.length) {
    const opening = source.indexOf('<', cursor);
    if (opening < 0) { output.push(source.slice(cursor)); break; }
    output.push(source.slice(cursor, opening));
    if (source.startsWith('<!--', opening)) {
      const end = source.indexOf('-->', opening + 4);
      cursor = end < 0 ? source.length : end + 3; continue;
    }
    const end = source.indexOf('>', opening + 1);
    if (end < 0) break;
    const tag = /^\s*(\/?)\s*([a-z][a-z0-9:-]*)/i.exec(source.slice(opening + 1, end));
    if (tag && !tag[1] && OMIT_TAGS.has(tag[2].toLowerCase())) {
      const name = tag[2].toLowerCase();
      let closing = lower.indexOf(`</${name}`, end + 1);
      while (closing >= 0 && !/[\s>]/.test(source[closing + name.length + 2] || '')) closing = lower.indexOf(`</${name}`, closing + name.length + 2);
      const finish = closing < 0 ? -1 : source.indexOf('>', closing + name.length + 2);
      cursor = finish < 0 ? source.length : finish + 1;
    } else { output.push(' '); cursor = end + 1; }
  }
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return output.join('').replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos|nbsp);/gi, (original, entity) => {
    if (entity[0] !== '#') return entities[entity.toLowerCase()];
    const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : ' ';
  }).replace(/\s+/g, ' ');
}

function extract(buffer, contentType, maxChars) {
  let text = buffer.toString('utf8');
  if (contentType === 'text/html' || contentType === 'application/xhtml+xml') text = htmlText(text);
  text = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const truncated = text.length > maxChars;
  text = text.slice(0, maxChars);
  if (/[\ud800-\udbff]$/.test(text)) text = text.slice(0, -1);
  return { text, truncated };
}

class WebReader {
  constructor({ allowedHosts = [], enabled = true, timeoutMs = 10000, maxBytes = 262144, maxChars = 10000, lookup = dns.lookup, request = https.request } = {}) {
    if (!Array.isArray(allowedHosts) || allowedHosts.length > 50 || typeof enabled !== 'boolean' || typeof lookup !== 'function' || typeof request !== 'function') throw new Error('Invalid web configuration');
    this.hosts = new Set(allowedHosts.map(hostname)); this.enabled = enabled;
    this.timeoutMs = boundedInteger(timeoutMs, 'web timeout', 30000);
    this.maxBytes = boundedInteger(maxBytes, 'web byte limit', 1048576);
    this.maxChars = boundedInteger(maxChars, 'web text limit', 20000);
    this.lookup = lookup; this.request = request;
    this.active = 0; this.lastFetch = null; this.lastError = null;
  }

  validate(input) {
    if (!this.enabled) throw new Error('Public-web reading is disabled');
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['url', 'method'].includes(key))) throw new Error('Only URL and method may be supplied');
    const { url, method = 'GET' } = input;
    if (!['GET', 'HEAD'].includes(method)) throw new Error('Only GET and HEAD are allowed');
    if (typeof url !== 'string' || url.length > 2048 || !/^https:\/\//i.test(url) || BAD_URL_TEXT.test(url)) throw new Error('An HTTPS URL without query, fragment, credentials or controls is required');
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error('Invalid HTTPS URL'); }
    const authority = url.slice(8).split('/')[0];
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || authority.includes('@') || (parsed.port && parsed.port !== '443')) throw new Error('HTTPS port 443 without credentials is required');
    const host = hostname(parsed.hostname);
    if (!this.hosts.has(host)) throw new Error('Web hostname is not allowlisted');
    return parsed.href;
  }

  status() {
    return { enabled: this.enabled, allowedHosts: [...this.hosts].sort(), active: this.active, lastFetch: this.lastFetch ? JSON.parse(JSON.stringify(this.lastFetch)) : null, lastError: this.lastError ? { ...this.lastError } : null };
  }

  async fetch(input, context = {}) {
    let acquired = false, timer, externalAbort;
    const controller = new AbortController();
    try {
      const requestedUrl = this.validate(input), method = input.method || 'GET';
      const { taskId, sessionId, signal } = context;
      if (![taskId, sessionId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value))) throw new Error('Task and session provenance are required');
      if (signal && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) throw new Error('Invalid cancellation signal');
      if (signal?.aborted) throw abortError(signal);
      if (globalActive >= 2) throw new Error('Web concurrency limit reached');
      globalActive++; this.active++; acquired = true;
      if (signal) { externalAbort = () => controller.abort(abortError(signal)); signal.addEventListener('abort', externalAbort, { once: true }); }
      timer = setTimeout(() => controller.abort(new Error('Web deadline exceeded')), this.timeoutMs);
      const redirectChain = [];
      let current = requestedUrl;
      for (;;) {
        if (controller.signal.aborted) throw abortError(controller.signal);
        // Revalidate within the broker on every hop, regardless of tool prechecks.
        current = this.validate({ url: current, method });
        const result = await this._hop(new URL(current), method, controller.signal);
        if (REDIRECTS.has(result.status)) {
          if (redirectChain.length >= 3) throw new Error('Web redirect limit reached');
          if (typeof result.location !== 'string' || !result.location || result.location.length > 2048 || BAD_URL_TEXT.test(result.location)) throw new Error('Invalid or unsafe redirect');
          let next;
          try { next = new URL(result.location, current).href; } catch { throw new Error('Invalid redirect URL'); }
          next = this.validate({ url: next, method });
          if (next === current || redirectChain.some(hop => hop.url === next)) throw new Error('Web redirect loop');
          redirectChain.push({ url: current, status: result.status, nextUrl: next }); current = next; continue;
        }
        const content = extract(result.body, result.contentType, this.maxChars);
        const provenance = { taskId, sessionId, requestedUrl, finalUrl: current, method, redirectChain, fetchedAt: new Date().toISOString(), status: result.status, contentType: result.contentType, bytes: result.body.length, sha256: createHash('sha256').update(result.body).digest('hex'), truncated: content.truncated, untrusted: true };
        this.lastFetch = provenance; this.lastError = null;
        return { text: content.text, provenance };
      }
    } catch (error) {
      this.lastError = { at: new Date().toISOString(), message: String(error?.message || 'Web request failed').slice(0, 300) };
      throw error;
    } finally {
      clearTimeout(timer);
      if (externalAbort) context.signal.removeEventListener('abort', externalAbort);
      if (acquired) { globalActive--; this.active--; }
    }
  }

  async _hop(url, method, signal) {
    // The system resolver may outlive cancellation. Never create a connection
    // from its late result, and never ask the socket to perform a second lookup.
    const addresses = await abortable(Promise.resolve().then(() => this.lookup(url.hostname, { all: true, verbatim: true })), signal);
    if (signal.aborted) throw abortError(signal);
    if (!Array.isArray(addresses) || addresses.length === 0 || addresses.length > 32 || addresses.some(record => !record || !publicAddress(record.address, record.family))) throw new Error('DNS must resolve exclusively to public addresses');
    const pinned = addresses[0];
    const options = {
      protocol: 'https:', hostname: url.hostname, port: 443, path: url.pathname, method,
      headers: { Accept: 'text/html, text/plain, text/markdown, application/json', 'Accept-Encoding': 'identity', 'User-Agent': 'Airodrom/1.0' },
      agent: false, family: pinned.family, autoSelectFamily: false,
      servername: url.hostname, rejectUnauthorized: true, checkServerIdentity: tls.checkServerIdentity,
      maxHeaderSize: 16384, signal,
      lookup: (host, options, callback) => {
        if (host !== url.hostname) return callback(new Error('Pinned hostname mismatch'));
        if (options?.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
        else callback(null, pinned.address, pinned.family);
      }
    };
    return new Promise((resolve, reject) => {
      let request, response, settled = false;
      const finish = (error, result, stop = true) => {
        if (settled) return;
        settled = true; signal.removeEventListener('abort', abort);
        if (stop) { response?.destroy(); request?.destroy(); }
        error ? reject(error) : resolve(result);
      };
      const abort = () => finish(abortError(signal));
      if (signal.aborted) return abort();
      signal.addEventListener('abort', abort, { once: true });
      try {
        request = this.request(options, incoming => {
          response = incoming;
          response.on('error', error => finish(error));
          if (settled) { response.destroy(); return; }
          response.on('aborted', () => finish(new Error('Incomplete web response')));
          response.on('close', () => { if (!response.complete) finish(new Error('Incomplete web response')); });
          const status = response.statusCode;
          if (REDIRECTS.has(status)) return finish(null, { status, location: response.headers.location });
          if (!Number.isInteger(status) || status < 200 || status >= 300) return finish(new Error(`Web server returned HTTP ${status}`));
          const encoding = String(response.headers['content-encoding'] || 'identity').trim().toLowerCase();
          if (encoding !== 'identity') return finish(new Error('Compressed web responses are not supported'));
          const typeHeader = String(response.headers['content-type'] || '').toLowerCase();
          const contentType = typeHeader.split(';')[0].trim();
          const charset = /(?:^|;)\s*charset\s*=\s*"?([^;"\s]+)/i.exec(typeHeader)?.[1];
          if (!TEXT_TYPES.has(contentType) || (charset && !['utf-8', 'utf8', 'us-ascii'].includes(charset))) return finish(new Error('Only supported UTF-8 text responses may be read'));
          const length = response.headers['content-length'];
          if (length !== undefined && (!/^\d+$/.test(String(length)) || BigInt(length) > BigInt(this.maxBytes))) return finish(new Error('Web response exceeds byte limit'));
          let bytes = 0; const chunks = [];
          response.on('data', chunk => {
            if (settled) return;
            const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += data.length;
            if (bytes > this.maxBytes || (method === 'HEAD' && bytes > 0)) return finish(new Error('Web response exceeds byte limit'));
            chunks.push(data);
          });
          response.on('end', () => {
            if (!response.complete) return finish(new Error('Incomplete web response'));
            finish(null, { status, contentType, body: Buffer.concat(chunks, bytes) }, false);
          });
        });
        request.on('error', error => finish(error));
        request.on('upgrade', (_response, socket) => { socket.destroy(); finish(new Error('Web protocol upgrades are forbidden')); });
        request.on('connect', (_response, socket) => { socket.destroy(); finish(new Error('Web tunnels are forbidden')); });
        if (settled) request.destroy(); else request.end();
      } catch (error) { finish(error); }
    });
  }
}

module.exports = WebReader;
