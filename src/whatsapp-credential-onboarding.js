'use strict';
/**
 * Operator WhatsApp credential onboarding.
 * Captures three purpose=whatsapp Vault secrets via hidden TTY input,
 * binds opaque references through the inbound configure API, validates
 * resolvability without printing values, then optionally discovers Graph
 * accounts and prepares a webhook-only HTTPS callback. Public ingress and
 * Mission auto-dispatch remain off.
 *
 * rotate-verify-token generates a new webhook verify token in-process,
 * replaces only that Vault slot, displays the plaintext once on a TTY,
 * and never writes the value to logs, Git, Notion, or Mission results.
 */
const path = require('node:path');
const crypto = require('node:crypto');
const { hidden, confirm } = require('./vault-cli');

const VERIFY_TOKEN_BYTES = 32;

const SLOTS = [
  {
    key: 'verify_token_reference',
    label: 'Webhook verification token',
    detail: 'Meta App → WhatsApp → Configuration → Verify token (you choose this value).'
  },
  {
    key: 'app_secret_reference',
    label: 'Meta App Secret',
    detail: 'Meta App → Settings → Basic → App Secret (used for X-Hub-Signature-256).'
  },
  {
    key: 'access_token_reference',
    label: 'Graph API access token',
    detail: 'System user / permanent token with WhatsApp Business permissions for Graph discovery.'
  }
];


async function ensureService(home) {
  const local = require('./local-bootstrap');
  try {
    await local.status(home, { allowOlderSource: true });
    return;
  } catch {}
  await ensureService(home);
}

function vaultFor(home) {
  const local = require('./local-bootstrap');
  const data = local.privateDirectory(path.join(home, 'data'), true);
  return new (require('./secret-vault').SecretVault)(data);
}

/** Store one labeled secret; returns opaque reference only. Never logs the value. */
function storeSlot(vault, value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || Buffer.byteLength(value) > 8192) {
    throw Error('Invalid secure WhatsApp credential');
  }
  return vault.put(value, 'whatsapp');
}

/** Cryptographically secure Meta webhook verify token (URL-safe; never logged). */
function generateVerifyToken() {
  return crypto.randomBytes(VERIFY_TOKEN_BYTES).toString('base64url');
}

/**
 * Replace only the verify-token Vault slot; preserve app_secret and access_token references.
 * @param {{vault, inbound, token?:string}} options inbound must expose configure + challenge
 * @returns {{verify_token_reference, app_secret_reference, access_token_reference, previous_reference, token}}
 *   `token` is returned only for the caller to display once; do not persist or log it.
 */
function rotateVerifyTokenSlot({ vault, inbound, token } = {}) {
  if (!vault || !inbound) throw Error('Vault and WhatsApp inbound required for verify-token rotation');
  const refs = typeof inbound.opaqueCredentialReferences === 'function'
    ? inbound.opaqueCredentialReferences('operator')
    : null;
  const previousRef = refs?.slot_verify;
  const appRef = refs?.slot_app;
  const accessRef = refs?.slot_graph;
  if (!previousRef || !appRef || !accessRef) {
    throw Error('WhatsApp verify token, App Secret and Graph access token must already be bound. Run: airodrom whatsapp bind');
  }
  let next = typeof token === 'string' && token ? token : generateVerifyToken();
  if (!next || next.includes('\0') || Buffer.byteLength(next) > 200) {
    throw Error('Invalid generated WhatsApp verify token');
  }
  const replaced = vault.replace(previousRef, next, 'whatsapp');
  inbound.configure({
    enabled: refs.enabled !== false,
    confirmed: true,
    verify_token_reference: replaced.reference,
    app_secret_reference: appRef,
    access_token_reference: accessRef
  }, 'operator');
  if (typeof inbound.options?.verifyToken === 'string') {
    // Drop in-memory fixture override so Vault is authoritative after rotation.
    delete inbound.options.verifyToken;
  }
  return {
    slot_verify: replaced.reference,
    slot_app: appRef,
    slot_graph: accessRef,
    previous_slot_verify: previousRef,
    token: next,
    public_ingress: false,
    auto_mission_execution: false
  };
}

