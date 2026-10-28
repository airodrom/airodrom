'use strict';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const intent = require('../src/assistant-intent');
const writeIntent = require('../src/gmail-write-intent');
const searchIntent = require('../src/gmail-search-intent');
const { AssistantConnectors } = require('../src/assistant-connectors');
const assistantService = require('../src/assistant-service');

const MSG_ID = '1a183ddc75c69e5f';
const ADDR = 'hello@arecibo.ca';

test('verify existing message id routes to connector read, not compose or conversation', () => {
  const message = `Verify Gmail message ${MSG_ID} from/to ${ADDR} using read-only provider operations.`;
  const routed = intent.parse(message);
  assert.equal(routed.kind, 'connector');
  assert.equal(routed.action, 'read');
  assert.equal(routed.id, MSG_ID);
  assert.equal(routed.expected_from, ADDR);
  assert.equal(routed.expected_to, ADDR);
  assert.equal(writeIntent.parse(message), null);
  assert.equal(writeIntent.isSendPreviewRequest(require('../src/assistant-intent-text').normalize(message)), null);
});

test('verify + Do not send does not become Recipient noted compose', () => {
  const message = `Verify Gmail message ${MSG_ID} from/to ${ADDR} using read-only provider operations. Do not send.`;
  const routed = intent.parse(message);
  assert.equal(routed.kind, 'connector');
  assert.equal(routed.action, 'read');
  assert.equal(routed.id, MSG_ID);
  assert.notEqual(routed.kind, 'gmail_write');
  assert.doesNotMatch(routed.message || '', /Recipient noted/i);
});

test('read/check Gmail message id does not collapse to sender search', () => {
  for (const message of [
    `Read Gmail message ${MSG_ID} from/to ${ADDR}`,
    `Check Gmail message ${MSG_ID} to ${ADDR}`,
    `Get Gmail message ${MSG_ID}`,
  ]) {
    const routed = intent.parse(message);
    assert.equal(routed.action, 'read', message);
    assert.equal(routed.id, MSG_ID, message);
    assert.notEqual(routed.action, 'search', message);
  }
});

test('normal send preview and incomplete send still use GMAIL_WRITE', () => {
  const preview = intent.parse('Send a test email to myself and show me the preview');
  assert.equal(preview.route, 'GMAIL_WRITE');
  assert.equal(preview.action, 'send');
  const incomplete = intent.parse(`Send email to ${ADDR}`);
  assert.equal(incomplete.kind, 'gmail_write');
  assert.equal(incomplete.clarify, true);
  assert.match(incomplete.message, /Recipient noted/i);
});

test('chat yes is not a gmail confirm send', () => {
  const routed = intent.parse('yes, send it');
  assert.notEqual(routed.kind, 'gmail_write');
  assert.notEqual(routed.action, 'confirm');
});

test('explicit /gmail confirm still parses as write confirm', () => {
  const id = '56075465-09a2-457e-9e80-a466a65a0dfb';
  const routed = intent.parse(`/gmail confirm ${id}`);
  assert.equal(routed.kind, 'gmail_write');
  assert.equal(routed.action, 'confirm');
  assert.equal(routed.preview_id, id);
  assert.equal(routed.confirmed, true);
});

test('connector read returns labels and attachment sha; no send POST', async () => {
  const body = Buffer.from('Airodrom live retry attachment.\n', 'utf8');
  const sha = createHash('sha256').update(body).digest('hex');
  const posts = [];
  const gets = [];
  const adapter = new AssistantConnectors({
    gmail: { reference: 'opaque', scope: 'https://www.googleapis.com/auth/gmail.readonly' },
    secrets: { resolve: async () => 'synthetic-mail-token' },
    connected: () => true,
    request: async (url, opts = {}) => {
      const method = (opts.method || 'GET').toUpperCase();
      if (method !== 'GET') posts.push({ url: String(url), method });
      else gets.push(String(url));
      assert.equal(method, 'GET');
      assert.match(String(url), new RegExp(`/messages/${MSG_ID}`));
      const payload = {
        id: MSG_ID,
        threadId: 'thread1',
        labelIds: ['SENT', 'INBOX'],
        snippet: 'snippet',
        payload: {
          headers: [
            { name: 'From', value: `Operator <${ADDR}>` },
            { name: 'To', value: ADDR },
            { name: 'Subject', value: 'Airodrom Drive attach live retry' },
            { name: 'Date', value: 'Wed, 28 Oct 2026 12:00:00 -0700' },
          ],
          mimeType: 'multipart/mixed',
          parts: [
            { mimeType: 'text/plain', body: { data: Buffer.from('body text', 'utf8').toString('base64url') } },
            {
              filename: 'airodrom-retry-20261028185242.txt',
              mimeType: 'text/plain',
              body: { data: body.toString('base64url') },
            },
          ],
        },
      };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(payload),
        body: { cancel: async () => {} },
      };
    },
  });
  const data = await adapter.read('gmail', 'read', {
    id: MSG_ID,
    verify: true,
    want_attachment: true,
    limit: 1,
  });
  assert.equal(posts.length, 0);
  assert.equal(data.items.length, 1);
  const item = data.items[0];
  assert.equal(item.id, MSG_ID);
  assert.equal(item.label_sent, true);
  assert.equal(item.label_inbox, true);
  assert.equal(item.attachments[0].sha256, sha);
  assert.equal(item.attachments[0].size, body.length);
});

