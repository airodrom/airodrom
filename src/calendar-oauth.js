'use strict';
// Operator-only Google Calendar PKCE. Separate vault purpose from Gmail.
// Tokens and scopes never broaden the Gmail gmail.readonly grant.
const crypto = require('node:crypto');

const READ_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const WRITE_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const CALLBACK_PATH = '/oauth/calendar/callback';

const FAIL = Object.freeze({
  network: 'calendar_oauth_network_error',
  timeout: 'calendar_oauth_timeout',
  http: 'calendar_oauth_http_rejected',
  schema: 'calendar_oauth_response_invalid',
  scope: 'calendar_oauth_scope_mismatch',
  consent: 'calendar_oauth_consent_required',
  client: 'calendar_oauth_client_rejected',
  grant: 'calendar_oauth_grant_invalid',
  request: 'calendar_oauth_request_invalid',
});

const PROVIDER_ERRORS = Object.freeze({
  invalid_grant: FAIL.grant,
  invalid_client: FAIL.client,
  unauthorized_client: FAIL.client,
  invalid_request: FAIL.request,
  unsupported_grant_type: FAIL.request,
  invalid_scope: FAIL.scope,
  access_denied: FAIL.consent,
});

function exchangeError(safeClass, message, providerError = null) {
  const err = Error(message);
  err.code = safeClass;
  err.safe_error_class = safeClass;
  if (providerError) err.provider_error = providerError;
  return err;
}

function phaseOf(form) {
  const grant = form && form.grant_type;
  if (grant === 'authorization_code') return 'authorization_code';
  if (grant === 'refresh_token') return 'refresh_token';
  return 'exchange';
}

function parseScopes(value) {
  if (typeof value !== 'string' || !value.trim()) return [];
  return [...new Set(value.trim().split(/\s+/).filter(Boolean))].sort();
}

function scopesEqual(a, b) {
  const left = parseScopes(a);
  const right = parseScopes(b);
  return left.length === right.length && left.every((s, i) => s === right[i]);
}

function scopeForMode(mode) {
  if (mode === 'events' || mode === 'write' || mode === 'manage') return WRITE_SCOPE;
  return READ_SCOPE;
}

function hasWriteScope(scope) {
  return parseScopes(scope).includes(WRITE_SCOPE);
}

function hasReadCapability(scope) {
  const set = new Set(parseScopes(scope));
  return set.has(READ_SCOPE) || set.has(WRITE_SCOPE);
}

function parseProviderError(raw) {
  if (typeof raw !== 'string' || !raw || Buffer.byteLength(raw) > 12000) return null;
  let value;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = value.error;
  if (typeof id !== 'string' || !Object.prototype.hasOwnProperty.call(PROVIDER_ERRORS, id)) return null;
  return id;
}

class CalendarOAuth {
  #vault; #request; #client; #clientSecretReference; #pending = null; #reference = null; #refresh = null; #lastFailure = null; #mode = 'readonly';
  constructor({
    clientId,
    vault,
    request = fetch,
    reference = null,
    clientSecretReference = null,
    mode = 'readonly',
    onReference = () => {},
  }) {
    if (typeof clientId !== 'string' || !clientId.endsWith('.apps.googleusercontent.com') || clientId.length > 200 || !vault) {
      throw Error('Owner-configured Google desktop OAuth client required');
    }
    if (clientSecretReference !== null && clientSecretReference !== undefined) {
      if (typeof clientSecretReference !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(clientSecretReference)) {
        throw Error('Owner-configured Google desktop OAuth client required');
      }
    }
    this.#vault = vault;
    this.#request = request;
    this.#client = clientId;
    this.#reference = reference;
    this.#clientSecretReference = clientSecretReference || null;
    this.#mode = mode === 'events' || mode === 'write' || mode === 'manage' ? 'events' : 'readonly';
    this.onReference = onReference;
    if (this.#reference) {
      try {
        const token = JSON.parse(this.#vault.resolve(this.#reference, 'calendar'));
        if (token?.scope && !hasReadCapability(token.scope)) this.#recordFailure(FAIL.scope, 'resolve', null);
      } catch { /* resolve reports unavailable */ }
    }
  }

  #expectedScope() {
    return scopeForMode(this.#mode);
  }

  #authorizationFromPending() {
    const p = this.#pending;
    if (!p) throw Error('OAuth session is not pending');
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    for (const [k, v] of Object.entries({
      client_id: this.#client,
      redirect_uri: p.redirect,
      response_type: 'code',
      scope: p.scope,
      state: p.state,
      code_challenge: crypto.createHash('sha256').update(p.verifier).digest('base64url'),
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent',
    })) url.searchParams.set(k, v);
    return {
      authorization_url: String(url),
      read_only: p.scope === READ_SCOPE,
      mode: p.mode,
      scope: p.scope,
      expires_at: p.expires,
      reused: true,
      connector: 'calendar',
    };
  }

