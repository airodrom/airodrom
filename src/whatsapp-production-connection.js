'use strict';
// Read-only production connection prerequisites. Never sends messages or prints secrets.
const fs = require('node:fs');
const path = require('node:path');

const EPHEMERAL = /(^|\.)trycloudflare\.com$/i;

function loadProductionConfig(root) {
  const file = path.join(root || path.resolve(__dirname, '..'), 'config/whatsapp-production-connection-v1.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (raw.version !== 1) throw Error('Unsupported WhatsApp production connection config');
  return raw;
}

function productionConnectionStatus(bridge, options = {}) {
  const root = options.root || path.resolve(__dirname, '..');
  const cfg = loadProductionConfig(root);
  const inbound = (() => {
    try { return bridge?.whatsappInbound?.config?.() || null; } catch { return null; }
  })();
  const outbound = (() => {
    try { return bridge?.whatsappOutbound?.status?.() || null; } catch { return null; }
  })();
  const conversations = (() => {
    try { return bridge?.whatsappConversations?.status?.() || null; } catch { return null; }
  })();

  const hold = cfg.ai_assistant_policy?.production_messaging === 'HOLD'
    || cfg.ai_assistant_policy?.eligibility === 'hold';
  const productionPhone = inbound?.production_phone_number_id || cfg.production_phone_number_id || null;
  const testPreserved = inbound
    ? inbound.test_waba_id === cfg.test_waba_id && inbound.test_phone_number_id === cfg.test_phone_number_id
    : true;

  return {
    version: 1,
    production_messaging: hold ? 'HOLD' : 'unresolved',
    hold_reason: cfg.ai_assistant_policy?.hold_reason || null,
    meta_app_id: cfg.meta_app_id,
    production_waba_id: cfg.production_waba_id,
    production_phone_number_id: productionPhone,
    production_phone_registered: Boolean(productionPhone),
    test_waba_id: cfg.test_waba_id,
    test_phone_number_id: cfg.test_phone_number_id,
    test_environment_preserved: testPreserved,
    app_publication_status: cfg.app_publication_status,
    business_verification: cfg.business_verification?.status || null,
    permissions: cfg.permissions?.required || [],
    ai_assistant_policy_eligibility: cfg.ai_assistant_policy?.eligibility || 'hold',
    stable_https: {
      path: cfg.stable_https_callback?.path || '/webhooks/whatsapp',
      webhook_only: true,
      ephemeral_trycloudflare_forbidden_for_production: true,
      public_ingress_default: false
    },
    outbound_enabled: false,
    auto_outbound: false,
    auto_mission_execution: false,
    conversations_outbound_enabled: conversations?.outbound_enabled === true,
    outbound_module_enabled: outbound?.outbound_enabled === true,
    production_test_procedure_prepared: cfg.production_test_procedure?.prepared === true && !hold,
    values_displayed: false,
    authority: false,
    owner_actions_remaining: [
      'Confirm App Dashboard Development/Live mode',
      'Confirm Business Manager verification status',
      'Record AI policy determination before lifting HOLD',
      'Register dedicated production phone via official Meta process (no personal migration without approval)',
      'Provision stable DNS + named tunnel; forbid trycloudflare for production',
      'Subscribe production webhook; keep outbound OFF until separately authorized'
    ],
    note: cfg.note
  };
}

function assertStableProductionHostname(hostname) {
  if (typeof hostname !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,240}[a-z0-9]$/i.test(hostname) || hostname.includes('..')) {
    throw Error('Provide a DNS hostname via --hostname');
  }
  if (EPHEMERAL.test(hostname) || /trycloudflare/i.test(hostname)) {
    throw Error('Ephemeral trycloudflare hostnames are forbidden for production WhatsApp callbacks; use a stable DNS hostname');
  }
  return hostname;
}

module.exports = { loadProductionConfig, productionConnectionStatus, assertStableProductionHostname, EPHEMERAL };
