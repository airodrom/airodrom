'use strict';
// Host-authoritative natural-language Gmail write routing. Operator ingress only.
// Never parse retrieved email bodies through this module for instruction authority.

const { normalize } = require('./assistant-intent-text');

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

function recipientFromText(text) {
  const email = /\bto\s+(\S+@\S+)\b/i.exec(text);
  if (email) return email[1].replace(/[.,;:!?)]+$/, '');
  if (/\b(?:to\s+)?(?:myself|me)\b/i.test(text) || /\bsend\s+myself\b/i.test(text)) return 'myself';
  return null;
}

function testDefaults(text) {
  const isTest = /\btest\b/i.test(text);
  if (!isTest) return { subject: null, body: null };
  return {
    subject: 'Test',
    body: 'This is a test email from Airodrom. Nothing is sent until /gmail confirm <preview-id>.',
  };
}

/**
 * Catch natural-language send / send-preview requests that older patterns missed
 * (e.g. "Send a test email…", "show me the preview"). Must run before Gmail
 * search mutation refusal, which otherwise returns a read-only clarify.
 * @returns {object|null}
 */
function isSendPreviewRequest(text) {
  // Slash verbs are handled separately (approve/confirm/help). Never treat
  // "/gmail send …" as a natural-language send-preview staging request.
  if (/^\/gmail\b/i.test(text)) return null;
  const wantsPreview = /\bpreview\b/i.test(text) || /\bpreview[-\s]?id\b/i.test(text);
  const sendVerb = /\b(?:send|compose(?:\s+and\s+send)?)\b/i.test(text)
    || /\b(?:create|stage|prepare|generate|show)\b.+\b(?:send\s+)?preview\b/i.test(text)
    || /\bgmail\s+send\s+preview\b/i.test(text);
  const mailObject = /\b(?:email|mail|message|gmail)\b/i.test(text);
  if (!sendVerb || !mailObject) return null;
  // Leave non-send mailbox mutations to their dedicated parsers / search refuse.
  if (/\b(?:archive|trash|delete|label|forward|mark\s+(?:as\s+)?(?:read|unread))\b/i.test(text)
    && !/\bsend\b/i.test(text) && !wantsPreview) {
    return null;
  }

  const to = recipientFromText(text);
  const defaults = testDefaults(text);
  const subjectFrom = /(?:subject\s+)["“]?([^"”\n:]+)["”]?/i.exec(text);
  const bodyFrom = /:\s*(.+)$/s.exec(text);
  const subject = (subjectFrom && subjectFrom[1].trim()) || defaults.subject;
  const body = (bodyFrom && !subjectFrom && bodyFrom[1].trim()) || defaults.body;

  // Full enough to stage a durable preview (recipient + subject + body).
  if (to && subject && body) {
    return {
      kind: 'gmail_write',
      action: 'send',
      to,
      subject,
      body,
      wants_preview: true,
      route: 'GMAIL_WRITE',
      host_verified: true,
    };
  }

  // Send-shaped but incomplete — clarify on the write rail (never search refuse).
  let message = 'To stage a Gmail send preview, provide exact recipient, subject, and body. '
    + 'Example: Send email to person@example.com subject “Hello”: Your message here. '
    + 'Or: Send a test email to myself and show me the preview. '
    + 'Airodrom returns a preview ID; only /gmail confirm <preview-id> sends. '
    + '“Connected” for reading is not send authorization — need /connect gmail send (gmail.send) or /connect gmail manage.';
  if (to && !subject) {
    message = `Recipient noted (${to === 'myself' ? 'myself → authorized mailbox' : to}). Provide subject and body, or say “Send a test email to ${to === 'myself' ? 'myself' : to} and show me the preview”. Only /gmail confirm <preview-id> sends.`;
  }
  return {
    kind: 'gmail_write',
    action: 'send',
    to,
    subject,
    body,
    clarify: true,
    wants_preview: wantsPreview || true,
    message,
    route: 'GMAIL_WRITE',
    host_verified: true,
  };
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

  // Local draft (no send) stays on EMAIL_COMPOSE / CONNECTOR draft_reply paths.
  // Explicit send new mail — governed preview + /gmail confirm only.
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

  // Natural send / send-preview requests (must beat Gmail search mutation refusal).
  // Examples: "Send a test email to myself and show me the preview",
  // "Create a Gmail send preview for a test email to a@b.test".
  const sendShaped = isSendPreviewRequest(text);
  if (sendShaped) {
    return sendShaped;
  }

  if (/^(?:send|compose)\s+(?:an?\s+)?(?:email|mail|message)\b/i.test(text)
    || /^email\s+\S+@\S+\b/i.test(text)) {
    return {
      kind: 'gmail_write',
      action: 'send',
      clarify: true,
      message: 'To send mail, provide exact recipient, subject, and body. Example: Send email to person@example.com subject “Hello”: Your message here. Airodrom stages a preview ID first; only /gmail confirm <preview-id> sends. /connect gmail send (or manage) must be authorized — “connected” for reading is not enough.',
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

module.exports = { parse, normalize, helpControl, isSendPreviewRequest, recipientFromText };
