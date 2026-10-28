'use strict';
// Host-governed exact-scope GCS Terraform state-backend CREATE.
// Enrollment ≠ write authority. Chat text never widens scope or grants CREATE.
const { createHash, randomUUID } = require('node:crypto');
const { GcpProjectEnrollment } = require('./gcp-project-enrollment');
const { GcpGcsTfStateOps } = require('./gcp-gcs-tf-state-ops');
const {
  SOMIN_TF_STATE_BACKEND_V1,
  assertExactSominTfStateBackend,
  insertBody,
  verifyBucketMetadata,
  digest,
} = require('./gcp-exact-scope');
const { GcpStorageTransport, redact } = require('./gcp-storage-transport');

function enrollment(server) {
  if (!server.gcpProjectEnrollment) {
    const db = server.bridge?.controlStore?.db || server.gcpDb || null;
    server.gcpProjectEnrollment = new GcpProjectEnrollment({ db });
  }
  return server.gcpProjectEnrollment;
}

function ops(server) {
  if (!server.gcpGcsTfStateOps) {
    const db = server.bridge?.controlStore?.db || server.gcpDb || null;
    server.gcpGcsTfStateOps = new GcpGcsTfStateOps({ db });
  }
  return server.gcpGcsTfStateOps;
}

function requireConversation(conversation_id) {
  if (typeof conversation_id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(conversation_id)) {
    return {
      kind: 'clarify',
      route: 'GCP_GCS_TF_STATE',
      message: 'GCP governed cloud ops require an authenticated Terminal conversation session.',
      code: 'gcp_tf_state_session_required',
      authority: false,
      host_verified: true,
      model_invoked: false,
    };
  }
  return null;
}

function helpMessage(server) {
  const enrolled = (() => {
    try { return enrollment(server).list('operator'); } catch { return []; }
  })();
  const hasToken = typeof server.gcpTokenProvider === 'function';
  return [
    'Governed GCP V1: exact-scope GCS Terraform state-backend CREATE only (Somin).',
    'No unrestricted gcloud. No shell. No Terraform apply/import. No Arecibo reuse.',
    `Enrollment ≠ write authority. Enrolled projects: ${enrolled.length}. Credential provider: ${hasToken ? 'injected' : 'missing'}.`,
    'Enroll: /gcp enroll project somin-ca-prod 172228664875',
    'Revoke: /gcp unenroll project somin-ca-prod',
    'Preview CREATE: /gcp tf-state preview somin',
    'Confirm: /gcp confirm <preview-id> (uncertain outcomes need --ack-uncertain after inspection)',
    'Status: /gcp status · Help: /gcp help',
    'V1 enrollment limited to somin-ca-prod / 172228664875. Enrollment ≠ write authority.',
    'MCP cloud_* capabilities remain inactive. Host rail retains exclusive CREATE authority after authenticated confirm.',
  ].join('\n');
}

function statusPayload(server) {
  let enrolled = [];
  try { enrolled = enrollment(server).list('operator'); } catch { enrolled = []; }
  const somin = enrolled.find((e) => e.project_id === SOMIN_TF_STATE_BACKEND_V1.project_id) || null;
  return {
    kind: 'gcp_gcs_tf_state',
    action: 'status',
    route: 'GCP_GCS_TF_STATE',
    capability: 'gcp_gcs_tf_state_backend_create',
    mcp_active: false,
    credential_provider: typeof server.gcpTokenProvider === 'function' ? 'injected' : 'missing',
    enrolled_count: enrolled.length,
    somin_enrolled: !!somin,
    exact_scope: { ...SOMIN_TF_STATE_BACKEND_V1 },
    message: helpMessage(server),
    authority: false,
    host_verified: true,
    model_invoked: false,
  };
}

function assertFounderIdentity(identity, spec) {
  const email = identity?.account_email;
  if (!email || typeof email !== 'string') {
    const err = Error('GCP credential provider must return account_email for governed cloud writes.');
    err.code = 'gcp_identity_required';
    throw err;
  }
  if (String(email).toLowerCase() !== String(spec.founder_email).toLowerCase()) {
    const err = Error(`Authenticated GCP identity ${email} does not match approved founder ${spec.founder_email}.`);
    err.code = 'gcp_identity_mismatch';
    throw err;
  }
  return email;
}