async function probeWebhookChallenge(home, token) {
  const local = require('./local-bootstrap');
  const d = local.discovery(home);
  const challenge = 'rotateProof1';
  const url = `${d.origin}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(token)}&hub.challenge=${challenge}`;
  const r = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10000) });
  const body = await r.text();
  return { status: r.status, accepted: r.status === 200 && body === challenge };
}

/**
 * Bind already-stored opaque references on a live WhatsAppInbound instance.
 * Validates each reference resolves for purpose=whatsapp without returning values.
 */
function bindReferences(inbound, refs, actor = 'operator') {
  if (!inbound || typeof inbound.bindCredentialReferences !== 'function') {
    throw Error('WhatsApp inbound binding surface unavailable');
  }
  return inbound.bindCredentialReferences({
    confirmed: true,
    enabled: true,
    verify_token_reference: refs.verify_token_reference,
    app_secret_reference: refs.app_secret_reference,
    access_token_reference: refs.access_token_reference
  }, actor);
}

function slotBound(sources, name) {
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    if (typeof src[`${name}_bound`] === 'boolean') return src[`${name}_bound`];
    if (typeof src[name]?.bound === 'boolean') return src[name].bound;
    if (typeof src[name]?.vault_reference_present === 'boolean') return src[name].vault_reference_present;
  }
  return null;
}

function summarizeBinding(status) {
  const live = status?.live_connection || status;
  const binding = (typeof live?.binding === 'object' && live.binding) || (typeof status?.binding === 'object' && status.binding) || {};
  const cred = (typeof status?.credentials === 'object' && status.credentials)
    || (typeof live?.credentials === 'object' && live.credentials)
    || {};
  const vault = (typeof live?.vault === 'object' && live.vault) || (typeof status?.vault === 'object' && status.vault) || {};
  const meta = live?.meta || status?.meta || {};
  const discovery = meta.discovery || live?.meta?.discovery || null;
  let verify = slotBound([binding, cred, status, live], 'verify_token');
  let app = slotBound([binding, cred, status, live], 'app_secret');
  let access = slotBound([binding, cred, status, live], 'access_token');
  // When control-plane safeValue omits credentials, vault aggregates still report readiness.
  if ((verify == null || app == null || access == null)
    && vault.configure_slots_bound === 3
    && vault.ready_for_live_hmac === true
    && vault.ready_for_graph_discovery === true) {
    verify = true;
    app = true;
    access = true;
  }
  if (verify == null && vault.ready_for_live_hmac === true) verify = true;
  if (app == null && vault.ready_for_live_hmac === true) app = true;
  if (access == null && vault.ready_for_graph_discovery === true) access = true;
  return {
    vault_slots: {
      verify_token: Boolean(verify),
      app_secret: Boolean(app),
      access_token: Boolean(access)
    },
    references_validated: Boolean(
      status?.credentials?.references_validated
      || status?.references_validated
      || (verify && app && access && vault.ready_for_graph_discovery)
    ),
    active_environment: live?.active_environment || meta.active_environment || null,
    production_waba_id: live?.production_waba_id || meta.production_waba_id || null,
    production_phone_number_id: live?.production_phone_number_id || meta.production_phone_number_id || null,
    test_waba_id: live?.test_waba_id || meta.test_waba_id || null,
    test_phone_number_id: live?.test_phone_number_id || meta.test_phone_number_id || null,
    waba_id: meta.waba_id || live?.waba_id || null,
    phone_number_id: meta.phone_number_id || live?.phone_number_id || null,
    graph_access: discovery?.graph_access || null,
    permission_prerequisite: discovery?.permission_prerequisite || null,
    prepared_callback_url: live?.callback?.prepared_callback_url || status?.callback?.prepared_callback_url || null,
    public_ingress: false,
    auto_mission_execution: false,
    values_displayed: false
  };
}

