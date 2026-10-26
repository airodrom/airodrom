'use strict';
// Host-authoritative natural-language Calendar routing. Operator ingress only.
// Never parse retrieved event descriptions or invitation bodies through this module.

function normalize(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function dayToken(request) {
  if (/\btoday\b/i.test(request)) return 'today';
  if (/\btomorrow\b/i.test(request)) return 'tomorrow';
  const dow = /\b(?:on\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.exec(request);
  if (dow) return dow[1].toLowerCase();
  return null;
}

function helpControl(request) {
  const text = normalize(request);
  // Exact regression: "yes i want you help me to control calendar"
  if (/^(?:yes[,.]?\s+)?(?:i\s+)?(?:want\s+(?:you\s+)?(?:to\s+)?)?(?:help(?:\s+me)?(?:\s+to)?|assist(?:\s+me)?(?:\s+to)?)\s+(?:me\s+)?(?:to\s+)?(?:control|manage|handle|organize)\s+(?:my\s+)?(?:google\s+)?calendar\.?$/i.test(text)) {
    return { kind: 'calendar', action: 'help', route: 'CALENDAR', host_verified: true };
  }
  if (/^(?:help(?:\s+me)?(?:\s+to)?|i want you to help me)\s+(?:control|manage|handle|organize)\s+(?:my\s+)?(?:google\s+)?calendar\.?$/i.test(text)) {
    return { kind: 'calendar', action: 'help', route: 'CALENDAR', host_verified: true };
  }
  if (/^(?:control|manage|handle|organize)\s+(?:my\s+)?(?:google\s+)?calendar\.?$/i.test(text)) {
    return { kind: 'calendar', action: 'help', route: 'CALENDAR', host_verified: true };
  }
  if (/^(?:can you|could you|please)\s+(?:help(?:\s+me)?(?:\s+to)?\s+)?(?:control|manage|access|read|check|organize)\s+(?:my\s+)?(?:google\s+)?calendar\b/i.test(text)) {
    return { kind: 'calendar', action: 'help', route: 'CALENDAR', host_verified: true };
  }
  if (/^what can you (?:do|access|manage) (?:with|for) (?:my )?(?:google )?calendar/i.test(text)) {
    return { kind: 'calendar', action: 'help', route: 'CALENDAR', host_verified: true };
  }
  return null;
}

/**
 * Follow-ups that would otherwise hijack Gmail pagination or unrelated chat.
 * - Generic "show more" / "cancel that": only with an active verified Calendar session.
 * - Calendar-explicit ("show more events", "cancel that meeting"): calendar-shaped;
 *   execution still requires a bound active session.
 */
function followUp(request, { activeCalendarSession = false } = {}) {
  const text = normalize(request);
  if (/^(?:make|set|change)\s+(?:it\s+)?(?:to\s+)?(\d{1,3})\s*(?:min(?:ute)?s?)(?:\s+instead)?\.?$/i.test(text)) {
    if (!activeCalendarSession) return null;
    const m = text.match(/(\d{1,3})\s*(?:min(?:ute)?s?)/i);
    return { kind: 'calendar', action: 'followup_duration', minutes: Number(m[1]), route: 'CALENDAR', host_verified: true };
  }

  const cancelExplicit = /^(?:actually[,.]?\s+)?cancel(?:\s+(?:that|it))?\s+(?:the\s+)?(?:meeting|event|appointment)\.?$/i.test(text)
    || /^(?:actually[,.]?\s+)?cancel\s+(?:that|it)\s+(?:meeting|event|appointment)\.?$/i.test(text);
  const cancelGeneric = /^(?:actually[,.]?\s+)?cancel(?:\s+(?:that|it))?\.?$/i.test(text);
  if (cancelExplicit) {
    return { kind: 'calendar', action: 'followup_cancel', route: 'CALENDAR', host_verified: true, calendar_explicit: true };
  }
  if (cancelGeneric && activeCalendarSession) {
    return { kind: 'calendar', action: 'followup_cancel', route: 'CALENDAR', host_verified: true };
  }

  const moreExplicit = /^(?:show|get|list)?\s*(?:the\s+)?(?:next\s+page|more)\s+(?:of\s+)?(?:those\s+|the\s+)?(?:events?|meetings?|results)\.?$/i.test(text)
    || /^(?:show|get|list)\s+more\s+(?:calendar\s+)?(?:events?|meetings?)\.?$/i.test(text);
  const moreGeneric = /^(?:show|get|list)?\s*(?:the\s+)?(?:next\s+page|more(?:\s+results)?)\.?$/i.test(text);
  if (moreExplicit) {
    return { kind: 'calendar', action: 'continue', route: 'CALENDAR', host_verified: true, calendar_explicit: true };
  }
  if (moreGeneric && activeCalendarSession) {
    return { kind: 'calendar', action: 'continue', route: 'CALENDAR', host_verified: true };
  }
  return null;
}

function parse(request, { activeCalendarSession = false } = {}) {
  if (typeof request !== 'string' || !request.trim()) return null;
  const text = normalize(request);
  const help = helpControl(text);
  if (help) return help;
  const cont = followUp(text, { activeCalendarSession });
  if (cont) return cont;

  // Mutation verbs with incomplete details → clarify (never invent events).
  if (/\b(?:cancel|delete|remove)\b.+\b(?:meeting|event|appointment|calendar)\b/i.test(text)
    || /^(?:cancel|delete)\s+(?:my\s+)?(?:meeting|event|appointment)\b/i.test(text)) {
    return {
      kind: 'calendar',
      action: 'cancel',
      route: 'CALENDAR',
      clarify: true,
      message: 'Which event should be cancelled? First show your schedule (for example: “What’s on my calendar tomorrow?”), then say “cancel that” or name the exact event.',
      host_verified: true,
    };
  }
  if (/\b(?:move|reschedule|shift)\b.+\b(?:meeting|event|appointment)\b/i.test(text)
    || /^(?:move|reschedule)\s+(?:my\s+)?(?:meeting|event|appointment)\b/i.test(text)) {
    const to = /\bto\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2})\b/i.exec(text);
    return {
      kind: 'calendar',
      action: 'reschedule',
      route: 'CALENDAR',
      time_hint: to ? to[1] : null,
      day: dayToken(text),
      clarify: !to,
      message: to
        ? null
        : 'Which meeting should move, and to what time? Show the schedule first, then say e.g. “Move the 2 PM meeting to 3 PM.”',
      host_verified: true,
    };
  }
  // Explicit structured create before vague create clarify.
  const createExact = /^(?:create|schedule|add)\s+(?:calendar\s+)?(?:event|meeting)\s+(.+?)\s+(?:on\s+)?(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(?:from\s+)?(\d{1,2}:\d{2})\s*(?:to|-)\s*(\d{1,2}:\d{2})\s*$/i.exec(text);
  if (createExact) {
    return {
      kind: 'calendar',
      action: 'create',
      route: 'CALENDAR',
      summary: createExact[1].trim().slice(0, 200),
      day: createExact[2].toLowerCase(),
      start_hm: createExact[3],
      end_hm: createExact[4],
      clarify: false,
      host_verified: true,
    };
  }

  if (/\b(?:schedule|create|add|book)\b.+\b(?:meeting|event|appointment)\b/i.test(text)
    || /^(?:schedule|create|add|book)\s+(?:a\s+)?(?:meeting|event|appointment)\b/i.test(text)) {
    return {
      kind: 'calendar',
      action: 'create',
      route: 'CALENDAR',
      day: dayToken(text),
      raw: text,
      clarify: true,
      message: 'To schedule an event I need a title, start time, and end time (with timezone if not local). Example: “Create event Team sync tomorrow 14:00 to 14:30”. No invitations are sent until you confirm the preview.',
      host_verified: true,
    };
  }

  if (/^(?:list|show)\s+(?:my\s+)?calendars?\b/i.test(text)) {
    return { kind: 'calendar', action: 'list_calendars', route: 'CALENDAR', host_verified: true };
  }

  if (/\bam i (?:free|available)\b/i.test(text) || /\b(?:check|show)\s+(?:my\s+)?(?:availability|free time)\b/i.test(text)) {
    return {
      kind: 'calendar',
      action: 'freebusy',
      route: 'CALENDAR',
      day: dayToken(text) || 'today',
      afternoon: /\bafternoon\b/i.test(text),
      morning: /\bmorning\b/i.test(text),
      host_verified: true,
    };
  }

  if (/\b(?:search|find)\b.+\b(?:calendar|events?|meetings?)\b/i.test(text)
    || /^(?:search|find)\s+(?:my\s+)?(?:calendar|events?)\b/i.test(text)) {
    const q = text
      .replace(/^(?:search|find)\s+(?:my\s+)?(?:calendar|events?|meetings?)\s+(?:for\s+)?/i, '')
      .replace(/\b(?:on my calendar|in my calendar)\b/i, '')
      .trim()
      .slice(0, 200);
    if (!q || /^(?:events?|meetings?|calendar)$/i.test(q)) {
      return { kind: 'calendar', action: 'search', route: 'CALENDAR', clarify: true, message: 'What should I search for on your calendar?', host_verified: true };
    }
    return { kind: 'calendar', action: 'search', route: 'CALENDAR', query: q, host_verified: true };
  }

  if (
    /^(?:show|read|open|check)\s+(?:my\s+)?(?:schedule|calendar)(?:\s+(?:for\s+)?(today|tomorrow))?\??$/i.test(text)
    || /^(?:what(?:'s| is)|whats)\s+on\s+(?:my\s+)?calendar(?:\s+(today|tomorrow))?\??$/i.test(text)
    || /^(?:what(?:'s| is)|whats)\s+(?:my\s+)?schedule(?:\s+(today|tomorrow))?\??$/i.test(text)
    || /^calendar\s+(today|tomorrow)$/i.test(text)
  ) {
    return {
      kind: 'calendar',
      action: 'events',
      route: 'CALENDAR',
      day: dayToken(text) || 'today',
      host_verified: true,
    };
  }

  // Soft calendar-only help. Multi-service personal-ops keeps the matrix route.
  if (/\b(?:gmail|drive|sheets?|excel|job search|whatsapp)\b/i.test(text)
    && /\b(?:and|,)\b/i.test(text)
    && /\b(?:google\s+)?calendar\b/i.test(text)) {
    return null;
  }
  if (/\b(?:google\s+)?calendar\b/i.test(text) && /\b(?:help|control|manage|connect|access|authorize)\b/i.test(text)) {
    return { kind: 'calendar', action: 'help', route: 'CALENDAR', host_verified: true };
  }

  return null;
}

module.exports = { parse, normalize, helpControl, dayToken, followUp };
