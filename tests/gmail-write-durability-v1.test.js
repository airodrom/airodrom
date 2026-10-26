'use strict';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { GmailOAuth, scopeForMode } = require('../src/gmail-oauth');
const { GmailWriteSessions } = require('../src/gmail-write-session');
const { GmailWriteConnector } = require('../src/gmail-write-connector');
const writeService = require('../src/gmail-write-service');
const writeIntent = require('../src/gmail-write-intent');
const fs = require('node:fs');
const path = require('node:path');

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

async function authorizedServer({ request, db = null, mode = 'manage' } = {}) {
  const conversation_id = randomUUID();
  const vault = memoryVault();
  const scope = scopeForMode(mode);
  const oauth = new GmailOAuth({
    clientId: CLIENT,
    vault,
    request: async () => jsonResponse(200, {
      access_token: 'tok', refresh_token: 'r', expires_in: 3600, scope,
    }),
  });
  const state = new URL(oauth.start(REDIRECT, { mode }).authorization_url).searchParams.get('state');
  await oauth.complete({ state, code: 'code' });
  const adapter = new GmailWriteConnector({ oauth, request });
  const sessions = new GmailWriteSessions({ db: db || new DatabaseSync(':memory:') });
  return {
    conversation_id,
    server: {
      gmailOAuth: oauth,
      gmailWriteConnector: adapter,
      gmailWriteSessions: sessions,
      gmailWriteDb: sessions.db,
    },
    sessions,
  };
}

test('100 concurrent confirmations produce at most one provider send', async () => {
  let sends = 0;
  const { conversation_id, server } = await authorizedServer({
    request: async (url, options) => {
      if (String(url).endsWith('/profile')) return jsonResponse(200, { emailAddress: 'owner@example.com' });
      if (String(url).includes('/messages/send')) {
        sends += 1;
        // Yield so concurrent claims race.
        await new Promise((r) => setImmediate(r));
        return jsonResponse(200, { id: 'sent-once', threadId: 't1', labelIds: ['SENT'] });
      }
      return jsonResponse(200, {});
    },
  });

  const preview = await writeService.run(server, {
    kind: 'gmail_write', action: 'send',
    to: 'person@example.com', subject: 'Hi', body: 'Hello',
  }, { conversation_id });

  const results = await Promise.all(Array.from({ length: 100 }, () => writeService.run(server, {
    kind: 'gmail_write', action: 'confirm', preview_id: preview.preview_id, confirmed: true,
  }, { conversation_id, confirmed: true })));

  const sent = results.filter((r) => r.action === 'sent' && !r.host_dedupe);
  const replay = results.filter((r) => r.host_dedupe === true);
  const blocked = results.filter((r) => r.kind === 'clarify');
  assert.equal(sends, 1, 'provider send count');
  assert.equal(sent.length, 1, 'exactly one fresh sent receipt');
  assert.equal(sent.length + replay.length + blocked.length, 100);
});

test('repeated confirmations do not duplicate delivery', async () => {
  let sends = 0;
  const { conversation_id, server } = await authorizedServer({
    request: async (url) => {
      if (String(url).endsWith('/profile')) return jsonResponse(200, { emailAddress: 'owner@example.com' });
      if (String(url).includes('/messages/send')) {
        sends += 1;
        return jsonResponse(200, { id: 'sent-r', threadId: 't1', labelIds: ['SENT'] });
      }
      return jsonResponse(200, {});
    },
  });
  const preview = await writeService.run(server, {
    kind: 'gmail_write', action: 'send',
    to: 'a@b.test', subject: 'S', body: 'B',
  }, { conversation_id });
  const first = await writeService.run(server, {
    kind: 'gmail_write', action: 'confirm', preview_id: preview.preview_id, confirmed: true,
  }, { conversation_id, confirmed: true });
  assert.equal(first.action, 'sent');
  const second = await writeService.run(server, {
    kind: 'gmail_write', action: 'confirm', preview_id: preview.preview_id, confirmed: true,
  }, { conversation_id, confirmed: true });
  assert.equal(second.host_dedupe, true);
  assert.equal(sends, 1);
});