function writeSummary(output, summary) {
  const slot = summary.vault_slots;
  output.write('WhatsApp credential binding\n');
  output.write(`  Verify token: ${slot.verify_token ? 'bound' : 'missing'}\n`);
  output.write(`  App secret: ${slot.app_secret ? 'bound' : 'missing'}\n`);
  output.write(`  Access token: ${slot.access_token ? 'bound' : 'missing'}\n`);
  if (summary.references_validated) output.write('  Vault references validated (values not displayed).\n');
  if (summary.graph_access) output.write(`  Graph discovery: ${summary.graph_access}\n`);
  if (summary.permission_prerequisite) output.write(`  Graph detail: ${summary.permission_prerequisite}\n`);
  if (summary.active_environment) output.write(`  Active environment: ${summary.active_environment}\n`);
  if (summary.production_waba_id) output.write(`  Production WABA: ${summary.production_waba_id}\n`);
  if (summary.test_waba_id) output.write(`  Test WABA: ${summary.test_waba_id}\n`);
  if (summary.test_phone_number_id) output.write(`  Test Phone Number ID: ${summary.test_phone_number_id}\n`);
  output.write(`  Active WABA ID: ${summary.waba_id || 'unavailable'}\n`);
  output.write(`  Active Phone Number ID: ${summary.phone_number_id || 'unavailable'}\n`);
  output.write(`  Prepared HTTPS callback: ${summary.prepared_callback_url || 'none'}\n`);
  output.write('  Public ingress: OFF · Mission auto-dispatch: OFF\n');
}

/**
 * Interactive onboarding. Requires TTY. Uses local service APIs when available.
 * @param {{home:string,input,output,signal?:AbortSignal,callbackUrl?:string,discover?:boolean,startService?:boolean}} options
 */
