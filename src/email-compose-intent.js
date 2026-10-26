'use strict';
// Host-owned local email composition. Never implies Gmail send or Gmail Drafts save.

function normalize(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function soft(value) {
  return normalize(value)
    .replace(/^(?:hi|hey|hello)[\s,:.!–—-]*/i, '')
    .replace(/^(?:airo(?:drom)?|airo)[,:!\s–—-]*/i, '')
    .trim();
}

/**
 * Local compose / revise intents. Distinct from Gmail send and Gmail Drafts.
 * @returns {object|null}
 */
function parse(request, { activeCompose = false } = {}) {
  if (typeof request !== 'string' || !request.trim()) return null;
  const text = soft(request);
  if (!text || Buffer.byteLength(text) > 4000) return null;

  // Explicit draft follow-ups — service clarifies when no draft exists in this conversation.
  if (/^(?:show|display|read)\s+(?:me\s+)?(?:the\s+)?(?:draft|email|message)\s*(?:again)?\.?$/i.test(text)
    || /^(?:show|display)\s+(?:it|that)\s+again\.?$/i.test(text)) {
    return { kind: 'email_compose', action: 'show', route: 'EMAIL_COMPOSE', host_verified: true };
  }
  if (activeCompose || /^(?:make|rewrite|edit)\s+(?:it|the\s+draft|the\s+email)\b/i.test(text)
    || /^(?:change|set)\s+(?:the\s+)?tone\b/i.test(text)
    || /^(?:add|include)\s+(?:my\s+)?(?:usual\s+)?signature\.?$/i.test(text)
    || /^(?:add|include)\s+(?:our|my)\s+(?:phone|telephone|phone\s+number)\b/i.test(text)
    || /^(?:use|include)\s+(?:my\s+)?(?:saved\s+)?(?:business|company)\s+address\.?$/i.test(text)) {
    if (/^(?:make|rewrite|edit)\s+(?:it|the\s+draft|the\s+email)\s+(?:more\s+)?(?:formal|professional)\.?$/i.test(text)
      || /^(?:change|set)\s+(?:the\s+)?tone\s+to\s+(?:more\s+)?formal\.?$/i.test(text)) {
      return { kind: 'email_compose', action: 'revise', revise: 'formal', route: 'EMAIL_COMPOSE', host_verified: true };
    }
    if (/^(?:make|rewrite)\s+(?:it|the\s+draft|the\s+email)\s+shorter\.?$/i.test(text)) {
      return { kind: 'email_compose', action: 'revise', revise: 'shorter', route: 'EMAIL_COMPOSE', host_verified: true };
    }
    if (/^(?:add|include)\s+(?:my\s+)?(?:usual\s+)?signature\.?$/i.test(text)) {
      return { kind: 'email_compose', action: 'revise', revise: 'signature', route: 'EMAIL_COMPOSE', host_verified: true };
    }
    if (/^(?:add|include)\s+(?:our|my)\s+(?:phone|telephone|phone\s+number)\b/i.test(text)) {
      return { kind: 'email_compose', action: 'revise', revise: 'phone', route: 'EMAIL_COMPOSE', host_verified: true };
    }
    if (/^(?:use|include)\s+(?:my\s+)?(?:saved\s+)?(?:business|company)\s+address\.?$/i.test(text)) {
      return { kind: 'email_compose', action: 'revise', revise: 'address', route: 'EMAIL_COMPOSE', host_verified: true };
    }
  }

  // Local compose — not Gmail send / not Gmail Drafts API.
  const compose =
    /^(?:draft|write|compose)\s+(?:an?\s+)?(?:email|mail|message)\b/i.test(text)
    || /^(?:draft|write|compose)\s+(?:an?\s+)?(?:professional\s+)?(?:reply|email)\b/i.test(text)
    || /\bdraft\s+(?:an?\s+)?email\b/i.test(text)
    || /\bwrite\s+(?:an?\s+)?(?:professional\s+)?(?:email|reply)\b/i.test(text);

  if (!compose) return null;

  // Explicit Gmail provider save/send stays out of this path.
  if (/\b(?:send|save to gmail|gmail draft|upload to gmail)\b/i.test(text)) return null;

  const wantsAddress = /\b(?:company(?:['’]s)?|business)\s+address\b/i.test(text)
    || /\b(?:include|use|add)\s+(?:my\s+)?(?:saved\s+)?(?:company(?:['’]s)?|business)\s+address\b/i.test(text)
    || /\binclude my company(?:['’]s)? business address\b/i.test(text);

  const toEmail = /\bto\s+(\S+@\S+)\b/i.exec(text);
  const toClient = /\bto\s+(?:a\s+|the\s+)?client\b/i.test(text);
  const toNamed = /\bto\s+([A-Z][A-Za-z0-9 .&'-]{1,60})\b/.exec(text);

  return {
    kind: 'email_compose',
    action: 'compose',
    route: 'EMAIL_COMPOSE',
    host_verified: true,
    local_only: true,
    gmail_write: false,
    include_company_address: wantsAddress,
    to: toEmail ? toEmail[1] : null,
    audience: toClient ? 'client' : (toNamed && !toEmail ? toNamed[1].trim() : null),
    raw: text,
  };
}

module.exports = { parse, normalize, soft };
