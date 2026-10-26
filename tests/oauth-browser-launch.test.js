'use strict';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  launchAuthorizationUrl, recoveryMessage, redact, assertAuthorizationUrl,
  wireConnectOffer, CODES, AUTH_HOST,
} = require('../src/oauth-browser-launch');
const { safeValue } = require('../src/secret-observation');
const { GmailOAuth, SCOPE } = require('../src/gmail-oauth');
const cli = require('../src/interactive-cli');

const SAMPLE = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x.apps.googleusercontent.com&state=secretstatevalue1234567890&code_challenge=abc';

function fakeChild({ status = 0, signal = null, error = null, stderr = '', delay = 5 } = {}) {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.kill = () => { child.emit('close', null, 'SIGTERM'); };
  setTimeout(() => {
    if (error) child.emit('error', error);
    else {
      if (stderr) child.stderr.emit('data', stderr);
      child.emit('close', status, signal);
    }
  }, delay);
  return child;
}

test('assertAuthorizationUrl permits only Google accounts HTTPS host', () => {
  assert.equal(assertAuthorizationUrl(SAMPLE).hostname, AUTH_HOST);
  assert.throws(() => assertAuthorizationUrl('http://accounts.google.com/x'), /not permitted|invalid/i);
  assert.throws(() => assertAuthorizationUrl('https://evil.example/oauth'), /not permitted|invalid/i);
});

test('wireConnectOffer preserves pinned authorization_url that safeValue would scrub', () => {
  const offer = {
    authorization_url: SAMPLE,
    read_only: true,
    expires_at: 1_700_000_000_000,
    reused: false,
    client_secret: 'sk-ant-synthetic-must-omit',
  };
  assert.equal(safeValue(offer).authorization_url, '[omitted]');
  const wired = wireConnectOffer(offer);
  assert.equal(wired.authorization_url, SAMPLE);
  assert.equal(wired.read_only, true);
  assert.equal(wired.expires_at, 1_700_000_000_000);
  assert.equal(wired.reused, false);
  assert.equal(wired.client_secret, '[omitted]');
  assert.throws(() => wireConnectOffer({ authorization_url: 'https://evil.example/oauth' }), /not permitted|invalid/i);
});

test('redact strips authorization URL and PKCE parameters', () => {
  const out = redact('open failed for ' + SAMPLE + ' state=secretstatevalue1234567890');
  assert.doesNotMatch(out, /secretstatevalue/);
  assert.doesNotMatch(out, /code_challenge=abc/);
  assert.match(out, /\[redacted\]/);
});

test('successful browser-launch handoff resolves opened without exposing the URL', async () => {
  const calls = [];
  const result = await launchAuthorizationUrl(SAMPLE, {
    spawnImpl: (cmd, args) => {
      calls.push({ cmd, args });
      return fakeChild({ status: 0 });
    },
    openPath: '/usr/bin/open',
  });
  assert.equal(result.ok, true);
  assert.equal(result.code, CODES.OPENED);
  assert.match(result.message, /waiting for operator consent/i);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, '/usr/bin/open');
  assert.deepEqual(calls[0].args, [SAMPLE]);
  assert.equal(JSON.stringify(result).includes('secretstatevalue'), false);
});