test('provider timeout never triggers blind retry', async () => {
  let sends = 0;
  const { conversation_id, server } = await authorizedServer({
    request: async (url) => {
      if (String(url).endsWith('/profile')) return jsonResponse(200, { emailAddress: 'owner@example.com' });
      if (String(url).includes('/messages/send')) {
        sends += 1;
        const err = Error('fetch failed');
        err.code = 'ETIMEOUT';
        throw err;
      }
      return jsonResponse(200, {});
    },
  });
  const preview = await writeService.run(server, {
    kind: 'gmail_write', action: 'send',
    to: 'a@b.test', subject: 'S', body: 'B',
  }, { conversation_id });
  const uncertain = await writeService.run(server, {
    kind: 'gmail_write', action: 'confirm', preview_id: preview.preview_id, confirmed: true,
  }, { conversation_id, confirmed: true });
  assert.equal(uncertain.code, 'gmail_write_uncertain');
  assert.equal(uncertain.action, 'uncertain');

  const blind = await writeService.run(server, {
    kind: 'gmail_write', action: 'confirm', preview_id: preview.preview_id, confirmed: true,
  }, { conversation_id, confirmed: true });
  assert.equal(blind.code, 'gmail_write_uncertain_ack_required');
  assert.equal(sends, 1);

  // Explicit ack after operator verification may attempt once more.
  const retried = await writeService.run(server, {
    kind: 'gmail_write', action: 'confirm', preview_id: preview.preview_id, confirmed: true, ack_uncertain: true,
  }, { conversation_id, confirmed: true });
  assert.equal(retried.code, 'gmail_write_uncertain');
  assert.equal(sends, 2);
});

test('restart preserves completed receipts and does not re-send', async () => {
  const db = new DatabaseSync(':memory:');
  let sends = 0;
  const { conversation_id, server, sessions } = await authorizedServer({
    db,
    request: async (url) => {
      if (String(url).endsWith('/profile')) return jsonResponse(200, { emailAddress: 'owner@example.com' });
      if (String(url).includes('/messages/send')) {
        sends += 1;
        return jsonResponse(200, { id: 'sent-persist', threadId: 't1', labelIds: ['SENT'] });
      }
      return jsonResponse(200, {});
    },
  });
  const preview = await writeService.run(server, {
    kind: 'gmail_write', action: 'send',
    to: 'a@b.test', subject: 'S', body: 'B',
  }, { conversation_id });
  await writeService.run(server, {
    kind: 'gmail_write', action: 'confirm', preview_id: preview.preview_id, confirmed: true,
  }, { conversation_id, confirmed: true });
  assert.equal(sends, 1);

  // Simulate process restart with the same durable db.
  const revived = GmailWriteSessions.reopen(sessions.db);
  server.gmailWriteSessions = revived;
  const replay = await writeService.run(server, {
    kind: 'gmail_write', action: 'confirm', preview_id: preview.preview_id, confirmed: true,
  }, { conversation_id, confirmed: true });
  assert.equal(replay.host_dedupe, true);
  assert.equal(sends, 1);
});

test('restart during uncertain refuses blind confirm', async () => {
  const db = new DatabaseSync(':memory:');
  const { conversation_id, server, sessions } = await authorizedServer({
    db,
    request: async (url) => {
      if (String(url).endsWith('/profile')) return jsonResponse(200, { emailAddress: 'owner@example.com' });
      if (String(url).includes('/messages/send')) {
        const err = Error('network');
        err.code = 'ENOTFOUND';
        throw err;
      }
      return jsonResponse(200, {});
    },
  });
  const preview = await writeService.run(server, {
    kind: 'gmail_write', action: 'send',
    to: 'a@b.test', subject: 'S', body: 'B',
  }, { conversation_id });
  await writeService.run(server, {
    kind: 'gmail_write', action: 'confirm', preview_id: preview.preview_id, confirmed: true,
  }, { conversation_id, confirmed: true });

  server.gmailWriteSessions = GmailWriteSessions.reopen(sessions.db);
  const blind = await writeService.run(server, {
    kind: 'gmail_write', action: 'confirm', preview_id: preview.preview_id, confirmed: true,
  }, { conversation_id, confirmed: true });
  assert.equal(blind.code, 'gmail_write_uncertain_ack_required');
});

