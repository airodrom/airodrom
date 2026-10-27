'use strict';
// Operator-only Google Drive PKCE. Separate vault purpose from Gmail/Calendar.
// Stage B V1: drive.file only (picker / app-opened resources). No broad drive.readonly.
const crypto = require('node:crypto');

const FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const CALLBACK_PATH = '/oauth/drive/callback';
const VAULT_PURPOSE = 'drive';

const FAIL = Object.freeze({
  network: 'drive_oauth_network_error',
  timeout: 'drive_oauth_timeout',
  http: 'drive_oauth_http_rejected',
  schema: 'drive_oauth_response_invalid',
  scope: 'drive_oauth_scope_mismatch',
  consent: 'drive_oauth_consent_required',
  client: 'drive_oauth_client_rejected',
  grant: 'drive_oauth_grant_invalid',
  request: 'drive_oauth_request_invalid',
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

function parseScopes(value) {
  if (typeof value !== 'string' || !value.trim()) return [];
  return [...new Set(value.trim().split(/\s+/).filter(Boolean))].sort();
}

function scopesEqual(a, b) {
  const left = parseScopes(a);
  const right = parseScopes(b);
  return left.length === right.length && left.every((s, i) => s === right[i]);
}

function hasFileScope(scope) {
  return parseScopes(scope).includes(FILE_SCOPE);
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

class DriveOAuth {
  #vault; #request; #client; #clientSecretReference; #pending = null; #reference = null; #refresh = null; #lastFailure = null;
  constructor({
    clientId,
    vault,
    request = fetch,
    reference = null,
    clientSecretReference = null,
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
    this.#client = clientId;
    this.#vault = vault;
    this.#request = request;
    this.#clientSecretReference = clientSecretReference || null;
    this.#reference = reference || null;
    this.onReference = onReference;
  }

  configuration() {
    return { clientId: this.#client, reference: this.#reference, scope: FILE_SCOPE, purpose: VAULT_PURPOSE };
  }

  status() {
    const connected = !!this.#reference;
    return {
      id: 'drive',
      connected,
      mode: 'file',
      scope: FILE_SCOPE,
      can_read_enrolled: connected,
      can_write: false,
      read_only: true,
      token_present: connected,
      last_failure: this.#lastFailure,
      authority: false,
    };
  }

  start(redirectUri, { forceNew = false } = {}) {
    if (typeof redirectUri !== 'string' || !redirectUri.startsWith('http://127.0.0.1:')) {
      throw Error('Loopback OAuth redirect required');
    }
    if (this.#reference && !forceNew) {
      return { state: 'connected', message: 'Drive is already connected. Use /connect drive fresh to re-consent, then enroll exact files/folders.' };
    }
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = crypto.randomBytes(24).toString('hex');
    this.#pending = { state, verifier, redirectUri, created: Date.now() };
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', this.#client);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', FILE_SCOPE);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', forceNew ? 'consent' : 'select_account consent');
    return {
      state: 'WAIT',
      authorization_url: url.toString(),
      redirect_uri: redirectUri,
      scope: FILE_SCOPE,
      message: 'Authorize Google Drive (drive.file only). After consent, enroll exact file/folder IDs — Drive is not blanket-authorized.',
    };
  }

  async complete({ state, code }) {
    if (!this.#pending || this.#pending.state !== state || Date.now() - this.#pending.created > 600000) {
      throw exchangeError(FAIL.consent, 'Drive OAuth callback expired or pending authorization missing. Run /connect drive fresh.');
    }
    if (typeof code !== 'string' || !code || code.length > 2048) {
      throw exchangeError(FAIL.request, 'Drive OAuth authorization code missing.');
    }
    const form = {
      client_id: this.#client,
      code,
      code_verifier: this.#pending.verifier,
      grant_type: 'authorization_code',
      redirect_uri: this.#pending.redirectUri,
    };
    if (this.#clientSecretReference) {
      form.client_secret = this.#vault.resolve(this.#clientSecretReference, VAULT_PURPOSE);
    }
    const token = await this.#exchange(form);
    this.#pending = null;
    this.#lastFailure = null;
    if (this.#reference) {
      try { this.#vault.forget(this.#reference); } catch { /* */ }
    }
    const packed = JSON.stringify({
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expires_at: Date.now() + (Number(token.expires_in) || 3600) * 1000,
      scope: token.scope || FILE_SCOPE,
    });
    const put = this.#vault.put(packed, VAULT_PURPOSE);
    this.#reference = put.reference;
    this.onReference(this.#reference, { mode: 'file' });
    return { connected: true, scope: FILE_SCOPE };
  }

  async resolve() {
    if (!this.#reference) throw exchangeError(FAIL.consent, 'Drive is not connected.');
    let raw;
    try { raw = this.#vault.resolve(this.#reference, VAULT_PURPOSE); }
    catch {
      throw exchangeError(FAIL.consent, 'Drive credentials unavailable.');
    }
    let value;
    try { value = JSON.parse(raw); } catch {
      throw exchangeError(FAIL.schema, 'Drive credential record invalid.');
    }
    if (!hasFileScope(value.scope)) {
      throw exchangeError(FAIL.scope, 'Drive scope mismatch; reconnect with drive.file only.');
    }
    if (value.expires_at && value.expires_at < Date.now() + 60000) {
      if (!value.refresh_token) throw exchangeError(FAIL.grant, 'Drive access expired; reconnect.');
      const form = {
        client_id: this.#client,
        grant_type: 'refresh_token',
        refresh_token: value.refresh_token,
      };
      if (this.#clientSecretReference) {
        form.client_secret = this.#vault.resolve(this.#clientSecretReference, VAULT_PURPOSE);
      }
      const token = await this.#exchange(form);
      const next = {
        access_token: token.access_token,
        refresh_token: token.refresh_token || value.refresh_token,
        expires_at: Date.now() + (Number(token.expires_in) || 3600) * 1000,
        scope: token.scope || value.scope,
      };
      if (!hasFileScope(next.scope)) throw exchangeError(FAIL.scope, 'Drive refresh returned unexpected scope.');
      const replaced = this.#vault.replace(this.#reference, JSON.stringify(next), VAULT_PURPOSE);
      this.#reference = replaced.reference;
      this.onReference(this.#reference, { mode: 'file' });
      return next.access_token;
    }
    return value.access_token;
  }

  revoke() {
    const had = !!this.#reference;
    if (this.#reference) {
      try { this.#vault.forget(this.#reference); } catch { /* */ }
    }
    this.#reference = null;
    this.#pending = null;
    this.#lastFailure = null;
    this.onReference(null, { mode: 'file', revoked: true });
    return { revoked: had, connected: false };
  }

  async #exchange(form) {
    const body = new URLSearchParams(form);
    let response;
    try {
      response = await this.#request('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
      });
    } catch (error) {
      const code = /timeout|AbortError/i.test(String(error?.name || error?.message)) ? FAIL.timeout : FAIL.network;
      this.#lastFailure = code;
      throw exchangeError(code, 'Drive OAuth token exchange unavailable.');
    }
    const raw = await response.text();
    if (!response.ok) {
      const provider = parseProviderError(raw);
      const code = provider ? PROVIDER_ERRORS[provider] : FAIL.http;
      this.#lastFailure = code;
      throw exchangeError(code, 'Drive OAuth token exchange rejected.', provider);
    }
    let value;
    try { value = JSON.parse(raw); } catch {
      this.#lastFailure = FAIL.schema;
      throw exchangeError(FAIL.schema, 'Drive OAuth token response invalid.');
    }
    if (typeof value.access_token !== 'string' || !value.access_token) {
      this.#lastFailure = FAIL.schema;
      throw exchangeError(FAIL.schema, 'Drive OAuth token response missing access_token.');
    }
    if (value.scope && !scopesEqual(value.scope, FILE_SCOPE) && !hasFileScope(value.scope)) {
      this.#lastFailure = FAIL.scope;
      throw exchangeError(FAIL.scope, 'Drive OAuth scope mismatch.');
    }
    if (/gmail|calendar/i.test(String(value.scope || ''))) {
      this.#lastFailure = FAIL.scope;
      throw exchangeError(FAIL.scope, 'Drive OAuth must not include Gmail or Calendar scopes.');
    }
    return value;
  }
}

module.exports = {
  DriveOAuth,
  FILE_SCOPE,
  CALLBACK_PATH,
  VAULT_PURPOSE,
  hasFileScope,
  FAIL,
};
