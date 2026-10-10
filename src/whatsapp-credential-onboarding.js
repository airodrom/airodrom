'use strict';
/**
 * Operator WhatsApp credential onboarding.
 * Captures three purpose=whatsapp Vault secrets via hidden TTY input,
 * binds opaque references through the inbound configure API, validates
 * resolvability without printing values, then optionally discovers Graph
 * accounts and prepares a webhook-only HTTPS callback. Public ingress and
 * Mission auto-dispatch remain off.
 *
 * rotate-verify-token stages a new webhook verify token in Keychain without
 * revoking the current slot and displays the plaintext once on a TTY. Local
 * probes never finalize. Meta Verify (non-probe) or commit-verify-token promotes
 * the candidate and revokes the previous slot. rollback-verify-token discards an
 * uncommitted stage. Values never enter logs, Git, Notion, or Mission results.
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
 * Stage a new verify-token Vault slot; preserve current verify, app_secret and access_token.
 * @param {{vault, inbound, token?:string, ttlMs?:number}} options
 * @returns {{slot_verify, slot_staged, slot_app, slot_graph, previous_slot_verify, token, staging_expires_at}}
 *   `token` is returned only for the caller to display once; do not persist or log it.
 */
function rotateVerifyTokenSlot({ vault, inbound, token, ttlMs } = {}) {
  if (!vault || !inbound) throw Error('Vault and WhatsApp inbound required for verify-token rotation');
  if (typeof inbound.options?.verifyToken === 'string') delete inbound.options.verifyToken;
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
  const stored = vault.put(next, 'whatsapp');
  const staged = inbound.stageVerifyTokenRotation({
    confirmed: true,
    staged_verify_reference: stored.reference,
    ...(Number.isInteger(ttlMs) ? { ttl_ms: ttlMs } : {})
  }, 'operator');
  return {
    slot_verify: previousRef,
    slot_staged: staged.slot_staged,
    slot_app: appRef,
    slot_graph: accessRef,
    previous_slot_verify: previousRef,
    staging_expires_at: staged.staging_expires_at,
    staged: true,
    token: next,
    public_ingress: false,
    auto_mission_execution: false
  };
}

/** Local loopback proof. Never finalizes staged rotation (probe header). */
async function probeWebhookChallenge(home, token, { finalizeStaged = false } = {}) {
  const local = require('./local-bootstrap');
  const d = local.discovery(home);
  const challenge = 'rotateProof1';
  const url = `${d.origin}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(token)}&hub.challenge=${challenge}`;
  const headers = {};
  if (finalizeStaged !== true) headers['x-airodrom-verify-probe'] = '1';
  const r = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10000), headers });
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
 * Stage a new webhook verify token. Displays plaintext once on TTY.
 * Current token remains valid until Meta Verify finalizes the stage (or explicit commit),
 * or until rollback/expiry. Local probes never finalize. Never logs the token.
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

  output.write('WhatsApp verify-token staged rotation\n');
  output.write('A new cryptographically secure verify token will be staged in Keychain.\n');
  output.write('The current verify token stays valid until Meta Verify and Save succeeds (or you commit).\n');
  output.write('Meta App Secret and Graph access token references stay unchanged.\n');
  output.write('The new token is printed once below for Meta Configuration. It is not logged.\n');
  output.write('Local proofs use a non-finalizing probe and cannot revoke the current token.\n');
  output.write('Public ingress and Mission auto-dispatch stay OFF.\n');

  if (!await confirm(input, output, { prompt: 'Stage a new WhatsApp webhook verify token now?', signal })) {
    output.write('WhatsApp verify-token rotation cancelled.\n');
    return { cancelled: true, public_ingress: false, auto_mission_execution: false };
  }

  await ensureService(home);
  const refs = await local.request(home, '/api/assistant/whatsapp/inbound/credential-references', { confirmed: true });
  if (!refs.slot_verify || !refs.slot_app || !refs.slot_graph
    || refs.slot_verify === '[omitted]' || refs.slot_app === '[omitted]' || refs.slot_graph === '[omitted]') {
    throw Error('WhatsApp verify token, App Secret and Graph access token must already be bound. Run: airodrom whatsapp bind');
  }
  if (refs.staging_active) {
    throw Error('WhatsApp verify-token rotation already staged. Run: airodrom whatsapp rollback-verify-token');
  }
  const preservedVerify = refs.slot_verify;
  const preservedApp = refs.slot_app;
  const preservedAccess = refs.slot_graph;

  let previous = '';
  let next = '';
  try {
    previous = vault.resolve(preservedVerify, 'whatsapp');
    next = generateVerifyToken();
    const stored = vault.put(next, 'whatsapp');
    const staged = await local.request(home, '/api/assistant/whatsapp/inbound/stage-verify-token', {
      confirmed: true,
      staged_verify_reference: stored.reference
    });
    if (staged?.slot_app !== preservedApp || staged?.slot_graph !== preservedAccess) {
      throw Error('App Secret or Graph access token reference changed unexpectedly');
    }
    if (staged?.slot_verify !== preservedVerify) {
      throw Error('Current verify token reference changed unexpectedly during staging');
    }
    if (staged?.slot_staged !== stored.reference) {
      throw Error('Staged verify token reference was not recorded');
    }

    const stagedOk = await probeWebhookChallenge(home, next, { finalizeStaged: false });
    const previousOk = await probeWebhookChallenge(home, previous, { finalizeStaged: false });
    if (stagedOk.accepted !== true) throw Error('Local webhook challenge did not accept the staged verify token');
    if (previousOk.accepted !== true) throw Error('Current verify token must remain accepted during staging');

    const afterProbe = await local.request(home, '/api/assistant/whatsapp/inbound/credential-references', { confirmed: true });
    if (!afterProbe.staging_active || afterProbe.slot_verify !== preservedVerify || afterProbe.slot_staged !== stored.reference) {
      throw Error('Staging was altered by local probe; refusing to continue');
    }
    if (afterProbe.slot_app !== preservedApp || afterProbe.slot_graph !== preservedAccess) {
      throw Error('App Secret or Graph access token reference changed after probe');
    }

    output.write('\nNew Meta webhook verify token (enter once in Meta App → WhatsApp → Configuration):\n\n');
    output.write(next + '\n\n');
    output.write('Shown once. Do not paste into chat, Git, Notion, or Mission results.\n');
    output.write('Staging active: current and staged tokens both accepted until Meta Verify, commit, rollback, or expiry.\n');
    output.write('Meta Verify and Save (non-probe) finalizes the new token and revokes the previous Keychain slot.\n');
    output.write('Manual finalize: airodrom whatsapp commit-verify-token\n');
    output.write('Rollback without finalize: airodrom whatsapp rollback-verify-token\n');
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
      staged: true,
      committed: false,
      slot_verify: preservedVerify,
      slot_staged: stored.reference,
      slot_app: preservedApp,
      slot_graph: preservedAccess,
      staging_expires_at: staged.staging_expires_at,
      challenge_staged_ok: true,
      challenge_previous_ok: true,
      probe_finalized: false,
      public_ingress: false,
      auto_mission_execution: false,
      values_displayed_once: true
    };
  } finally {
    previous = '';
    next = '';
  }
}

