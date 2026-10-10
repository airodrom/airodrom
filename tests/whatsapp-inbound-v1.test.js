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
  // Inbound fixture suite isolates webhook/inbox behavior; conversation AI is covered separately.
  if (bridge.whatsappConversations?.config) bridge.whatsappConversations.config.conversations_enabled = false;
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

test('live connection readiness, discovery record, HTTPS prepare, vault refs without secrets', async t => {
  const { bridge, request } = await fixture(t);
  const discovery = bridge.whatsappInbound.recordDiscovery({
    confirmed: true,
    app_name: 'Airodrom',
    graph_access: 'refused',
    permission_prerequisite: 'OAuthException 104: authorized Graph credential required for portfolio and WABA reads.',
    business_verification: 'Not observed without Business Manager access',
    notes: 'Public Graph returned app id/name only. Portfolio, WABA, phone, and subscriptions require authorized Graph credential.'
  }, 'operator');
  assert.equal(discovery.meta.discovery.app_name, 'Airodrom');
  assert.equal(discovery.meta.discovery.graph_access, 'refused');
  assert.equal(discovery.waba_id, null);
  assert.equal(discovery.phone_number_id, null);
  assert.equal(discovery.real_message_test.authorized, false);
  assert.equal(discovery.real_message_test.executed, false);
  assert.equal(discovery.credentials.plaintext_in_git, false);
  assert.equal(discovery.callback.mcp_tunnel_suitable, false);
  assert.equal(discovery.callback.exposes_control_plane, false);

  assert.throws(() => bridge.whatsappInbound.preparePublicCallback({
    confirmed: true,
    url: 'http://example.test/webhooks/whatsapp'
  }, 'operator'), /HTTPS/i);
  assert.throws(() => bridge.whatsappInbound.preparePublicCallback({
    confirmed: true,
    url: 'https://example.test/api/assistant/whatsapp'
  }, 'operator'), /exactly \/webhooks\/whatsapp|control plane/i);
  const prepared = bridge.whatsappInbound.preparePublicCallback({
    confirmed: true,
    url: 'https://hooks.example.test/webhooks/whatsapp'
  }, 'operator');
  assert.equal(prepared.prepared_callback_url, 'https://hooks.example.test/webhooks/whatsapp');
  assert.equal(prepared.public_ingress, false);
  assert.equal(prepared.public_url, null);

  const bound = bridge.whatsappInbound.configure({
    enabled: true,
    confirmed: true,
    verify_token_reference: '11111111-2222-4333-a444-555555555555',
    app_secret_reference: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    access_token_reference: 'ffffffff-0000-4111-8222-333333333333'
  }, 'operator');
  assert.equal(bound.credentials.verify_token_present, true);
  assert.equal(bound.credentials.app_secret_present, true);
  assert.equal(bound.credentials.access_token_present, true);
  assert.equal(bound.credentials.verify_token_bound, true);
  assert.equal(bound.live_connection.binding.verify_token_bound, true);
  assert.equal(bound.live_connection.subscription.execute_external_changes, false);
  assert.ok(bound.live_connection.subscription.blockers.includes('public_ingress_inactive'));

  const api = await request('/api/assistant/whatsapp/live-connection');
  assert.equal(api.status, 200);
  assert.equal(api.body.public_ingress, false);
  assert.equal(api.body.auto_mission_execution, false);
  assert.equal(api.body.binding.verify_token_bound, true);
  assert.equal(api.body.binding.app_secret_bound, true);
  assert.equal(api.body.binding.access_token_bound, true);
  assert.equal(api.body.credentials, '[omitted]');
  assert.doesNotMatch(JSON.stringify(api.body), /synthetic-app-secret|synthetic-verify-token/);
});

test('vault binding status and webhook-only ingress plan stay inactive', async t => {
  const { bridge, request } = await fixture(t);
  const vault = bridge.whatsappInbound.vaultBindingStatus();
  assert.equal(vault.purpose, 'whatsapp');
  assert.equal(vault.required_slots, 3);
  assert.equal(vault.values_displayed, false);
  assert.equal(vault.vault_whatsapp_active, 0);
  const plan = bridge.whatsappInbound.ingressRoutingPlan();
  assert.equal(plan.public_ingress, false);
  assert.equal(plan.activated, false);
  assert.equal(plan.mcp_tunnel_suitable, false);
  assert.deepEqual(plan.allow_only, ['/webhooks/whatsapp']);
  assert.ok(plan.example_cloudflared_ingress.some(line => line.includes('/webhooks/whatsapp')));
  const live = await request('/api/assistant/whatsapp/live-connection');
  assert.equal(live.status, 200);
  assert.equal(live.body.vault.required_slots, 3);
  assert.equal(live.body.ingress.public_ingress, false);
});

