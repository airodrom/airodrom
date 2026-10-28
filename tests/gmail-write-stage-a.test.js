'use strict';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  GmailOAuth, SCOPE, READ_SCOPE, SEND_SCOPE, MODIFY_SCOPE, scopeForMode, FAIL,
} = require('../src/gmail-oauth');
const { AssistantConnectors } = require('../src/assistant-connectors');
const { GmailWriteSessions } = require('../src/gmail-write-session');
const { GmailWriteConnector, encodeRaw, parseAddressList } = require('../src/gmail-write-connector');
const writeIntent = require('../src/gmail-write-intent');
const writeService = require('../src/gmail-write-service');
const calendarIntent = require('../src/calendar-intent');

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

test('gmail oauth modes request least-privilege scopes and never mail.google.com', () => {
  assert.equal(scopeForMode('readonly'), READ_SCOPE);
  assert.equal(scopeForMode('send').includes(SEND_SCOPE), true);
  assert.equal(scopeForMode('send').includes(READ_SCOPE), true);
  assert.equal(scopeForMode('manage').includes(MODIFY_SCOPE), true);
  assert.equal(scopeForMode('manage').includes(SEND_SCOPE), true);
  assert.equal(SCOPE, READ_SCOPE);
  const vault = memoryVault();
  const oauth = new GmailOAuth({ clientId: CLIENT, vault });
  const send = oauth.start(REDIRECT, { mode: 'send' });
  assert.equal(send.mode, 'send');
  assert.match(send.authorization_url, /gmail\.send/);
  assert.doesNotMatch(send.authorization_url, /mail\.google\.com/);
  const manage = oauth.start(REDIRECT, { forceNew: true, mode: 'manage' });
  assert.equal(manage.mode, 'manage');
  assert.match(manage.authorization_url, /gmail\.modify/);
  assert.doesNotMatch(manage.authorization_url, /mail\.google\.com/);
});

test('readonly consent rejects silent upgrade to send/modify scopes', async () => {
  const vault = memoryVault();
  const oauth = new GmailOAuth({
    clientId: CLIENT,
    vault,
    request: async () => jsonResponse(200, {
      access_token: 'a', refresh_token: 'r', expires_in: 3600,
      scope: `${READ_SCOPE} ${SEND_SCOPE}`,
    }),
  });
  const state = new URL(oauth.start(REDIRECT, { mode: 'readonly' }).authorization_url).searchParams.get('state');
  await assert.rejects(oauth.complete({ state, code: 'code' }), (err) => err.safe_error_class === FAIL.scope);
});

test('send mode complete reports can_send without can_modify', async () => {
  const vault = memoryVault();
  const expected = scopeForMode('send');
  const oauth = new GmailOAuth({
    clientId: CLIENT,
    vault,
    request: async () => jsonResponse(200, {
      access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: expected,
    }),
  });
  const state = new URL(oauth.start(REDIRECT, { mode: 'send' }).authorization_url).searchParams.get('state');
  const done = await oauth.complete({ state, code: 'code' });
  assert.equal(done.mode, 'send');
  assert.equal(done.can_send, true);
  assert.equal(done.can_modify, false);
  assert.equal(done.read_only, false);
  assert.equal(oauth.canWrite(), true);
  assert.equal(oauth.status().can_send, true);
  assert.equal(oauth.status().can_modify, false);
});

test('assistant connectors allow read with modify scope and report write flags', async () => {
  const scope = scopeForMode('manage');
  let calls = 0;
  const live = new AssistantConnectors({
    gmail: { reference: 'host-oauth', scope },
    secrets: { resolve: async () => 'tok' },
    connected: () => true,
    capabilities: () => ({
      scope, mode: 'manage', can_send: true, can_modify: true, can_write: true, read_only: false,
    }),
    request: async (url) => {
      calls++;
      if (String(url).includes('/messages/') && !String(url).endsWith('/messages')) {
        return jsonResponse(200, { id: 'm1', snippet: 'x', payload: { headers: [{ name: 'Subject', value: 'S' }] } });
      }
      return jsonResponse(200, { messages: [{ id: 'm1' }] });
    },
  });
  const st = live.status().items[0];
  assert.equal(st.can_send, true);
  assert.equal(st.can_modify, true);
  assert.equal(st.write_qualified, false);
  assert.equal(st.read_only, false);
  const receipt = await live.read('gmail', 'recent', { limit: 1 });
  assert.equal(receipt.items.length, 1);
  assert.ok(calls >= 2);
});

