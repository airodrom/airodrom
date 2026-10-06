'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AutonomyPolicy, loadAutonomyPolicy } = require('../src/autonomy-policy');
const SafetyPolicy = require('../src/safety-policy');
const path = require('node:path');
const fs = require('node:fs');

test('trusted-routine-actions-v1 loads with final-clause protected overrides', () => {
  const policy = new AutonomyPolicy();
  assert.equal(policy.policyVersion, 'trusted-routine-actions-v1');
  assert.equal(policy.precedenceRule, 'final_clause_overrides');

  for (const name of ['personal_memory_remember', 'personal_memory_update', 'personal_memory_forget', 'read', 'write', 'edit', 'bridge-maintenance', 'trusted-development']) {
    const decision = policy.decide(name);
    assert.equal(decision.decision, 'auto_allow', name);
    assert.equal(decision.automatic, true, name);
  }

  const overrides = policy.protectedOverrides();
  for (const [name, decision] of Object.entries(overrides)) {
    assert.notEqual(decision.decision, 'auto_allow', `${name} must remain protected by final-clause precedence`);
    assert.ok(['approval_required', 'deny'].includes(decision.decision), name);
  }

  assert.equal(policy.decide('system_software_install').decision, 'approval_required');
  assert.equal(policy.decide('system_software_uninstall').decision, 'approval_required');
  assert.equal(policy.decide('pr_merge').decision, 'approval_required');
  assert.equal(policy.decide('sudo').decision, 'deny');
  assert.equal(policy.decide('messaging_bulk_broadcast').decision, 'approval_required');
  assert.equal(policy.decide('gmail_send').active, false);
  assert.equal(policy.decide('calendar_event_create').active, false);
});

test('SafetyPolicy auto-allows Personal Memory writes under standing policy and keeps project writes approval-gated', () => {
  const root = fs.mkdtempSync('/private/tmp/autonomy-policy-');
  try {
    const policy = new SafetyPolicy();
    policy.registerTask({ id: 't1', sessionId: 's1', workspace: root });
    const remember = policy.check('t1', {
      toolName: 'personal_memory_remember',
      input: { domain: 'personal', type: 'preference', subject: 'alpha', content: 'alpha value' }
    }, { brokered: true });
    assert.equal(remember.allow, true);
    assert.equal(remember.automatic, true);
    assert.equal(remember.policy_version, 'trusted-routine-actions-v1');
    assert.equal(remember.approvalId, undefined);

    const project = policy.check('t1', {
      toolName: 'project_create',
      input: { name: 'Needs Approval' }
    }, { brokered: true });
    assert.equal(project.allow, false);
    assert.equal(project.kind, 'approval_required');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('policy document path is loadable and unknown capabilities fail closed', () => {
  const document = loadAutonomyPolicy(path.join(__dirname, '../config/trusted-routine-actions-v1.json'));
  assert.equal(document.policyVersion, 'trusted-routine-actions-v1');
  const policy = new AutonomyPolicy({ document });
  const unknown = policy.decide('not_a_real_capability');
  assert.equal(unknown.found, false);
  assert.equal(unknown.decision, 'deny');
  assert.equal(unknown.automatic, false);
});
