'use strict';
// Allowlisted multi-source compositions. Host facts + connectors + memory only.
// Never invents measurements. Never sends Gmail. Never grants Mission authority.

const composeService = require('./email-compose-service');
const hostFacts = require('./host-fact-service');
const { secret } = require('./assistant-intent');

const ALLOWED = Object.freeze({
  MEMORY_DATE_COMPOSE: ['memory_address', 'host_date', 'local_compose'],
  CALENDAR_FOLLOWUP_COMPOSE: ['calendar_tomorrow', 'local_compose'],
  MEETING_FOLLOWUP_SEND: ['calendar_tomorrow', 'memory_company', 'local_compose', 'gmail_preview'],
  HEALTH_EXPLAIN: ['airodrom_health', 'explain_observed'],
});

/** Product-facing workflow states — never equate chat text with authenticated approval. */
const WORKFLOW = Object.freeze({
  DRAFT_READY: 'draft_ready',
  APPROVAL_REQUIRED: 'approval_required',
  SENDING: 'sending',
  SENT_CONFIRMED: 'sent_and_provider_confirmed',
  DELIVERY_UNCERTAIN: 'delivery_uncertain',
  NOT_AUTHORIZED: 'not_authorized',
  CLARIFY: 'clarify',
});

function base(extra = {}) {
  return {
    kind: 'contextual_assistant',
    route: 'CONTEXTUAL_ASSISTANT',
    host_verified: true,
    model_invoked: false,
    authority: false,
    execution_authorized: false,
    gmail_sent: false,
    gmail_saved: false,
    local_only: true,
    ...extra,
  };
}

function deny(message, code, extra = {}) {
  return base({ kind: 'clarify', message, code, ...extra });
}

function sanitizeUntrusted(value) {
  const raw = String(value || '');
  if (secret(raw)) return '[Sensitive content withheld]';
  return raw
    .split(/\r?\n/)
    .filter((line) => !/^\s*(ignore|system|assistant|tool|execute|sudo)\b/i.test(line))
    .join('\n')
    .slice(0, 800)
    .trim();
}

function planAllowed(parsed) {
  const expected = ALLOWED[parsed.composition];
  if (!expected) return false;
  if (!Array.isArray(parsed.plan) || parsed.plan.length !== expected.length) return false;
  return expected.every((step, i) => parsed.plan[i] === step);
}

async function memoryDateCompose(server, parsed, { conversation_id }) {
  const evidence = { memory: null, date: null };
  const addressLookup = composeService.lookupCompanyAddress(server);
  evidence.memory = { status: addressLookup.status };

  if (addressLookup.status === 'ambiguous') {
    return deny(addressLookup.message, 'memory_address_ambiguous', {
      composition: parsed.composition,
      evidence,
    });
  }
  if (addressLookup.status === 'missing' || addressLookup.status === 'unavailable') {
    return deny(
      (addressLookup.message || 'No ordinary company address found.') + ' I did not invent an address.',
      'memory_address_' + addressLookup.status,
      { composition: parsed.composition, evidence }
    );
  }

  const dateFact = hostFacts.answerDateTime('date');
  evidence.date = {
    date: dateFact.clock?.date || null,
    timezone: dateFact.clock?.timezone || null,
    epoch_ms: dateFact.clock?.epoch_ms || null,
  };

  const audience = parsed.audience || 'business partner';
  const address = sanitizeUntrusted(addressLookup.address);
  const dateLine = evidence.date.date
    ? `Today's date (host clock): ${evidence.date.date}.`
    : null;

  const draftParsed = {
    kind: 'email_compose',
    action: 'compose',
    include_company_address: true,
    // Role audiences stay in `to` for local draft display; emails keep address form.
    to: audience,
    audience: /@/.test(audience) ? null : audience,
    purpose: dateLine
      ? `I am writing on ${evidence.date.date} regarding our ongoing work together.`
      : 'I am writing regarding our ongoing work together.',
  };

  // Prefer compose service for session storage + memory grounding; inject host date into body.
  const composed = await composeService.run(server, {
    ...draftParsed,
    // Force address inclusion using already-resolved memory (compose re-looks up).
  }, { conversation_id });

  if (composed.kind === 'clarify') {
    return { ...composed, composition: parsed.composition, evidence, route: 'CONTEXTUAL_ASSISTANT' };
  }

  let message = composed.message || '';
  if (dateLine && !/Today's date \(host clock\)/i.test(message)) {
    // Insert host date into body section of the local draft receipt.
    message = message.replace(
      /(Subject:[^\n]*\n\n)/,
      `$1${dateLine}\n\n`
    );
    if (composed.draft?.body && !/Today's date \(host clock\)/i.test(composed.draft.body)) {
      composed.draft.body = `${dateLine}\n\n${composed.draft.body}`;
    }
  }

  return base({
    composition: parsed.composition,
    plan: parsed.plan,
    evidence,
    draft: composed.draft || null,
    draft_id: composed.draft_id || null,
    address_included: composed.address_included === true,
    date_included: !!evidence.date.date,
    message:
      message
      + '\n\nSources: Personal Memory V2 (ordinary address) + host clock. Local draft only — not saved to Gmail, not sent.',
  });
}