  start(redirect, { forceNew = false, mode = null } = {}) {
    const u = new URL(redirect);
    if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || u.pathname !== CALLBACK_PATH) {
      throw Error('Pinned loopback calendar callback required');
    }
    const wantMode = mode === 'events' || mode === 'write' || mode === 'manage' ? 'events' : 'readonly';
    const scope = scopeForMode(wantMode);
    if (!forceNew && this.#pending && this.#pending.expires > Date.now() && this.#pending.redirect === redirect && this.#pending.scope === scope) {
      return this.#authorizationFromPending();
    }
    const state = crypto.randomBytes(32).toString('base64url');
    const verifier = crypto.randomBytes(32).toString('base64url');
    this.#pending = { state, verifier, redirect, scope, mode: wantMode, expires: Date.now() + 300000 };
    return { ...this.#authorizationFromPending(), reused: false };
  }

  #attachClientSecret(form) {
    if (!this.#clientSecretReference) return;
    let secret;
    try {
      // Desktop client secret is shared with the Gmail OAuth client registration.
      secret = this.#vault.resolve(this.#clientSecretReference, 'gmail');
    } catch {
      try { secret = this.#vault.resolve(this.#clientSecretReference, 'calendar'); }
      catch {
        this.#recordFailure(FAIL.client, phaseOf(form), null);
        throw exchangeError(FAIL.client, 'Calendar OAuth client secret is unavailable from the host vault. Restore the Keychain helper reference, then /connect calendar fresh.');
      }
    }
    if (typeof secret !== 'string' || !secret || secret.length > 400 || secret.includes('\0')) {
      secret = undefined;
      this.#recordFailure(FAIL.client, phaseOf(form), null);
      throw exchangeError(FAIL.client, 'Calendar OAuth client secret reference is invalid. Credentials withheld.');
    }
    form.client_secret = secret;
    secret = undefined;
  }

  #recordFailure(safeClass, phase, providerError) {
    this.#lastFailure = {
      safe_error_class: safeClass,
      at: Date.now(),
      phase,
      ...(providerError ? { provider_error: providerError } : {}),
    };
  }

  #messageFor(safeClass, phase) {
    if (safeClass === FAIL.timeout) return 'Calendar OAuth timed out contacting Google. Retry /connect calendar; tokens were not printed.';
    if (safeClass === FAIL.network) return 'Calendar OAuth network error contacting Google. Retry later; tokens and response bodies are withheld.';
    if (safeClass === FAIL.client) return 'Calendar OAuth client was rejected by Google. Confirm the Desktop OAuth client and vault client-secret reference, then /connect calendar fresh.';
    if (safeClass === FAIL.grant) {
      return phase === 'refresh_token'
        ? 'Calendar OAuth refresh grant is invalid or revoked. Re-authorize with /connect calendar fresh; credentials withheld.'
        : 'Calendar OAuth authorization code was rejected. Retry /connect calendar fresh; credentials withheld.';
    }
    if (safeClass === FAIL.request) return 'Calendar OAuth token request was rejected as invalid. Retry /connect calendar fresh; credentials withheld.';
    if (safeClass === FAIL.scope) return 'Calendar OAuth scope mismatch. Re-authorize with /connect calendar (or /connect calendar manage for writes). Gmail consent does not grant Calendar.';
    if (safeClass === FAIL.consent) return 'Calendar OAuth consent or refresh was rejected. Re-authorize with /connect calendar; credentials withheld.';
    if (safeClass === FAIL.schema) return 'Calendar OAuth response invalid; credential diagnostics withheld';
    return 'Calendar OAuth HTTP exchange rejected. Re-authorize with /connect calendar; provider diagnostics withheld.';
  }

  async #exchange(form, expectedScope) {
    const phase = phaseOf(form);
    this.#attachClientSecret(form);
    let response;
    try {
      response = await this.#request('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form),
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
    } catch (error) {
      const safe = error?.name === 'TimeoutError' || error?.code === 'TIMEOUT' ? FAIL.timeout : FAIL.network;
      this.#recordFailure(safe, phase, null);
      throw exchangeError(safe, this.#messageFor(safe, phase));
    } finally {
      if (form.client_secret) form.client_secret = '';
      delete form.client_secret;
    }
    if (!response.ok) {
      let providerError = null;
      let safe = FAIL.http;
      try {
        const raw = await response.text();
        providerError = parseProviderError(raw);
        if (providerError) safe = PROVIDER_ERRORS[providerError];
        else if (response.status === 400 || response.status === 401) safe = FAIL.consent;
      } catch {
        try { await response.body?.cancel?.(); } catch { /* */ }
        if (response.status === 400 || response.status === 401) safe = FAIL.consent;
      }
      this.#recordFailure(safe, phase, providerError);
      throw exchangeError(safe, this.#messageFor(safe, phase), providerError);
    }
    let raw;
    try {
      raw = await response.text();
      if (Buffer.byteLength(raw) > 12000) throw exchangeError(FAIL.schema, 'Calendar OAuth response exceeded size bound');
      const value = JSON.parse(raw);
      if (typeof value.access_token !== 'string' || !value.access_token || !Number.isInteger(value.expires_in) || value.expires_in < 1) {
        throw exchangeError(FAIL.schema, 'Calendar OAuth response schema invalid');
      }
      if (value.scope && !scopesEqual(value.scope, expectedScope) && !hasReadCapability(value.scope)) {
        throw exchangeError(FAIL.scope, 'Calendar OAuth scope mismatch');
      }
      // Fail closed if Google returns unrelated scopes (e.g. gmail).
      if (value.scope && /gmail|drive/i.test(value.scope) && !hasReadCapability(value.scope)) {
        throw exchangeError(FAIL.scope, 'Calendar OAuth scope mismatch');
      }
      this.#lastFailure = null;
      return value;
    } catch (error) {
      if (error?.safe_error_class) {
        this.#recordFailure(error.safe_error_class, phase, error.provider_error || null);
        throw error;
      }
      this.#recordFailure(FAIL.schema, phase, null);
      throw exchangeError(FAIL.schema, 'Calendar OAuth response invalid; credential diagnostics withheld');
    } finally {
      raw = undefined;
    }
  }

  #readStoredToken() {
    if (!this.#reference) throw exchangeError(FAIL.consent, 'Calendar OAuth authorization required');
    let token;
    try { token = JSON.parse(this.#vault.resolve(this.#reference, 'calendar')); }
    catch {
      this.#recordFailure(FAIL.consent, 'resolve', null);
      throw exchangeError(FAIL.consent, 'Calendar OAuth authorization required');
    }
    if (!token || typeof token !== 'object' || typeof token.access_token !== 'string' || !token.access_token) {
      this.#recordFailure(FAIL.schema, 'resolve', null);
      throw exchangeError(FAIL.schema, 'Calendar authorization unavailable');
    }
    if (token.scope && !hasReadCapability(token.scope)) {
      this.#recordFailure(FAIL.scope, 'resolve', null);
      throw exchangeError(FAIL.scope, 'Calendar OAuth scope mismatch. Re-authorize with /connect calendar. Gmail consent does not grant Calendar.');
    }
    return token;
  }

  async complete({ state, code }) {
    const p = this.#pending;
    this.#pending = null;
    if (!p || p.expires < Date.now() || state !== p.state || typeof code !== 'string' || !code || code.length > 2000) {
      throw Error('OAuth callback refused');
    }
    const token = await this.#exchange({
      client_id: this.#client,
      redirect_uri: p.redirect,
      grant_type: 'authorization_code',
      code,
      code_verifier: p.verifier,
    }, p.scope);
    const prior = this.#reference;
    const receipt = this.#vault.put(JSON.stringify({ ...token, scope: token.scope || p.scope, expires_at: Date.now() + token.expires_in * 1000 }), 'calendar');
    this.#reference = receipt.reference;
    this.#mode = p.mode;
    this.#lastFailure = null;
    this.onReference(this.#reference, { mode: this.#mode, scope: token.scope || p.scope });
    if (prior && prior !== receipt.reference) {
      try { this.#vault.forget(prior); } catch { /* replaced */ }
    }
    return {
      connected: true,
      read_only: !hasWriteScope(token.scope || p.scope),
      mode: this.#mode,
      values_displayed: false,
      live_qualified: false,
      connector: 'calendar',
    };
  }

  async resolve() {
    if (this.#refresh) return this.#refresh;
    const old = this.#reference;
    const token = this.#readStoredToken();
    if (token.expires_at > Date.now() + 30000) return token.access_token;
    if (!token.refresh_token) {
      this.#recordFailure(FAIL.consent, 'refresh_token', null);
      throw exchangeError(FAIL.consent, 'Calendar OAuth renewal requires operator authorization');
    }
    this.#refresh = (async () => {
      try {
        const next = await this.#exchange({
          client_id: this.#client,
          grant_type: 'refresh_token',
          refresh_token: token.refresh_token,
        }, token.scope || this.#expectedScope());
        if (this.#reference !== old) throw Error('Calendar authorization changed during renewal');
        const scope = next.scope || token.scope;
        const receipt = this.#vault.replace(old, JSON.stringify({
          ...next,
          refresh_token: next.refresh_token || token.refresh_token,
          scope,
          expires_at: Date.now() + next.expires_in * 1000,
        }), 'calendar');
        this.#reference = receipt.reference;
        this.#lastFailure = null;
        this.onReference(this.#reference, { mode: hasWriteScope(scope) ? 'events' : 'readonly', scope });
        return next.access_token;
      } catch (error) {
        if (!error?.safe_error_class) this.#recordFailure(FAIL.consent, 'refresh_token', null);
        throw error;
      }
    })();
    try { return await this.#refresh; }
    finally { this.#refresh = null; }
  }

  configuration() {
    return { scope: this.#expectedScope(), reference: 'host-oauth', connector: 'calendar' };
  }

  granted() {
    try {
      const token = this.#readStoredToken();
      return parseScopes(token.scope || this.#expectedScope());
    } catch {
      return [];
    }
  }

  canWrite() {
    return this.granted().includes(WRITE_SCOPE);
  }

  status() {
    const tokenPresent = !!this.#reference;
    const blocking = this.#lastFailure && [FAIL.client, FAIL.grant, FAIL.consent, FAIL.scope, FAIL.request].includes(this.#lastFailure.safe_error_class);
    let scope = this.#expectedScope();
    try {
      if (tokenPresent) scope = this.#readStoredToken().scope || scope;
    } catch { /* keep expected */ }
    return {
      configured: true,
      token_present: tokenPresent,
      connected: tokenPresent && !blocking,
      pending: !!this.#pending,
      scope,
      mode: hasWriteScope(scope) ? 'events' : 'readonly',
      read_only: !hasWriteScope(scope),
      can_write: hasWriteScope(scope),
      values_displayed: false,
      live_qualified: false,
      client_secret_bound: !!this.#clientSecretReference,
      last_safe_error_class: this.#lastFailure?.safe_error_class || null,
      last_failure_phase: this.#lastFailure?.phase || null,
      last_provider_error: this.#lastFailure?.provider_error || null,
      connector: 'calendar',
    };
  }

  revoke() {
    const ref = this.#reference;
    this.#pending = null;
    this.#reference = null;
    this.#refresh = null;
    this.#lastFailure = null;
    if (ref) {
      try { this.#vault.forget(ref); } catch { /* already revoked */ }
      this.onReference(null, { mode: 'readonly', scope: null });
    }
    return { revoked: true, values_displayed: false, connector: 'calendar' };
  }
}

module.exports = {
  CalendarOAuth,
  READ_SCOPE,
  WRITE_SCOPE,
  CALLBACK_PATH,
  FAIL,
  PROVIDER_ERRORS,
  parseProviderError,
  hasWriteScope,
  hasReadCapability,
  scopeForMode,
};
