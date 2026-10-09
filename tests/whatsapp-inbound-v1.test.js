'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const Bridge = require('./fixtures/test-bridge.cjs');
const ControlServer = require('../src/control-server');

const VERIFY = 'synthetic-verify-token';
const SECRET = 'synthetic-app-secret';

function payload(messages = [], statuses = []) {
  return Buffer.from(JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { messages, statuses } }] }]
  }));
}

function sign(raw, secret = SECRET) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
}

async function fixture(t, { enabled = true, allowlist = ['15551234567'] } = {}) {
  const root = fs.mkdtempSync('/private/tmp/wa-inbound-');
  const profile = path.join(root, 'source');
  fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, 'settings.json'), '{}');
  const bridge = await new Bridge({
    defaultRuntime: 'host',
    dataDir: path.join(root, 'data'),
    sourceProfile: profile,
    allowFixtureWorker: true,
    executable: path.join(__dirname, 'fixtures/host-worker.cjs'),
    whatsappInbound: { verifyToken: VERIFY, appSecret: SECRET }
  }).initialize();
  if (enabled) {
    bridge.whatsappInbound.configure({
      enabled: true,
      confirmed: true,
      allowlist,
      verify_token: VERIFY,
      app_secret: SECRET
    }, 'operator');
  }
  const ui = new ControlServer(bridge, {
    port: 0,
    connectionStatus: async () => ({ state: 'not_connected', connected: false, tunnelHealthy: false, mcpProbe: 'unknown' })
  });
  await ui.start();
  t.after(async () => {
    await ui.close();
    await bridge.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const request = (route, { method = 'GET', body, headers = {}, authorized = true, raw = false } = {}) => new Promise((resolve, reject) => {
    const payloadBody = raw ? body : (body === undefined ? undefined : Buffer.from(JSON.stringify(body)));
    const req = http.request(ui.origin + route, {
      method,
      headers: {
        ...(authorized ? { authorization: `Bearer ${ui.token}` } : {}),
        ...(payloadBody ? { 'content-type': raw ? 'application/json' : 'application/json', 'content-length': Buffer.byteLength(payloadBody) } : {}),
        ...headers
      }
    }, res => {
      const chunks = [];
      res.on('data', p => chunks.push(p));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = text;
        try { parsed = text ? JSON.parse(text) : null; } catch { /* plain */ }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, text });
      });
    });
    req.on('error', reject);
    if (payloadBody) req.write(payloadBody);
    req.end();
  });
  return { bridge, ui, request };
}

test('valid verification challenge returns hub.challenge', async t => {
  const { request } = await fixture(t);
  const r = await request(`/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=12345`, { authorized: false });
  assert.equal(r.status, 200);
  assert.equal(r.text, '12345');
});

test('invalid verification token is refused', async t => {
  const { request } = await fixture(t);
  const r = await request(`/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345`, { authorized: false });
  assert.equal(r.status, 400);
  assert.match(String(r.body?.error || ''), /verification token/i);
});