async function calendarFollowupCompose(server, parsed, { conversation_id }) {
  const evidence = { calendar: null };
  const calendar = require('./calendar-service');
  const calParsed = {
    kind: 'calendar',
    action: 'events',
    day: parsed.day || 'tomorrow',
    host_verified: true,
  };

  let calResult;
  try {
    calResult = await calendar.run(server, calParsed, { conversation_id });
  } catch (error) {
    return deny(
      `Calendar could not be checked (${String(error.message || error).slice(0, 120)}). No draft was invented.`,
      'calendar_unavailable',
      { composition: parsed.composition, evidence }
    );
  }

  if (calResult.kind === 'connect_required' || calResult.code === 'calendar_oauth_required') {
    return deny(
      calResult.message || 'Calendar authorization required. Run /connect calendar. No draft was invented.',
      calResult.code || 'calendar_oauth_required',
      { composition: parsed.composition, evidence }
    );
  }

  const items = Array.isArray(calResult.items) ? calResult.items : [];
  evidence.calendar = {
    status: calResult.kind,
    count: items.length,
    day: parsed.day || 'tomorrow',
    host_verified: calResult.host_verified === true,
  };

  if (!items.length) {
    return deny(
      `No authorized calendar events were found for ${parsed.day || 'tomorrow'}. I did not invent a meeting or draft.`,
      'calendar_empty',
      { composition: parsed.composition, evidence }
    );
  }

  if (items.length > 1) {
    const lines = items.slice(0, 8).map((ev, i) => {
      const title = sanitizeUntrusted(ev.summary || ev.title || 'Untitled event');
      const when = sanitizeUntrusted(ev.when || ev.start || '');
      return `${i + 1}. ${title}${when ? ` — ${when}` : ''}`;
    });
    return deny(
      `Multiple meetings match ${parsed.day || 'tomorrow'}. Which one should the follow-up email reference?\n${lines.join('\n')}`,
      'calendar_ambiguous',
      { composition: parsed.composition, evidence, choices: items.slice(0, 8).map((ev) => ({
        id: ev.id || null,
        title: sanitizeUntrusted(ev.summary || ev.title || 'Untitled'),
      })) }
    );
  }

  const meeting = items[0];
  const title = sanitizeUntrusted(meeting.summary || meeting.title || 'our meeting');
  const when = sanitizeUntrusted(meeting.when || meeting.start || (parsed.day || 'tomorrow'));

  const composed = await composeService.run(server, {
    kind: 'email_compose',
    action: 'compose',
    include_company_address: false,
    audience: 'there',
    purpose: `I am following up on ${title}${when ? ` (${when})` : ''}.`,
  }, { conversation_id });

  if (composed.kind === 'clarify') {
    return { ...composed, composition: parsed.composition, evidence, route: 'CONTEXTUAL_ASSISTANT' };
  }

  return base({
    composition: parsed.composition,
    plan: parsed.plan,
    evidence: {
      ...evidence,
      meeting: { title, when, id: meeting.id || null },
    },
    draft: composed.draft || null,
    draft_id: composed.draft_id || null,
    message:
      (composed.message || '')
      + `\n\nCalendar source: authorized host event “${title}”${when ? ` (${when})` : ''}. `
      + 'Local draft only — not sent. Sending requires a separate Gmail write confirmation.',
  });
}