async function run(options = {}) {
  const { home, input, output, signal, callbackUrl = null, discover = true, startService = true } = options;
  if (!home || !input || !output) throw Error('WhatsApp credential onboarding requires home, input and output');
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    throw Error('WhatsApp credential binding requires an interactive operator terminal.');
  }
  const local = require('./local-bootstrap');
  local.privateDirectory(home, true);
  const vault = vaultFor(home);
  if (!vault.status().configured) {
    throw Error('Keychain Vault is not prepared. Run: airodrom secret prepare');
  }

  output.write('WhatsApp credential onboarding\n');
  output.write('Three secrets will be stored in Keychain (purpose whatsapp) with hidden input.\n');
  output.write('Opaque references are configured automatically. Values are never printed.\n');
  output.write('Public Meta HTTPS ingress stays OFF. Missions are never auto-dispatched.\n');

  if (!await confirm(input, output, { prompt: 'Continue with secure WhatsApp credential binding?', signal })) {
    output.write('WhatsApp credential binding cancelled.\n');
    return { cancelled: true, public_ingress: false };
  }

  const refs = {};
  for (const slot of SLOTS) {
    if (signal?.aborted) throw Error('Secure entry cancelled');
    output.write(`\n${slot.label}\n${slot.detail}\n`);
    let value = await hidden(input, output, { prompt: `${slot.label} (hidden; Enter continues, Ctrl+C cancels): `, signal });
    try {
      if (!value) throw Error(`${slot.label} is required`);
      if (!await confirm(input, output, { prompt: `Save ${slot.label} securely in Keychain?`, signal })) {
        output.write('Save cancelled. Binding incomplete.\n');
        return { cancelled: true, public_ingress: false, partial: refs };
      }
      const receipt = storeSlot(vault, value);
      refs[slot.key] = receipt.reference;
      output.write(`Saved securely. Opaque reference recorded for ${slot.label}.\n`);
    } finally {
      value = '';
    }
  }

  if (startService) {
    try { await ensureService(home); } catch (error) {
      throw Error('Local Airodrom service required to configure WhatsApp references: ' + (error.message || 'unavailable'));
    }
  }

  const configured = await local.request(home, '/api/assistant/whatsapp/inbound/configure', {
    enabled: true,
    confirmed: true,
    verify_token_reference: refs.verify_token_reference,
    app_secret_reference: refs.app_secret_reference,
    access_token_reference: refs.access_token_reference
  });

  const validated = await local.request(home, '/api/assistant/whatsapp/inbound/validate-credentials', {
    confirmed: true
  });

  let discovery = null;
  if (discover !== false && validated?.ready_for_graph_discovery !== false) {
    if (await confirm(input, output, { prompt: 'Run Meta Graph discovery now with the bound access token?', signal })) {
      discovery = await local.request(home, '/api/assistant/whatsapp/inbound/discover-graph', { confirmed: true });
    } else {
      output.write('Graph discovery skipped. Run: airodrom whatsapp discover\n');
    }
  } else if (discover !== false) {
    output.write('Graph discovery deferred: access token reference not ready.\n');
  }

  let prepared = null;
  let url = callbackUrl;
  if (!url) {
    output.write('\nOptional: prepare webhook-only HTTPS callback (public ingress stays OFF).\n');
    output.write('Enter https://<host>/webhooks/whatsapp or leave blank to skip.\n');
    // Visible non-secret URL capture via a one-line readline would risk mixing with
    // credential mode; use confirm+prompt pattern through ordinary API when provided.
  }
  if (typeof url === 'string' && url.trim()) {
    prepared = await local.request(home, '/api/assistant/whatsapp/inbound/prepare-callback', {
      confirmed: true,
      url: url.trim()
    });
  }

  const live = await local.request(home, '/api/assistant/whatsapp/live-connection');
  const summary = summarizeBinding({
    ...configured,
    credentials: { ...configured.credentials, references_validated: validated?.ok === true },
    live_connection: live,
    meta: live.meta,
    callback: live.callback
  });
  if (discovery) {
    summary.graph_access = discovery.meta?.discovery?.graph_access || discovery.graph_access || summary.graph_access;
    summary.permission_prerequisite = discovery.meta?.discovery?.permission_prerequisite || summary.permission_prerequisite;
    summary.waba_id = discovery.waba_id || discovery.meta?.waba_id || summary.waba_id;
    summary.phone_number_id = discovery.phone_number_id || discovery.meta?.phone_number_id || summary.phone_number_id;
  }
  if (prepared) summary.prepared_callback_url = prepared.prepared_callback_url || summary.prepared_callback_url;
  writeSummary(output, summary);
  output.write('\nNext: owner-authorize public ingress separately, then subscribe the callback in Meta.\n');
  output.write('Webhook-only tunnel plan (no start): node scripts/whatsapp-webhook-ingress-prep.cjs --hostname <host> --port <port>\n');
  return { cancelled: false, references: { verify_token: true, app_secret: true, access_token: true }, summary, public_ingress: false };
}

async function runDiscover(home, output, wabaId = null) {
  const local = require('./local-bootstrap');
  await ensureService(home);
  const live = await local.request(home, '/api/assistant/whatsapp/live-connection');
  if (!live.credentials?.access_token?.bound && !live.vault?.ready_for_graph_discovery) {
    output.write('No usable Graph access token is bound. Run: airodrom whatsapp bind\n');
    return { deferred: true, reason: 'access_token_unbound', public_ingress: false };
  }
  const body = { confirmed: true };
  if (typeof wabaId === 'string' && /^[0-9]{5,32}$/.test(wabaId.trim())) {
    body.waba_id = wabaId.trim();
    if (wabaId.trim() === '28756456347344989') body.environment = 'test';
  }
  const discovery = await local.request(home, '/api/assistant/whatsapp/inbound/discover-graph', body);
  const summary = summarizeBinding({ live_connection: discovery, credentials: discovery.credentials, meta: discovery.meta, callback: discovery.callback });
  writeSummary(output, summary);
  return { deferred: false, summary, public_ingress: false };
}

