'use strict';
// Host-mediated local email composition with Personal Memory V2 grounding.
// Never sends or saves to Gmail. Memory text is untrusted reference data.
const { EmailComposeSessions } = require('./email-compose-session');
const { secret } = require('./assistant-intent');

function sessions(server) {
  if (!server.emailComposeSessions) server.emailComposeSessions = new EmailComposeSessions();
  return server.emailComposeSessions;
}

function requireConversation(conversation_id) {
  if (typeof conversation_id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(conversation_id)) {
    return {
      kind: 'clarify',
      route: 'EMAIL_COMPOSE',
      message: 'Email composition requires an authenticated Terminal conversation session. Re-open the interactive chat and try again.',
      authority: false,
      host_verified: true,
      model_invoked: false,
      code: 'email_compose_session_required',
    };
  }
  return null;
}

function sanitizeMemoryText(value) {
  const raw = String(value || '');
  if (secret(raw)) return null;
  // Strip instruction-like lines from retrieved memory before drafting.
  return raw
    .split(/\r?\n/)
    .filter((line) => !/^\s*(ignore|system|assistant|tool)\b/i.test(line))
    .join('\n')
    .slice(0, 500)
    .trim();
}

function lookupCompanyAddress(server) {
  const memory = server.bridge?.personalMemory;
  if (!memory || typeof memory.search !== 'function') {
    return { status: 'unavailable', items: [], message: 'Personal Memory is unavailable; no address was invented.' };
  }
  const queries = [
    'company business address',
    'business address',
    'company address',
    'office address',
  ];
  const found = [];
  const seen = new Set();
  for (const q of queries) {
    let result;
    try {
      result = memory.search(q, { domain: 'personal', limit: 6, includeSensitive: false });
    } catch {
      return { status: 'unavailable', items: [], message: 'Personal Memory search failed closed; no address was invented.' };
    }
    for (const item of result.items || []) {
      if (seen.has(item.memoryId)) continue;
      if (item.sensitivity && item.sensitivity !== 'normal') continue;
      const subject = String(item.subject || '').toLowerCase();
      const content = String(item.content || '');
      if (!/address|office|headquarters|hq\b/i.test(subject + ' ' + content)) continue;
      const cleaned = sanitizeMemoryText(content);
      if (!cleaned) continue;
      seen.add(item.memoryId);
      found.push({
        memoryId: item.memoryId,
        subject: item.subject,
        content: cleaned,
        updated_at: item.updated_at || item.updatedAt || null,
      });
    }
  }
  if (!found.length) {
    return { status: 'missing', items: [], message: 'No current ordinary company/business address was found in Personal Memory V2. I did not invent one. Save it with /remember, or tell me the address to include for this draft only.' };
  }
  if (found.length > 1) {
    return {
      status: 'ambiguous',
      items: found.slice(0, 5),
      message: 'Multiple ordinary address facts matched. Which should I use?\n'
        + found.slice(0, 5).map((f, i) => `${i + 1}. ${f.subject || 'address'} — ${f.content.slice(0, 120)}`).join('\n'),
    };
  }
  return { status: 'found', items: found, address: found[0].content, memoryId: found[0].memoryId };
}

function formatDraft(draft) {
  const lines = [
    'Local email draft (not saved to Gmail, not sent):',
    `To: ${draft.to || '(recipient needed)'}`,
    `Subject: ${draft.subject || '(subject needed)'}`,
    '',
    draft.body || '',
    '',
    'Capabilities: local compose only. Saving to Gmail Drafts or sending requires a separate authorized Gmail write capability.',
  ];
  return lines.join('\n');
}

function buildBody({ audience, address, purpose, tone = 'professional' }) {
  const who = audience === 'client' ? 'valued client' : (audience || 'there');
  const opener = tone === 'formal'
    ? `Dear ${who},`
    : `Hello ${who},`;
  const purposeLine = purpose
    ? purpose
    : 'I am writing regarding our ongoing work together.';
  const addressBlock = address
    ? `\n\nOur business address:\n${address}`
    : '';
  const close = tone === 'formal'
    ? '\n\nYours sincerely,\n'
    : '\n\nBest regards,\n';
  return `${opener}\n\n${purposeLine}${addressBlock}${close}`.trim();
}