/**
 * Full personal-assistant rail: calendar → company memory → local draft → Gmail send preview.
 * Never sends. Never treats ordinary chat as approval. Confirmation uses /gmail confirm only.
 */
async function meetingFollowupSend(server, parsed, { conversation_id }) {
  const evidence = { calendar: null, memory: null, gmail: null };
  const calendar = require('./calendar-service');
  const gmailWrite = require('./gmail-write-service');

  let calResult;
  try {
    calResult = await calendar.run(server, {
      kind: 'calendar',
      action: 'events',
      day: parsed.day || 'tomorrow',
      host_verified: true,
    }, { conversation_id });
  } catch (error) {
    return deny(
      `Calendar could not be checked (${String(error.message || error).slice(0, 120)}). No draft or send was started.`,
      'calendar_unavailable',
      { composition: parsed.composition, evidence, workflow_state: WORKFLOW.CLARIFY }
    );
  }

  if (calResult.kind === 'connect_required' || calResult.code === 'calendar_oauth_required') {
    return deny(
      calResult.message || 'Calendar authorization required. Run /connect calendar. No draft or send was started.',
      calResult.code || 'calendar_oauth_required',
      { composition: parsed.composition, evidence, workflow_state: WORKFLOW.NOT_AUTHORIZED }
    );
  }

  const items = Array.isArray(calResult.items) ? calResult.items : [];
  evidence.calendar = {
    status: calResult.kind,
    count: items.length,
    day: parsed.day || 'tomorrow',
    host_verified: calResult.host_verified === true,
    timezone: calResult.timezone || calResult.clock_timezone || null,
  };

  if (!items.length) {
    return deny(
      `No authorized calendar events were found for ${parsed.day || 'tomorrow'}. I did not invent a meeting, draft, or send.`,
      'calendar_empty',
      { composition: parsed.composition, evidence, workflow_state: WORKFLOW.CLARIFY }
    );
  }

  if (items.length > 1) {
    const lines = items.slice(0, 8).map((ev, i) => {
      const title = sanitizeUntrusted(ev.summary || ev.title || 'Untitled event');
      const when = sanitizeUntrusted(ev.when || ev.start || '');
      return `${i + 1}. ${title}${when ? ` — ${when}` : ''}`;
    });
    return deny(
      `Multiple meetings match ${parsed.day || 'tomorrow'}. Which one should the follow-up email reference?\n${lines.join('\n')}\n\nReply with the number (or exact title). Nothing was drafted or sent.`,
      'calendar_ambiguous',
      {
        composition: parsed.composition,
        evidence,
        workflow_state: WORKFLOW.CLARIFY,
        choices: items.slice(0, 8).map((ev) => ({
          id: ev.id || null,
          title: sanitizeUntrusted(ev.summary || ev.title || 'Untitled'),
        })),
      }
    );
  }

  const meeting = items[0];
  const title = sanitizeUntrusted(meeting.summary || meeting.title || 'our meeting');
  const when = sanitizeUntrusted(meeting.when || meeting.start || (parsed.day || 'tomorrow'));
  evidence.calendar.meeting = { title, when, id: meeting.id || null };

  const addressLookup = composeService.lookupCompanyAddress(server);
  evidence.memory = { status: addressLookup.status };
  if (addressLookup.status === 'ambiguous') {
    return deny(addressLookup.message, 'memory_address_ambiguous', {
      composition: parsed.composition, evidence, workflow_state: WORKFLOW.CLARIFY,
    });
  }
  if (addressLookup.status === 'missing' || addressLookup.status === 'unavailable') {
    return deny(
      (addressLookup.message || 'No ordinary company address found.') + ' I did not invent company information.',
      'memory_address_' + addressLookup.status,
      { composition: parsed.composition, evidence, workflow_state: WORKFLOW.CLARIFY }
    );
  }
  const address = sanitizeUntrusted(addressLookup.address);
  evidence.memory.address_included = true;

  // Prefer explicit recipient; otherwise try a single attendee email from the event.
  let to = parsed.to || null;
  if (!to) {
    const attendees = Array.isArray(meeting.attendees) ? meeting.attendees : [];
    const emails = attendees
      .map((a) => (typeof a === 'string' ? a : (a?.email || a?.address || '')))
      .filter((e) => typeof e === 'string' && /@/.test(e) && !/@resource\.calendar\.google\.com$/i.test(e));
    const unique = [...new Set(emails.map((e) => e.toLowerCase()))];
    if (unique.length === 1) to = unique[0];
  }

  const purpose = `I am following up on ${title}${when ? ` (${when})` : ''}. Our company address for reference: ${address}.`;
  const composed = await composeService.run(server, {
    kind: 'email_compose',
    action: 'compose',
    include_company_address: true,
    to: to || 'there',
    audience: to && /@/.test(to) ? null : (to || 'there'),
    purpose,
  }, { conversation_id });

  if (composed.kind === 'clarify') {
    return {
      ...composed,
      composition: parsed.composition,
      evidence,
      workflow_state: WORKFLOW.CLARIFY,
      route: 'CONTEXTUAL_ASSISTANT',
    };
  }

  const draft = composed.draft || null;
  const subject = draft?.subject || `Follow-up: ${title}`;
  const body = draft?.body || composed.message || '';

  // Without a concrete recipient email, stop at draft_ready — never invent an address.
  if (!to || !/@/.test(String(to))) {
    return base({
      composition: parsed.composition,
      plan: parsed.plan,
      workflow_state: WORKFLOW.DRAFT_READY,
      evidence: { ...evidence, meeting: evidence.calendar.meeting },
      draft,
      draft_id: composed.draft_id || null,
      address_included: true,
      requires_confirmation: false,
      message:
        (composed.message || '')
        + `\n\nState: Draft ready (local only).\n`
        + `Calendar: “${title}”${when ? ` (${when})` : ''}. Company address from Memory V2 included.\n`
        + 'Provide the recipient email to stage a Gmail send preview '
        + '(example: “Send the draft to person@example.com after I approve”). '
        + 'Nothing was sent. Chat text alone is never send approval.',
    });
  }

  const oauth = server.gmailOAuth?.status?.() || {};
  evidence.gmail = {
    connected: !!oauth.connected,
    can_send: !!oauth.can_send || !!oauth.can_modify,
    mode: oauth.mode || null,
    write_qualified: false,
  };

  if (!oauth.connected) {
    return base({
      composition: parsed.composition,
      plan: parsed.plan,
      workflow_state: WORKFLOW.NOT_AUTHORIZED,
      evidence: { ...evidence, meeting: evidence.calendar.meeting },
      draft,
      draft_id: composed.draft_id || null,
      address_included: true,
      message:
        (composed.message || '')
        + `\n\nState: Not authorized to send.\n`
        + `Draft is ready locally for “${title}”. Connect Gmail with /connect gmail send (or manage), then ask again to stage the send preview. Nothing was sent.`,
    });
  }

  if (!oauth.can_send && !oauth.can_modify) {
    return base({
      composition: parsed.composition,
      plan: parsed.plan,
      workflow_state: WORKFLOW.NOT_AUTHORIZED,
      evidence: { ...evidence, meeting: evidence.calendar.meeting },
      draft,
      draft_id: composed.draft_id || null,
      address_included: true,
      message:
        (composed.message || '')
        + `\n\nState: Not authorized to send.\n`
        + 'Gmail is connected read-only. Run /connect gmail send (or /connect gmail manage) for outbound send consent, then ask again. '
        + 'Draft remains local — not saved to Gmail Drafts, not sent.',
    });
  }

  // Stage durable Gmail write preview — does not send.
  const preview = await gmailWrite.run(server, {
    kind: 'gmail_write',
    action: 'send',
    to: String(to),
    subject,
    body,
  }, { conversation_id });

  if (preview.kind === 'connect_required' || preview.code === 'gmail_write_session_required') {
    return {
      ...preview,
      composition: parsed.composition,
      evidence,
      workflow_state: WORKFLOW.NOT_AUTHORIZED,
      draft,
      draft_id: composed.draft_id || null,
      route: 'CONTEXTUAL_ASSISTANT',
    };
  }

  if (preview.kind === 'clarify' || preview.action !== 'preview') {
    return {
      ...preview,
      composition: parsed.composition,
      evidence,
      workflow_state: WORKFLOW.CLARIFY,
      draft,
      draft_id: composed.draft_id || null,
      route: 'CONTEXTUAL_ASSISTANT',
    };
  }

  evidence.gmail.preview_id = preview.preview_id;
  evidence.gmail.operation_id = preview.operation_id;
  evidence.gmail.account = preview.proposal?.account_hint || oauth.email || null;

  return base({
    composition: parsed.composition,
    plan: parsed.plan,
    workflow_state: WORKFLOW.APPROVAL_REQUIRED,
    local_only: false,
    gmail_sent: false,
    gmail_saved: false,
    requires_confirmation: true,
    preview_id: preview.preview_id,
    approval_id: preview.approval_id || null,
    operation_id: preview.operation_id,
    evidence: { ...evidence, meeting: evidence.calendar.meeting },
    draft,
    draft_id: composed.draft_id || null,
    address_included: true,
    proposal: preview.proposal || null,
    message:
      `State: Approval required — nothing has been sent.\n\n`
      + `Calendar: “${title}”${when ? ` (${when})` : ''} (authorized host event).\n`
      + `Company information: included from Memory V2 (ordinary address).\n`
      + `Sender account: authorized Gmail account.\n`
      + `To: ${to}\nSubject: ${subject}\n\n`
      + `${String(body).slice(0, 2000)}\n\n`
      + `Confirm delivery with: /gmail confirm ${preview.preview_id}\n`
      + 'Ordinary chat messages are not send approval. Local draft ≠ Gmail Drafts ≠ delivered mail.',
  });
}