test('Graph discovery without token records unavailable; with mock token binds WABA and phone IDs', async t => {
  const { bridge, request } = await fixture(t);
  const unavailable = await bridge.whatsappInbound.discoverGraphAccounts({ confirmed: true }, 'operator');
  assert.equal(unavailable.meta.discovery.graph_access, 'unavailable');
  assert.equal(unavailable.waba_id, null);
  assert.equal(unavailable.phone_number_id, null);

  const calls = [];
  bridge.whatsappInbound.options.accessToken = 'synthetic-graph-token';
  bridge.whatsappInbound.options.graphFetch = async (url) => {
    const href = String(url);
    const decoded = decodeURIComponent(href);
    calls.push(href.replace(/access_token=[^&]+/, 'access_token=[redacted]'));
    if (decoded.includes('1625559252697626') && decoded.includes('fields=id,name')) {
      return { ok: true, json: async () => ({ id: '1625559252697626', name: 'Airodrom' }) };
    }
    if (href.includes('owned_whatsapp_business_accounts')) {
      return { ok: true, json: async () => ({ data: [{ id: '111222333444555', name: 'Fixture WABA' }] }) };
    }
    // readWabaAndPhones verifies WABA id/name before phone_numbers (fields may be percent-encoded).
    if (decoded.includes('/111222333444555') && decoded.includes('fields=id,name') && !decoded.includes('phone_numbers')) {
      return { ok: true, json: async () => ({ id: '111222333444555', name: 'Fixture WABA' }) };
    }
    if (href.includes('/phone_numbers')) {
      return { ok: true, json: async () => ({ data: [{ id: '999888777666555', display_phone_number: '+1 555-0100', verified_name: 'Fixture' }] }) };
    }
    return { ok: false, status: 404, json: async () => ({ error: { message: 'missing', type: 'GraphMethodException', code: 100 } }) };
  };
  const found = await bridge.whatsappInbound.discoverGraphAccounts({ confirmed: true }, 'operator');
  assert.equal(found.meta.discovery.graph_access, 'authorized');
  assert.equal(found.waba_id, '111222333444555');
  assert.equal(found.phone_number_id, '999888777666555');
  assert.ok(calls.every(c => !c.includes('synthetic-graph-token')));
  assert.doesNotMatch(JSON.stringify(found), /synthetic-graph-token|\+1 555/);

  const api = await request('/api/assistant/whatsapp/inbound/discover-graph', { method: 'POST', body: { confirmed: true } });
  assert.equal(api.status, 200);
  assert.equal(api.body.public_ingress, false);
});