async function resolveIdentity(server) {
  if (typeof server.gcpTokenProvider !== 'function') {
    const err = Error('GCP credential provider is not configured on this host.');
    err.code = 'gcp_credential_provider_missing';
    throw err;
  }
  if (require('./external-write-context').isTestProcess() && !server.gcpAllowTestCredentials) {
    const err = Error('Test processes must inject synthetic GCP transport; live credentials refused.');
    err.code = 'gcp_credential_refused_in_test';
    throw err;
  }
  const identity = await server.gcpTokenProvider();
  if (!identity || typeof identity.accessToken !== 'string' || identity.accessToken.length < 8) {
    const err = Error('GCP access token unavailable.');
    err.code = 'gcp_credential_missing';
    throw err;
  }
  return {
    accessToken: identity.accessToken,
    account_email: identity.account_email || null,
    project_id: identity.project_id || null,
  };
}

function transportFor(server, identity) {
  if (server.gcpStorageTransport) {
    if (require('./external-write-context').isTestProcess() && !server.gcpAllowTestCredentials) {
      const err = Error('Synthetic GCP transport refused without gcpAllowTestCredentials.');
      err.code = 'gcp_transport_injection_refused';
      throw err;
    }
    return server.gcpStorageTransport;
  }
  if (server.gcpStorageRequestImpl && !server.gcpAllowTransportInjection
      && !require('./external-write-context').isTestProcess()) {
    const err = Error('gcpStorageRequestImpl requires explicit gcpAllowTransportInjection.');
    err.code = 'gcp_transport_injection_refused';
    throw err;
  }
  if (require('./external-write-context').isTestProcess() && !server.gcpAllowTestCredentials) {
    const err = Error('Test processes must inject synthetic GCP transport; live Storage client refused.');
    err.code = 'gcp_credential_refused_in_test';
    throw err;
  }
  return new GcpStorageTransport({
    accessToken: identity.accessToken,
    requestImpl: server.gcpStorageRequestImpl || null,
  });
}

function denyResult(code, message, extra = {}) {
  return {
    kind: 'gcp_gcs_tf_state',
    action: 'denied',
    route: 'GCP_GCS_TF_STATE',
    code,
    message: redact(message),
    authority: false,
    host_verified: true,
    model_invoked: false,
    ...extra,
  };
}