test('valid HMAC signature accepts text into durable inbox without Mission dispatch', async t => {
  const { bridge, request } = await fixture(t);
  const before = bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_missions').get().n;
  const raw = payload([{ id: 'wamid.valid1', type: 'text', from: '15551234567', text: { body: 'Hello Airodrom fixture' } }]);
  const r = await request('/webhooks/whatsapp', {
    method: 'POST',
    authorized: false,
    raw: true,
    body: raw,
    headers: { 'x-hub-signature-256': sign(raw) }
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.accepted, 1);
  assert.equal(r.body.auto_mission_execution, false);
  assert.equal(r.body.authority, false);
  assert.deepEqual(r.body.items[0].lifecycle, { received: true, verified: true, stored: true, available: true });
  const inbox = bridge.whatsappInbound.list();
  assert.equal(inbox.items.length, 1);
  assert.equal(inbox.items[0].status, 'received');
  assert.equal(inbox.items[0].authority, false);
  assert.equal(inbox.items[0].lifecycle.available, true);
  assert.match(inbox.items[0].content, /Hello Airodrom fixture/);
  assert.equal(bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_missions').get().n, before);
  const events = bridge.controlStore.db.prepare("SELECT event_type FROM event_ledger_events WHERE event_type LIKE 'whatsapp.inbound.%'").all().map(e => e.event_type);
  for (const need of ['whatsapp.inbound.received', 'whatsapp.inbound.verified', 'whatsapp.inbound.stored', 'whatsapp.inbound.available']) {
    assert.ok(events.includes(need), need);
  }
  assert.ok(!events.some(e => /mission|dispatch/.test(e)));
});

test('invalid HMAC signature is refused', async t => {
  const { bridge, request } = await fixture(t);
  const raw = payload([{ id: 'wamid.bad', type: 'text', from: '15551234567', text: { body: 'should fail' } }]);
  const r = await request('/webhooks/whatsapp', {
    method: 'POST',
    authorized: false,
    raw: true,
    body: raw,
    headers: { 'x-hub-signature-256': 'sha256=deadbeef' }
  });
  assert.equal(r.status, 400);
  assert.equal(bridge.whatsappInbound.list().items.length, 0);
  const events = bridge.controlStore.db.prepare("SELECT event_type FROM event_ledger_events WHERE event_type LIKE 'whatsapp.inbound.%'").all().map(e => e.event_type);
  assert.ok(events.includes('whatsapp.inbound.received'));
  assert.ok(events.includes('whatsapp.inbound.rejected'));
  assert.ok(!events.includes('whatsapp.inbound.available'));
});

test('duplicate message id is rejected and not reinserted', async t => {
  const { bridge, request } = await fixture(t);
  const raw = payload([{ id: 'wamid.dup', type: 'text', from: '15551234567', text: { body: 'once' } }]);
  const headers = { 'x-hub-signature-256': sign(raw) };
  const first = await request('/webhooks/whatsapp', { method: 'POST', authorized: false, raw: true, body: raw, headers });
  const second = await request('/webhooks/whatsapp', { method: 'POST', authorized: false, raw: true, body: raw, headers });
  assert.equal(first.body.accepted, 1);
  assert.equal(second.body.accepted, 0);
  assert.equal(second.body.rejections[0].reason, 'duplicate');
  assert.equal(bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_whatsapp_inbox').get().n, 1);
});

test('unauthorized sender is retained as unauthorized_sender', async t => {
  const { bridge, request } = await fixture(t, { allowlist: ['15550001111'] });
  const raw = payload([{ id: 'wamid.unauth', type: 'text', from: '15559999999', text: { body: 'blocked' } }]);
  const r = await request('/webhooks/whatsapp', {
    method: 'POST',
    authorized: false,
    raw: true,
    body: raw,
    headers: { 'x-hub-signature-256': sign(raw) }
  });
  assert.equal(r.body.accepted, 0);
  assert.equal(r.body.rejections[0].reason, 'unauthorized_sender');
  const row = bridge.controlStore.db.prepare('SELECT status FROM cp_whatsapp_inbox WHERE message_id=?').get('wamid.unauth');
  assert.equal(row.status, 'unauthorized_sender');
});

test('message statuses are observed durably', async t => {
  const { bridge, request } = await fixture(t);
  const raw = payload([], [{ id: 'wamid.status1', status: 'delivered' }]);
  const r = await request('/webhooks/whatsapp', {
    method: 'POST',
    authorized: false,
    raw: true,
    body: raw,
    headers: { 'x-hub-signature-256': sign(raw) }
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.statuses, 1);
  const statuses = bridge.whatsappInbound.statuses({ message_id: 'wamid.status1' });
  assert.equal(statuses.items[0].status, 'delivered');
});

test('operator APIs expose status and inbox; webhook stays loopback', async t => {
  const { bridge, request, ui } = await fixture(t);
  const raw = payload([{ id: 'wamid.api', type: 'text', from: '15551234567', text: { body: 'inbox api' } }]);
  await request('/webhooks/whatsapp', { method: 'POST', authorized: false, raw: true, body: raw, headers: { 'x-hub-signature-256': sign(raw) } });
  const status = await request('/api/assistant/whatsapp/inbound');
  assert.equal(status.status, 200);
  assert.equal(status.body.auto_mission_execution, false);
  assert.equal(status.body.public_ingress, false);
  assert.ok(status.body.retained >= 1);
  assert.equal(status.body.meta.meta_app_id, '1625559252697626');
  assert.equal(status.body.meta.business_portfolio_id, '1791528208560099');
  assert.equal(status.body.meta.webhook_subscription_status, 'inactive');
  assert.equal(status.body.callback.public_ingress, false);
  assert.equal(status.body.callback.activation, 'inactive_until_owner_authorization');
  assert.equal(status.body.callback.path, '/webhooks/whatsapp');
  assert.equal(status.body.callback.tls_required, true);
  const inbox = await request('/api/assistant/whatsapp/inbox');
  assert.equal(inbox.status, 200);
  assert.equal(inbox.body.items[0].id, 'wamid.api');
  assert.equal(ui.server.address().address, '127.0.0.1');
  assert.equal((await request('/api/assistant/whatsapp/inbound', { authorized: false })).status, 401);
  assert.equal(bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_missions').get().n, 0);
});

test('public ingress cannot be enabled through configure; Meta IDs are non-secret', async t => {
  const { bridge } = await fixture(t);
  assert.throws(() => bridge.whatsappInbound.configure({
    enabled: true,
    confirmed: true,
    public_ingress: true
  }, 'operator'), /separate owner authorization/i);
  const status = bridge.whatsappInbound.configure({
    enabled: true,
    confirmed: true,
    waba_id: '123456789012345',
    phone_number_id: '987654321098765',
    app_publication_status: 'development'
  }, 'operator');
  assert.equal(status.meta.waba_id, '123456789012345');
  assert.equal(status.meta.phone_number_id, '987654321098765');
  assert.equal(status.meta.app_publication_status, 'development');
  assert.equal(status.public_ingress, false);
  assert.equal(status.callback.public_url, null);
});