test('connector read fetches attachmentId parts and hashes bytes (GET only)', async () => {
  const body = Buffer.from('Airodrom live retry 20261028185242.\nGoogle Drive multiline UTF-8 readback.\nGmail attachment preview verification.', 'utf8');
  const sha = createHash('sha256').update(body).digest('hex');
  const posts = [];
  const gets = [];
  const adapter = new AssistantConnectors({
    gmail: { reference: 'opaque', scope: 'https://www.googleapis.com/auth/gmail.readonly' },
    secrets: { resolve: async () => 'synthetic-mail-token' },
    connected: () => true,
    request: async (url, opts = {}) => {
      const method = (opts.method || 'GET').toUpperCase();
      const href = String(url);
      if (method !== 'GET') posts.push({ url: href, method });
      else gets.push(href);
      assert.equal(method, 'GET');
      if (/\/attachments\//.test(href)) {
        assert.match(href, new RegExp(`/messages/${MSG_ID}/attachments/att_remote_1`));
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ size: body.length, data: body.toString('base64url') }),
          body: { cancel: async () => {} },
        };
      }
      assert.match(href, new RegExp(`/messages/${MSG_ID}`));
      const payload = {
        id: MSG_ID,
        threadId: 'thread1',
        labelIds: ['SENT', 'INBOX'],
        snippet: 'snippet',
        payload: {
          headers: [
            { name: 'From', value: `Operator <${ADDR}>` },
            { name: 'To', value: ADDR },
            { name: 'Subject', value: 'Airodrom Drive attach live retry' },
          ],
          mimeType: 'multipart/mixed',
          parts: [
            { mimeType: 'text/plain', body: { data: Buffer.from('Live retry body', 'utf8').toString('base64url') } },
            {
              filename: 'airodrom-retry-20261028185242.txt',
              mimeType: 'text/plain',
              body: { attachmentId: 'att_remote_1', size: body.length },
            },
          ],
        },
      };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(payload),
        body: { cancel: async () => {} },
      };
    },
  });
  const data = await adapter.read('gmail', 'read', {
    id: MSG_ID,
    verify: true,
    want_attachment: true,
    limit: 1,
  });
  assert.equal(posts.length, 0);
  assert.equal(gets.filter((u) => /\/attachments\//.test(u)).length, 1);
  const item = data.items[0];
  assert.equal(item.attachments.length, 1);
  assert.equal(item.attachments[0].filename, 'airodrom-retry-20261028185242.txt');
  assert.equal(item.attachments[0].size, body.length);
  assert.equal(item.attachments[0].sha256, sha);
  assert.equal(sha, '0c5de90d237e3abcd652d7d8100fb1d16a84dcd3e6f54e91a5a20789771de6f5');
});

test('unauthorized gmail read offers connect without inventing message', async () => {
  const bridge = {
    options: { assistantConnectors: {} },
    assistantConnectors: new AssistantConnectors({}),
  };
  const server = { bridge, gmailOAuth: null };
  const result = await assistantService.connectorInput(server, {
    connector: 'gmail',
    action: 'read',
    input: { id: MSG_ID },
    host_verified: true,
  });
  assert.equal(result.kind, 'connect_required');
  assert.equal(result.authorized, false);
});

test('parseReadById exported for early assistant routing', () => {
  const parsed = searchIntent.parseReadById(
    `Inspect Sent for Gmail message ${MSG_ID} with attachment sha256`
  );
  assert.equal(parsed?.action, 'read');
  assert.equal(parsed?.id, MSG_ID);
  assert.equal(parsed?.want_attachment, true);
});