async function run(server, parsed, { conversation_id = null } = {}) {
  const host_verified = true;
  const model_invoked = false;
  const missing = requireConversation(conversation_id);
  if (missing) return missing;

  const store = sessions(server);

  if (parsed.action === 'show') {
    const draft = store.get({ conversation_id, operator: 'operator' });
    if (!draft) {
      return {
        kind: 'clarify',
        route: 'EMAIL_COMPOSE',
        message: 'No local email draft is active in this conversation. Ask me to draft an email first.',
        host_verified,
        model_invoked,
        authority: false,
      };
    }
    return {
      kind: 'email_compose',
      action: 'show',
      route: 'EMAIL_COMPOSE',
      draft_id: draft.id,
      draft: { to: draft.to, subject: draft.subject, body: draft.body, local_only: true },
      message: formatDraft(draft),
      gmail_saved: false,
      gmail_sent: false,
      host_verified,
      model_invoked,
      authority: false,
    };
  }

  if (parsed.action === 'revise') {
    const draft = store.get({ conversation_id, operator: 'operator' });
    if (!draft) {
      return {
        kind: 'clarify',
        route: 'EMAIL_COMPOSE',
        message: 'No local draft to revise in this conversation. Draft an email first.',
        host_verified,
        model_invoked,
        authority: false,
      };
    }
    let next = { ...draft };
    if (parsed.revise === 'formal') {
      next.tone = 'formal';
      next.body = buildBody({
        audience: draft.audience,
        address: draft.address || null,
        purpose: draft.purpose,
        tone: 'formal',
      });
      if (draft.signature) next.body += draft.signature;
    } else if (parsed.revise === 'shorter') {
      next.body = String(draft.body || '')
        .split(/\n\n+/)
        .slice(0, 3)
        .join('\n\n')
        .slice(0, 800);
    } else if (parsed.revise === 'signature') {
      const sigLookup = lookupCompanyAddress(server);
      const sig = '\n—\n' + (draft.address || (sigLookup.status === 'found' ? sigLookup.address : 'Sent via Airo local draft'));
      next.signature = sig;
      if (!/\n—\n/.test(next.body || '')) next.body = (next.body || '') + sig;
    } else if (parsed.revise === 'phone') {
      let phone = null;
      try {
        const hits = server.bridge.personalMemory.search('phone number', { domain: 'personal', limit: 4, includeSensitive: false });
        for (const item of hits.items || []) {
          const cleaned = sanitizeMemoryText(item.content);
          if (cleaned && /\+?\d[\d\s().-]{6,}/.test(cleaned)) { phone = cleaned; break; }
        }
      } catch { /* */ }
      if (!phone) {
        return {
          kind: 'clarify',
          route: 'EMAIL_COMPOSE',
          message: 'No ordinary phone number was found in Personal Memory. Tell me the number to add, or save it with /remember first. The current draft was preserved.',
          draft_id: draft.id,
          message_draft: formatDraft(draft),
          host_verified,
          model_invoked,
          authority: false,
        };
      }
      next.body = (next.body || '') + `\nPhone: ${phone}`;
    } else if (parsed.revise === 'address') {
      const lookup = lookupCompanyAddress(server);
      if (lookup.status !== 'found') {
        return {
          kind: 'clarify',
          route: 'EMAIL_COMPOSE',
          message: lookup.message,
          choices: lookup.items,
          draft_id: draft.id,
          host_verified,
          model_invoked,
          authority: false,
        };
      }
      next.address = lookup.address;
      next.address_memory_id = lookup.memoryId;
      next.body = buildBody({
        audience: draft.audience,
        address: lookup.address,
        purpose: draft.purpose,
        tone: draft.tone || 'professional',
      });
    }
    const saved = store.put(next, { conversation_id, operator: 'operator' });
    return {
      kind: 'email_compose',
      action: 'revised',
      route: 'EMAIL_COMPOSE',
      draft_id: saved.id,
      draft: { to: saved.to, subject: saved.subject, body: saved.body, local_only: true },
      message: formatDraft(saved),
      gmail_saved: false,
      gmail_sent: false,
      host_verified,
      model_invoked,
      authority: false,
    };
  }

  // Compose
  let address = null;
  let address_memory_id = null;
  let address_note = null;
  if (parsed.include_company_address) {
    const lookup = lookupCompanyAddress(server);
    if (lookup.status === 'ambiguous') {
      return {
        kind: 'clarify',
        route: 'EMAIL_COMPOSE',
        message: lookup.message,
        choices: lookup.items,
        host_verified,
        model_invoked,
        authority: false,
        code: 'email_compose_address_ambiguous',
      };
    }
    if (lookup.status === 'missing' || lookup.status === 'unavailable') {
      address_note = lookup.message;
    } else {
      address = lookup.address;
      address_memory_id = lookup.memoryId;
    }
  }

  const clarifications = [];
  if (!parsed.to && !parsed.audience) {
    clarifications.push('Who is the recipient (name or email)?');
  }
  if (!/\b(?:about|regarding|re:|subject)\b/i.test(parsed.raw || '')) {
    clarifications.push('What is the purpose or subject of the email?');
  }

  const audience = parsed.audience || (parsed.to ? parsed.to : 'client');
  const subject = parsed.to || parsed.audience
    ? 'Following up'
    : 'Following up';
  const body = buildBody({
    audience,
    address,
    purpose: null,
    tone: 'professional',
  });

  const draft = store.put({
    to: parsed.to || null,
    audience: parsed.audience || (parsed.to ? null : 'client'),
    subject,
    body,
    address,
    address_memory_id,
    purpose: null,
    tone: 'professional',
    include_company_address: !!parsed.include_company_address,
  }, { conversation_id, operator: 'operator' });

  let message = formatDraft(draft);
  if (address_note) message += '\n\n' + address_note;
  if (clarifications.length) {
    message += '\n\nTo finish the draft, please tell me:\n• ' + clarifications.join('\n• ');
  }
  message += '\n\nYou can say “Make it more formal”, “Make it shorter”, or “Show me the draft again”. This did not send or save to Gmail.';

  return {
    kind: 'email_compose',
    action: 'composed',
    route: 'EMAIL_COMPOSE',
    draft_id: draft.id,
    draft: { to: draft.to, subject: draft.subject, body: draft.body, local_only: true },
    address_included: !!address,
    address_memory_id,
    gmail_saved: false,
    gmail_sent: false,
    local_only: true,
    message,
    host_verified,
    model_invoked,
    authority: false,
  };
}

module.exports = { run, sessions, lookupCompanyAddress, formatDraft, buildBody };
