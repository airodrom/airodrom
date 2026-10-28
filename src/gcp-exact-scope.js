'use strict';
// Exact V1 Somin Terraform state-backend scope. Chat text cannot widen this.
const { createHash } = require('node:crypto');

const SOMIN_TF_STATE_BACKEND_V1 = Object.freeze({
  project_id: 'somin-ca-prod',
  project_number: '172228664875',
  bucket: 'somin-ca-prod-tf-state',
  location: 'northamerica-northeast1',
  storage_class: 'STANDARD',
  uniform_bucket_level_access: true,
  public_access_prevention: 'enforced',
  versioning: true,
  encryption: 'google-managed',
  founder_email: 'andcantech@gmail.com',
  writer_role: 'roles/storage.objectAdmin',
  prefix: 'terraform/prod',
  arecibo_reuse: false,
});

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function canonicalSpec(input = {}) {
  return {
    project_id: String(input.project_id || ''),
    project_number: String(input.project_number || ''),
    bucket: String(input.bucket || ''),
    location: String(input.location || ''),
    storage_class: String(input.storage_class || ''),
    uniform_bucket_level_access: input.uniform_bucket_level_access === true,
    public_access_prevention: String(input.public_access_prevention || ''),
    versioning: input.versioning === true,
    encryption: String(input.encryption || ''),
    founder_email: String(input.founder_email || ''),
    writer_role: String(input.writer_role || ''),
    prefix: String(input.prefix || ''),
    arecibo_reuse: input.arecibo_reuse === true,
  };
}

function assertExactSominTfStateBackend(input = {}) {
  const got = canonicalSpec(input);
  const want = canonicalSpec(SOMIN_TF_STATE_BACKEND_V1);
  if (digest(got) !== digest(want)) {
    const err = Error('GCP operation rejected: exact Somin tf-state backend scope mismatch.');
    err.code = 'gcp_exact_scope_mismatch';
    err.safe = true;
    throw err;
  }
  if (got.arecibo_reuse === true) {
    const err = Error('Arecibo state-bucket reuse is forbidden.');
    err.code = 'gcp_arecibo_reuse_forbidden';
    throw err;
  }
  return { ...SOMIN_TF_STATE_BACKEND_V1, scope_sha256: digest(want) };
}

function insertBody(spec = SOMIN_TF_STATE_BACKEND_V1) {
  assertExactSominTfStateBackend(spec);
  return {
    name: spec.bucket,
    location: spec.location,
    storageClass: 'STANDARD',
    versioning: { enabled: true },
    iamConfiguration: {
      uniformBucketLevelAccess: { enabled: true },
      publicAccessPrevention: 'enforced',
    },
  };
}

function verifyBucketMetadata(bucket, spec = SOMIN_TF_STATE_BACKEND_V1) {
  try {
    const ok = bucket
      && bucket.name === spec.bucket
      && String(bucket.projectNumber) === spec.project_number
      && String(bucket.location || '').toLowerCase() === spec.location
      && bucket.storageClass === 'STANDARD'
      && bucket.versioning?.enabled === true
      && bucket.iamConfiguration?.uniformBucketLevelAccess?.enabled === true
      && bucket.iamConfiguration?.publicAccessPrevention === 'enforced'
      && !bucket.encryption
      && bucket.autoclass?.enabled !== true;
    if (!ok) {
      const err = Error('Existing bucket posture does not match the approved exact scope.');
      err.code = 'gcp_bucket_posture_mismatch';
      throw err;
    }
  } catch (error) {
    if (error.code) throw error;
    const err = Error('Existing bucket posture does not match the approved exact scope.');
    err.code = 'gcp_bucket_posture_mismatch';
    throw err;
  }
  return { matched: true, bucket: spec.bucket, project_number: spec.project_number };
}

module.exports = {
  SOMIN_TF_STATE_BACKEND_V1,
  digest,
  canonicalSpec,
  assertExactSominTfStateBackend,
  insertBody,
  verifyBucketMetadata,
};
