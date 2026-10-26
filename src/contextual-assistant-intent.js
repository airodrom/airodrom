'use strict';
// Deterministic multi-source composition intents. Allowlisted plans only.

function soft(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:hi|hey|hello)[\s,:.!–—-]*/i, '')
    .replace(/^(?:airo(?:drom)?|airo)[,:!\s–—-]*/i, '')
    .trim();
}

/**
 * @returns {{ kind: string, composition: string, plan: string[], route: string, host_verified: boolean, raw?: string } | null}
 */
function parse(request) {
  if (typeof request !== 'string' || !request.trim()) return null;
  const text = soft(request);
  if (!text || Buffer.byteLength(text) > 4000) return null;

  // MEMORY_ADDRESS + HOST_DATE + LOCAL_COMPOSE
  // "Draft an email to my business partner using my company's address and today's date."
  if (
    /^(?:draft|write|compose)\s+(?:an?\s+)?(?:email|mail|message)\b/i.test(text)
    && /\b(?:company(?:['’]s)?|business)\s+address\b/i.test(text)
    && /\b(?:today(?:['’]s)?\s+date|current\s+date)\b/i.test(text)
  ) {
    const toPartner = /\bto\s+(?:my\s+)?(?:business\s+)?partner\b/i.test(text);
    const toEmail = /\bto\s+(\S+@\S+)\b/i.exec(text);
    return {
      kind: 'contextual_assistant',
      composition: 'MEMORY_DATE_COMPOSE',
      plan: ['memory_address', 'host_date', 'local_compose'],
      route: 'CONTEXTUAL_ASSISTANT',
      host_verified: true,
      audience: toPartner ? 'business partner' : (toEmail ? toEmail[1] : null),
      include_address: true,
      include_date: true,
      raw: text,
    };
  }

  // CALENDAR_TOMORROW + LOCAL_COMPOSE_FOLLOWUP
  // "Find my meeting tomorrow and draft a follow-up email."
  if (
    /^(?:find|show|get|check)\s+(?:my\s+)?(?:meeting|meetings|event|events|appointment)\b/i.test(text)
    && /\btomorrow\b/i.test(text)
    && /\b(?:draft|write|compose)\b.*\b(?:follow[- ]?up|email|mail|message)\b/i.test(text)
  ) {
    return {
      kind: 'contextual_assistant',
      composition: 'CALENDAR_FOLLOWUP_COMPOSE',
      plan: ['calendar_tomorrow', 'local_compose'],
      route: 'CONTEXTUAL_ASSISTANT',
      host_verified: true,
      day: 'tomorrow',
      raw: text,
    };
  }
  if (
    /^(?:draft|write|compose)\s+(?:an?\s+)?(?:follow[- ]?up\s+)?(?:email|mail)\b/i.test(text)
    && /\b(?:meeting|event|appointment)\b/i.test(text)
    && /\btomorrow\b/i.test(text)
  ) {
    return {
      kind: 'contextual_assistant',
      composition: 'CALENDAR_FOLLOWUP_COMPOSE',
      plan: ['calendar_tomorrow', 'local_compose'],
      route: 'CONTEXTUAL_ASSISTANT',
      host_verified: true,
      day: 'tomorrow',
      raw: text,
    };
  }

  // AIRODROM_HEALTH + explain
  // "Check whether Airodrom is healthy and tell me what's wrong."
  if (
    /^(?:check|tell me|show)\b.*\bairodrom\b.*\b(?:healthy|health|status)\b/i.test(text)
    || /^(?:is|how(?:'s| is))\s+airodrom\b.*\b(?:healthy|health)\b/i.test(text)
  ) {
    if (/\b(?:what(?:'s| is)\s+wrong|what(?:'s| is)\s+(?:degraded|failing|broken)|tell me what(?:'s| is) wrong|summarize|explain)\b/i.test(text)
      || /\band\b.*\b(?:what|tell|explain)\b/i.test(text)) {
      return {
        kind: 'contextual_assistant',
        composition: 'HEALTH_EXPLAIN',
        plan: ['airodrom_health', 'explain_observed'],
        route: 'CONTEXTUAL_ASSISTANT',
        host_verified: true,
        raw: text,
      };
    }
  }

  return null;
}

module.exports = { parse, soft };
