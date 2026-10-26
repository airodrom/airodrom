'use strict';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  GmailOAuth, SCOPE, FAIL, PROVIDER_ERRORS, parseProviderError,
} = require('../src/gmail-oauth');
const { AssistantConnectors } = require('../src/assistant-connectors');

const CLIENT = 'synthetic-desktop.apps.googleusercontent.com';
const REDIRECT = 'http://127.0.0.1:43117/oauth/gmail/callback';
const SECRET_REF = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function memoryVault(seed = new Map()) {
  const values = seed;
  let seq = 0;
  return {
    values,
    put(value, purpose) {
      assert.equal(purpose, 'gmail');
      const reference = 'opaque-' + (++seq);
      values.set(reference, value);
      return { reference };
    },
    resolve(ref, purpose) {
      assert.equal(purpose, 'gmail');
      if (!values.has(ref)) throw Error('Secret reference is invalid or revoked');
      return values.get(ref);
    },
    forget(ref) { values.delete(ref); },
    replace(ref, value, purpose) {
      assert.equal(purpose, 'gmail');
      assert.ok(values.has(ref));
      values.delete(ref);
      const reference = 'opaque-' + (++seq);
      values.set(reference, value);
      return { reference };
    },
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => typeof body === 'string' ? body : JSON.stringify(body),
    body: { cancel: async () => {} },
  };
}

test('parseProviderError allowlists Google identifiers and drops descriptions', () => {
  assert.equal(parseProviderError(JSON.stringify({
    error: 'invalid_client',
    error_description: 'Unauthorized secret ya29.leak',
  })), 'invalid_client');
  assert.equal(parseProviderError(JSON.stringify({ error: 'invalid_grant' })), 'invalid_grant');
  assert.equal(parseProviderError(JSON.stringify({ error: 'not_a_google_error' })), null);
  assert.equal(parseProviderError('not-json'), null);
  assert.equal(Object.keys(PROVIDER_ERRORS).includes('invalid_request'), true);
});

test('authorization_code exchange includes vault client_secret when configured', async () => {
  const vault = memoryVault(new Map([[SECRET_REF, 'SYNTHETIC_CLIENT_SECRET_VALUE']]));
  const forms = [];
  const oauth = new GmailOAuth({
    clientId: CLIENT,
    vault,
    clientSecretReference: SECRET_REF,
    request: async (_url, options) => {
      const form = Object.fromEntries(new URLSearchParams(options.body));
      forms.push({ ...form, client_secret: form.client_secret ? '[present]' : undefined });
      return jsonResponse(200, {
        access_token: 'synthetic-access-token',
        refresh_token: 'synthetic-refresh-token',
        expires_in: 3600,
        scope: SCOPE,
      });
    },
  });
  const started = oauth.start(REDIRECT);
  const state = new URL(started.authorization_url).searchParams.get('state');
  const done = await oauth.complete({ state, code: 'synthetic-auth-code' });
  assert.equal(done.connected, true);
  assert.equal(done.live_qualified, false);
  assert.equal(forms[0].grant_type, 'authorization_code');
  assert.equal(forms[0].client_secret, '[present]');
  assert.equal(forms[0].code_verifier?.length > 10, true);
  assert.equal(forms[0].redirect_uri, REDIRECT);
  assert.equal(oauth.status().token_present, true);
  assert.equal(oauth.status().connected, true);
  assert.equal(oauth.status().live_qualified, false);
  assert.equal(oauth.status().client_secret_bound, true);
  assert.equal(oauth.status().last_safe_error_class, null);
});

test('authorization_code exchange stays PKCE-only when no client secret reference', async () => {
  const vault = memoryVault();
  let form;
  const oauth = new GmailOAuth({
    clientId: CLIENT,
    vault,
    request: async (_url, options) => {
      form = Object.fromEntries(new URLSearchParams(options.body));
      return jsonResponse(200, { access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: SCOPE });
    },
  });
  const state = new URL(oauth.start(REDIRECT).authorization_url).searchParams.get('state');
  await oauth.complete({ state, code: 'code' });
  assert.equal(form.client_secret, undefined);
  assert.equal(form.code_verifier?.length > 10, true);
});

test('provider error categories map without leaking bodies or secrets', async () => {
  for (const [provider, safe] of Object.entries({
    invalid_client: FAIL.client,
    unauthorized_client: FAIL.client,
    invalid_grant: FAIL.grant,
    invalid_request: FAIL.request,
    invalid_scope: FAIL.scope,
    access_denied: FAIL.consent,
  })) {
    const vault = memoryVault(new Map([[SECRET_REF, 'SYNTHETIC_CLIENT_SECRET_VALUE']]));
    const oauth = new GmailOAuth({
      clientId: CLIENT,
      vault,
      clientSecretReference: SECRET_REF,
      request: async () => jsonResponse(401, {
        error: provider,
        error_description: 'token=ya29.secret state=leak code=leak',
      }),
    });
    const state = new URL(oauth.start(REDIRECT).authorization_url).searchParams.get('state');
    await assert.rejects(oauth.complete({ state, code: 'synthetic-code' }), (err) => {
      assert.equal(err.safe_error_class, safe);
      assert.equal(err.provider_error, provider);
      assert.doesNotMatch(err.message, /ya29|SYNTHETIC_CLIENT|synthetic-code|leak/);
      return true;
    });
    const status = oauth.status();
    assert.equal(status.last_safe_error_class, safe);
    assert.equal(status.last_failure_phase, 'authorization_code');
    assert.equal(status.last_provider_error, provider);
    assert.equal(status.token_present, false);
    assert.equal(status.connected, false);
    assert.doesNotMatch(JSON.stringify(status), /ya29|SYNTHETIC_CLIENT|leak/);
  }
});