async function previewCreate(server, parsed, conversation_id) {
  const sessionErr = requireConversation(conversation_id);
  if (sessionErr) return sessionErr;

  let spec;
  try {
    spec = assertExactSominTfStateBackend(parsed.spec || SOMIN_TF_STATE_BACKEND_V1);
  } catch (error) {
    return denyResult(error.code || 'gcp_exact_scope_mismatch', error.message);
  }

  try {
    enrollment(server).assertEnrolled(spec.project_id, spec.project_number, 'operator');
  } catch (error) {
    return denyResult(error.code || 'gcp_project_not_enrolled', error.message, {
      blockers: ['missing_project_enrollment'],
    });
  }

  let identity;
  try {
    identity = await resolveIdentity(server);
  } catch (error) {
    return denyResult(error.code || 'gcp_credential_missing', error.message, {
      blockers: ['missing_gcp_credentials'],
    });
  }

  try {
    assertFounderIdentity(identity, spec);
  } catch (error) {
    return denyResult(error.code || 'gcp_identity_mismatch', error.message, {
      blockers: ['wrong_authenticated_identity'],
    });
  }

  const idempotency_key = parsed.idempotency_key
    || `somin-tf-state-v1:${spec.bucket}:${conversation_id}`;
  const proposal = {
    operation: 'gcp_gcs_tf_state_backend_create',
    spec,
    insert: { project: spec.project_id, body: insertBody(spec) },
    writer: {
      bucket: spec.bucket,
      role: spec.writer_role,
      member: `user:${spec.founder_email}`,
    },
    review: [
      `Create gs://${spec.bucket} in ${spec.project_id} (${spec.project_number})`,
      `Region ${spec.location} · STANDARD · UBLA · PAP enforced · versioning · google-managed encryption`,
      `Writer: user:${spec.founder_email} → ${spec.writer_role} (bucket-scoped only)`,
      'No public ACLs · No Arecibo reuse · No Terraform apply/import',
    ],
  };

  let preview;
  try {
    preview = ops(server).createPreview({
      conversation_id,
      operator: 'operator',
      account_email: identity.account_email,
      proposal,
      idempotency_key,
      scope_sha256: spec.scope_sha256,
    });
  } catch (error) {
    return denyResult(error.code || 'gcp_tf_state_preview_failed', error.message, {
      receipt: error.receipt || null,
    });
  }

  return {
    kind: 'gcp_gcs_tf_state',
    action: 'preview',
    route: 'GCP_GCS_TF_STATE',
    preview_id: preview.preview_id,
    operation_id: preview.operation_id,
    idempotency_key: preview.idempotency_key,
    scope_sha256: preview.scope_sha256,
    expires_at: preview.expires_at,
    status: preview.status,
    proposal,
    message: [
      'Exact-scope GCS tf-state backend CREATE staged for owner confirm.',
      ...proposal.review,
      `Confirm with: /gcp confirm ${preview.preview_id}`,
      'Chat “yes” / NL approval does not execute. Preview expires; replay after completion is refused.',
    ].join('\n'),
    authority: false,
    host_verified: true,
    model_invoked: false,
    requires_confirm: true,
  };
}

function desiredIam(policy, spec) {
  const expected = {
    role: spec.writer_role,
    members: [`user:${spec.founder_email}`],
  };
  if (!policy || !policy.etag) {
    const err = Error('IAM etag required before bucket policy write.');
    err.code = 'gcp_iam_etag_required';
    throw err;
  }
  const bindings = policy.bindings || [];
  if (bindings.length && JSON.stringify(bindings) !== JSON.stringify([expected])) {
    const err = Error('Unexpected existing bucket IAM bindings; recovery requires separate approval.');
    err.code = 'gcp_unexpected_bucket_bindings';
    throw err;
  }
  return { version: 3, etag: policy.etag, bindings: [expected] };
}