test('webhook ingress prep script writes webhook-only cloudflared plan without activating', async t => {
  const root = fs.mkdtempSync('/private/tmp/wa-ingress-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prep = require('../scripts/whatsapp-webhook-ingress-prep.cjs');
  assert.equal(prep.main(['--hostname', 'hooks.example.test', '--port', '43117', '--write', root]), 0);
  const yaml = fs.readFileSync(path.join(root, 'whatsapp-webhook-only.cloudflared.yml'), 'utf8');
  assert.match(yaml, /path: \/webhooks\/whatsapp/);
  assert.match(yaml, /http:\/\/127\.0\.0\.1:43117/);
  assert.match(yaml, /http_status:404/);
  assert.doesNotMatch(yaml, /\/api\/|mcp-tunnel/);
  const plan = JSON.parse(fs.readFileSync(path.join(root, 'whatsapp-webhook-ingress-plan.json'), 'utf8'));
  assert.equal(plan.public_ingress, false);
  assert.equal(plan.activated, false);
  assert.equal(plan.exposes_control_plane, false);
});

test('credential bind validates Vault references without exposing values and keeps ingress off', async t => {
  const { bridge, request } = await fixture(t, { enabled: false });
  const values = new Map();
  const vault = new (require('../src/secret-vault').SecretVault)(bridge.dataDir, (op, id, value) => {
    if (op === 'put') values.set(id, value);
    if (op === 'read') return values.get(id);
    if (op === 'delete') values.delete(id);
    return '';
  });
  bridge.whatsappInbound.options.vault = vault;
  const verify = vault.put('synthetic-verify-token-bind', 'whatsapp');
  const secret = vault.put('synthetic-app-secret-bind', 'whatsapp');
  const access = vault.put('synthetic-graph-token-bind', 'whatsapp');
  assert.equal(values.size, 3);

  assert.throws(() => bridge.whatsappInbound.bindCredentialReferences({
    confirmed: true,
    verify_token_reference: verify.reference,
    app_secret_reference: secret.reference,
    access_token_reference: access.reference,
    verify_token: 'plaintext-refused'
  }, 'operator'), /Plaintext|Vault references/i);

  const bound = bridge.whatsappInbound.bindCredentialReferences({
    confirmed: true,
    verify_token_reference: verify.reference,
    app_secret_reference: secret.reference,
    access_token_reference: access.reference
  }, 'operator');
  assert.equal(bound.credentials.references_validated, true);
  assert.equal(bound.public_ingress, false);
  assert.equal(bound.auto_mission_execution, false);
  assert.doesNotMatch(JSON.stringify(bound), /synthetic-verify-token-bind|synthetic-app-secret-bind|synthetic-graph-token-bind/);

  const validation = bridge.whatsappInbound.validateCredentialReferences('operator');
  assert.equal(validation.ok, true);
  assert.equal(validation.verify_token_bound, true);
  assert.equal(validation.app_secret_bound, true);
  assert.equal(validation.access_token_bound, true);
  assert.equal(validation.verify_token_resolvable, true);
  assert.equal(validation.ready_for_live_hmac, true);
  assert.equal(validation.ready_for_graph_discovery, true);
  assert.equal(validation.values_displayed, false);

  const api = await request('/api/assistant/whatsapp/inbound/validate-credentials', { method: 'POST', body: { confirmed: true } });
  assert.equal(api.status, 200);
  assert.equal(api.body.ok, true);
  assert.equal(api.body.verify_token_bound, true);
  assert.equal(api.body.app_secret_bound, true);
  assert.equal(api.body.access_token_bound, true);
  assert.doesNotMatch(JSON.stringify(api.body), /synthetic-verify-token-bind|synthetic-app-secret-bind|synthetic-graph-token-bind/);

  const live = await request('/api/assistant/whatsapp/live-connection');
  assert.equal(live.status, 200);
  assert.equal(live.body.binding.verify_token_bound, true);
  assert.equal(live.body.binding.app_secret_bound, true);
  assert.equal(live.body.binding.access_token_bound, true);
  assert.equal(live.body.vault.configure_slots_bound, 3);
  // Parent key `credentials` remains omitted by safeValue; binding flags must survive.
  assert.equal(live.body.credentials, '[omitted]');

  const bindApi = await request('/api/assistant/whatsapp/inbound/bind-credentials', {
    method: 'POST',
    body: {
      confirmed: true,
      verify_token_reference: verify.reference,
      app_secret_reference: secret.reference,
      access_token_reference: access.reference
    }
  });
  assert.equal(bindApi.status, 200);
  assert.equal(bindApi.body.public_ingress, false);
});

test('onboarding helpers store labeled slots and summarize without secret leakage', async t => {
  const root = fs.mkdtempSync('/private/tmp/wa-onboard-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'data'), { mode: 0o700 });
  const values = new Map();
  const vault = new (require('../src/secret-vault').SecretVault)(path.join(root, 'data'), (op, id, value) => {
    if (op === 'put') values.set(id, value);
    if (op === 'read') return values.get(id);
    return '';
  });
  const onboard = require('../src/whatsapp-credential-onboarding');
  const a = onboard.storeSlot(vault, 'slot-verify');
  const b = onboard.storeSlot(vault, 'slot-secret');
  const c = onboard.storeSlot(vault, 'slot-access');
  assert.equal(values.get(a.reference), 'slot-verify');
  assert.equal(values.get(b.reference), 'slot-secret');
  assert.equal(values.get(c.reference), 'slot-access');
  const summary = onboard.summarizeBinding({
    binding: {
      verify_token_bound: true,
      app_secret_bound: true,
      access_token_bound: true
    },
    credentials: {
      verify_token_bound: true,
      app_secret_bound: true,
      access_token_bound: true,
      references_validated: true
    },
    live_connection: {
      waba_id: '111222333444555',
      phone_number_id: '999888777666555',
      meta: { discovery: { graph_access: 'authorized' } },
      callback: { prepared_callback_url: 'https://hooks.example.test/webhooks/whatsapp' }
    }
  });
  assert.equal(summary.vault_slots.verify_token, true);
  assert.equal(summary.vault_slots.app_secret, true);
  assert.equal(summary.vault_slots.access_token, true);
  assert.equal(summary.waba_id, '111222333444555');
  assert.equal(summary.phone_number_id, '999888777666555');
  assert.equal(summary.public_ingress, false);
  assert.equal(summary.values_displayed, false);
  // Status projection must recover when API redacts credentials to "[omitted]".
  const recovered = onboard.summarizeBinding({
    credentials: '[omitted]',
    vault: {
      configure_slots_bound: 3,
      ready_for_live_hmac: true,
      ready_for_graph_discovery: true
    },
    live_connection: {
      waba_id: '29094507813569086',
      meta: { discovery: { graph_access: 'authorized' } },
      vault: {
        configure_slots_bound: 3,
        ready_for_live_hmac: true,
        ready_for_graph_discovery: true
      }
    }
  });
  assert.equal(recovered.vault_slots.verify_token, true);
  assert.equal(recovered.vault_slots.app_secret, true);
  assert.equal(recovered.vault_slots.access_token, true);
  assert.equal(recovered.graph_access, 'authorized');
  const { safeValue } = require('../src/secret-observation');
  const projected = safeValue({
    binding: { verify_token_bound: true, app_secret_bound: true, access_token_bound: true, values_displayed: false },
    credentials: { verify_token_bound: true, app_secret_bound: true, access_token_bound: true },
    vault: { configure_slots_bound: 3, ready_for_live_hmac: true, ready_for_graph_discovery: true, storage_slots_available: true }
  });
  assert.equal(projected.credentials, '[omitted]');
  assert.equal(projected.binding.verify_token_bound, true);
  assert.equal(projected.binding.app_secret_bound, true);
  assert.equal(projected.binding.access_token_bound, true);
  assert.equal(projected.vault.storage_slots_available, true);
  let text = '';
  onboard.writeSummary({ write: v => { text += String(v); } }, summary);
  assert.match(text, /Active WABA ID: 111222333444555/);
  assert.doesNotMatch(text, /slot-verify|slot-secret|slot-access/);
});

test('meta test environment preserves production WABA and accepts test-WABA webhook payloads', async t => {
  const { bridge, request } = await fixture(t, { allowlist: ['15556519146'] });
  bridge.whatsappInbound.configure({
    enabled: true,
    confirmed: true,
    environment: 'production',
    waba_id: '29094507813569086',
    allowlist: ['15556519146']
  }, 'operator');
  const live = bridge.whatsappInbound.configureMetaEnvironment({
    confirmed: true,
    environment: 'test',
    waba_id: '28756456347344989',
    phone_number_id: '1330971766772548',
    allowlist_sender: '15556519146',
    select_active: true
  }, 'operator');
  assert.equal(live.production_waba_id, '29094507813569086');
  assert.equal(live.test_waba_id, '28756456347344989');
  assert.equal(live.test_phone_number_id, '1330971766772548');
  assert.equal(live.active_environment, 'test');
  assert.equal(live.waba_id, '28756456347344989');
  assert.equal(live.phone_number_id, '1330971766772548');
  assert.equal(live.production_waba_id === live.test_waba_id, false);
  assert.equal(live.public_ingress, false);
  assert.equal(live.auto_mission_execution, false);

  const raw = Buffer.from(JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{
      id: '28756456347344989',
      changes: [{
        value: {
          messaging_product: 'whatsapp',
          metadata: { phone_number_id: '1330971766772548' },
          messages: [{ id: 'wamid.test-env-1', type: 'text', from: '15556519146', text: { body: 'Meta test webhook' } }]
        }
      }]
    }]
  }));
  const before = bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_missions').get().n;
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
  assert.equal(bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_missions').get().n, before);

  const foreign = Buffer.from(JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{
      id: '11111111111111111',
      changes: [{ value: { messages: [{ id: 'wamid.foreign', type: 'text', from: '15556519146', text: { body: 'nope' } }] } }]
    }]
  }));
  const denied = await request('/webhooks/whatsapp', {
    method: 'POST',
    authorized: false,
    raw: true,
    body: foreign,
    headers: { 'x-hub-signature-256': sign(foreign) }
  });
  assert.equal(denied.status, 400);
  assert.match(String(denied.body?.error || ''), /accepted production or test/i);

  const api = await request('/api/assistant/whatsapp/inbound/configure-environment', {
    method: 'POST',
    body: {
      confirmed: true,
      environment: 'production',
      select_active: true
    }
  });
  assert.equal(api.status, 200);
  assert.equal(api.body.active_environment, 'production');
  assert.equal(api.body.waba_id, '29094507813569086');
  assert.equal(api.body.test_waba_id, '28756456347344989');
  assert.equal(api.body.test_phone_number_id, '1330971766772548');
});