test('refresh attaches client_secret and replaces expired token', async () => {
  const vault = memoryVault(new Map([[SECRET_REF, 'SYNTHETIC_CLIENT_SECRET_VALUE']]));
  const seed = vault.put(JSON.stringify({
    access_token: 'old-access',
    refresh_token: 'old-refresh',
    expires_at: 1,
    scope: SCOPE,
  }), 'gmail');
  let form;
  const oauth = new GmailOAuth({
    clientId: CLIENT,
    vault,
    reference: seed.reference,
    clientSecretReference: SECRET_REF,
    request: async (_url, options) => {
      form = Object.fromEntries(new URLSearchParams(options.body));
      return jsonResponse(200, { access_token: 'new-access', expires_in: 3600, scope: SCOPE });
    },
  });
  assert.equal(await oauth.resolve(), 'new-access');
  assert.equal(form.grant_type, 'refresh_token');
  assert.ok(form.client_secret);
  assert.equal(oauth.status().last_safe_error_class, null);
});

test('stored broad historical scope fails closed before refresh', async () => {
  const vault = memoryVault();
  const seed = vault.put(JSON.stringify({
    access_token: 'old-access',
    refresh_token: 'old-refresh',
    expires_at: Date.now() + 60_000,
    scope: 'https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/drive',
  }), 'gmail');
  const oauth = new GmailOAuth({ clientId: CLIENT, vault, reference: seed.reference });
  assert.equal(oauth.status().token_present, true);
  assert.equal(oauth.status().connected, false);
  assert.equal(oauth.status().last_safe_error_class, FAIL.scope);
  await assert.rejects(oauth.resolve(), (err) => err.safe_error_class === FAIL.scope);
});

test('successful authorization does not imply live_qualified until bounded read', async () => {
  const vault = memoryVault();
  const oauth = new GmailOAuth({
    clientId: CLIENT,
    vault,
    request: async () => jsonResponse(200, {
      access_token: 'mail-token', refresh_token: 'r', expires_in: 3600, scope: SCOPE,
    }),
  });
  const state = new URL(oauth.start(REDIRECT).authorization_url).searchParams.get('state');
  await oauth.complete({ state, code: 'code' });
  let calls = 0;
  const live = new AssistantConnectors({
    gmail: oauth.configuration(),
    secrets: { resolve: () => oauth.resolve() },
    connected: () => oauth.status().connected,
    request: async (url) => {
      calls++;
      if (String(url).includes('/messages/') && !String(url).endsWith('/messages')) {
        return jsonResponse(200, {
          id: 'm1',
          payload: { headers: [{ name: 'Subject', value: 'Synthetic' }, { name: 'From', value: 'a@b.test' }, { name: 'Date', value: 'Mon' }] },
          snippet: 'Synthetic body',
        });
      }
      return jsonResponse(200, { messages: [{ id: 'm1' }] });
    },
  });
  assert.equal(live.status().items[0].live_qualified, false);
  assert.equal(live.status().items[0].connected, true);
  const receipt = await live.read('gmail', 'recent', { limit: 1 });
  assert.equal(receipt.items.length, 1);
  assert.equal(live.status().items[0].live_qualified, true);
  assert.equal(live.status().items[0].state, 'live_qualified');
  assert.ok(calls >= 2);
});

test('PKCE verifier and redirect stay consistent across start reuse and complete', async () => {
  const vault = memoryVault();
  const seen = [];
  const oauth = new GmailOAuth({
    clientId: CLIENT,
    vault,
    request: async (_url, options) => {
      seen.push(Object.fromEntries(new URLSearchParams(options.body)));
      return jsonResponse(200, { access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: SCOPE });
    },
  });
  const first = oauth.start(REDIRECT);
  const second = oauth.start(REDIRECT);
  assert.equal(first.authorization_url, second.authorization_url);
  assert.equal(second.reused, true);
  const challenge = new URL(first.authorization_url).searchParams.get('code_challenge');
  const state = new URL(first.authorization_url).searchParams.get('state');
  await oauth.complete({ state, code: 'code' });
  const verifier = seen[0].code_verifier;
  const expected = require('node:crypto').createHash('sha256').update(verifier).digest('base64url');
  assert.equal(challenge, expected);
  assert.equal(seen[0].redirect_uri, REDIRECT);
});