async function executeClaimed(server, claimed, identity) {
  const spec = assertExactSominTfStateBackend(claimed.spec || claimed.proposal?.spec || SOMIN_TF_STATE_BACKEND_V1);
  enrollment(server).assertEnrolled(spec.project_id, spec.project_number, 'operator');
  if (claimed.scope_sha256 !== spec.scope_sha256) {
    const err = Error('Scope digest drifted between preview and confirm.');
    err.code = 'gcp_scope_digest_drift';
    throw err;
  }

  const transport = transportFor(server, identity);
  const existing = await transport.getBucket(spec.bucket);
  if (existing.status === 200 && existing.body) {
    try {
      verifyBucketMetadata(existing.body, spec);
    } catch (error) {
      const err = Error(error.message || 'Existing conflicting bucket.');
      err.code = error.code || 'gcp_bucket_posture_mismatch';
      err.existing = true;
      throw err;
    }
    const err = Error('Bucket already exists with matching posture; CREATE refused (no silent reuse).');
    err.code = 'gcp_bucket_already_exists';
    err.existing = true;
    throw err;
  }
  if (existing.status && existing.status !== 404) {
    const err = Error(`Ambiguous bucket lookup status ${existing.status}.`);
    err.code = 'gcp_bucket_lookup_ambiguous';
    throw err;
  }

  const inserted = await transport.insertBucket(spec.project_id, insertBody(spec));
  if (inserted.status === 409) {
    const err = Error('Provider reported bucket conflict during insert; inspect before retry.');
    err.code = 'gcp_insert_conflict';
    throw err;
  }
  if (!inserted.status || inserted.status < 200 || inserted.status >= 300) {
    const message = inserted.body?.error?.message || `insert failed status=${inserted.status}`;
    const err = Error(redact(message));
    err.code = inserted.status === 403 ? 'gcp_permission_denied' : 'gcp_insert_failed';
    throw err;
  }

  const afterInsert = await transport.getBucket(spec.bucket);
  if (afterInsert.status !== 200 || !afterInsert.body) {
    const err = Error('Ambiguous provider response after insert; no automatic retry.');
    err.code = 'gcp_post_insert_ambiguous';
    throw err;
  }
  verifyBucketMetadata(afterInsert.body, spec);

  const iamGet = await transport.getBucketIam(spec.bucket);
  if (iamGet.status !== 200 || !iamGet.body) {
    const err = Error('Unable to read bucket IAM after create; partial creation — no automatic delete.');
    err.code = 'gcp_iam_read_failed';
    throw err;
  }
  const policy = desiredIam(iamGet.body, spec);
  const iamPut = await transport.setBucketIam(spec.bucket, policy);
  if (!iamPut.status || iamPut.status < 200 || iamPut.status >= 300) {
    const err = Error('Bucket IAM write failed after create; partial creation — no automatic delete.');
    err.code = 'gcp_iam_write_failed';
    throw err;
  }

  const finalMeta = await transport.getBucket(spec.bucket);
  verifyBucketMetadata(finalMeta.body, spec);
  const finalIam = await transport.getBucketIam(spec.bucket);
  if (JSON.stringify(finalIam.body?.bindings || []) !== JSON.stringify(policy.bindings)) {
    const err = Error('IAM verification failed after write.');
    err.code = 'gcp_iam_verification_failed';
    throw err;
  }

  return {
    status: 'VERIFIED',
    bucket: spec.bucket,
    project_id: spec.project_id,
    project_number: spec.project_number,
    scope_sha256: spec.scope_sha256,
    operation_id: claimed.operation_id,
    preview_id: claimed.preview_id,
    account_email: identity.account_email || null,
    evidence_hash: digest({
      bucket: spec.bucket,
      project_number: spec.project_number,
      location: spec.location,
      bindings: policy.bindings,
    }),
  };
}

async function confirmCreate(server, parsed, conversation_id) {
  const sessionErr = requireConversation(conversation_id);
  if (sessionErr) return sessionErr;
  const preview_id = parsed.preview_id;
  if (!preview_id) return denyResult('gcp_confirm_id_required', 'Confirm requires preview_id.');

  let identity;
  try {
    identity = await resolveIdentity(server);
    assertFounderIdentity(identity, SOMIN_TF_STATE_BACKEND_V1);
  } catch (error) {
    return denyResult(error.code || 'gcp_credential_missing', error.message, {
      blockers: error.code === 'gcp_identity_mismatch' || error.code === 'gcp_identity_required'
        ? ['wrong_authenticated_identity']
        : ['missing_gcp_credentials'],
    });
  }

  let claimed;
  try {
    claimed = ops(server).claim(preview_id, {
      conversation_id,
      operator: 'operator',
      account_email: identity.account_email,
      ack_uncertain: parsed.ack_uncertain === true,
    });
  } catch (error) {
    return denyResult(error.code || 'gcp_tf_state_claim_failed', error.message, {
      receipt: error.receipt || null,
    });
  }

  try {
    const receipt = await executeClaimed(server, {
      ...claimed,
      spec: claimed.spec || claimed.proposal?.spec,
      proposal: claimed,
    }, identity);
    ops(server).complete(preview_id, receipt, { claim_token: claimed.claim_token });
    return {
      kind: 'gcp_gcs_tf_state',
      action: 'completed',
      route: 'GCP_GCS_TF_STATE',
      preview_id,
      receipt,
      message: `Verified gs://${receipt.bucket} under exact approved scope.`,
      authority: false,
      host_verified: true,
      model_invoked: false,
    };
  } catch (error) {
    const uncertain = [
      'gcp_transport_timeout',
      'gcp_post_insert_ambiguous',
      'gcp_insert_conflict',
      'gcp_iam_read_failed',
      'gcp_iam_write_failed',
      'gcp_bucket_lookup_ambiguous',
    ].includes(error.code);
    const payload = {
      error_code: error.code || 'gcp_execute_failed',
      message: redact(error.message || 'execution failed'),
      existing: !!error.existing,
    };
    try {
      if (uncertain) ops(server).markUncertain(preview_id, payload, { claim_token: claimed.claim_token });
      else ops(server).deny(preview_id, payload.message);
    } catch { /* best-effort */ }
    return denyResult(error.code || 'gcp_execute_failed', error.message, {
      uncertain,
      recovery: uncertain
        ? 'Inspect provider journal/metadata; no automatic retry or deletion.'
        : null,
    });
  }
}