/** Bind Meta test/sandbox WABA + Phone Number ID without overwriting production. */
async function runConfigureTest(home, output, {
  wabaId = '28756456347344989',
  phoneNumberId = '1330971766772548',
  allowlistSender = '15556519146',
  discover = true
} = {}) {
  const local = require('./local-bootstrap');
  await ensureService(home);
  const configured = await local.request(home, '/api/assistant/whatsapp/inbound/configure-environment', {
    confirmed: true,
    environment: 'test',
    waba_id: wabaId,
    phone_number_id: phoneNumberId,
    allowlist_sender: allowlistSender,
    select_active: true,
    enabled: true
  });
  let discovery = null;
  if (discover) {
    discovery = await local.request(home, '/api/assistant/whatsapp/inbound/discover-graph', {
      confirmed: true,
      environment: 'test',
      waba_id: wabaId,
      phone_number_id: phoneNumberId
    });
  }
  const live = discovery || configured;
  const summary = summarizeBinding({ live_connection: live, credentials: live.credentials, meta: live.meta, callback: live.callback, vault: live.vault });
  writeSummary(output, summary);
  if (summary.production_waba_id === wabaId) throw Error('Production WABA was not preserved');
  output.write('Test environment selected. Production identifiers preserved. Public ingress OFF.\n');
  return { summary, live, public_ingress: false };
}

async function runPrepare(home, output, url) {
  const local = require('./local-bootstrap');
  if (typeof url !== 'string' || !url) throw Error('Use airodrom whatsapp prepare-callback <https://host/webhooks/whatsapp>');
  await ensureService(home);
  const prepared = await local.request(home, '/api/assistant/whatsapp/inbound/prepare-callback', { confirmed: true, url });
  output.write(`Prepared callback: ${prepared.prepared_callback_url}\n`);
  output.write('Public ingress: OFF · activation inactive until owner authorization\n');
  return prepared;
}

async function runStatus(home, output, json = false) {
  const local = require('./local-bootstrap');
  await ensureService(home);
  const live = await local.request(home, '/api/assistant/whatsapp/live-connection');
  const summary = summarizeBinding({
    live_connection: live,
    binding: live.binding,
    credentials: typeof live.credentials === 'object' ? live.credentials : null,
    vault: live.vault,
    meta: live.meta,
    callback: live.callback
  });
  if (json) {
    output.write(JSON.stringify({
      vault: live.vault,
      binding: live.binding || {
        verify_token_bound: summary.vault_slots.verify_token,
        app_secret_bound: summary.vault_slots.app_secret,
        access_token_bound: summary.vault_slots.access_token,
        values_displayed: false
      },
      credentials: {
        verify_token_bound: summary.vault_slots.verify_token,
        app_secret_bound: summary.vault_slots.app_secret,
        access_token_bound: summary.vault_slots.access_token,
        values_displayed: false
      },
      waba_id: live.waba_id,
      phone_number_id: live.phone_number_id,
      graph_access: live.meta?.discovery?.graph_access || null,
      permission_prerequisite: live.meta?.discovery?.permission_prerequisite || null,
      prepared_callback_url: live.callback?.prepared_callback_url || null,
      public_ingress: false,
      auto_mission_execution: false
    }) + '\n');
    return live;
  }
  writeSummary(output, summary);
  return live;
}

/**
 * Generate and bind a new webhook verify token. Displays plaintext once on TTY.
 * Preserves Meta App Secret and Graph access token references. Never logs the token.
 */
