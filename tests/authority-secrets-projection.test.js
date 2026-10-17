'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { safeValue, sensitiveKey } = require('../src/secret-observation');
const { fingerprint } = require('../src/control-plane-store');

test('empty permissions.secrets allowlist round-trips through API safeValue projection', () => {
  const authority = {
    level: 'development',
    permissions: {
      repository: ['read', 'write'],
      runtime: ['diagnostic', 'test'],
      network: ['localhost'],
      secrets: [],
      data: ['read', 'workspace_write']
    },
    filesystem: { read: ['/tmp/fixture'], write: ['/tmp/fixture'] },
    expiresAt: Date.now() + 60000
  };
  const projected = safeValue({ authority, grant_material: { client_secret: 'sk-ant-synthetic' } });
  assert.deepEqual(projected.authority.permissions.secrets, []);
  assert.equal(projected.grant_material.client_secret, '[omitted]');
  assert.equal(fingerprint(projected.authority.permissions), fingerprint(authority.permissions));
  assert.notEqual(projected.authority.permissions.secrets, '[omitted]');
});

test('only permissions.secrets typed allowlists project; unrelated secrets fields stay omitted', () => {
  assert.equal(sensitiveKey('secrets'), true);
  assert.equal(safeValue({ secrets: { api_key: 'sk-ant-synthetic' } }).secrets, '[omitted]');
  assert.equal(safeValue({ secrets: 'sk-ant-synthetic' }).secrets, '[omitted]');
  assert.equal(safeValue({ secrets: [] }).secrets, '[omitted]');
  assert.equal(safeValue({ secrets: ['use'] }).secrets, '[omitted]');
  assert.equal(safeValue({ vault: { secrets: ['use'] } }).vault.secrets, '[omitted]');
  assert.equal(safeValue({ permissions: { secrets: ['use', 'evil'] } }).permissions.secrets, '[omitted]');
  assert.deepEqual(safeValue({ permissions: { secrets: ['use'] } }).permissions.secrets, ['use']);
  assert.deepEqual(safeValue({ permissions: { secrets: ['production'] } }).permissions.secrets, ['production']);
  assert.doesNotMatch(JSON.stringify(safeValue({
    permissions: { secrets: ['use'] },
    password: 'sk-ant-synthetic'
  })), /sk-ant-synthetic/);
});

test('Developer Autonomy rejects "[omitted]" as authority secrets', () => {
  const { DeveloperAutonomy } = require('../src/developer-autonomy');
  const da = Object.create(DeveloperAutonomy.prototype);
  da.grantScope = () => ({
    developer_autonomy: { policy_id: 'p', grant_id: 'g', hash: 'h', workspace_id: 'w', repair_budget: 1 },
    project_id: 'proj', goal_id: 'goal', workspace: '/tmp', allowed_files: ['a.txt'],
    verification: {}, capability_scopes: [], authority: { permissions: { secrets: [] } },
    dispatch_policy: require('../src/default-runtime').LOCAL_POLICY, fallback_agents: [], manifest: {}
  });
  assert.throws(() => da.assertInput({
    developer_autonomy: { policy_id: 'p', grant_id: 'g', hash: 'h', workspace_id: 'w', repair_budget: 1 },
    authority: { permissions: { secrets: '[omitted]' } }
  }), /Immutable grant ceiling mismatch/);
});
