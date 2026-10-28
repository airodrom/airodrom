'use strict';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { CapabilityPolicy } = require('../src/capability-policy');
const { SOMIN_TF_STATE_BACKEND_V1, assertExactSominTfStateBackend, digest, insertBody, canonicalSpec } = require('../src/gcp-exact-scope');
const { GcpProjectEnrollment } = require('../src/gcp-project-enrollment');
const { GcpGcsTfStateOps } = require('../src/gcp-gcs-tf-state-ops');
const { redact } = require('../src/gcp-storage-transport');
const intent = require('../src/gcp-intent');
const service = require('../src/gcp-gcs-tf-state-service');
const { connectorCapabilities } = require('../src/apps/capability-connectors');

const SPEC = { ...SOMIN_TF_STATE_BACKEND_V1 };
const FOUNDER = SPEC.founder_email;

function matchingBucket() {
  return {
    name: SPEC.bucket,
    projectNumber: SPEC.project_number,
    location: SPEC.location.toUpperCase(),
    storageClass: 'STANDARD',
    versioning: { enabled: true },
    iamConfiguration: {
      uniformBucketLevelAccess: { enabled: true },
      publicAccessPrevention: 'enforced',
    },
  };
}

function mockTransport({
  getStatus = 404,
  getBody = null,
  insertStatus = 200,
  insertBodyOut = null,
  iamGet = { etag: 'etag-1', bindings: [] },
  iamPutStatus = 200,
  failOnce = null,
  log = [],
} = {}) {
  let inserted = false;
  return {
    async getBucket(bucket) {
      log.push(['getBucket', bucket]);
      if (failOnce === 'getBucket') {
        failOnce = null;
        const err = Error('network timeout');
        err.code = 'gcp_transport_timeout';
        throw err;
      }
      if (inserted) {
        return { status: 200, body: insertBodyOut || matchingBucket() };
      }
      if (getStatus === 200) {
        return { status: 200, body: getBody || matchingBucket() };
      }
      return { status: getStatus, body: getBody };
    },
    async insertBucket(project_id, resource) {
      log.push(['insertBucket', project_id, resource]);
      if (failOnce === 'insert') {
        failOnce = null;
        const err = Error('network timeout');
        err.code = 'gcp_transport_timeout';
        throw err;
      }
      if (insertStatus === 403) return { status: 403, body: { error: { message: 'Permission denied on storage.buckets.create' } } };
      if (insertStatus === 409) return { status: 409, body: { error: { message: 'conflict' } } };
      inserted = true;
      return { status: insertStatus, body: insertBodyOut || matchingBucket() };
    },
    async getBucketIam(bucket) {
      log.push(['getBucketIam', bucket]);
      return { status: 200, body: typeof iamGet === 'function' ? iamGet() : iamGet };
    },
    async setBucketIam(bucket, policy) {
      log.push(['setBucketIam', bucket, policy]);
      iamGet = policy;
      return { status: iamPutStatus, body: policy };
    },
  };
}

function serverFixture({ transport = mockTransport(), enroll = true, identity = FOUNDER, token = 'ya29.test-token-value' } = {}) {
  const db = new DatabaseSync(':memory:');
  const enrollment = new GcpProjectEnrollment({ db });
  if (enroll) {
    enrollment.enroll({
      project_id: SPEC.project_id,
      project_number: SPEC.project_number,
      operator: 'operator',
      account_email: FOUNDER,
    });
  }
  const ops = new GcpGcsTfStateOps({ db });
  const conversation_id = randomUUID();
  const server = {
    gcpDb: db,
    gcpProjectEnrollment: enrollment,
    gcpGcsTfStateOps: ops,
    gcpStorageTransport: transport,
    gcpAllowTestCredentials: true,
    gcpTokenProvider: async () => ({
      accessToken: token,
      account_email: identity,
      project_id: SPEC.project_id,
    }),
  };
  return { server, conversation_id, enrollment, ops, db };
}