test('conversation and approval mismatches fail closed', async () => {
  const { conversation_id, server } = await authorizedServer({
    request: async (url) => {
      if (String(url).endsWith('/profile')) return jsonResponse(200, { emailAddress: 'owner@example.com' });
      return jsonResponse(200, { id: 'x', labelIds: ['TRASH'] });
    },
  });
  const other = randomUUID();
  const preview = await writeService.run(server, {
    kind: 'gmail_write', action: 'send',
    to: 'a@b.test', subject: 'S', body: 'B',
  }, { conversation_id });
  const mismatch = await writeService.run(server, {
    kind: 'gmail_write', action: 'confirm', preview_id: preview.preview_id, confirmed: true,
  }, { conversation_id: other, confirmed: true });
  assert.equal(mismatch.code, 'gmail_write_preview_forbidden');

  // Stage trash requiring approval; confirm without approve.
  server.gmailSearchSessions = new (require('../src/gmail-search-session').GmailSearchSessions)();
  server.gmailSearchSessions.rememberResults({
    items: [{ id: 'm9', subject: 'Synth', from: 'a@b.test' }],
    conversation_id,
    operator: 'operator',
  });
  const trash = await writeService.run(server, {
    kind: 'gmail_write', action: 'trash', destructive: true,
  }, { conversation_id });
  const noApprove = await writeService.run(server, {
    kind: 'gmail_write', action: 'confirm', preview_id: trash.preview_id, confirmed: true, destructive: true,
  }, { conversation_id, confirmed: true, destructive: true });
  assert.equal(noApprove.code, 'gmail_write_approval_required');
});

test('account mismatch fails closed', async () => {
  const db = new DatabaseSync(':memory:');
  const sessions = new GmailWriteSessions({ db });
  const conversation_id = randomUUID();
  const staged = sessions.stageWrite({
    op: 'send', to: ['a@b.test'], cc: [], bcc: [], subject: 'S', body: 'B',
  }, {
    conversation_id,
    operator: 'operator',
    account_email: 'bound@example.com',
    oauth_mode: 'send',
    oauth_scope: scopeForMode('send'),
  });
  assert.throws(() => sessions.claimWrite(staged.preview_id, {
    conversation_id,
    operator: 'operator',
    account_email: 'other@example.com',
    oauth_mode: 'send',
    oauth_scope: scopeForMode('send'),
  }), (err) => err.code === 'gmail_write_account_mismatch');
});

test('confirm intent parses --ack-uncertain', () => {
  const id = randomUUID();
  const parsed = writeIntent.parse(`/gmail confirm ${id} --ack-uncertain`);
  assert.equal(parsed.action, 'confirm');
  assert.equal(parsed.ack_uncertain, true);
  assert.equal(parsed.destructive, false);
});

test('draft-only local compose never claims gmail persistence', () => {
  const intent = require('../src/assistant-intent');
  const parsed = intent.parse('Draft an email to a client and include my company address.');
  assert.equal(parsed.kind, 'email_compose');
  assert.notEqual(parsed.kind, 'gmail_write');
});

test('required release files are packaged including durability suite', () => {
  const root = path.join(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const release = new Set(JSON.parse(fs.readFileSync(path.join(root, 'release-files.json'), 'utf8')));
  for (const file of [
    'src/gmail-write-session.js',
    'src/gmail-write-service.js',
    'tests/gmail-write-stage-a.test.js',
    'tests/gmail-write-durability-v1.test.js',
    'tests/gmail-oauth-token-exchange.test.js',
    'tests/email-compose-memory-v1.test.js',
  ]) {
    assert.ok(release.has(file), file + ' missing from release-files.json');
  }
  for (const file of [
    'src/gmail-write-session.js',
    'src/gmail-write-service.js',
    'tests/gmail-write-stage-a.test.js',
    'tests/gmail-write-durability-v1.test.js',
  ]) {
    assert.ok(pkg.files.includes(file), file + ' missing from package.json files');
  }
});
