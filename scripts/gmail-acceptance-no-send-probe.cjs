'use strict';
// Canonical Gmail live-acceptance probe. Defaults to NO provider send.
//
// Verifies: session binding, preview staging, unauthenticated deny, cross-conversation deny,
// and same-session confirm reaching governed lookup WITHOUT executing /gmail confirm on a
// live staged preview.
//
// Never passes a confirmed flag. Never issues `/gmail confirm <live-preview-id>` against the
// sticky Terminal session that owns a real preview.
//
// Usage (managed install root):
//   node scripts/run.cjs scripts/gmail-acceptance-no-send-probe.cjs
//
// Explicit live send remains owner-only via interactive Terminal `/gmail confirm <id>` and is
// out of scope for this probe.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const MODE = String(process.env.AIRODROM_GMAIL_ACCEPTANCE_MODE || 'no_send').toLowerCase();
if (MODE !== 'no_send') {
  console.error(JSON.stringify({
    ok: false,
    code: 'gmail_acceptance_live_send_refused',
    message: 'gmail-acceptance-no-send-probe refuses modes other than no_send. Use interactive Terminal /gmail confirm only with explicit owner approval.',
    mode: MODE,
  }));
  process.exit(2);
}

function redact(value) {
  if (value == null) return value;
  if (typeof value === 'string') {
    return value
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, (m) => m.slice(0, 8) + '…');
  }
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/token|secret|password|authorization|bearer|credential/i.test(k)) out[k] = '<redacted>';
      else out[k] = redact(v);
    }
    return out;
  }
  return value;
}

async function main() {
  const home = path.join(os.homedir(), '.airodrom');
  const local = require('../src/local-bootstrap');
  const evidence = {
    at: new Date().toISOString(),
    mode: 'no_send',
    never_confirm_live_preview: true,
  };

  const session = await local.request(home, '/api/assistant/conversation/session', {});
  const other = await local.request(home, '/api/assistant/conversation/session', { new: true });
  evidence.sessions = {
    staging_prefix: String(session.conversation_id).slice(0, 8) + '…',
    other_prefix: String(other.conversation_id).slice(0, 8) + '…',
    distinct: session.conversation_id !== other.conversation_id,
    sticky_without_new: true,
  };

  const preview = await local.request(home, '/api/assistant/input', {
    message: 'Send a test email to myself and show me the preview',
    request_id: crypto.randomUUID(),
    conversation_id: session.conversation_id,
  });
  const previewId = preview.preview_id
    || ((String(preview.message || '').match(/Preview ID:\s*([0-9a-f-]+)/i) || [])[1]);
  evidence.preview = {
    kind: preview.kind,
    action: preview.action,
    route: preview.route,
    preview_id_present: !!previewId,
    preview_id_prefix: previewId ? String(previewId).slice(0, 8) + '…' : undefined,
    message: redact(String(preview.message || '').slice(0, 280)),
  };
  if (!previewId) {
    evidence.verdict = 'FAIL_PREVIEW';
    console.log(JSON.stringify(evidence, null, 2));
    process.exit(1);
  }

  const missing = await local.request(home, '/api/assistant/input', {
    message: `/gmail confirm ${previewId}`,
    request_id: crypto.randomUUID(),
  });
  evidence.unauthenticated_confirm = {
    kind: missing.kind,
    message: redact(String(missing.message || '').slice(0, 200)),
    denied_auth: /authenticated Terminal conversation session/i.test(String(missing.message || '')),
    provider_dispatched: missing.action === 'sent' || missing.provider_confirmed === true,
  };

  const cross = await local.request(home, '/api/assistant/input', {
    message: `/gmail confirm ${previewId}`,
    request_id: crypto.randomUUID(),
    conversation_id: other.conversation_id,
  });
  evidence.cross_conversation_confirm = {
    kind: cross.kind,
    message: redact(String(cross.message || '').slice(0, 240)),
    denied: cross.kind === 'clarify'
      || /conversation|mismatch|unavailable|not found|binding|forbidden|preview|expired/i.test(String(cross.message || '')),
    provider_dispatched: cross.action === 'sent' || cross.provider_confirmed === true,
  };

  // Same-session confirm against a ghost id: clears auth false-negative, no send.
  // Deliberately does NOT confirm the live staged previewId.
  const ghost = await local.request(home, '/api/assistant/input', {
    message: `/gmail confirm ${crypto.randomUUID()}`,
    request_id: crypto.randomUUID(),
    conversation_id: session.conversation_id,
  });
  evidence.same_session_governed_lookup = {
    kind: ghost.kind,
    message: redact(String(ghost.message || '').slice(0, 240)),
    cleared_auth_false_negative: !/authenticated Terminal conversation session/i.test(String(ghost.message || '')),
    preview_gate: /preview|not found|unavailable|expired|unknown/i.test(String(ghost.message || '')),
    provider_dispatched: ghost.action === 'sent' || ghost.provider_confirmed === true,
    confirmed_live_preview: false,
  };

  evidence.verdict =
    evidence.sessions.distinct
    && evidence.preview.preview_id_present
    && evidence.unauthenticated_confirm.denied_auth
    && !evidence.unauthenticated_confirm.provider_dispatched
    && evidence.cross_conversation_confirm.denied
    && !evidence.cross_conversation_confirm.provider_dispatched
    && evidence.same_session_governed_lookup.cleared_auth_false_negative
    && !evidence.same_session_governed_lookup.provider_dispatched
      ? 'PASS_NO_SEND'
      : 'FAIL';

  const out = process.env.AIRODROM_ACCEPTANCE_EVIDENCE
    || path.join(home, 'activation', `gmail-acceptance-no-send-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
  fs.writeFileSync(out, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({
    verdict: evidence.verdict,
    evidence: out,
    no_send: true,
    live_preview_confirmed: false,
  }, null, 2));
  process.exit(evidence.verdict === 'PASS_NO_SEND' ? 0 : 1);
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    message: String(error && error.message || error),
  }));
  process.exit(1);
});
