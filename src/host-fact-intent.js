'use strict';
// Deterministic NL → host-fact intents. Never invents measurements.

function soft(value) {
  let text = String(value || '')
    .normalize('NFKC')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:hi|hey|hello)[\s,:.!–—-]*/i, '')
    .trim();
  // Keep product name when it is the subject (health/status/services), not a vocative.
  if (!/^(?:airo(?:drom)?)\s+(?:health|status|services?)\b/i.test(text)) {
    text = text.replace(/^(?:airo(?:drom)?|airo)[,:!\s–—-]*/i, '').trim();
  }
  return text;
}

function parse(request) {
  if (typeof request !== 'string' || !request.trim()) return null;
  const text = soft(request);
  if (!text || Buffer.byteLength(text) > 4000) return null;

  // —— DATE_TIME ——
  if (/^(?:what(?:'s| is)|tell me)\s+(?:the\s+)?(?:current\s+)?(?:local\s+)?time(?:\s+is\s+it)?\??$/i.test(text)
    || /^what time is it\??$/i.test(text)
    || /^(?:current\s+)?(?:local\s+)?time\??$/i.test(text)
    || /^what(?:'s| is) the (?:current\s+)?(?:local\s+)?time\??$/i.test(text)) {
    return { kind: 'host_fact', fact: 'DATE_TIME', detail: 'time', route: 'HOST_FACT', host_verified: true };
  }
  if (/^(?:what(?:'s| is)|tell me)\s+(?:today'?s|the)\s+date\??$/i.test(text)
    || /^what(?:'s| is) today(?:'s date)?\??$/i.test(text)
    || /^(?:today'?s|current)\s+date\??$/i.test(text)
    || /^what day is (?:it|today)\??$/i.test(text)) {
    return { kind: 'host_fact', fact: 'DATE_TIME', detail: 'date', route: 'HOST_FACT', host_verified: true };
  }
  if (/^(?:what(?:'s| is)|tell me)\s+(?:the\s+)?(?:local\s+)?timezone\??$/i.test(text)
    || /^what timezone (?:am i in|is this|are we in)\??$/i.test(text)) {
    return { kind: 'host_fact', fact: 'DATE_TIME', detail: 'timezone', route: 'HOST_FACT', host_verified: true };
  }
  if (/^(?:what(?:'s| is)|tell me)\s+(?:the\s+)?(?:date and time|time and date)\??$/i.test(text)
    || /^(?:date and time|time and date)\??$/i.test(text)) {
    return { kind: 'host_fact', fact: 'DATE_TIME', detail: 'both', route: 'HOST_FACT', host_verified: true };
  }
  if (/^what(?:'s| is)\s+tomorrow(?:'s date)?\??$/i.test(text)
    || /^tomorrow(?:'s date)?\??$/i.test(text)) {
    return { kind: 'host_fact', fact: 'DATE_TIME', detail: 'tomorrow', route: 'HOST_FACT', host_verified: true };
  }

  // —— PORT_DIAGNOSTICS ——
  const portExact = /^(?:is|check(?:\s+if)?)\s+port\s+(\d{1,5})\s+(?:is\s+)?(?:in use|open|listening|bound|taken)\??$/i.exec(text)
    || /^port\s+(\d{1,5})\s*(?:in use|open|listening|status)?\??$/i.exec(text)
    || /^(?:what(?:'s| is)|check)\s+(?:the\s+)?status of port\s+(\d{1,5})\??$/i.exec(text);
  if (portExact) {
    const port = Number(portExact[1]);
    return { kind: 'host_fact', fact: 'PORT_DIAGNOSTICS', port, route: 'HOST_FACT', host_verified: true };
  }
  if (/^(?:which|what)\s+ports?\s+(?:are\s+)?(?:open|listening|in use)(?:\s+on\s+(?:my\s+)?(?:mac|machine|computer|host))?\??$/i.test(text)
    || /^(?:list|show)\s+(?:listening\s+)?(?:tcp\s+)?ports?(?:\s+on\s+(?:my\s+)?(?:mac|machine))?\??$/i.test(text)
    || /^what(?:'s| is)\s+listening(?:\s+on\s+(?:my\s+)?(?:mac|machine))?\??$/i.test(text)) {
    return { kind: 'host_fact', fact: 'PORT_DIAGNOSTICS', port: null, route: 'HOST_FACT', host_verified: true };
  }

  // —— AIRODROM_HEALTH (before generic services) ——
  if (/^(?:is|how(?:'s| is))\s+airodrom(?:\s+(?:healthy|doing|running|ok|okay))?\??$/i.test(text)
    || /^(?:airodrom|system)\s+(?:health|status)\??$/i.test(text)
    || /^(?:what(?:'s| is)|show|check)\s+(?:the\s+)?(?:airodrom\s+)?(?:health|status)(?:\s+of\s+airodrom)?\??$/i.test(text)
    || /^how healthy is airodrom\??$/i.test(text)
    || /^is (?:the\s+)?(?:local\s+)?(?:airodrom\s+)?(?:service|control(?:\s+plane)?)\s+(?:healthy|running|ok|okay)\??$/i.test(text)) {
    return { kind: 'host_fact', fact: 'AIRODROM_HEALTH', route: 'HOST_FACT', host_verified: true };
  }

  // —— SERVICE_STATUS ——
  if (/^(?:what|which)\s+services?\s+(?:are\s+)?(?:running|active)(?:\s+on\s+(?:my\s+)?(?:mac|machine))?\??$/i.test(text)
    || /^(?:list|show)\s+(?:running\s+)?(?:airodrom\s+)?services?\??$/i.test(text)
    || /^(?:what(?:'s| is)|show)\s+(?:the\s+)?(?:service|process)\s+(?:status|list)\??$/i.test(text)
    || /^which (?:airodrom\s+)?(?:services|processes) are running\??$/i.test(text)) {
    return { kind: 'host_fact', fact: 'SERVICE_STATUS', route: 'HOST_FACT', host_verified: true };
  }

  return null;
}

module.exports = { parse, soft };
