'use strict';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DriveOAuth, FILE_SCOPE, VAULT_PURPOSE, FAIL } = require('../src/drive-oauth');
const { SecretVault } = require('../src/secret-vault');

const CLIENT = '123456789012-abcdefghijklmnopqrstuvwxyz.apps.googleusercontent.com';
const REDIRECT = 'http://127.0.0.1:43117/oauth/drive/callback';

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => typeof body === 'string' ? body : JSON.stringify(body),
  };
}

function dualPurposeVault({ gmailSecret = 'desktop-client-secret-fixture' } = {}) {
  const values = new Map();
  const purposes = new Map();
  let seq = 0;
  const gmailRef = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  values.set(gmailRef, gmailSecret);
  purposes.set(gmailRef, 'gmail');
  return {
    gmailRef,
    put(value, purpose) {
      if (!['operator', 'gmail', 'whatsapp', 'calendar', 'drive'].includes(purpose)) {
        throw Error('Invalid secure input');
      }
      const reference = 'opaque-' + (++seq);
      values.set(reference, value);
      purposes.set(reference, purpose);
      return { reference };
    },
    resolve(ref, purpose) {
      if (!values.has(ref) || purposes.get(ref) !== purpose) {
        throw Error('Secret reference is invalid or revoked');
      }
      return values.get(ref);
    },
    forget(ref) { values.delete(ref); purposes.delete(ref); },
    replace(ref, value, purpose) {
      if (purposes.get(ref) !== purpose) throw Error('Secret reference is invalid or revoked');
      values.delete(ref);
      purposes.delete(ref);
      const reference = 'opaque-' + (++seq);
      values.set(reference, value);
      purposes.set(reference, purpose);
      return { reference };
    },
    _values: values,
    _purposes: purposes,
  };
}

test('SecretVault accepts drive purpose for put/resolve/replace', () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'drive-vault-')));
  fs.chmodSync(home, 0o700);
  const values = new Map();
  const revoked = new Set();
  const port = (op, id, value) => {
    if (op === 'revoke') { revoked.add(id); return ''; }
    if (op === 'delete') { values.delete(id); return ''; }
    if (revoked.has(id)) throw Error('revoked');
    if (op === 'put') { values.set(id, value); return ''; }
    if (op === 'read') {
      if (!values.has(id)) throw Error('missing');
      return values.get(id);
    }
    throw Error('unsupported:' + op);
  };
  const vault = new SecretVault(home, port);
  const put = vault.put(JSON.stringify({ access_token: 't', scope: FILE_SCOPE }), 'drive');
  assert.ok(put.reference);
  const raw = vault.resolve(put.reference, 'drive');
  assert.match(raw, /access_token/);
  const replaced = vault.replace(put.reference, JSON.stringify({ access_token: 't2', scope: FILE_SCOPE }), 'drive');
  assert.ok(replaced.reference);
  assert.throws(() => vault.resolve(put.reference, 'drive'));
  assert.match(vault.resolve(replaced.reference, 'drive'), /t2/);
  // dispositions must record drive purpose without invalidating the vault
  const dispositions = JSON.parse(fs.readFileSync(path.join(home, 'vault-dispositions.json'), 'utf8'));
  assert.equal(dispositions.refs[replaced.reference].purpose, 'drive');
});

test('Drive OAuth resolves shared desktop secret from gmail purpose and stores tokens under drive', async () => {
  const vault = dualPurposeVault();
  const seen = [];
  const oauth = new DriveOAuth({
    clientId: CLIENT,
    vault,
    clientSecretReference: vault.gmailRef,
    request: async (_url, options) => {
      const body = String(options.body);
      seen.push(body);
      assert.match(body, /client_secret=desktop-client-secret-fixture/);
      assert.doesNotMatch(body, /gmail\.|calendar\./i);
      return jsonResponse(200, {
        access_token: 'ya29.drive-ok',
        refresh_token: 'refresh-ok',
        expires_in: 3600,
        scope: FILE_SCOPE,
      });
    },
  });
  const started = oauth.start(REDIRECT, { forceNew: true });
  assert.equal(started.scope, FILE_SCOPE);
  const state = new URL(started.authorization_url).searchParams.get('state');
  const done = await oauth.complete({ state, code: 'auth-code-1' });
  assert.equal(done.connected, true);
  assert.equal(oauth.status().connected, true);
  assert.equal(oauth.status().last_failure, null);
  const packed = vault._values.get(oauth.configuration().reference);
  assert.match(packed, /ya29\.drive-ok/);
  assert.equal(vault._purposes.get(oauth.configuration().reference), 'drive');
});