test('exact scope: only Somin SPEC accepted; wrong project/bucket/region/settings fail', () => {
  assert.equal(assertExactSominTfStateBackend(SPEC).bucket, SPEC.bucket);
  for (const bad of [
    { ...SPEC, project_id: 'other-prod' },
    { ...SPEC, bucket: 'other-bucket' },
    { ...SPEC, location: 'us-central1' },
    { ...SPEC, storage_class: 'NEARLINE' },
    { ...SPEC, public_access_prevention: 'inherited' },
    { ...SPEC, uniform_bucket_level_access: false },
    { ...SPEC, versioning: false },
    { ...SPEC, encryption: 'cmek' },
    { ...SPEC, arecibo_reuse: true },
  ]) {
    assert.throws(() => assertExactSominTfStateBackend(bad), /exact|Arecibo|scope/i);
  }
});

test('enrollment: missing, wrong number, revoke, list', () => {
  const db = new DatabaseSync(':memory:');
  const e = new GcpProjectEnrollment({ db });
  assert.throws(() => e.assertEnrolled(SPEC.project_id, SPEC.project_number), /not enrolled/);
  e.enroll({ project_id: SPEC.project_id, project_number: SPEC.project_number });
  assert.throws(() => e.assertEnrolled(SPEC.project_id, '999'), /project_number/);
  assert.equal(e.list().length, 1);
  assert.equal(e.revoke(SPEC.project_id).revoked, true);
  assert.throws(() => e.assertEnrolled(SPEC.project_id, SPEC.project_number), /not enrolled/);
});

test('intent: preview/confirm/enroll routed; free-form create clarified', () => {
  assert.equal(intent.parse('/gcp tf-state preview somin').action, 'preview');
  assert.equal(intent.parse('/gcp enroll project somin-ca-prod 172228664875').project_number, '172228664875');
  const id = randomUUID();
  assert.equal(intent.parse(`/gcp confirm ${id}`).preview_id, id);
  assert.match(intent.parse('create the somin tf-state bucket').message, /host-gated/i);
  assert.equal(intent.parse('/drive status'), null);
});

test('missing project enrollment blocks preview', async () => {
  const { server, conversation_id } = serverFixture({ enroll: false });
  const out = await service.run(server, { kind: 'gcp_gcs_tf_state', action: 'preview', spec: SPEC }, { conversation_id });
  assert.equal(out.code, 'gcp_project_not_enrolled');
  assert.ok(out.blockers.includes('missing_project_enrollment'));
});

test('missing credentials block preview', async () => {
  const { server, conversation_id } = serverFixture();
  delete server.gcpTokenProvider;
  const out = await service.run(server, { kind: 'gcp_gcs_tf_state', action: 'preview', spec: SPEC }, { conversation_id });
  assert.equal(out.code, 'gcp_credential_provider_missing');
});

test('wrong authenticated identity blocks preview', async () => {
  const { server, conversation_id } = serverFixture({ identity: 'intruder@example.com' });
  const out = await service.run(server, { kind: 'gcp_gcs_tf_state', action: 'preview', spec: SPEC }, { conversation_id });
  assert.equal(out.code, 'gcp_identity_mismatch');
});

test('wrong project in enrollment vs SPEC is enrollment mismatch', async () => {
  const { server, conversation_id, enrollment } = serverFixture({ enroll: false });
  enrollment.enroll({ project_id: 'other-proj-xyz', project_number: '123456789012' });
  const out = await service.run(server, { kind: 'gcp_gcs_tf_state', action: 'preview', spec: SPEC }, { conversation_id });
  assert.equal(out.code, 'gcp_project_not_enrolled');
});