async function runRollbackVerifyToken(home, input, output, { signal } = {}) {
  if (!home || !input || !output) throw Error('WhatsApp verify-token rollback requires home, input and output');
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    throw Error('WhatsApp verify rollback requires an interactive operator terminal.');
  }
  const local = require('./local-bootstrap');
  output.write('WhatsApp verify-token staging rollback\n');
  output.write('Discards the staged candidate and keeps the current verify-token reference.\n');
  output.write('App Secret and Graph access token stay unchanged. Public ingress stays OFF.\n');
  if (!await confirm(input, output, { prompt: 'Rollback staged WhatsApp verify-token rotation now?', signal })) {
    output.write('WhatsApp verify-token rollback cancelled.\n');
    return { cancelled: true, public_ingress: false };
  }
  await ensureService(home);
  const result = await local.request(home, '/api/assistant/whatsapp/inbound/rollback-verify-token', { confirmed: true });
  output.write('Staged verify token discarded. Current verify token remains active.\n');
  output.write('Public ingress: OFF · Mission auto-dispatch: OFF\n');
  return { cancelled: false, ...result };
}

async function runCommitVerifyToken(home, input, output, { signal } = {}) {
  if (!home || !input || !output) throw Error('WhatsApp verify-token commit requires home, input and output');
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    throw Error('WhatsApp verify commit requires an interactive operator terminal.');
  }
  const local = require('./local-bootstrap');
  output.write('WhatsApp verify-token staging commit\n');
  output.write('Promotes the staged candidate and revokes the previous verify-token Keychain slot.\n');
  output.write('Use after Meta Verify and Save succeeded, or to finalize without another Meta challenge.\n');
  output.write('App Secret and Graph access token stay unchanged. Public ingress stays OFF.\n');
  if (!await confirm(input, output, { prompt: 'Commit staged WhatsApp verify-token rotation now?', signal })) {
    output.write('WhatsApp verify-token commit cancelled.\n');
    return { cancelled: true, public_ingress: false };
  }
  await ensureService(home);
  const before = await local.request(home, '/api/assistant/whatsapp/inbound/credential-references', { confirmed: true });
  const preservedApp = before.slot_app;
  const preservedAccess = before.slot_graph;
  const result = await local.request(home, '/api/assistant/whatsapp/inbound/commit-verify-token', { confirmed: true });
  if (result.slot_app !== preservedApp || result.slot_graph !== preservedAccess) {
    throw Error('App Secret or Graph access token reference changed during commit');
  }
  output.write('Staged verify token committed. Previous verify-token slot revoked.\n');
  output.write('Public ingress: OFF · Mission auto-dispatch: OFF\n');
  return { cancelled: false, ...result };
}

module.exports = {
  SLOTS,
  storeSlot,
  generateVerifyToken,
  rotateVerifyTokenSlot,
  probeWebhookChallenge,
  bindReferences,
  summarizeBinding,
  writeSummary,
  run,
  runDiscover,
  runConfigureTest,
  runPrepare,
  runStatus,
  runRotateVerifyToken,
  runRollbackVerifyToken,
  runCommitVerifyToken,
  vaultFor
};