test('Drive OAuth fails closed on expired/missing pending state with actionable class', async () => {
  const oauth = new DriveOAuth({
    clientId: CLIENT,
    vault: dualPurposeVault(),
    request: async () => jsonResponse(200, { access_token: 'x', refresh_token: 'y', expires_in: 1, scope: FILE_SCOPE }),
  });
  await assert.rejects(
    () => oauth.complete({ state: 'deadbeef', code: 'code' }),
    (err) => err.safe_error_class === FAIL.consent && /expired|pending/i.test(err.message),
  );
});

test('Drive OAuth fails closed on Google access_denied without inventing success', async () => {
  const oauth = new DriveOAuth({
    clientId: CLIENT,
    vault: dualPurposeVault(),
    request: async () => { throw Error('should not exchange'); },
  });
  oauth.start(REDIRECT, { forceNew: true });
  await assert.rejects(
    () => oauth.complete({ state: 'any', code: null, providerError: 'access_denied' }),
    (err) => err.safe_error_class === FAIL.consent && /denied Drive consent/i.test(err.message),
  );
  assert.equal(oauth.status().connected, false);
});

test('Drive OAuth fails closed on token exchange rejection and keeps Gmail secret intact', async () => {
  const vault = dualPurposeVault();
  const oauth = new DriveOAuth({
    clientId: CLIENT,
    vault,
    clientSecretReference: vault.gmailRef,
    request: async () => jsonResponse(400, { error: 'invalid_grant' }),
  });
  const state = new URL(oauth.start(REDIRECT, { forceNew: true }).authorization_url).searchParams.get('state');
  await assert.rejects(
    () => oauth.complete({ state, code: 'bad' }),
    (err) => err.safe_error_class === FAIL.grant,
  );
  assert.equal(vault.resolve(vault.gmailRef, 'gmail'), 'desktop-client-secret-fixture');
  assert.equal(oauth.status().connected, false);
});

test('Drive OAuth forceNew invalidates only pending Drive attempt; connected grant remains until replace', async () => {
  const vault = dualPurposeVault();
  const oauth = new DriveOAuth({
    clientId: CLIENT,
    vault,
    clientSecretReference: vault.gmailRef,
    request: async () => jsonResponse(200, {
      access_token: 'tok', refresh_token: 'r', expires_in: 3600, scope: FILE_SCOPE,
    }),
  });
  const first = oauth.start(REDIRECT, { forceNew: true });
  const state1 = new URL(first.authorization_url).searchParams.get('state');
  await oauth.complete({ state: state1, code: 'c1' });
  assert.equal(oauth.status().connected, true);
  const refBefore = oauth.configuration().reference;
  const second = oauth.start(REDIRECT, { forceNew: true });
  assert.equal(oauth.status().connected, true); // still connected until complete
  assert.notEqual(new URL(second.authorization_url).searchParams.get('state'), state1);
  await assert.rejects(() => oauth.complete({ state: state1, code: 'replay' }), /expired|pending/i);
  assert.equal(oauth.configuration().reference, refBefore);
});

test('Drive OAuth rejects PKCE/state replay after successful complete', async () => {
  const vault = dualPurposeVault();
  const oauth = new DriveOAuth({
    clientId: CLIENT,
    vault,
    clientSecretReference: vault.gmailRef,
    request: async () => jsonResponse(200, {
      access_token: 'tok', refresh_token: 'r', expires_in: 3600, scope: FILE_SCOPE,
    }),
  });
  const state = new URL(oauth.start(REDIRECT, { forceNew: true }).authorization_url).searchParams.get('state');
  await oauth.complete({ state, code: 'once' });
  await assert.rejects(() => oauth.complete({ state, code: 'once-again' }), /expired|pending/i);
});

test('legacy vault without drive purpose surfaces actionable storage failure class', async () => {
  const values = new Map();
  const gmailRef = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  values.set(gmailRef, 'secret');
  const legacyVault = {
    put(_v, purpose) {
      if (purpose === 'drive') throw Error('Invalid secure input');
      const id = randomUUID();
      values.set(id, _v);
      return { reference: id };
    },
    resolve(ref, purpose) {
      if (purpose === 'gmail' && ref === gmailRef) return values.get(ref);
      throw Error('Secret reference is invalid or revoked');
    },
    forget() {},
  };
  const oauth = new DriveOAuth({
    clientId: CLIENT,
    vault: legacyVault,
    clientSecretReference: gmailRef,
    request: async () => jsonResponse(200, {
      access_token: 'tok', refresh_token: 'r', expires_in: 3600, scope: FILE_SCOPE,
    }),
  });
  const state = new URL(oauth.start(REDIRECT, { forceNew: true }).authorization_url).searchParams.get('state');
  await assert.rejects(
    () => oauth.complete({ state, code: 'code' }),
    (err) => err.safe_error_class === FAIL.request && /purpose "drive"/i.test(err.message),
  );
  assert.equal(oauth.status().connected, false);
});