test('preview then confirm creates exact-scope bucket (mocked)', async () => {
  const log = [];
  const { server, conversation_id } = serverFixture({ transport: mockTransport({ log }) });
  const preview = await service.run(server, { kind: 'gcp_gcs_tf_state', action: 'preview', spec: SPEC }, { conversation_id });
  assert.equal(preview.action, 'preview');
  assert.ok(preview.preview_id);
  assert.match(preview.message, /Confirm with/);
  const done = await service.run(server, {
    kind: 'gcp_gcs_tf_state', action: 'confirm', preview_id: preview.preview_id, confirmed: true,
  }, { conversation_id });
  assert.equal(done.action, 'completed');
  assert.equal(done.receipt.status, 'VERIFIED');
  assert.equal(done.receipt.bucket, SPEC.bucket);
  const insert = log.find((e) => e[0] === 'insertBucket');
  assert.deepEqual(insert[2], insertBody(SPEC));
  const iam = log.find((e) => e[0] === 'setBucketIam');
  assert.deepEqual(iam[2].bindings, [{ role: SPEC.writer_role, members: [`user:${FOUNDER}`] }]);
});

test('missing approval/confirm without preview fails', async () => {
  const { server, conversation_id } = serverFixture();
  const out = await service.run(server, {
    kind: 'gcp_gcs_tf_state', action: 'confirm', preview_id: randomUUID(),
  }, { conversation_id });
  assert.equal(out.code, 'gcp_tf_state_preview_missing');
});

test('expired approval cannot confirm', async () => {
  let now = 1_000_000;
  const db = new DatabaseSync(':memory:');
  const enrollment = new GcpProjectEnrollment({ db });
  enrollment.enroll({ project_id: SPEC.project_id, project_number: SPEC.project_number });
  const ops = new GcpGcsTfStateOps({ db, now: () => now });
  const conversation_id = randomUUID();
  const server = {
    gcpDb: db,
    gcpProjectEnrollment: enrollment,
    gcpGcsTfStateOps: ops,
    gcpStorageTransport: mockTransport(),
    gcpAllowTestCredentials: true,
    gcpTokenProvider: async () => ({ accessToken: 'ya29.token', account_email: FOUNDER }),
  };
  const preview = await service.run(server, { kind: 'gcp_gcs_tf_state', action: 'preview', spec: SPEC }, { conversation_id });
  now += 16 * 60 * 1000;
  const out = await service.run(server, {
    kind: 'gcp_gcs_tf_state', action: 'confirm', preview_id: preview.preview_id,
  }, { conversation_id });
  assert.ok(['gcp_tf_state_expired', 'gcp_tf_state_preview_missing'].includes(out.code));
});

test('revoked enrollment blocks confirm after preview', async () => {
  const { server, conversation_id, enrollment } = serverFixture();
  const preview = await service.run(server, { kind: 'gcp_gcs_tf_state', action: 'preview', spec: SPEC }, { conversation_id });
  enrollment.revoke(SPEC.project_id);
  const out = await service.run(server, {
    kind: 'gcp_gcs_tf_state', action: 'confirm', preview_id: preview.preview_id,
  }, { conversation_id });
  assert.equal(out.code, 'gcp_project_not_enrolled');
});

test('cross-project / wrong bucket rejected at exact scope', async () => {
  const { server, conversation_id } = serverFixture();
  const out = await service.run(server, {
    kind: 'gcp_gcs_tf_state',
    action: 'preview',
    spec: { ...SPEC, project_id: 'arecibo-prod', bucket: 'arecibo-tf-state' },
  }, { conversation_id });
  assert.equal(out.code, 'gcp_exact_scope_mismatch');
});

test('duplicate idempotency / replay after completion refused', async () => {
  const { server, conversation_id } = serverFixture();
  const key = 'idem-somin-1';
  const preview = await service.run(server, {
    kind: 'gcp_gcs_tf_state', action: 'preview', spec: SPEC, idempotency_key: key,
  }, { conversation_id });
  await service.run(server, {
    kind: 'gcp_gcs_tf_state', action: 'confirm', preview_id: preview.preview_id,
  }, { conversation_id });
  const replay = await service.run(server, {
    kind: 'gcp_gcs_tf_state', action: 'preview', spec: SPEC, idempotency_key: key,
  }, { conversation_id });
  assert.equal(replay.code, 'gcp_tf_state_replay_completed');
});

