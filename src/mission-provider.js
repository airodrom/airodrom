'use strict';

const crypto = require('node:crypto');

const CALLBACK_FIELDS = Object.freeze(['aud', 'decision', 'decisionId', 'eventId', 'expiresAt', 'instructions', 'iss', 'missionId', 'nonce', 'resultHash', 'sessionId', 'taskAId', 'taskBId', 'version', 'issuedAt']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const OPAQUE = /^[A-Za-z0-9_-]{8,128}$/;

function canonical(value, depth = 0) {
  if (depth > 20) throw new Error('Provider callback is too deeply nested');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, depth + 1)).join(',')}]`;
  if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    if (Object.getOwnPropertySymbols(value).length) throw new Error('Provider callback symbol keys are forbidden');
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key], depth + 1)}`).join(',')}}`;
  }
  throw new Error('Provider callback must contain canonical JSON values');
}

class DecisionCallbackVerifier {
  constructor({ publicKey, issuer, audience = 'pi-chatgpt-bridge/mission-decision/v1', now = Date.now, maxClockSkewMs = 30_000, maxTtlMs = 60_000 } = {}) {
    if (!publicKey || typeof issuer !== 'string' || !issuer.trim()) throw new Error('A pinned provider signing key and issuer are required');
    this.publicKey = publicKey?.type === 'public' ? publicKey : crypto.createPublicKey(publicKey);
    if (this.publicKey.asymmetricKeyType !== 'ed25519') throw new Error('Provider callback key must be Ed25519');
    this.issuer = issuer; this.audience = audience; this.now = now;
    this.maxClockSkewMs = maxClockSkewMs; this.maxTtlMs = maxTtlMs; this.usedNonces = new Map();
  }

  verify(envelope) {
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || Object.keys(envelope).sort().join(',') !== 'payload,signature') throw new Error('Invalid provider callback envelope');
    const payload = envelope.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).sort().join(',') !== [...CALLBACK_FIELDS].sort().join(',')) throw new Error('Provider callback fields do not match the signed schema');
    const signatureText = envelope.signature;
    if (typeof signatureText !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signatureText)) throw new Error('Invalid provider callback signature encoding');
    const signature = Buffer.from(signatureText, 'base64url');
    if (signature.length !== 64 || !crypto.verify(null, Buffer.from(canonical(payload)), this.publicKey, signature)) throw new Error('Provider callback signature verification failed');
    if (payload.version !== 1 || payload.iss !== this.issuer || payload.aud !== this.audience) throw new Error('Provider callback issuer, audience, or version mismatch');
    if (![payload.missionId, payload.taskAId, payload.taskBId, payload.nonce].every(value => typeof value === 'string' && OPAQUE.test(value))) throw new Error('Provider callback identifiers are invalid');
    if (![payload.sessionId, payload.eventId, payload.decisionId].every(value => typeof value === 'string' && UUID.test(value))) throw new Error('Provider callback IDs are invalid');
    if (!HASH.test(payload.resultHash) || payload.decision !== 'continue' || typeof payload.instructions !== 'string' || !payload.instructions.trim() || payload.instructions.length > 4000 || /[\0\r]/.test(payload.instructions)) throw new Error('Provider callback decision is invalid');
    if (!Number.isSafeInteger(payload.issuedAt) || !Number.isSafeInteger(payload.expiresAt)) throw new Error('Provider callback timestamps are invalid');
    const now = this.now();
    if (payload.issuedAt > now + this.maxClockSkewMs || payload.expiresAt <= now || payload.expiresAt <= payload.issuedAt || payload.expiresAt - payload.issuedAt > this.maxTtlMs) throw new Error('Provider callback is expired or outside its time window');
    for (const [nonce, expiry] of this.usedNonces) if (expiry <= now) this.usedNonces.delete(nonce);
    if (this.usedNonces.has(payload.nonce)) throw new Error('Provider callback nonce was already used');
    this.usedNonces.set(payload.nonce, payload.expiresAt);
    return Object.freeze({ ...payload, authenticated: true, simulation: false });
  }
}

/** No live HTTP transport is installed. The bridge default always stays inert. */
class ProviderDecisionAdapter {
  constructor({ enabled = false, simulation = false, transport = null, verifier = null } = {}) {
    if (simulation === true && process.env.NODE_ENV !== 'test') throw new Error('Simulated provider adapters are restricted to isolated test runs');
    this.enabled = enabled === true; this.simulation = simulation === true; this.transport = transport; this.verifier = verifier;
  }
  get status() { return { liveEnabled: this.enabled && !this.simulation && typeof this.transport === 'function' && this.verifier instanceof DecisionCallbackVerifier, requestEnabled: this.enabled && typeof this.transport === 'function' && this.verifier instanceof DecisionCallbackVerifier, simulation: this.simulation, transportConfigured: typeof this.transport === 'function', callbackVerifierConfigured: this.verifier instanceof DecisionCallbackVerifier }; }
  buildRequest({ mission, event }) {
    if (!mission || !event || typeof event.result !== 'string' || typeof event.resultHash !== 'string') throw new Error('Task A result event is required');
    const requestId = crypto.randomUUID();
    return Object.freeze({
      version: 1, audience: 'pi-chatgpt-bridge/mission-decision/v1', requestId,
      missionId: mission.missionId, taskBId: mission.taskBId,
      eventId: event.eventId, taskAId: event.taskId, sessionId: event.sessionId,
      resultHash: event.resultHash, taskAResult: event.result,
      instructions: 'Reason only from this Task A result. Return a signed, mission-bound decision callback; the bridge validates signature, identity, result hash, expiry, and replay before dispatch.'
    });
  }
  async requestDecision(request) {
    if (!this.enabled || typeof this.transport !== 'function' || !(this.verifier instanceof DecisionCallbackVerifier)) throw new Error('Live provider adapter is disabled');
    // Return the signed envelope intact. The coordinator performs callback
    // validation immediately before persisting the decision.
    return await this.transport(request);
  }
  verifyCallback(envelope) {
    if (!this.enabled || !(this.verifier instanceof DecisionCallbackVerifier)) throw new Error('Live provider callback validation is disabled');
    return this.verifier.verify(envelope);
  }
}

module.exports = { DecisionCallbackVerifier, ProviderDecisionAdapter, canonical, CALLBACK_FIELDS };
