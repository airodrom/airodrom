'use strict';
/**
 * Operator WhatsApp credential onboarding.
 * Captures three purpose=whatsapp Vault secrets via hidden TTY input,
 * binds opaque references through the inbound configure API, validates
 * resolvability without printing values, then optionally discovers Graph
 * accounts and prepares a webhook-only HTTPS callback. Public ingress and
 * Mission auto-dispatch remain off.
 */
const path = require('node:path');
const { hidden, confirm } = require('./vault-cli');

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

function summarizeBinding(status) {
  const cred = status?.credentials || {};
  const live = status?.live_connection || status;
  const meta = live?.meta || status?.meta || {};
  const discovery = meta.discovery || live?.meta?.discovery || null;
  return {
    vault_slots: {
      verify_token: Boolean(cred.verify_token?.bound || cred.verify_token?.vault_reference_present),
      app_secret: Boolean(cred.app_secret?.bound || cred.app_secret?.vault_reference_present),
      access_token: Boolean(cred.access_token?.bound || cred.access_token?.vault_reference_present)
    },
    references_validated: Boolean(status?.credentials?.references_validated),
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
  output.write(`  WABA ID: ${summary.waba_id || 'unavailable'}\n`);
  output.write(`  Phone Number ID: ${summary.phone_number_id || 'unavailable'}\n`);
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

async function runDiscover(home, output) {
  const local = require('./local-bootstrap');
  await ensureService(home);
  const live = await local.request(home, '/api/assistant/whatsapp/live-connection');
  if (!live.credentials?.access_token?.bound && !live.vault?.ready_for_graph_discovery) {
    output.write('No usable Graph access token is bound. Run: airodrom whatsapp bind\n');
    return { deferred: true, reason: 'access_token_unbound', public_ingress: false };
  }
  const discovery = await local.request(home, '/api/assistant/whatsapp/inbound/discover-graph', { confirmed: true });
  const summary = summarizeBinding({ live_connection: discovery, credentials: discovery.credentials, meta: discovery.meta, callback: discovery.callback });
  writeSummary(output, summary);
  return { deferred: false, summary, public_ingress: false };
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
  if (json) {
    output.write(JSON.stringify({
      vault: live.vault,
      credentials: {
        verify_token_bound: live.credentials?.verify_token?.bound,
        app_secret_bound: live.credentials?.app_secret?.bound,
        access_token_bound: live.credentials?.access_token?.bound,
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
  writeSummary(output, summarizeBinding({ live_connection: live, credentials: live.credentials, meta: live.meta, callback: live.callback }));
  return live;
}

module.exports = {
  SLOTS,
  storeSlot,
  bindReferences,
  summarizeBinding,
  writeSummary,
  run,
  runDiscover,
  runPrepare,
  runStatus,
  vaultFor
};