test('meta-graph falls back to WABA hint when portfolio owned-list requires business_management', async () => {
  const { discoverOwnedWhatsApp } = require('../src/whatsapp-meta-graph');
  const calls = [];
  const fetchImpl = async (url) => {
    const u = String(url);
    calls.push(u.replace(/access_token=[^&]+/, 'access_token=[redacted]'));
    if (u.includes('/owned_whatsapp_business_accounts')) {
      return { ok: false, status: 403, json: async () => ({ error: { message: '(#200) Requires business_management permission to manage the object', type: 'OAuthException', code: 200 } }) };
    }
    if (u.includes('/phone_numbers')) {
      return { ok: true, status: 200, json: async () => ({ data: [{ id: '109876543210987' }] }) };
    }
    if (/\/29094507813569086\?/.test(u) || u.includes('/29094507813569086&') || u.includes('/29094507813569086?')) {
      return { ok: true, status: 200, json: async () => ({ id: '29094507813569086', name: 'Fixture WABA' }) };
    }
    return { ok: false, status: 404, json: async () => ({ error: { message: 'unexpected', type: 'HTTP', code: 404 } }) };
  };
  const result = await discoverOwnedWhatsApp({
    accessToken: 'synthetic-access-token-value',
    businessPortfolioId: '1791528208560099',
    appId: '1625559252697626',
    wabaId: '29094507813569086',
    fetchImpl
  });
  assert.equal(result.graph_access, 'authorized');
  assert.equal(result.waba_id, '29094507813569086');
  assert.equal(result.phone_number_id, '109876543210987');
  assert.ok(calls.some(c => c.includes('owned_whatsapp_business_accounts')));
  assert.ok(calls.some(c => c.includes('/29094507813569086')));
});