test('process execution failure is diagnosed without URL leakage', async () => {
  const result = await launchAuthorizationUrl(SAMPLE, {
    spawnImpl: () => { throw Object.assign(Error('spawn EACCES ' + SAMPLE), { code: 'EACCES' }); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.LAUNCH_ERROR);
  assert.doesNotMatch(JSON.stringify(result), /secretstatevalue|accounts\.google\.com\/o/);
});

test('nonzero exit and LaunchServices-style stderr map to precise codes', async () => {
  const nonzero = await launchAuthorizationUrl(SAMPLE, {
    spawnImpl: () => fakeChild({ status: 1, stderr: 'LSOpenURL failed' }),
  });
  assert.equal(nonzero.ok, false);
  assert.equal(nonzero.code, CODES.NONZERO_EXIT);

  const noGui = await launchAuthorizationUrl(SAMPLE, {
    spawnImpl: () => fakeChild({ status: 1, stderr: 'WindowServer unavailable for user session' }),
  });
  assert.equal(noGui.ok, false);
  assert.equal(noGui.code, CODES.NO_GUI);
});

test('timeout kills the opener and reports browser launch timed out', async () => {
  const result = await launchAuthorizationUrl(SAMPLE, {
    timeoutMs: 30,
    spawnImpl: () => {
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stderr.setEncoding = () => {};
      let killed = false;
      child.kill = () => { killed = true; child.emit('close', null, 'SIGTERM'); };
      setTimeout(() => { if (!killed) child.emit('close', 0, null); }, 500);
      return child;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.TIMEOUT);
  assert.match(result.message, /timed out/i);
});

test('missing opener binary is diagnosed as unavailable', async () => {
  const result = await launchAuthorizationUrl(SAMPLE, {
    openPath: '/tmp/airodrom-missing-open-bin-' + Date.now(),
    spawnImpl: () => fakeChild({ status: 0 }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.OPENER_UNAVAILABLE);
});

test('non-darwin platforms report no graphical session', async () => {
  const result = await launchAuthorizationUrl(SAMPLE, {
    platform: 'linux',
    spawnImpl: () => fakeChild({ status: 0 }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.NO_GUI);
});

test('recovery message never embeds the authorization URL', () => {
  const text = recoveryMessage({
    ok: false,
    code: CODES.TIMEOUT,
    message: 'Browser launch timed out waiting for macOS LaunchServices.',
  });
  assert.match(text, /retry-open/);
  assert.match(text, /show-local/);
  assert.doesNotMatch(text, /accounts\.google\.com/);
  assert.doesNotMatch(text, /secretstatevalue/);
});

test('Gmail OAuth start reuses unexpired pending PKCE session', () => {
  const vault = {
    put() { return { reference: 'ref-1' }; },
    resolve() { return '{}'; },
    forget() {},
    replace() { return { reference: 'ref-2' }; },
  };
  const oauth = new GmailOAuth({
    clientId: 'synthetic.apps.googleusercontent.com',
    vault,
  });
  const redirect = 'http://127.0.0.1:43117/oauth/gmail/callback';
  const first = oauth.start(redirect);
  const second = oauth.start(redirect);
  assert.equal(second.reused, true);
  assert.equal(first.authorization_url, second.authorization_url);
  assert.equal(SCOPE, 'https://www.googleapis.com/auth/gmail.readonly');
  const fresh = oauth.start(redirect, { forceNew: true });
  assert.equal(fresh.reused, false);
  assert.notEqual(fresh.authorization_url, first.authorization_url);
  assert.match(fresh.authorization_url, /prompt=consent/);
  assert.match(fresh.authorization_url, /gmail\.readonly/);
});

test('OAuth callback state mismatch and expiry remain fail-closed', async () => {
  const vault = {
    put() { return { reference: 'ref-1' }; },
    resolve() { return '{}'; },
    forget() {},
    replace() { return { reference: 'ref-2' }; },
  };
  const oauth = new GmailOAuth({
    clientId: 'synthetic.apps.googleusercontent.com',
    vault,
    request: async () => ({ ok: true, text: async () => JSON.stringify({ access_token: 't', expires_in: 3600, scope: SCOPE }) }),
  });
  const started = oauth.start('http://127.0.0.1:43117/oauth/gmail/callback');
  const state = new URL(started.authorization_url).searchParams.get('state');
  await assert.rejects(oauth.complete({ state: 'wrong', code: 'x' }), /refused/);
  oauth.start('http://127.0.0.1:43117/oauth/gmail/callback', { forceNew: true });
  // Expire by completing after clearing via mismatched prior session already consumed.
  await assert.rejects(oauth.complete({ state, code: 'x' }), /refused/);
});

test('CLI pending authorization supports retry-open without new connect side effects', async () => {
  cli.clearPendingGmailAuthorization();
  const launches = [];
  cli.rememberGmailAuthorization({
    authorization_url: SAMPLE,
    expires_at: Date.now() + 60_000,
    read_only: true,
  });
  const output = { chunks: [], write(chunk) { this.chunks.push(String(chunk)); } };
  await cli.openGmailAuthorization(output, SAMPLE, {
    launch: async (url) => {
      launches.push(url);
      return { ok: true, code: CODES.OPENED, message: 'Authorization page opened; waiting for operator consent in your browser.' };
    },
  });
  assert.deepEqual(launches, [SAMPLE]);
  assert.match(output.chunks.join(''), /waiting for operator consent/i);
  assert.doesNotMatch(output.chunks.join(''), /secretstatevalue/);

  await assert.rejects(cli.openGmailAuthorization(output, SAMPLE, {
    launch: async () => ({ ok: false, code: CODES.TIMEOUT, message: 'Browser launch timed out waiting for macOS LaunchServices.' }),
  }), /retry-open|show-local|timed out/i);

  assert.throws(
    () => cli.rememberGmailAuthorization({ authorization_url: 'https://evil.example/oauth', expires_at: Date.now() + 60_000 }),
    /not permitted/
  );
  assert.equal(cli._pendingGmailAuthorization(), null);

  cli._setPendingGmailAuthorization({
    authorization_url: SAMPLE,
    expires_at: Date.now() - 1,
  });
  assert.throws(() => cli.requirePendingGmailAuthorization(), /expired|timed out/i);
  cli.clearPendingGmailAuthorization();
});

test('read-only permission and no credential leakage in launcher diagnostics', async () => {
  const result = await launchAuthorizationUrl(SAMPLE, {
    spawnImpl: () => fakeChild({ status: 1, stderr: 'fail ' + SAMPLE + ' token=ya29.secret' }),
  });
  const blob = JSON.stringify(result);
  assert.doesNotMatch(blob, /ya29|secretstatevalue|code_challenge=abc/);
  assert.equal(SCOPE.endsWith('gmail.readonly'), true);
});
