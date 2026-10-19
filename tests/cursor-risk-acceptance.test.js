'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { RiskAcceptance } = require('../src/risk-acceptance');

test('standing OpenCode risk preference does not apply when a Cursor Mission opts out', () => {
  const db = new DatabaseSync(':memory:');
  const risk = new RiskAcceptance({ bridge: {}, store: { db } });
  db.prepare('UPDATE cp_risk_acceptance_preference SET enabled=1').run();
  const cursor = {
    preferred_agent: 'cursor',
    fallback_agents: [],
    capability_scopes: ['repo', 'developer_environment'],
    data_class: 'public',
    dispatch_policy: { privacy: 'cloud_allowed' },
    criteria: [{ id: 'registered-checks', type: 'registered_checks', description: 'host checks' }],
  };
  assert.throws(() => risk.validateCreation(cursor, 'operator'), /OpenCode only/);
  assert.equal(risk.validateCreation({ ...cursor, risk_auto_acceptance: false }, 'operator'), null);
});
