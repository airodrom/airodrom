'use strict';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { PassThrough, Readable } = require('node:stream');
const {
  GmailOAuth, scopeForMode, READ_SCOPE,
} = require('../src/gmail-oauth');
const { GmailWriteSessions } = require('../src/gmail-write-session');
const { GmailWriteConnector } = require('../src/gmail-write-connector');
const writeService = require('../src/gmail-write-service');
const writeIntent = require('../src/gmail-write-intent');
const local = require('../src/local-bootstrap');
const ControlServer = require('../src/control-server');
const { interactive } = require('../src/interactive-cli');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { runtime } = require('./fixtures/opencode-fixture.cjs');
const { conversationOptions } = require('./fixtures/direct-conversation-fixture.cjs');

const CLIENT = 'synthetic-desktop.apps.googleusercontent.com';
const REDIRECT = 'http://127.0.0.1:43117/oauth/gmail/callback';

function memoryVault() {
  const values = new Map();
  let seq = 0;
  return {
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

async function sendAuthorizedServer({ request } = {}) {
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
  const adapter = new GmailWriteConnector({
    oauth,
    request: async (url, options) => {
      calls.push({ url: String(url), method: options.method });
      if (request) return request(url, options, calls);
      if (String(url).endsWith('/profile')) return jsonResponse(200, { emailAddress: 'owner@example.com' });
      if (String(url).includes('/messages/send')) {
        return jsonResponse(200, { id: 'sent1', threadId: 't1', labelIds: ['SENT'] });
      }
      return jsonResponse(200, {});
    },
  });
  const sessions = new GmailWriteSessions({ db: new DatabaseSync(':memory:') });
  return {
    calls,
    oauth,
    server: {
      gmailOAuth: oauth,
      gmailWriteConnector: adapter,
      gmailWriteSessions: sessions,
    },
    sessions,
  };
}

test('interactive CLI binds /gmail confirm and approve to session conversation_id', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/interactive-cli.js'), 'utf8');
  const confirmBlock = src.match(/if\(gmailAction==='confirm'\)\{[\s\S]*?(?=if\(gmailAction==='help')/);
  const approveBlock = src.match(/if\(gmailAction==='approve'\)\{[\s\S]*?(?=if\(gmailAction==='confirm')/);
  assert.ok(confirmBlock, 'confirm slash block missing');
  assert.ok(approveBlock, 'approve slash block missing');
  assert.match(confirmBlock[0], /conversation_id:\s*await session\(\)/);
  assert.match(approveBlock[0], /conversation_id:\s*await session\(\)/);
  // Defect regression: bare request_id-only confirm payload must not remain.
  assert.doesNotMatch(
    confirmBlock[0],
    /local\.request\(home,'\/api\/assistant\/input',\{message:`\/gmail confirm \$\{id\}[^`]*`,request_id:randomUUID\(\)\}\)/,
  );
});

test('authenticated same-conversation confirm reaches governed send exactly once', async () => {
  const { server, calls } = await sendAuthorizedServer();
  const conversation_id = randomUUID();
  const preview = await writeService.run(server, {
    kind: 'gmail_write', action: 'send',
    to: 'person@example.com', subject: 'Hi', body: 'Hello',
  }, { conversation_id });
  assert.equal(preview.action, 'preview');
  assert.ok(preview.preview_id);

  const missing = await writeService.run(server, writeIntent.parse(`/gmail confirm ${preview.preview_id}`), {
    conversation_id: null, confirmed: true,
  });
  assert.equal(missing.kind, 'clarify');
  assert.match(missing.message, /authenticated Terminal conversation session/i);
  assert.equal(calls.filter((c) => c.url.includes('/messages/send')).length, 0);

  const sent = await writeService.run(server, writeIntent.parse(`/gmail confirm ${preview.preview_id}`), {
    conversation_id, confirmed: true,
  });
  assert.equal(sent.action, 'sent');
  assert.equal(sent.provider_confirmed, true);
  assert.equal(calls.filter((c) => c.url.includes('/messages/send')).length, 1);

  const again = await writeService.run(server, writeIntent.parse(`/gmail confirm ${preview.preview_id}`), {
    conversation_id, confirmed: true,
  });
  assert.equal(again.host_dedupe === true || again.action === 'sent', true);
  assert.equal(calls.filter((c) => c.url.includes('/messages/send')).length, 1);
});

test('different conversation cannot confirm another session preview', async () => {
  const { server, calls } = await sendAuthorizedServer();
  const a = randomUUID();
  const b = randomUUID();
  const preview = await writeService.run(server, {
    kind: 'gmail_write', action: 'send',
    to: 'person@example.com', subject: 'Hi', body: 'Hello',
  }, { conversation_id: a });
  const denied = await writeService.run(server, writeIntent.parse(`/gmail confirm ${preview.preview_id}`), {
    conversation_id: b, confirmed: true,
  });
  assert.equal(denied.kind, 'clarify');
  assert.match(String(denied.message || denied.code || ''), /conversation|mismatch|unavailable|not found|binding|preview/i);
  assert.equal(calls.filter((c) => c.url.includes('/messages/send')).length, 0);
});

test('wrong operator binding is refused', async () => {
  const { server, sessions, calls } = await sendAuthorizedServer();
  const conversation_id = randomUUID();
  const staged = sessions.stageWrite({
    op: 'send', to: ['person@example.com'], cc: [], bcc: [], subject: 'Hi', body: 'Hello',
  }, { conversation_id, operator: 'operator' });
  let err;
  try {
    sessions.claimWrite(staged.preview_id, { conversation_id, operator: 'other-operator' });
  } catch (e) { err = e; }
  assert.ok(err);
  assert.match(String(err.code || err.message), /operator|mismatch|binding|unavailable|not found|conversation|forbidden/i);
  assert.equal(calls.filter((c) => c.url.includes('/messages/send')).length, 0);
});

test('expired preview cannot be confirmed', async () => {
  let now = 1_000_000;
  const { server, sessions, calls } = await sendAuthorizedServer();
  sessions.now = () => now;
  const conversation_id = randomUUID();
  const staged = sessions.stageWrite({
    op: 'send', to: ['person@example.com'], cc: [], bcc: [], subject: 'Hi', body: 'Hello',
  }, { conversation_id, operator: 'operator' });
  now = 1_000_000 + (48 * 60 * 60 * 1000);
  const denied = await writeService.run(server, writeIntent.parse(`/gmail confirm ${staged.preview_id}`), {
    conversation_id, confirmed: true,
  });
  assert.equal(denied.kind, 'clarify');
  assert.match(String(denied.message || ''), /expir|unavailable|not found|preview/i);
  assert.equal(calls.filter((c) => c.url.includes('/messages/send')).length, 0);
});

test('readonly connected account cannot confirm-send; still requires gmail.send', async () => {
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
  const server = {
    gmailOAuth: oauth,
    gmailWriteConnector: new GmailWriteConnector({
      oauth,
      request: async () => { throw Error('provider must not send without scope'); },
    }),
    gmailWriteSessions: new GmailWriteSessions({ db: new DatabaseSync(':memory:') }),
  };
  const conversation_id = randomUUID();
  const result = await writeService.run(server, {
    kind: 'gmail_write', action: 'send',
    to: 'person@example.com', subject: 'Hi', body: 'Hello',
  }, { conversation_id });
  assert.equal(result.kind, 'connect_required');
  assert.equal(result.can_send, false);
  assert.match(result.message, /gmail\.send/i);
});

test('provider timeout marks uncertain and refuses blind retry without --ack-uncertain', async () => {
  const { server, calls } = await sendAuthorizedServer({
    request: async (url) => {
      if (String(url).endsWith('/profile')) return jsonResponse(200, { emailAddress: 'owner@example.com' });
      if (String(url).includes('/messages/send')) {
        const err = Error('fetch failed');
        err.name = 'TimeoutError';
        throw err;
      }
      return jsonResponse(200, {});
    },
  });
  const conversation_id = randomUUID();
  const preview = await writeService.run(server, {
    kind: 'gmail_write', action: 'send',
    to: 'person@example.com', subject: 'Hi', body: 'Hello',
  }, { conversation_id });
  const uncertain = await writeService.run(server, writeIntent.parse(`/gmail confirm ${preview.preview_id}`), {
    conversation_id, confirmed: true,
  });
  assert.match(String(uncertain.kind || uncertain.action || uncertain.message || ''), /uncertain|clarify|timeout|failed/i);
  const blind = await writeService.run(server, writeIntent.parse(`/gmail confirm ${preview.preview_id}`), {
    conversation_id, confirmed: true,
  });
  assert.match(String(blind.message || ''), /uncertain|ack-uncertain|Verify|refused|Blind/i);
  assert.equal(calls.filter((c) => c.url.includes('/messages/send')).length, 1);
});

test('durable reopen preserves pending preview for same conversation only', async () => {
  const { server, sessions, calls } = await sendAuthorizedServer();
  const conversation_id = randomUUID();
  const preview = await writeService.run(server, {
    kind: 'gmail_write', action: 'send',
    to: 'person@example.com', subject: 'Hi', body: 'Hello',
  }, { conversation_id });
  const revived = GmailWriteSessions.reopen(sessions.db);
  server.gmailWriteSessions = revived;
  const denied = await writeService.run(server, writeIntent.parse(`/gmail confirm ${preview.preview_id}`), {
    conversation_id: randomUUID(), confirmed: true,
  });
  assert.equal(denied.kind, 'clarify');
  const sent = await writeService.run(server, writeIntent.parse(`/gmail confirm ${preview.preview_id}`), {
    conversation_id, confirmed: true,
  });
  assert.equal(sent.action, 'sent');
  assert.equal(calls.filter((c) => c.url.includes('/messages/send')).length, 1);
});

test('Control Center / MCP style input without Terminal conversation cannot confirm', async () => {
  const { server, calls } = await sendAuthorizedServer();
  const conversation_id = randomUUID();
  const preview = await writeService.run(server, {
    kind: 'gmail_write', action: 'send',
    to: 'person@example.com', subject: 'Hi', body: 'Hello',
  }, { conversation_id });
  // Simulate an unauthenticated or foreign surface omitting conversation identity.
  const denied = await writeService.run(server, writeIntent.parse(`/gmail confirm ${preview.preview_id}`), {
    conversation_id: undefined, confirmed: true,
  });
  assert.equal(denied.kind, 'clarify');
  assert.match(denied.message, /authenticated Terminal conversation session/i);
  assert.equal(calls.filter((c) => c.url.includes('/messages/send')).length, 0);
});

test('interactive Terminal slash confirm reuses the same conversation as preview', async (t) => {
  const r = runtime(t);
  const f = await fixture(t, { opencode: r.options });
  const home = path.join(f.root, 'cli');
  local.privateDirectory(home, true);
  const b = f.bridge;
  const old = b.dataDir;
  b.dataDir = local.privateDirectory(path.join(home, 'data'), true);
  const server = new ControlServer(b, { port: 0, conversationOptions: conversationOptions() });
  const address = await server.start();
  local.writePrivate(path.join(b.dataDir, 'ui.json'), { ...address, pid: process.pid });
  fs.writeFileSync(path.join(b.dataDir, 'bridge.lock'), String(process.pid), { mode: 0o600 });
  t.after(async () => { await server.close(); b.dataDir = old; });

  const { server: synth, calls } = await sendAuthorizedServer();
  server.gmailOAuth = synth.gmailOAuth;
  server.gmailWriteConnector = synth.gmailWriteConnector;
  server.gmailWriteSessions = synth.gmailWriteSessions;

  // Seed a durable preview bound to a Terminal session, then confirm via slash.
  const session = await local.request(home, '/api/assistant/conversation/session', {});
  const preview = await local.request(home, '/api/assistant/input', {
    message: 'Send email to person@example.com subject “Hello”: Body here',
    request_id: randomUUID(),
    conversation_id: session.conversation_id,
  });
  assert.equal(preview.action, 'preview');
  assert.ok(preview.preview_id);

  const output = new PassThrough();
  let text = '';
  output.on('data', (c) => { text += c; });
  await interactive(home, {
    input: Readable.from([`/gmail confirm ${preview.preview_id}\n/quit\n`]),
    output,
    env: { NO_COLOR: '1', TERM: 'dumb' },
  });
  assert.doesNotMatch(text, /authenticated Terminal conversation session/i);
  assert.equal(calls.filter((c) => c.url.includes('/messages/send')).length, 1);
  assert.match(text, /sent|delivered|confirm|Gmail|Hello|Body|person@example\.com/i);
});
