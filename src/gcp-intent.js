'use strict';
// Deterministic GCP governed-ops NL routing. Chat never grants enrollment or CREATE.
const { SOMIN_TF_STATE_BACKEND_V1 } = require('./gcp-exact-scope');

function parse(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();

  if (/^\/gcp\s+help$/i.test(raw) || /^help me (?:with )?governed (?:gcp|cloud)$/i.test(lower)) {
    return { kind: 'gcp_gcs_tf_state', action: 'help', host_verified: true };
  }
  if (/^\/gcp\s+status$/i.test(raw) || /^(?:gcp|governed cloud)\s+status$/i.test(lower)) {
    return { kind: 'gcp_gcs_tf_state', action: 'status', host_verified: true };
  }
  if (/^\/gcp\s+list(?:\s+enrolled)?(?:\s+projects)?$/i.test(raw)) {
    return { kind: 'gcp_gcs_tf_state', action: 'list_enrolled', host_verified: true };
  }

  const enroll = /^\/gcp\s+enroll\s+project\s+([a-z][a-z0-9-]{4,28}[a-z0-9])\s+([0-9]{6,20})(?:\s+(.+))?$/i.exec(raw);
  if (enroll) {
    return {
      kind: 'gcp_gcs_tf_state',
      action: 'enroll',
      project_id: enroll[1],
      project_number: enroll[2],
      note: enroll[3] ? String(enroll[3]).trim().slice(0, 200) : null,
      host_verified: true,
    };
  }

  const unenroll = /^\/gcp\s+unenroll\s+project\s+([a-z][a-z0-9-]{4,28}[a-z0-9])$/i.exec(raw);
  if (unenroll) {
    return {
      kind: 'gcp_gcs_tf_state',
      action: 'unenroll',
      project_id: unenroll[1],
      host_verified: true,
    };
  }

  // Exact Somin preview only — no free-form project/bucket arguments.
  if (
    /^\/gcp\s+tf-state\s+preview(?:\s+somin)?$/i.test(raw)
    || /^\/gcp\s+preview\s+tf-state(?:\s+somin)?$/i.test(raw)
    || /^preview\s+(?:the\s+)?somin\s+(?:tf[- ]?state|terraform state)\s+bucket(?:\s+create(?:ion)?)?$/i.test(lower)
  ) {
    return {
      kind: 'gcp_gcs_tf_state',
      action: 'preview',
      spec: { ...SOMIN_TF_STATE_BACKEND_V1 },
      host_verified: true,
    };
  }

  const confirm = /^\/gcp\s+confirm\s+([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})(\s+--ack-uncertain)?$/i.exec(raw);
  if (confirm) {
    return {
      kind: 'gcp_gcs_tf_state',
      action: 'confirm',
      preview_id: confirm[1],
      confirmed: true,
      ack_uncertain: !!confirm[2],
      host_verified: true,
    };
  }

  // Refuse free-form create language so it cannot fall through to a model claim.
  if (
    /(?:create|make|provision)\s+(?:the\s+)?(?:somin\s+)?(?:tf[- ]?state|terraform state)\s+bucket/i.test(lower)
    || /^\/gcp\s+create\b/i.test(raw)
    || /^gcloud\s+storage\s+buckets\s+create\b/i.test(lower)
  ) {
    return {
      kind: 'gcp_gcs_tf_state',
      action: 'help',
      host_verified: true,
      clarify: true,
      message: 'Live CREATE is host-gated. Use /gcp tf-state preview somin then /gcp confirm <preview-id>. Chat cannot authorize cloud writes.',
    };
  }

  if (/^\/gcp\b/i.test(raw)) {
    return { kind: 'gcp_gcs_tf_state', action: 'help', host_verified: true };
  }
  return null;
}

module.exports = { parse };
