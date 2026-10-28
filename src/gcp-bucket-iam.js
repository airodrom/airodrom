'use strict';
// Classify GCS bucket IAM for exact-scope Somin tf-state CREATE.
// Distinguishes provider project-default legacy bindings from unauthorized grants.
// Inherited project IAM that is NOT materialized as a bucket binding is out of scope here.

function sortedUnique(list) {
  return [...new Set((list || []).map(String))].sort();
}

function sameMembers(a, b) {
  return JSON.stringify(sortedUnique(a)) === JSON.stringify(sortedUnique(b));
}

function projectDefaultRoles(project_id) {
  const p = String(project_id || '');
  return Object.freeze({
    'roles/storage.legacyBucketOwner': Object.freeze([`projectEditor:${p}`, `projectOwner:${p}`]),
    'roles/storage.legacyBucketReader': Object.freeze([`projectViewer:${p}`]),
    'roles/storage.legacyObjectOwner': Object.freeze([`projectEditor:${p}`, `projectOwner:${p}`]),
    'roles/storage.legacyObjectReader': Object.freeze([`projectViewer:${p}`]),
  });
}

function founderMember(spec) {
  return `user:${String(spec.founder_email || '').toLowerCase()}`;
}

/**
 * @returns {{
 *   founder_present: boolean,
 *   missing_founder: boolean,
 *   unauthorized: Array<{role:string,members:string[],reason:string}>,
 *   default_bindings: Array<object>,
 *   founder_bindings: Array<object>,
 *   other_bindings: Array<object>,
 *   classification: 'empty'|'expected_defaults'|'founder_complete'|'unauthorized'
 * }}
 */
function classifyBucketIamBindings(policy, spec) {
  const bindings = Array.isArray(policy?.bindings) ? policy.bindings : [];
  const defaults = projectDefaultRoles(spec.project_id);
  const founder = founderMember(spec);
  const writerRole = spec.writer_role;
  const unauthorized = [];
  const default_bindings = [];
  const founder_bindings = [];
  const other_bindings = [];

  for (const binding of bindings) {
    const role = String(binding?.role || '');
    const members = sortedUnique(binding?.members || []);
    if (binding?.condition) {
      unauthorized.push({ role, members, reason: 'conditional_binding_refused' });
      other_bindings.push(binding);
      continue;
    }
    if (role === writerRole) {
      if (members.length === 1 && members[0].toLowerCase() === founder) {
        founder_bindings.push({ role, members: [founder] });
        continue;
      }
      unauthorized.push({ role, members, reason: 'writer_role_members_not_exact_founder' });
      other_bindings.push(binding);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(defaults, role)) {
      if (sameMembers(members, defaults[role])) {
        default_bindings.push({ role, members: sortedUnique(defaults[role]) });
        continue;
      }
      unauthorized.push({ role, members, reason: 'default_role_members_drift' });
      other_bindings.push(binding);
      continue;
    }
    unauthorized.push({ role, members, reason: 'unexpected_role' });
    other_bindings.push(binding);
  }

  const founder_present = founder_bindings.length > 0;
  let classification = 'empty';
  if (unauthorized.length) classification = 'unauthorized';
  else if (founder_present && (default_bindings.length || bindings.length === founder_bindings.length)) {
    classification = 'founder_complete';
  } else if (default_bindings.length || bindings.length === 0) {
    classification = bindings.length === 0 ? 'empty' : 'expected_defaults';
  }

  return {
    founder_present,
    missing_founder: !founder_present,
    unauthorized,
    default_bindings,
    founder_bindings,
    other_bindings,
    classification,
  };
}

function desiredIamPolicy(policy, spec) {
  if (!policy || !policy.etag) {
    const err = Error('IAM etag required before bucket policy write.');
    err.code = 'gcp_iam_etag_required';
    throw err;
  }
  const classified = classifyBucketIamBindings(policy, spec);
  if (classified.unauthorized.length) {
    const err = Error('Unexpected existing bucket IAM bindings; recovery requires separate approval.');
    err.code = 'gcp_unexpected_bucket_bindings';
    err.classification = classified;
    throw err;
  }

  const founder = founderMember(spec);
  const writer = { role: spec.writer_role, members: [founder] };
  // Preserve provider project-default legacy bindings; add exact founder writer.
  // Do not invent defaults when the provider returned an empty policy.
  const bindings = [
    ...classified.default_bindings.map((b) => ({ role: b.role, members: [...b.members] })),
    writer,
  ];
  // Stable role order for deterministic digests / verification.
  bindings.sort((a, b) => String(a.role).localeCompare(String(b.role)));
  return {
    version: 3,
    etag: policy.etag,
    bindings,
    classification: classified,
  };
}

function iamMatchesDesired(policy, desired) {
  const got = (policy?.bindings || []).map((b) => ({
    role: b.role,
    members: sortedUnique(b.members || []),
  })).sort((a, b) => String(a.role).localeCompare(String(b.role)));
  const want = (desired?.bindings || []).map((b) => ({
    role: b.role,
    members: sortedUnique(b.members || []),
  })).sort((a, b) => String(a.role).localeCompare(String(b.role)));
  return JSON.stringify(got) === JSON.stringify(want);
}

function assertIamAcceptable(policy, spec) {
  const classified = classifyBucketIamBindings(policy, spec);
  if (classified.unauthorized.length) {
    const err = Error('Unexpected existing bucket IAM bindings; recovery requires separate approval.');
    err.code = 'gcp_unexpected_bucket_bindings';
    err.classification = classified;
    throw err;
  }
  if (!classified.founder_present) {
    const err = Error('Approved founder writer binding is missing after IAM write.');
    err.code = 'gcp_iam_verification_failed';
    err.classification = classified;
    throw err;
  }
  return classified;
}

module.exports = {
  projectDefaultRoles,
  classifyBucketIamBindings,
  desiredIamPolicy,
  iamMatchesDesired,
  assertIamAcceptable,
  sortedUnique,
  founderMember,
};
