'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  loadProductionConfig,
  productionConnectionStatus,
  assertStableProductionHostname
} = require('../src/whatsapp-production-connection');
const { main: ingressPrep } = require('../scripts/whatsapp-webhook-ingress-prep.cjs');

test('production config holds messaging and preserves test slots', () => {
  const cfg = loadProductionConfig();
  assert.equal(cfg.production_waba_id, '29094507813569086');
  assert.equal(cfg.test_waba_id, '28756456347344989');
  assert.equal(cfg.test_phone_number_id, '1330971766772548');
  assert.equal(cfg.production_phone_number_id, null);
  assert.equal(cfg.preserve_test_environment, true);
  assert.ok(['hold', 'prohibited'].includes(cfg.ai_assistant_policy.eligibility));
  assert.equal(cfg.ai_assistant_policy.production_messaging, 'HOLD');
  if (cfg.ai_assistant_policy.eligibility === 'prohibited') {
    assert.match(String(cfg.ai_assistant_policy.decision || cfg.ai_assistant_policy.verdict || ''), /prohibit/i);
  }
  assert.equal(cfg.outbound_enabled, false);
  assert.equal(cfg.auto_mission_execution, false);
  assert.equal(cfg.production_test_procedure.prepared, false);
  assert.equal(cfg.phone_onboarding.migrate_personal_whatsapp_without_approval, false);
});

test('productionConnectionStatus reports HOLD without secrets', () => {
  const status = productionConnectionStatus({
    whatsappInbound: {
      config: () => ({
        production_waba_id: '29094507813569086',
        production_phone_number_id: null,
        test_waba_id: '28756456347344989',
        test_phone_number_id: '1330971766772548'
      })
    },
    whatsappOutbound: { status: () => ({ outbound_enabled: false }) },
    whatsappConversations: { status: () => ({ outbound_enabled: false }) }
  });
  assert.equal(status.production_messaging, 'HOLD');
  assert.equal(status.production_phone_registered, false);
  assert.equal(status.test_environment_preserved, true);
  assert.equal(status.outbound_enabled, false);
  assert.equal(status.auto_mission_execution, false);
  assert.equal(status.production_test_procedure_prepared, false);
  assert.ok(status.owner_actions_remaining.length >= 4);
  assert.doesNotMatch(JSON.stringify(status), /EAA|sk-|password|secret_value/i);
});

test('stable production hostname rejects trycloudflare', () => {
  assert.equal(assertStableProductionHostname('hooks.example.com'), 'hooks.example.com');
  assert.throws(() => assertStableProductionHostname('convention-suddenly-oliver-miles.trycloudflare.com'), /forbidden/i);
  assert.throws(() => assertStableProductionHostname('x.trycloudflare.com'), /forbidden/i);
});

test('ingress prep --production rejects ephemeral hostnames and writes stable plan', () => {
  assert.throws(() => ingressPrep(['--production', '--hostname', 'a.trycloudflare.com', '--port', '43117']), /forbidden/i);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-prod-ingress-'));
  assert.equal(ingressPrep(['--production', '--hostname', 'hooks.example.com', '--port', '43117', '--write', dir]), 0);
  const plan = JSON.parse(fs.readFileSync(path.join(dir, 'whatsapp-webhook-ingress-plan.json'), 'utf8'));
  assert.equal(plan.production, true);
  assert.equal(plan.public_ingress, false);
  assert.equal(plan.ephemeral_trycloudflare_forbidden, true);
  assert.equal(plan.activated, false);
  assert.match(fs.readFileSync(path.join(dir, 'whatsapp-webhook-only.cloudflared.yml'), 'utf8'), /hooks\.example\.com/);
  fs.rmSync(dir, { recursive: true, force: true });
});
