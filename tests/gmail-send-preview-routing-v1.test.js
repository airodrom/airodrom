'use strict';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const intent = require('../src/assistant-intent');
const writeIntent = require('../src/gmail-write-intent');
const searchIntent = require('../src/gmail-search-intent');
const writeService = require('../src/gmail-write-service');
const {
  GmailOAuth, scopeForMode, READ_SCOPE,
} = require('../src/gmail-oauth');
const { GmailWriteSessions } = require('../src/gmail-write-session');
const { GmailWriteConnector } = require('../src/gmail-write-connector');

const CLIENT = 'synthetic-desktop.apps.googleusercontent.com';
const REDIRECT = 'http://127.0.0.1:43117/oauth/gmail/callback';

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

const USER_REQUESTS = [
  'Send a test email to myself and show me the preview',
  'Send a test email and show a preview',
  'Please send a test email and give me the preview id',
  'Create a Gmail send preview for a test email to me@example.com',
  'Show me a send preview for an email to test@example.com',
  'Send myself a test email',
];

test('exact user send-preview requests route to GMAIL_WRITE, not Gmail search refuse', () => {
  for (const message of USER_REQUESTS) {
    const search = searchIntent.parse(message);
    const write = writeIntent.parse(message);
    const routed = intent.parse(message);
    assert.equal(routed.route, 'GMAIL_WRITE', message);
    assert.equal(routed.kind, 'gmail_write', message);
    assert.equal(write?.route, 'GMAIL_WRITE', message);
    assert.notEqual(routed.kind, 'clarify');
    // Search may still classify as mutation refuse in isolation; assistant must prefer write.
    if (search?.kind === 'clarify') {
      assert.match(search.message, /read-only/i);
    }
    assert.doesNotMatch(routed.message || '', /Gmail search is read-only/i, message);
  }
});

test('test email to myself stages send action with defaults (not clarify-only)', () => {
  const parsed = writeIntent.parse('Send a test email to myself and show me the preview');
  assert.equal(parsed.action, 'send');
  assert.equal(parsed.to, 'myself');
  assert.equal(parsed.subject, 'Test');
  assert.match(parsed.body, /test email/i);
  assert.equal(parsed.clarify, undefined);
  assert.equal(parsed.wants_preview, true);
});

test('OAuth scope mismatch: connected readonly refuses send with explicit gmail.send requirement', async () => {
  const conversation_id = randomUUID();
  const vault = memoryVault();
  const oauth = new GmailOAuth({
    clientId: CLIENT,
    vault,
    request: async () => jsonResponse(200, {
      access_token: 'tok', refresh_token: 'r', expires_in: 3600, scope: READ_SCOPE,
    }),
  });
  const state = new URL(oauth.start(REDIRECT, { mode: 'readonly' }).authorization_url).searchParams.get('state');
  await oauth.complete({ state, code: 'code' });
  assert.equal(oauth.status().connected, true);
  assert.equal(oauth.status().can_send, false);

  const server = {
    gmailOAuth: oauth,
    gmailWriteConnector: new GmailWriteConnector({
      oauth,
      request: async () => { throw Error('provider must not be called without send scope'); },
    }),
    gmailWriteSessions: new GmailWriteSessions(),
  };

  const result = await writeService.run(server, {
    kind: 'gmail_write', action: 'send',
    to: 'person@example.com', subject: 'Hi', body: 'Hello',
  }, { conversation_id });

  assert.equal(result.kind, 'connect_required');
  assert.equal(result.send_required, true);
  assert.equal(result.connected, true);
  assert.equal(result.can_send, false);
  assert.match(result.message, /gmail\.send/i);
  assert.match(result.message, /connected/i);
  assert.doesNotMatch(result.message, /^Gmail is connected\.?$/i);
  assert.equal(result.preview_id, undefined);
});

test('send-authorized account creates durable preview ID and never sends before confirm', async () => {
  const conversation_id = randomUUID();
  const vault = memoryVault();
  const scope = scopeForMode('send');
  const calls = [];
  const oauth = new GmailOAuth({
    clientId: CLIENT,
    vault,
    request: async () => jsonResponse(200, {
      access_token: 'tok', refresh_token: 'r', expires_in: 3600, scope,
    }),
  });
  const state = new URL(oauth.start(REDIRECT, { mode: 'send' }).authorization_url).searchParams.get('state');
  await oauth.complete({ state, code: 'code' });
  assert.equal(oauth.canSend(), true);

  const adapter = new GmailWriteConnector({
    oauth,
    request: async (url, options) => {
      calls.push({ url: String(url), method: options.method });
      if (String(url).endsWith('/profile')) return jsonResponse(200, { emailAddress: 'owner@example.com' });
      if (String(url).includes('/messages/send')) {
        return jsonResponse(200, { id: 'sent1', threadId: 't1', labelIds: ['SENT'] });
      }
      return jsonResponse(200, {});
    },
  });
  const server = {
    gmailOAuth: oauth,
    gmailWriteConnector: adapter,
    gmailWriteSessions: new GmailWriteSessions(),
  };

  const parsed = writeIntent.parse('Send a test email to myself and show me the preview');
  const preview = await writeService.run(server, parsed, { conversation_id });
  assert.equal(preview.action, 'preview');
  assert.ok(preview.preview_id);
  assert.match(preview.message, new RegExp(`Preview ID: ${preview.preview_id}`));
  assert.match(preview.message, /\/gmail confirm /);
  assert.match(preview.message, /Nothing has been sent/i);
  assert.deepEqual(preview.proposal.to, ['owner@example.com']);
  assert.equal(calls.filter((c) => c.url.includes('/messages/send')).length, 0);

  const denied = await writeService.run(server, {
    kind: 'gmail_write', action: 'confirm', preview_id: preview.preview_id, confirmed: false,
  }, { conversation_id });
  assert.equal(denied.kind, 'clarify');
  assert.equal(calls.filter((c) => c.url.includes('/messages/send')).length, 0);

  // Chat text must not authorize send — only /gmail confirm with confirmed=true.
  assert.equal(calls.filter((c) => c.url.includes('/messages/send')).length, 0);
});

test('incomplete Send the email clarifies on GMAIL_WRITE rail', () => {
  const parsed = intent.parse('Send the email');
  assert.equal(parsed.route, 'GMAIL_WRITE');
  assert.equal(parsed.kind, 'gmail_write');
  assert.equal(parsed.clarify, true);
  assert.match(parsed.message, /preview|recipient|\/gmail confirm|gmail\.send|send/i);
  assert.doesNotMatch(parsed.message, /Gmail search is read-only/i);
});
