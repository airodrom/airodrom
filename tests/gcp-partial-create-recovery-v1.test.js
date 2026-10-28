'use strict';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const service = require('../src/gcp-gcs-tf-state-service');
const {
  classifyBucketIamBindings,
  desiredIamPolicy,
  projectDefaultRoles,
} = require('../src/gcp-bucket-iam');
const { SOMIN_TF_STATE_BACKEND_V1 } = require('../src/gcp-exact-scope');
const { GcpProjectEnrollment } = require('../src/gcp-project-enrollment');
const { GcpGcsTfStateOps } = require('../src/gcp-gcs-tf-state-ops');

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

function gcsDefaultBindings(project_id = SPEC.project_id) {
  const defaults = projectDefaultRoles(project_id);
  return Object.entries(defaults).map(([role, members]) => ({ role, members: [...members] }));
}

function mockTransport({
  getStatus = 404,
  getBody = null,
  insertStatus = 200,
  iamBindings = null,
  iamPutStatus = 200,
  failOnce = null,
  log = [],
} = {}) {
  let inserted = false;
  let iam = {
    etag: 'etag-1',
    bindings: iamBindings == null ? [] : iamBindings,
  };
  return {
    async getBucket() {
      log.push(['getBucket']);
      if (failOnce === 'getBucket') {
        failOnce = null;
        const err = Error('network timeout');
        err.code = 'gcp_transport_timeout';
        throw err;
      }
      if (inserted || getStatus === 200) {
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
      if (insertStatus === 409) return { status: 409, body: { error: { message: 'conflict' } } };
      if (insertStatus === 403) return { status: 403, body: { error: { message: 'denied' } } };
      inserted = true;
      // Real GCS seeds project-default legacy bindings on new buckets.
      if (!iam.bindings.length) iam = { etag: 'etag-after-create', bindings: gcsDefaultBindings() };
      return { status: insertStatus, body: matchingBucket() };
    },
    async getBucketIam() {
      log.push(['getBucketIam']);
      return { status: 200, body: iam };
    },
    async setBucketIam(_b, policy) {
      log.push(['setBucketIam', policy]);
      if (iamPutStatus >= 400) return { status: iamPutStatus, body: { error: { message: 'iam put failed' } } };
      iam = { etag: 'etag-2', bindings: policy.bindings };
      return { status: iamPutStatus, body: iam };
    },
  };
}

function serverFixture(opts = {}) {
  const db = new DatabaseSync(':memory:');
  const enrollment = new GcpProjectEnrollment({ db });
  if (opts.enroll !== false) {
    enrollment.enroll({
      project_id: SPEC.project_id,
      project_number: SPEC.project_number,
      operator: 'operator',
      account_email: FOUNDER,
    });
  }
  const log = opts.log || [];
  const transport = opts.transport || mockTransport({ log, ...opts.transportOpts });
  return {
    conversation_id: randomUUID(),
    log,
    enrollment,
    server: {
      gcpDb: db,
      gcpProjectEnrollment: enrollment,
      gcpGcsTfStateOps: new GcpGcsTfStateOps({ db }),
      gcpStorageTransport: transport,
      gcpAllowTestCredentials: true,
      gcpTokenProvider: async () => ({
        accessToken: 'ya29.test-token-value',
        account_email: opts.identity || FOUNDER,
      }),
    },
  };
}

test('classifier accepts empty and GCS project-default legacy bindings', () => {
  assert.equal(classifyBucketIamBindings({ bindings: [] }, SPEC).classification, 'empty');
  const defaults = { etag: 'e', bindings: gcsDefaultBindings() };
  const c = classifyBucketIamBindings(defaults, SPEC);
  assert.equal(c.classification, 'expected_defaults');
  assert.equal(c.missing_founder, true);
  assert.equal(c.unauthorized.length, 0);
  const policy = desiredIamPolicy(defaults, SPEC);
  assert.ok(policy.bindings.some((b) => b.role === SPEC.writer_role));
  assert.ok(policy.bindings.some((b) => b.role === 'roles/storage.legacyBucketOwner'));
});

test('classifier refuses unauthorized direct user/group bindings', () => {
  const bad = {
    etag: 'e',
    bindings: [
      ...gcsDefaultBindings(),
      { role: 'roles/storage.admin', members: ['user:intruder@example.com'] },
    ],
  };
  const c = classifyBucketIamBindings(bad, SPEC);
  assert.equal(c.classification, 'unauthorized');
  assert.throws(() => desiredIamPolicy(bad, SPEC), (e) => e.code === 'gcp_unexpected_bucket_bindings');
});

test('fresh CREATE tolerates provider-default IAM after insert', async () => {
  const log = [];
  const { server, conversation_id } = serverFixture({ log });
  const preview = await service.run(server, { kind: 'gcp_gcs_tf_state', action: 'preview', spec: SPEC }, { conversation_id });
  assert.equal(preview.recovery_mode, 'create');
  const done = await service.run(server, {
    kind: 'gcp_gcs_tf_state', action: 'confirm', preview_id: preview.preview_id,
  }, { conversation_id });
  assert.equal(done.action, 'completed');
  assert.equal(done.receipt.mutation, 'bucket_create_and_iam');
  assert.equal(log.filter((e) => e[0] === 'insertBucket').length, 1);
  assert.equal(log.filter((e) => e[0] === 'setBucketIam').length, 1);
  const put = log.find((e) => e[0] === 'setBucketIam')[1];
  assert.ok(put.bindings.some((b) => b.role === 'roles/storage.legacyBucketOwner'));
  assert.ok(put.bindings.some((b) => b.role === SPEC.writer_role && b.members.includes(`user:${FOUNDER.toLowerCase()}`)));
});

test('partial create: existing defaults-only bucket completes IAM without insert', async () => {
  const log = [];
  const { server, conversation_id } = serverFixture({
    log,
    transportOpts: {
      getStatus: 200,
      getBody: matchingBucket(),
      iamBindings: gcsDefaultBindings(),
    },
  });
  const preview = await service.run(server, { kind: 'gcp_gcs_tf_state', action: 'preview', spec: SPEC }, { conversation_id });
  assert.equal(preview.recovery_mode, 'complete_iam');
  assert.match(preview.message, /PARTIAL CREATE|already exists/i);
  const done = await service.run(server, {
    kind: 'gcp_gcs_tf_state', action: 'confirm', preview_id: preview.preview_id,
  }, { conversation_id });
  assert.equal(done.action, 'completed');
  assert.equal(done.receipt.recovery, 'partial_create_iam_completed');
  assert.equal(log.filter((e) => e[0] === 'insertBucket').length, 0);
});

test('fully compliant existing bucket verifies without mutation', async () => {
  const log = [];
  const bindings = [
    ...gcsDefaultBindings(),
    { role: SPEC.writer_role, members: [`user:${FOUNDER}`] },
  ];
  const { server, conversation_id } = serverFixture({
    log,
    transportOpts: {
      getStatus: 200,
      getBody: matchingBucket(),
      iamBindings: bindings,
    },
  });
  const preview = await service.run(server, { kind: 'gcp_gcs_tf_state', action: 'preview', spec: SPEC }, { conversation_id });
  assert.equal(preview.recovery_mode, 'verify_existing');
  const done = await service.run(server, {
    kind: 'gcp_gcs_tf_state', action: 'confirm', preview_id: preview.preview_id,
  }, { conversation_id });
  assert.equal(done.action, 'completed');
  assert.equal(done.receipt.mutated, false);
  assert.equal(done.receipt.recovery, 'existing_bucket_verified');
  assert.equal(log.filter((e) => e[0] === 'insertBucket').length, 0);
  assert.equal(log.filter((e) => e[0] === 'setBucketIam').length, 0);
});

test('unauthorized IAM on existing bucket holds at preview', async () => {
  const { server, conversation_id } = serverFixture({
    transportOpts: {
      getStatus: 200,
      getBody: matchingBucket(),
      iamBindings: [
        ...gcsDefaultBindings(),
        { role: 'roles/storage.objectViewer', members: ['user:outsider@evil.example'] },
      ],
    },
  });
  const preview = await service.run(server, { kind: 'gcp_gcs_tf_state', action: 'preview', spec: SPEC }, { conversation_id });
  assert.equal(preview.action, 'denied');
  assert.equal(preview.code, 'gcp_unexpected_bucket_bindings');
});

test('posture mismatch existing bucket holds', async () => {
  const bad = { ...matchingBucket(), storageClass: 'NEARLINE' };
  const { server, conversation_id } = serverFixture({
    transportOpts: { getStatus: 200, getBody: bad, iamBindings: gcsDefaultBindings() },
  });
  const preview = await service.run(server, { kind: 'gcp_gcs_tf_state', action: 'preview', spec: SPEC }, { conversation_id });
  assert.equal(preview.code, 'gcp_bucket_posture_mismatch');
});

test('duplicate confirm after IAM completion fails closed', async () => {
  const { server, conversation_id } = serverFixture({
    transportOpts: {
      getStatus: 200,
      getBody: matchingBucket(),
      iamBindings: gcsDefaultBindings(),
    },
  });
  const preview = await service.run(server, { kind: 'gcp_gcs_tf_state', action: 'preview', spec: SPEC }, { conversation_id });
  const done = await service.run(server, {
    kind: 'gcp_gcs_tf_state', action: 'confirm', preview_id: preview.preview_id,
  }, { conversation_id });
  assert.equal(done.action, 'completed');
  const again = await service.run(server, {
    kind: 'gcp_gcs_tf_state', action: 'confirm', preview_id: preview.preview_id,
  }, { conversation_id });
  assert.equal(again.code, 'gcp_tf_state_replay_completed');
});

test('IAM put failure after insert is uncertain (partial), not hard-deny wipe', async () => {
  const log = [];
  const transport = mockTransport({ log, iamPutStatus: 500 });
  // Force defaults to appear only after insert
  const { server, conversation_id } = serverFixture({ transport, log });
  const preview = await service.run(server, { kind: 'gcp_gcs_tf_state', action: 'preview', spec: SPEC }, { conversation_id });
  const out = await service.run(server, {
    kind: 'gcp_gcs_tf_state', action: 'confirm', preview_id: preview.preview_id,
  }, { conversation_id });
  assert.equal(out.uncertain, true);
  assert.equal(out.code, 'gcp_iam_write_failed');
  assert.equal(log.filter((e) => e[0] === 'insertBucket').length, 1);
});

test('409 conflict is uncertain; missing confirm / expired / wrong identity still fail closed', async () => {
  {
    const { server, conversation_id } = serverFixture({
      transportOpts: { insertStatus: 409 },
    });
    const preview = await service.run(server, { kind: 'gcp_gcs_tf_state', action: 'preview', spec: SPEC }, { conversation_id });
    const out = await service.run(server, {
      kind: 'gcp_gcs_tf_state', action: 'confirm', preview_id: preview.preview_id,
    }, { conversation_id });
    assert.equal(out.uncertain, true);
    assert.equal(out.code, 'gcp_insert_conflict');
  }
  {
    const { server, conversation_id } = serverFixture();
    const missing = await service.run(server, {
      kind: 'gcp_gcs_tf_state', action: 'confirm', preview_id: randomUUID(),
    }, { conversation_id });
    assert.equal(missing.code, 'gcp_tf_state_preview_missing');
  }
  {
    const { server, conversation_id } = serverFixture({ identity: 'intruder@example.com' });
    const denied = await service.run(server, { kind: 'gcp_gcs_tf_state', action: 'preview', spec: SPEC }, { conversation_id });
    assert.equal(denied.code, 'gcp_identity_mismatch');
  }
});

test('default-role member drift is unauthorized', () => {
  const drifted = {
    etag: 'e',
    bindings: [{
      role: 'roles/storage.legacyBucketOwner',
      members: [`projectOwner:${SPEC.project_id}`, 'user:extra@example.com'],
    }],
  };
  assert.equal(classifyBucketIamBindings(drifted, SPEC).classification, 'unauthorized');
});