async function healthExplain(server, parsed) {
  const health = await hostFacts.answerHealth(server);
  if (health.kind === 'clarify') {
    return { ...health, composition: parsed.composition, route: 'CONTEXTUAL_ASSISTANT' };
  }

  const components = health.components || {};
  const issues = [];
  const check = (name, state) => {
    if (!state || state === 'ready' || state === 'not_checked') return;
    if (state === 'degraded') issues.push(`${name} is degraded.`);
    else if (state === 'unavailable') issues.push(`${name} is unavailable.`);
    else if (state === 'stale') issues.push(`${name} observation is stale.`);
    else issues.push(`${name}: ${state}.`);
  };
  check('Overall', components.overall);
  check('Control', components.control);
  check('OpenCode', components.opencode);
  check('Memory V2', components.memory_v2);
  check('Provider (Ollama)', components.provider_ollama);

  const missions = components.missions || {};
  if (Number(missions.failed) > 0) {
    issues.push(`${missions.failed} Mission(s) are in failed/needs-rework (historical inventory; not live execution).`);
  }
  if (Number(missions.review) > 0) {
    issues.push(`${missions.review} Mission(s) need operator attention.`);
  }

  let explanation;
  if (components.overall === 'ready' && !issues.length) {
    explanation = 'No component failures were observed in the live control-plane health check.';
  } else if (issues.length) {
    explanation = 'Observed issues:\n' + issues.map((i) => `• ${i}`).join('\n');
  } else {
    explanation = `Overall status is ${components.overall || 'not_checked'}; no additional failure detail was available.`;
  }

  return base({
    composition: parsed.composition,
    plan: parsed.plan,
    components,
    stale: health.stale === true,
    observed_at: health.observed_at,
    message: `${health.message}\n\n${explanation}\n\nDiagnostics are host-observed only; nothing was invented.`,
  });
}

async function run(server, parsed, { conversation_id = null } = {}) {
  if (!parsed || parsed.kind !== 'contextual_assistant') {
    return deny('Not a contextual assistant request.', 'not_contextual');
  }
  if (!planAllowed(parsed)) {
    return deny('Composition plan is not on the host allowlist.', 'plan_not_allowlisted', {
      composition: parsed.composition,
    });
  }

  switch (parsed.composition) {
    case 'MEMORY_DATE_COMPOSE':
      return memoryDateCompose(server, parsed, { conversation_id });
    case 'CALENDAR_FOLLOWUP_COMPOSE':
      return calendarFollowupCompose(server, parsed, { conversation_id });
    case 'MEETING_FOLLOWUP_SEND':
      return meetingFollowupSend(server, parsed, { conversation_id });
    case 'HEALTH_EXPLAIN':
      return healthExplain(server, parsed);
    default:
      return deny(`Unsupported composition: ${parsed.composition}`, 'unsupported_composition');
  }
}

module.exports = {
  run,
  planAllowed,
  ALLOWED,
  WORKFLOW,
  memoryDateCompose,
  calendarFollowupCompose,
  meetingFollowupSend,
  healthExplain,
};