test('meta-graph preferred phone id selects the verified test number', async () => {
  const { readWabaAndPhones } = require('../src/whatsapp-meta-graph');
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes('/phone_numbers')) {
      return { ok: true, status: 200, json: async () => ({ data: [{ id: '1330971766772548' }, { id: '109876543210987' }] }) };
    }
    return { ok: true, status: 200, json: async () => ({ id: '28756456347344989', name: 'Fixture Test WABA' }) };
  };
  const result = await readWabaAndPhones('synthetic-access-token-value', '28756456347344989', {
    fetchImpl,
    preferredPhoneNumberId: '1330971766772548'
  });
  assert.equal(result.waba_id, '28756456347344989');
  assert.equal(result.phone_number_id, '1330971766772548');
  assert.equal(result.preferred_phone_matched, true);
});

test('rotate verify token replaces only verify slot; previous challenge fails; secrets not leaked', async t => {
  const { bridge, request } = await fixture(t, { enabled: false });
  const values = new Map();
  const vault = new (require('../src/secret-vault').SecretVault)(bridge.dataDir, (op, id, value) => {
    if (op === 'put') values.set(id, value);
    if (op === 'read') {
      if (!values.has(id)) throw Error('missing');
      return values.get(id);
    }
    if (op === 'revoke' || op === 'delete') values.delete(id);
    return '';
  });
  bridge.whatsappInbound.options.vault = vault;
  // Fixture may inject plaintext options; Vault must be authoritative for rotation.
  delete bridge.whatsappInbound.options.verifyToken;
  delete bridge.whatsappInbound.options.appSecret;
  delete bridge.whatsappInbound.options.accessToken;
  const previous = 'synthetic-previous-verify-token-value';
  const appSecret = 'synthetic-app-secret-rotate-preserve';
  const access = 'synthetic-graph-token-rotate-preserve';
  const verify = vault.put(previous, 'whatsapp');
  const secret = vault.put(appSecret, 'whatsapp');
  const graph = vault.put(access, 'whatsapp');
  bridge.whatsappInbound.bindCredentialReferences({
    confirmed: true,
    verify_token_reference: verify.reference,
    app_secret_reference: secret.reference,
    access_token_reference: graph.reference
  }, 'operator');

  assert.equal(bridge.whatsappInbound.challenge({
    'hub.mode': 'subscribe',
    'hub.verify_token': previous,
    'hub.challenge': 'before1'
  }), 'before1');

  const refs = await request('/api/assistant/whatsapp/inbound/credential-references', {
    method: 'POST',
    body: { confirmed: true }
  });
  assert.equal(refs.status, 200);
  assert.equal(refs.body.slot_verify, verify.reference);
  assert.equal(refs.body.slot_app, secret.reference);
  assert.equal(refs.body.slot_graph, graph.reference);
  assert.doesNotMatch(JSON.stringify(refs.body), /synthetic-previous|synthetic-app-secret|synthetic-graph/);

  const onboard = require('../src/whatsapp-credential-onboarding');
  const generated = onboard.generateVerifyToken();
  assert.match(generated, /^[A-Za-z0-9_-]{40,}$/);
  assert.notEqual(generated, previous);

  const rotated = onboard.rotateVerifyTokenSlot({
    vault,
    inbound: bridge.whatsappInbound,
    token: generated
  });
  assert.equal(rotated.slot_app, secret.reference);
  assert.equal(rotated.slot_graph, graph.reference);
  assert.notEqual(rotated.slot_verify, verify.reference);
  assert.equal(rotated.public_ingress, false);
  assert.equal(vault.resolve(rotated.slot_verify, 'whatsapp'), generated);
  assert.throws(() => vault.resolve(verify.reference, 'whatsapp'), /invalid|revoked/i);
  assert.equal(vault.resolve(secret.reference, 'whatsapp'), appSecret);
  assert.equal(vault.resolve(graph.reference, 'whatsapp'), access);

  assert.equal(bridge.whatsappInbound.challenge({
    'hub.mode': 'subscribe',
    'hub.verify_token': generated,
    'hub.challenge': 'after1'
  }), 'after1');
  assert.throws(() => bridge.whatsappInbound.challenge({
    'hub.mode': 'subscribe',
    'hub.verify_token': previous,
    'hub.challenge': 'after1'
  }), /Invalid verification token/);

  const live = await request('/api/assistant/whatsapp/live-connection');
  assert.equal(live.body.binding.verify_token_bound, true);
  assert.equal(live.body.binding.app_secret_bound, true);
  assert.equal(live.body.binding.access_token_bound, true);
  assert.equal(live.body.public_ingress, false);
  assert.equal(live.body.auto_mission_execution, false);
  assert.doesNotMatch(JSON.stringify(live.body), new RegExp(generated.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(JSON.stringify(live.body), /synthetic-previous-verify|synthetic-app-secret-rotate|synthetic-graph-token-rotate/);
});

test('connectorsProjection separates inbound readiness from outbound and does not claim Meta delivery', async t => {
  const { bridge } = await fixture(t, { enabled: false });
  const inbound = bridge.whatsappInbound;
  const values = new Map();
  const vault = new (require('../src/secret-vault').SecretVault)(bridge.dataDir, (op, id, value) => {
    if (op === 'put') values.set(id, value);
    if (op === 'read') return values.get(id);
    if (op === 'delete') values.delete(id);
    return '';
  });
  inbound.options.vault = vault;
  const verify = vault.put('synthetic-verify-connectors-proj', 'whatsapp');
  const secret = vault.put('synthetic-app-secret-connectors-proj', 'whatsapp');
  const graph = vault.put('synthetic-graph-token-connectors-proj', 'whatsapp');
  inbound.configure({
    confirmed: true,
    enabled: true,
    verify_token_reference: verify.reference,
    app_secret_reference: secret.reference,
    access_token_reference: graph.reference,
    allowlist: ['15556519146']
  }, 'operator');
  inbound.configureMetaEnvironment({
    confirmed: true,
    environment: 'test',
    waba_id: '28756456347344989',
    phone_number_id: '1330971766772548',
    select_active: true
  }, 'operator');
  inbound.preparePublicCallback({ confirmed: true, url: 'https://example.invalid/webhooks/whatsapp' }, 'operator');
  inbound.db.prepare('UPDATE cp_whatsapp_inbound_config SET discovery_json=?, updated_at=? WHERE id=1')
    .run(JSON.stringify({ graph_access: 'authorized', app_name: 'Airodrom', environment: 'test' }), Date.now());
  inbound.store.event('whatsapp.inbound.challenge_ok', null, { authority: false });

  const before = inbound.connectorsProjection();
  assert.equal(before.capabilities.graph, 'Authorized');
  assert.equal(before.capabilities.binding_state, 'Bound');
  assert.equal(before.capabilities.callback, 'Registered');
  assert.equal(before.capabilities.messages, 'Not subscribed');
  assert.equal(before.capabilities.inbound_delivery, 'Not yet verified');
  assert.equal(before.capabilities.meta_dashboard_test, 'Not observed');
  assert.equal(before.capabilities.sender_allowlist, 'No rejection recorded');
  assert.equal(before.capabilities.outbound, 'Unavailable');
  assert.notEqual(before.state, 'unavailable');

  const recorded = inbound.recordWebhookSubscription({ confirmed: true, fields: ['messages'] }, 'operator');
  assert.equal(recorded.capabilities.messages, 'Subscribed');
  assert.equal(recorded.capabilities.inbound_delivery, 'Not yet verified');
  assert.equal(recorded.detail.subscription_status, 'active');
  assert.equal(recorded.detail.active_environment, 'test');
  assert.equal(recorded.detail.waba_id, '28756456347344989');
  assert.equal(recorded.detail.phone_number_id, '1330971766772548');

  const { AssistantConnectors } = require('../src/assistant-connectors');
  const connectors = require('../src/assistant-service').connectors(bridge);
  const item = connectors.status().items.find(x => x.id === 'whatsapp');
  assert.equal(item.state, 'configured');
  assert.equal(item.capabilities.messages, 'Subscribed');
  assert.equal(item.capabilities.outbound, 'Unavailable');
  assert.equal(item.capabilities.inbound_delivery, 'Not yet verified');
  assert.doesNotMatch(JSON.stringify(item), /synthetic-verify-connectors-proj|synthetic-app-secret-connectors-proj|synthetic-graph-token-connectors-proj/);

  const bare = new AssistantConnectors();
  assert.equal(bare.status().items.find(x => x.id === 'whatsapp').state, 'unavailable');
  assert.equal(bare.status().items.find(x => x.id === 'whatsapp').capabilities.outbound, 'Unavailable');
});

test('Meta dashboard webhook test is distinguished from allowlist rejection and phone delivery', async t => {
  const { bridge } = await fixture(t, { allowlist: ['15556519146'] });
  const inbound = bridge.whatsappInbound;
  const raw = Buffer.from(JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{
      id: '28756456347344989',
      changes: [{
        value: {
          messaging_product: 'whatsapp',
          messages: [{
            id: 'ABGGFlA5FpaFixtureMetaTest',
            from: '16315551181',
            type: 'text',
            text: { body: 'this is a text message' }
          }]
        }
      }]
    }]
  }));
  const sig = 'sha256=' + require('node:crypto').createHmac('sha256', 'synthetic-app-secret').update(raw).digest('hex');
  const result = inbound.ingest(raw, sig);
  assert.equal(result.accepted, 0);
  assert.equal(result.rejected, 1);
  assert.equal(result.rejections[0].reason, 'unauthorized_sender');
  assert.equal(result.auto_mission_execution, false);

  const proj = inbound.connectorsProjection();
  assert.equal(proj.capabilities.meta_dashboard_test, 'Received');
  assert.equal(proj.capabilities.sender_allowlist, 'Rejected unauthorized sender');
  assert.equal(proj.capabilities.inbound_delivery, 'Not yet verified');
  assert.equal(proj.detail.hmac_result, 'Verified');
  assert.equal(proj.detail.host_http_status, 200);
  assert.equal(proj.detail.phone_originated_delivery, 'Not yet verified');
  assert.match(proj.setup, /allowlist/i);
  assert.doesNotMatch(proj.setup, /Phone-originated delivery verified/i);

  const live = inbound.liveConnectionReadiness();
  assert.equal(live.real_message_test.meta_dashboard_test, 'Received');
  assert.equal(live.real_message_test.executed, false);
  assert.equal(live.real_message_test.mission_auto_execution, false);
  assert.equal(bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_missions').get().n, 0);
});
