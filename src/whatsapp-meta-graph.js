'use strict';
// Non-secret Meta Graph discovery for WhatsApp Business ownership.
// Access tokens are caller-supplied and never logged or returned.

const META_ID = /^[0-9]{5,32}$/;
const GRAPH = 'https://graph.facebook.com/v21.0';

function redactError(error) {
  const code = error && (error.code || error.error_subcode || null);
  const type = error && error.type ? String(error.type).slice(0, 64) : null;
  const message = error && error.message
    ? String(error.message).replace(/[A-Za-z0-9_\-]{12,}/g, '[redacted]').slice(0, 160)
    : 'graph_request_failed';
  return { code: code == null ? null : Number(code) || null, type, message_class: message };
}

async function graphGet(pathname, accessToken, { fetchImpl = fetch, fields } = {}) {
  if (typeof accessToken !== 'string' || !accessToken || accessToken.includes('\0')) {
    throw Object.assign(new Error('Graph access token unavailable'), { code: 104, type: 'OAuthException' });
  }
  const url = new URL(GRAPH + pathname);
  if (fields) url.searchParams.set('fields', fields);
  url.searchParams.set('access_token', accessToken);
  const response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error) {
    const err = body.error || { message: 'HTTP ' + response.status, type: 'HTTP', code: response.status };
    throw Object.assign(new Error(redactError(err).message_class), redactError(err));
  }
  return body;
}

async function discoverOwnedWhatsApp({
  accessToken,
  businessPortfolioId,
  fetchImpl = fetch,
  appId = null
} = {}) {
  if (!META_ID.test(String(businessPortfolioId || ''))) {
    throw Object.assign(new Error('Business Portfolio ID required'), { code: null, type: 'ConfigError' });
  }
  const accounts = await graphGet(
    `/${businessPortfolioId}/owned_whatsapp_business_accounts`,
    accessToken,
    { fetchImpl, fields: 'id,name' }
  );
  const list = Array.isArray(accounts.data) ? accounts.data : [];
  const waba = list.find(a => META_ID.test(String(a.id || ''))) || null;
  if (!waba) {
    return {
      graph_access: 'authorized',
      waba_id: null,
      phone_number_id: null,
      waba_count: list.length,
      phone_count: 0,
      app_id: appId,
      business_portfolio_id: businessPortfolioId,
      permissions_readable: false,
      note: 'Graph authorized but no owned WhatsApp Business Account was returned for this portfolio.'
    };
  }
  const phones = await graphGet(`/${waba.id}/phone_numbers`, accessToken, {
    fetchImpl,
    fields: 'id,display_phone_number,verified_name'
  });
  const phoneList = Array.isArray(phones.data) ? phones.data : [];
  const phone = phoneList.find(p => META_ID.test(String(p.id || ''))) || null;
  return {
    graph_access: 'authorized',
    waba_id: String(waba.id),
    phone_number_id: phone ? String(phone.id) : null,
    waba_count: list.length,
    phone_count: phoneList.length,
    app_id: appId,
    business_portfolio_id: businessPortfolioId,
    // Never return display phone numbers into durable docs/events — ID only.
    permissions_readable: true,
    note: phone
      ? 'WABA and Phone Number ID discovered via authorized Graph. Display numbers withheld.'
      : 'WABA discovered; no phone number ID returned for this account.'
  };
}

async function probePublicApp(appId, { fetchImpl = fetch } = {}) {
  if (!META_ID.test(String(appId || ''))) throw Error('Invalid Meta App ID');
  const url = new URL(`${GRAPH}/${appId}`);
  url.searchParams.set('fields', 'id,name');
  const response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error) {
    return { graph_access: 'refused', app_id: null, app_name: null, error: redactError(body.error || { code: response.status }) };
  }
  return {
    graph_access: 'public_app_only',
    app_id: META_ID.test(String(body.id || '')) ? String(body.id) : null,
    app_name: typeof body.name === 'string' && body.name.length <= 80 ? body.name : null,
    error: null
  };
}

module.exports = { discoverOwnedWhatsApp, probePublicApp, redactError, GRAPH, META_ID };