test('concurrent confirms: at most one insert', async () => {
  let inserts = 0;
  const transport = mockTransport();
  const orig = transport.insertBucket.bind(transport);
  transport.insertBucket = async (...args) => {
    inserts += 1;
    await new Promise((r) => setImmediate(r));
    return orig(...args);
  };
  const { server, conversation_id } = serverFixture({ transport });
  const preview = await service.run(server, { kind: 'gcp_gcs_tf_state', action: 'preview', spec: SPEC }, { conversation_id });
  const results = await Promise.all([
    service.run(server, { kind: 'gcp_gcs_tf_state', action: 'confirm', preview_id: preview.preview_id }, { conversation_id }),
    service.run(server, { kind: 'gcp_gcs_tf_state', action: 'confirm', preview_id: preview.preview_id }, { conversation_id }),
  ]);
  const completed = results.filter((r) => r.action === 'completed');
  const denied = results.filter((r) => r.action === 'denied');
  assert.equal(completed.length, 1);
  assert.equal(denied.length, 1);
  assert.equal(inserts, 1);
  assert.ok(['gcp_tf_state_concurrent_claim', 'gcp_tf_state_lease_unavailable', 'gcp_tf_state_replay_completed', 'gcp_tf_state_status_invalid'].includes(denied[0].code));
});

test('network timeout marks uncertain; no automatic retry insert', async () => {
  const log = [];
  const transport = mockTransport({ failOnce: 'insert', log });
  const { server, conversation_id } = serverFixture({ transport });
  const preview = await service.run(server, { kind: 'gcp_gcs_tf_state', action: 'preview', spec: SPEC }, { conversation_id });
  const out = await service.run(server, {
    kind: 'gcp_gcs_tf_state', action: 'confirm', preview_id: preview.preview_id,
  }, { conversation_id });
  assert.equal(out.uncertain, true);
  assert.equal(out.code, 'gcp_transport_timeout');
  assert.equal(log.filter((e) => e[0] === 'insertBucket').length, 1);
  // No automatic second insert after uncertain outcome.
  const again = await service.run(server, {
    kind: 'gcp_gcs_tf_state', action: 'confirm', preview_id: preview.preview_id,
  }, { conversation_id });
  // Uncertain ops may be re-claimed only with explicit confirm; still no silent auto-retry loop.
  assert.ok(again.action === 'denied' || again.action === 'completed' || again.uncertain === true);
  assert.ok(log.filter((e) => e[0] === 'insertBucket').length <= 2);
});

test('existing conflicting bucket fails closed', async () => {
  const bad = { ...matchingBucket(), storageClass: 'NEARLINE' };
  const { server, conversation_id } = serverFixture({
    transport: mockTransport({ getStatus: 200, getBody: bad }),
  });
  const preview = await service.run(server, { kind: 'gcp_gcs_tf_state', action: 'preview', spec: SPEC }, { conversation_id });
  const out = await service.run(server, {
    kind: 'gcp_gcs_tf_state', action: 'confirm', preview_id: preview.preview_id,
  }, { conversation_id });
  assert.equal(out.code, 'gcp_bucket_posture_mismatch');
});

test('existing matching bucket refused (no silent reuse)', async () => {
  const { server, conversation_id } = serverFixture({
    transport: mockTransport({ getStatus: 200, getBody: matchingBucket() }),
  });
  const preview = await service.run(server, { kind: 'gcp_gcs_tf_state', action: 'preview', spec: SPEC }, { conversation_id });
  const out = await service.run(server, {
    kind: 'gcp_gcs_tf_state', action: 'confirm', preview_id: preview.preview_id,
  }, { conversation_id });
  assert.equal(out.code, 'gcp_bucket_already_exists');
});