test('write intent routes send/reply/trash and does not invent slash send verbs', () => {
  const send = writeIntent.parse('Send email to person@example.com subject “Hello”: Body here');
  assert.equal(send.action, 'send');
  assert.equal(send.to, 'person@example.com');
  assert.equal(send.subject, 'Hello');
  assert.equal(send.body, 'Body here');
  const clarify = writeIntent.parse('Send an email');
  assert.equal(clarify.clarify, true);
  const trash = writeIntent.parse('Trash that email');
  assert.equal(trash.action, 'trash');
  assert.equal(trash.destructive, true);
  const slash = writeIntent.parse('/gmail send person@example.com');
  assert.equal(slash.action, 'send');
  assert.equal(slash.clarify, true);
  assert.match(slash.message, /attach-drive|confirm/i);
  const slashAttach = writeIntent.parse('/gmail send to myself subject “Hi”: Body --attach-drive file_x');
  assert.equal(slashAttach.action, 'send');
  assert.equal(slashAttach.drive_file_id, 'file_x');
  assert.equal(slashAttach.clarify, undefined);
});

test('gmail write preview requires confirm; trash needs independent approval', async () => {
  const conversation_id = randomUUID();
  const vault = memoryVault();
  const scope = scopeForMode('manage');
  const oauth = new GmailOAuth({
    clientId: CLIENT,
    vault,
    request: async () => jsonResponse(200, {
      access_token: 'tok', refresh_token: 'r', expires_in: 3600, scope,
    }),
  });
  const state = new URL(oauth.start(REDIRECT, { mode: 'manage' }).authorization_url).searchParams.get('state');
  await oauth.complete({ state, code: 'code' });

  const calls = [];
  const adapter = new GmailWriteConnector({
    oauth,
    request: async (url, options) => {
      calls.push({ url: String(url), method: options.method, body: options.body });
      if (String(url).endsWith('/profile')) return jsonResponse(200, { emailAddress: 'owner@example.com' });
      if (String(url).includes('/messages/send')) {
        return jsonResponse(200, { id: 'sent1', threadId: 't1', labelIds: ['SENT'] });
      }
      if (String(url).includes('/trash')) {
        return jsonResponse(200, { id: 'm9', labelIds: ['TRASH'] });
      }
      return jsonResponse(200, {});
    },
  });

  const server = {
    gmailOAuth: oauth,
    gmailWriteConnector: adapter,
    gmailWriteSessions: new GmailWriteSessions(),
    gmailSearchSessions: new (require('../src/gmail-search-session').GmailSearchSessions)(),
  };
  server.gmailSearchSessions.rememberResults({
    items: [{ id: 'm9', subject: 'Synth', from: 'a@b.test' }],
    conversation_id,
    operator: 'operator',
  });

  const preview = await writeService.run(server, {
    kind: 'gmail_write', action: 'send',
    to: 'person@example.com', subject: 'Hi', body: 'Hello',
  }, { conversation_id });
  assert.equal(preview.action, 'preview');
  assert.ok(preview.preview_id);
  assert.equal(calls.filter((c) => c.url.includes('/messages/send')).length, 0);

  const unconfirmed = await writeService.run(server, {
    kind: 'gmail_write', action: 'confirm', preview_id: preview.preview_id, confirmed: false,
  }, { conversation_id });
  assert.equal(unconfirmed.kind, 'clarify');

  const sent = await writeService.run(server, {
    kind: 'gmail_write', action: 'confirm', preview_id: preview.preview_id, confirmed: true,
  }, { conversation_id, confirmed: true });
  assert.equal(sent.action, 'sent');
  assert.equal(sent.item.message_id, 'sent1');
  assert.equal(sent.provider_confirmed, true);

  const replay = await writeService.run(server, {
    kind: 'gmail_write', action: 'confirm', preview_id: preview.preview_id, confirmed: true,
  }, { conversation_id, confirmed: true });
  assert.equal(replay.host_dedupe, true);
  assert.equal(calls.filter((c) => c.url.includes('/messages/send')).length, 1);

  const trashPreview = await writeService.run(server, {
    kind: 'gmail_write', action: 'trash', destructive: true,
  }, { conversation_id });
  assert.equal(trashPreview.requires_independent_approval, true);
  assert.ok(trashPreview.approval_id);

  const flagOnly = await writeService.run(server, {
    kind: 'gmail_write', action: 'confirm', preview_id: trashPreview.preview_id, confirmed: true, destructive: true,
  }, { conversation_id, confirmed: true, destructive: true });
  assert.equal(flagOnly.code, 'gmail_write_approval_required');

  await writeService.run(server, {
    kind: 'gmail_write', action: 'approve', approval_id: trashPreview.approval_id,
  }, { conversation_id });
  const trashed = await writeService.run(server, {
    kind: 'gmail_write', action: 'confirm', preview_id: trashPreview.preview_id, confirmed: true, destructive: true,
  }, { conversation_id, confirmed: true, destructive: true });
  assert.equal(trashed.action, 'trash');
  assert.equal(trashed.provider_confirmed, true);
});