async function runRotateVerifyToken(home, input, output, { signal } = {}) {
  if (!home || !input || !output) throw Error('WhatsApp verify-token rotation requires home, input and output');
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    throw Error('WhatsApp verify rotation requires an interactive operator terminal (value is shown once).');
  }
  const local = require('./local-bootstrap');
  local.privateDirectory(home, true);
  const vault = vaultFor(home);
  if (!vault.status().configured) {
    throw Error('Keychain Vault is not prepared. Run: airodrom secret prepare');
  }

  output.write('WhatsApp verify-token rotation\n');
  output.write('A new cryptographically secure verify token will be generated and bound.\n');
  output.write('Meta App Secret and Graph access token references stay unchanged.\n');
  output.write('The new token is printed once below for Meta Configuration. It is not logged.\n');
  output.write('Public ingress and Mission auto-dispatch stay OFF.\n');

  if (!await confirm(input, output, { prompt: 'Rotate the active WhatsApp webhook verify token now?', signal })) {
    output.write('WhatsApp verify-token rotation cancelled.\n');
    return { cancelled: true, public_ingress: false, auto_mission_execution: false };
  }

  await ensureService(home);
  const refs = await local.request(home, '/api/assistant/whatsapp/inbound/credential-references', { confirmed: true });
  if (!refs.slot_verify || !refs.slot_app || !refs.slot_graph
    || refs.slot_verify === '[omitted]' || refs.slot_app === '[omitted]' || refs.slot_graph === '[omitted]') {
    throw Error('WhatsApp verify token, App Secret and Graph access token must already be bound. Run: airodrom whatsapp bind');
  }
  const preservedApp = refs.slot_app;
  const preservedAccess = refs.slot_graph;

  let previous = '';
  let next = '';
  try {
    previous = vault.resolve(refs.slot_verify, 'whatsapp');
    next = generateVerifyToken();
    const replaced = vault.replace(refs.slot_verify, next, 'whatsapp');
    const configured = await local.request(home, '/api/assistant/whatsapp/inbound/configure', {
      enabled: refs.enabled !== false,
      confirmed: true,
      verify_token_reference: replaced.reference,
      app_secret_reference: preservedApp,
      access_token_reference: preservedAccess
    });
    if (configured?.binding?.app_secret_bound === false || configured?.app_secret_bound === false) {
      throw Error('App Secret binding was lost during verify-token rotation');
    }
    if (configured?.binding?.access_token_bound === false || configured?.access_token_bound === false) {
      throw Error('Graph access token binding was lost during verify-token rotation');
    }
    const after = await local.request(home, '/api/assistant/whatsapp/inbound/credential-references', { confirmed: true });
    if (after.slot_app !== preservedApp || after.slot_graph !== preservedAccess) {
      throw Error('App Secret or Graph access token reference changed unexpectedly');
    }
    if (after.slot_verify !== replaced.reference) {
      throw Error('Verify token reference was not updated');
    }

    const accepted = await probeWebhookChallenge(home, next);
    const rejected = await probeWebhookChallenge(home, previous);
    if (accepted.accepted !== true) throw Error('Local webhook challenge did not accept the new verify token');
    if (rejected.accepted === true) throw Error('Previous verify token still accepted after rotation');

    output.write('\nNew Meta webhook verify token (enter once in Meta App → WhatsApp → Configuration):\n\n');
    output.write(next + '\n\n');
    output.write('Shown once. Do not paste into chat, Git, Notion, or Mission results.\n');
    output.write('Challenge proof: new token accepted · previous token rejected\n');
    output.write('App Secret and Graph access token: preserved\n');
    output.write('Public ingress: OFF · Mission auto-dispatch: OFF\n');

    const live = await local.request(home, '/api/assistant/whatsapp/live-connection');
    const summary = summarizeBinding({
      live_connection: live,
      binding: live.binding,
      credentials: typeof live.credentials === 'object' ? live.credentials : null,
      vault: live.vault,
      meta: live.meta,
      callback: live.callback
    });
    writeSummary(output, summary);
    return {
      cancelled: false,
      rotated: true,
      slot_verify: replaced.reference,
      slot_app: preservedApp,
      slot_graph: preservedAccess,
      challenge_new_ok: true,
      challenge_previous_rejected: true,
      public_ingress: false,
      auto_mission_execution: false,
      values_displayed_once: true
    };
  } finally {
    previous = '';
    next = '';
  }
}

module.exports = {
  SLOTS,
  storeSlot,
  generateVerifyToken,
  rotateVerifyTokenSlot,
  bindReferences,
  summarizeBinding,
  writeSummary,
  run,
  runDiscover,
  runConfigureTest,
  runPrepare,
  runStatus,
  runRotateVerifyToken,
  vaultFor
};