test('GCP permission denial surfaced', async () => {
  const { server, conversation_id } = serverFixture({
    transport: mockTransport({ insertStatus: 403 }),
  });
  const preview = await service.run(server, { kind: 'gcp_gcs_tf_state', action: 'preview', spec: SPEC }, { conversation_id });
  const out = await service.run(server, {
    kind: 'gcp_gcs_tf_state', action: 'confirm', preview_id: preview.preview_id,
  }, { conversation_id });
  assert.equal(out.code, 'gcp_permission_denied');
});

test('policy denial: MCP capability inactive and approval_required', () => {
  const policy = new CapabilityPolicy();
  const decided = policy.decide('gcp_gcs_tf_state_backend_create', {
    taskScopes: ['developer_environment', 'repo', 'system_readonly'],
  });
  assert.equal(decided.decision, 'deny');
  assert.equal(decided.kind, 'capability_unavailable');
  assert.equal(decided.standing_decision, 'approval_required');
  assert.equal(policy.entry('gcp_gcs_tf_state_backend_create').active, false);
});

test('connector rejects shell/command injection fields', () => {
  const caps = connectorCapabilities();
  const cap = caps.gcp_gcs_tf_state_backend_create;
  assert.throws(() => cap.validate({
    project_id: SPEC.project_id,
    project_number: SPEC.project_number,
    bucket: SPEC.bucket,
    location: SPEC.location,
    idempotency_key: 'k',
    approval_reference: 'a',
    command: 'gsutil mb gs://x',
  }), /shell|command/i);
});

test('secret leakage prevention: tokens redacted', () => {
  const raw = 'Authorization Bearer ya29.a0AfH6SMC-secret-value and AIzaSyDummyKeyValue1234567890';
  const cleaned = redact(raw);
  assert.equal(cleaned.includes('ya29.'), false);
  assert.equal(cleaned.includes('AIza'), false);
  assert.match(cleaned, /REDACTED/);
});

test('audit receipt correctness after success', async () => {
  const { server, conversation_id, ops } = serverFixture();
  const preview = await service.run(server, { kind: 'gcp_gcs_tf_state', action: 'preview', spec: SPEC }, { conversation_id });
  const done = await service.run(server, {
    kind: 'gcp_gcs_tf_state', action: 'confirm', preview_id: preview.preview_id,
  }, { conversation_id });
  const row = ops.get(preview.preview_id);
  assert.equal(row.status, 'completed');
  assert.equal(row.receipt.status, 'VERIFIED');
  assert.equal(row.receipt.evidence_hash, done.receipt.evidence_hash);
  assert.equal(row.scope_sha256, digest(canonicalSpec(SPEC)));
});

test('binding mismatch across conversations', async () => {
  const { server, conversation_id } = serverFixture();
  const preview = await service.run(server, { kind: 'gcp_gcs_tf_state', action: 'preview', spec: SPEC }, { conversation_id });
  const out = await service.run(server, {
    kind: 'gcp_gcs_tf_state', action: 'confirm', preview_id: preview.preview_id,
  }, { conversation_id: randomUUID() });
  assert.equal(out.code, 'gcp_tf_state_binding_mismatch');
});

test('release + retention inventory includes GCP V1 sources', () => {
  const root = path.join(__dirname, '..');
  const release = new Set(JSON.parse(fs.readFileSync(path.join(root, 'release-files.json'), 'utf8')));
  const retention = JSON.parse(fs.readFileSync(path.join(root, 'config/memory-retention-fields.json'), 'utf8'));
  for (const file of [
    'src/gcp-exact-scope.js',
    'src/gcp-project-enrollment.js',
    'src/gcp-gcs-tf-state-ops.js',
    'src/gcp-storage-transport.js',
    'src/gcp-gcs-tf-state-service.js',
    'src/gcp-intent.js',
    'docs/operations/gcp-governed-cloud-ops-v1.md',
    'tests/gcp-governed-cloud-ops-v1.test.js',
  ]) {
    assert.ok(release.has(file), file);
  }
  assert.ok(retention.gcp_enrolled_projects);
  assert.ok(retention.gcp_gcs_tf_state_ops);
});