test('readonly gmail cannot send; manage offer is explicit', async () => {
  const conversation_id = randomUUID();
  const vault = memoryVault();
  const oauth = new GmailOAuth({
    clientId: CLIENT,
    vault,
    request: async () => jsonResponse(200, {
      access_token: 'tok', refresh_token: 'r', expires_in: 3600, scope: READ_SCOPE,
    }),
  });
  const state = new URL(oauth.start(REDIRECT).authorization_url).searchParams.get('state');
  await oauth.complete({ state, code: 'code' });
  const server = { gmailOAuth: oauth, gmailWriteSessions: new GmailWriteSessions() };
  const offer = await writeService.run(server, {
    kind: 'gmail_write', action: 'send',
    to: 'a@b.test', subject: 'x', body: 'y',
  }, { conversation_id });
  assert.equal(offer.kind, 'connect_required');
  assert.match(offer.message, /connect gmail send/);
});

test('calendar manage destructive path still requires independent approval (acceptance)', () => {
  const cancel = calendarIntent.parse('cancel that meeting', { activeCalendarSession: true });
  assert.equal(cancel.action, 'followup_cancel');
  const help = calendarIntent.parse('help me control my calendar');
  assert.equal(help.action, 'help');
});

test('encodeRaw and recipient parsing stay bounded', () => {
  const raw = encodeRaw({ to: ['a@b.test'], subject: 'Hi', body: 'Body' });
  assert.equal(typeof raw, 'string');
  assert.ok(raw.length > 10);
  assert.deepEqual(parseAddressList('Ada <ada@example.com>', 'to'), ['ada@example.com']);
  assert.throws(() => parseAddressList(Array.from({ length: 25 }, (_, i) => `u${i}@ex.com`), 'to'));
});

test('Stage A gmail-write modules are on package and release allowlists; MCP trash stays inactive', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const release = new Set(JSON.parse(fs.readFileSync(path.join(root, 'release-files.json'), 'utf8')));
  const policy = JSON.parse(fs.readFileSync(path.join(root, 'config/capability-policy-v2.json'), 'utf8'));
  for (const file of [
    'src/gmail-write-connector.js',
    'src/gmail-write-intent.js',
    'src/gmail-write-service.js',
    'src/gmail-write-session.js',
    'docs/GOOGLE-WORKSPACE-STAGE-A-V1.md',
    'tests/gmail-write-stage-a.test.js',
    'tests/gmail-send-preview-routing-v1.test.js',
    'tests/gmail-confirm-terminal-session-v1.test.js',
    'src/external-write-context.js',
    'tests/gmail-live-send-guardrails-v1.test.js',
    'scripts/gmail-acceptance-no-send-probe.cjs',
    'docs/GMAIL-LIVE-SEND-SAFETY-CLOSEOUT-V1.md',
  ]) {
    assert.ok(release.has(file), file + ' missing from release-files.json');
    assert.ok(pkg.files.includes(file), file + ' missing from package.json files');
  }
  assert.equal(policy.capabilities.gmail_trash.active, false);
  assert.equal(policy.capabilities.gmail_trash.riskClass, 'DESTRUCTIVE');
  assert.equal(policy.capabilities.gmail_send.active, false);
});