function enrollProject(server, parsed, conversation_id) {
  const sessionErr = requireConversation(conversation_id);
  if (sessionErr) return sessionErr;
  const project_id = parsed.project_id;
  const project_number = parsed.project_number;
  // V1: only the locked Somin project may be enrolled for governed cloud writes.
  if (project_id !== SOMIN_TF_STATE_BACKEND_V1.project_id
      || String(project_number) !== String(SOMIN_TF_STATE_BACKEND_V1.project_number)) {
    return denyResult('gcp_enrollment_scope_denied',
      'V1 enrollment is limited to somin-ca-prod / 172228664875.');
  }
  try {
    const row = enrollment(server).enroll({
      project_id,
      project_number,
      operator: 'operator',
      account_email: parsed.account_email || null,
      note: parsed.note || 'owner-controlled GCP enrollment',
    });
    return {
      kind: 'gcp_gcs_tf_state',
      action: 'enrolled',
      route: 'GCP_GCS_TF_STATE',
      project: row,
      message: [
        `Enrolled GCP project ${row.project_id} (${row.project_number}).`,
        'Enrollment does not authorize cloud writes. Exact-scope preview + confirm still required.',
      ].join(' '),
      authority: false,
      host_verified: true,
      model_invoked: false,
    };
  } catch (error) {
    return denyResult(error.code || 'gcp_enrollment_failed', error.message);
  }
}

function unenrollProject(server, parsed, conversation_id) {
  const sessionErr = requireConversation(conversation_id);
  if (sessionErr) return sessionErr;
  const result = enrollment(server).revoke(parsed.project_id, 'operator');
  return {
    kind: 'gcp_gcs_tf_state',
    action: 'unenrolled',
    route: 'GCP_GCS_TF_STATE',
    ...result,
    message: result.revoked
      ? `Revoked enrollment for ${parsed.project_id}.`
      : `No active enrollment for ${parsed.project_id}.`,
    authority: false,
    host_verified: true,
    model_invoked: false,
  };
}

async function run(server, parsed, { conversation_id = null } = {}) {
  const action = parsed?.action || 'help';
  if (action === 'help') {
    return {
      kind: 'gcp_gcs_tf_state',
      action: 'help',
      route: 'GCP_GCS_TF_STATE',
      message: helpMessage(server),
      authority: false,
      host_verified: true,
      model_invoked: false,
    };
  }
  if (action === 'status') return statusPayload(server);
  if (action === 'enroll') return enrollProject(server, parsed, conversation_id);
  if (action === 'unenroll') return unenrollProject(server, parsed, conversation_id);
  if (action === 'list_enrolled') {
    return {
      kind: 'gcp_gcs_tf_state',
      action: 'list_enrolled',
      route: 'GCP_GCS_TF_STATE',
      projects: enrollment(server).list('operator'),
      authority: false,
      host_verified: true,
      model_invoked: false,
    };
  }
  if (action === 'preview' || action === 'tf_state_preview') {
    return previewCreate(server, parsed, conversation_id);
  }
  if (action === 'confirm') {
    return confirmCreate(server, parsed, conversation_id);
  }
  return denyResult('gcp_action_unknown', `Unknown GCP action: ${action}`);
}

module.exports = {
  run,
  enrollment,
  ops,
  SOMIN_TF_STATE_BACKEND_V1,
  // test helpers
  _test: {
    executeClaimed,
    desiredIam,
    digest,
    randomUUID,
    createHash,
  },
};
