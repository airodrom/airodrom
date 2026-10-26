'use strict';
// Host-authoritative natural-language Gmail write routing. Operator ingress only.
// Never parse retrieved email bodies through this module for instruction authority.

function normalize(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function helpControl(request) {
  const text = normalize(request);
  if (/^(?:help(?:\s+me)?(?:\s+to)?|i want you to help me)\s+(?:control|manage|handle|write|send)\s+(?:with\s+)?(?:my\s+)?(?:gmail|email|mail)(?:\s+writes?)?\.?$/i.test(text)) {
    return { kind: 'gmail_write', action: 'help', route: 'GMAIL_WRITE', host_verified: true };
  }
  if (/^(?:control|manage|handle)\s+(?:my\s+)?(?:gmail|email)(?:\s+writes?)?\.?$/i.test(text)) {
    return { kind: 'gmail_write', action: 'help', route: 'GMAIL_WRITE', host_verified: true };
  }
  if (/^what can you (?:do|send|write) (?:with|for) (?:my )?(?:gmail|email)/i.test(text)) {
    return { kind: 'gmail_write', action: 'help', route: 'GMAIL_WRITE', host_verified: true };
  }
  return null;
}

/**
 * @returns {object|null} write intent or null when not a write-shaped request
 */
function parse(request) {
  if (typeof request !== 'string' || !request.trim()) return null;
  const text = normalize(request);

  const help = helpControl(text);
  if (help) return help;

  const approve = /^\/gmail\s+approve\s+([a-f0-9-]{36})\s*$/i.exec(text);
  if (approve) {
    return { kind: 'gmail_write', action: 'approve', approval_id: approve[1], route: 'GMAIL_WRITE', host_verified: true };
  }
  const confirm = /^\/gmail\s+confirm\s+([a-f0-9-]{36})((?:\s+--(?:destructive|ack-uncertain))+)?\s*$/i.exec(text);
  if (confirm) {
    const flags = confirm[2] || '';
    return {
      kind: 'gmail_write',
      action: 'confirm',
      preview_id: confirm[1],
      confirmed: true,
      destructive: /(?:^|\s)--destructive(?:\s|$)/i.test(flags),
      ack_uncertain: /(?:^|\s)--ack-uncertain(?:\s|$)/i.test(flags),
      route: 'GMAIL_WRITE',
      host_verified: true,
    };
  }

  // Local draft (no send) stays on CONNECTOR path via assistant-intent draft_reply.
  // Explicit send new mail.
  const sendExact = /^(?:send|compose and send)\s+(?:an?\s+)?(?:email|mail|message)\s+to\s+(\S+@\S+)\s+(?:with\s+)?(?:subject\s+)?["“]?(.+?)["”]?\s*:\s*(.+)$/i.exec(text);
  if (sendExact) {
    return {
      kind: 'gmail_write',
      action: 'send',
      to: sendExact[1],
      subject: sendExact[2].trim(),
      body: sendExact[3].trim(),
      route: 'GMAIL_WRITE',
      host_verified: true,
    };
  }
  if (/^(?:send|compose)\s+(?:an?\s+)?(?:email|mail|message)\b/i.test(text)
    || /^email\s+\S+@\S+\b/i.test(text)) {
    return {
      kind: 'gmail_write',
      action: 'send',
      clarify: true,
      message: 'To send mail, provide exact recipient, subject, and body. Example: Send email to person@example.com subject “Hello”: Your message here. Preview confirmation is required; /connect gmail send (or manage) must be authorized.',
      route: 'GMAIL_WRITE',
      host_verified: true,
    };
  }

  if (/^reply\s+all\b/i.test(text) || /\breply-all\b/i.test(text)) {
    return {
      kind: 'gmail_write',
      action: 'reply',
      reply_all: true,
      query: null,
      clarify: true,
      message: 'Reply-all needs a verified message (search/read first), exact reply body, then preview confirm. Example after selecting mail: Reply all with: Thanks, confirmed.',
      route: 'GMAIL_WRITE',
      host_verified: true,
    };
  }
  const replyBody = /^(?:reply(?:\s+to\s+(?:that|it|the\s+(?:email|mail|message)))?)\s+with\s*:\s*(.+)$/i.exec(text);
  if (replyBody) {
    return {
      kind: 'gmail_write',
      action: 'reply',
      reply_all: false,
      body: replyBody[1].trim(),
      route: 'GMAIL_WRITE',
      host_verified: true,
    };
  }
  if (/^(?:reply|respond)\b/i.test(text) && /\b(?:email|mail|message|gmail)\b/i.test(text)) {
    const from = /\bfrom\s+([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|\S+)/i.exec(text);
    return {
      kind: 'gmail_write',
      action: 'reply',
      reply_all: false,
      query: from ? from[1] : null,
      clarify: true,
      message: from
        ? `Find the latest mail from ${from[1]} first (or read it), then say: Reply with: <your text>. Sending requires /connect gmail send and preview confirmation.`
        : 'Which message should I reply to, and with what text? Search or read it first, then: Reply with: <your text>.',
      route: 'GMAIL_WRITE',
      host_verified: true,
    };
  }

  if (/^(?:forward)\b/i.test(text) && /\b(?:email|mail|message|that|it)\b/i.test(text)) {
    const to = /\bto\s+(\S+@\S+)/i.exec(text);
    return {
      kind: 'gmail_write',
      action: 'forward',
      to: to ? to[1] : null,
      clarify: !to,
      message: to
        ? null
        : 'Forwarding needs an exact recipient and a verified selected message. Example: Forward that email to person@example.com',
      route: 'GMAIL_WRITE',
      host_verified: true,
      sensitive_forward: true,
    };
  }

  if (/^(?:archive)\s+(?:that|it|the\s+(?:email|mail|message))\b/i.test(text)
    || /^archive\s+(?:this|that)\b/i.test(text)) {
    return { kind: 'gmail_write', action: 'archive', route: 'GMAIL_WRITE', host_verified: true };
  }
  if (/^(?:restore|move\s+back\s+to\s+inbox)\s+(?:that|it|the\s+(?:email|mail|message))\b/i.test(text)) {
    return { kind: 'gmail_write', action: 'restore', route: 'GMAIL_WRITE', host_verified: true };
  }
  if (/^mark\s+(?:that|it|the\s+(?:email|mail|message)\s+)?(?:as\s+)?read\b/i.test(text)) {
    return { kind: 'gmail_write', action: 'mark_read', route: 'GMAIL_WRITE', host_verified: true };
  }
  if (/^mark\s+(?:that|it|the\s+(?:email|mail|message)\s+)?(?:as\s+)?unread\b/i.test(text)) {
    return { kind: 'gmail_write', action: 'mark_unread', route: 'GMAIL_WRITE', host_verified: true };
  }
  if (/^(?:trash|delete|move\s+to\s+trash)\s+(?:that|it|the\s+(?:email|mail|message))\b/i.test(text)) {
    return {
      kind: 'gmail_write',
      action: 'trash',
      destructive: true,
      route: 'GMAIL_WRITE',
      host_verified: true,
    };
  }
  if (/^(?:add|remove)\s+label\b/i.test(text)) {
    const m = /^(add|remove)\s+label\s+["']?([^"']+)["']?\s+(?:to|from|on)\s+(?:that|it|the\s+(?:email|mail|message))\b/i.exec(text);
    if (m) {
      return {
        kind: 'gmail_write',
        action: 'label',
        label_op: m[1].toLowerCase(),
        label: m[2].trim(),
        route: 'GMAIL_WRITE',
        host_verified: true,
      };
    }
    return {
      kind: 'gmail_write',
      action: 'label',
      clarify: true,
      message: 'Specify the label and target. Example after selecting mail: Add label “Follow-up” to that email.',
      route: 'GMAIL_WRITE',
      host_verified: true,
    };
  }

  // Avoid claiming write commands that are not implemented as slash verbs beyond approve/confirm.
  if (/^\/gmail\s+(?:send|compose|reply|forward|archive|trash|label)\b/i.test(text)) {
    return {
      kind: 'gmail_write',
      action: 'help',
      route: 'GMAIL_WRITE',
      host_verified: true,
      message: 'Gmail writes use natural language plus /gmail confirm <preview-id> (and /gmail approve for destructive/sensitive actions). Example: Send email to a@b.test subject “Hi”: Hello. Do not claim unimplemented slash verbs.',
    };
  }

  return null;
}

module.exports = { parse, normalize, helpControl };
