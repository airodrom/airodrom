'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { runtime, manifest } = require('./fixtures/opencode-fixture.cjs');
const { LOCAL_POLICY } = require('../src/default-runtime');
const { missionView } = require('../src/product-observability');

function reset(f) { fs.writeFileSync(path.join(f.repo, 'fixture.txt'), 'alpha\n'); }

function riskCreate(f, extra = {}) {
  return f.create({
    preferred_agent: 'opencode',
    fallback_agents: [],
    dispatch_policy: { ...LOCAL_POLICY },
    risk_auto_acceptance: true,
    data_class: 'public',
    ...extra
  });
}

test('eligible low-risk OpenCode WORK auto-accepts, settles, and is idempotent after reopen', async t => {
  const r = runtime(t);
  const f = await fixture(t, { opencode: r.options });
  const m = riskCreate(f, { manifest: manifest(f.repo) });
  assert.equal(m.envelope.risk_auto_acceptance.authorized, true);
  f.bridge.missions.dispatch(m.id, { request_id: randomUUID() });
  const done = await f.settle(m.id, 'completed');
  assert.equal(done.acceptance.length, 1);
  assert.equal(done.acceptance[0].decision, 'accept');
  assert.equal(done.program_contract.settlement.state, 'settled');
  assert.equal(f.bridge.missions.riskAcceptance.attempt(m.id).duplicate, true);
  const view = missionView(f.bridge, f.bridge.controlStore.requireMission(m.id));
  assert.equal(view.acceptance.mode, 'automatically_verified');
  assert.equal(view.acceptance.status, 'accept');
  await f.reopen();
  f.bridge.missions.riskAcceptance.reconcile();
  assert.equal(f.bridge.missions.detail(m.id).acceptance.length, 1);
  assert.equal(f.bridge.missions.detail(m.id).program_contract.settlement.state, 'settled');
});

test('pending approval and high-risk shapes stay awaiting with durable review_reason', async t => {
  const r = runtime(t);
  const f = await fixture(t, { opencode: r.options });
  assert.throws(() => riskCreate(f, { criteria: [{ id: 'review', type: 'operator_review', description: 'Human review' }] }), /operator_review/);
  assert.throws(() => riskCreate(f, {
    preferred_agent: 'claude_code',
    dispatch_policy: { privacy: 'cloud_allowed', providers: ['anthropic_subscription'], billing_classes: ['subscription'], task_category: 'focused_coding' }
  }), /OpenCode only|Risk auto acceptance/);
  // Ordinary Mission without opt-in remains awaiting_acceptance after verification.
  const ordinary = f.create({ preferred_agent: 'opencode', fallback_agents: [], dispatch_policy: { ...LOCAL_POLICY } });
  assert.equal(ordinary.envelope.risk_auto_acceptance, undefined);
  f.bridge.missions.dispatch(ordinary.id, { request_id: randomUUID() });
  const waiting = await f.settle(ordinary.id, 'awaiting_acceptance');
  assert.equal(waiting.acceptance.length, 0);
  assert.equal(f.bridge.missions.riskAcceptance.attempt(ordinary.id).reason, 'not_preauthorized_risk');
  reset(f);

  const m = riskCreate(f, { objective: 'Risk-policy Mission: change fixture.txt from alpha to beta. Make its test pass.' });
  const attempt = f.bridge.missions.riskAcceptance.attempt.bind(f.bridge.missions.riskAcceptance);
  f.bridge.missions.riskAcceptance.attempt = () => ({ accepted: false, reason: 'deferred' });
  f.bridge.missions.dispatch(m.id, { request_id: randomUUID() });
  await f.settle(m.id, 'awaiting_acceptance');
  f.bridge.missions.riskAcceptance.attempt = attempt;
  const list = f.bridge.policy.list;
  f.bridge.policy.list = () => [{ status: 'pending', taskId: m.task_id }];
  assert.equal(attempt(m.id).reason, 'pending_approval');
  assert.equal(f.bridge.missions.riskAcceptance.reviewReason(m.id), 'pending_approval');
  f.bridge.policy.list = list;
  const view = missionView(f.bridge, f.bridge.controlStore.requireMission(m.id));
  assert.equal(view.acceptance.mode, 'needs_operator_review');
  assert.equal(view.acceptance.review_reason, 'pending_approval');
  const denied = f.bridge.ledger.list({ missionId: m.id, limit: 100, order: 'desc' }).events
    .some(e => e.event_type === 'risk.auto_acceptance.denied' && e.metadata?.reason === 'pending_approval');
  assert.equal(denied, true);
  await f.reopen();
  const retained = f.bridge.ledger.list({ missionId: m.id, limit: 100, order: 'desc' }).events
    .some(e => e.event_type === 'risk.auto_acceptance.denied' && e.metadata?.reason === 'pending_approval');
  assert.equal(retained, true);
});

test('MCP owner cannot authorize risk auto acceptance', async t => {
  const r = runtime(t);
  const f = await fixture(t, { opencode: r.options });
  const sample = riskCreate(f);
  assert.throws(() => f.bridge.missions.create({
    request_id: randomUUID(),
    project_id: sample.project_id,
    goal_id: sample.goal_id,
    objective: sample.envelope.objective,
    workspace: f.repo,
    allowed_files: ['fixture.txt'],
    criteria: sample.envelope.criteria,
    verification: sample.envelope.verification,
    preferred_agent: 'opencode',
    fallback_agents: [],
    dispatch_policy: { ...LOCAL_POLICY },
    risk_auto_acceptance: true,
    data_class: 'public'
  }, 'mcp'), /operator/);
  assert.throws(() => f.bridge.missions.riskAcceptance.setPreference({ enabled: true, confirmed: true }, 'mcp'), /operator/);
});

test('operator preference enables new WORK only; historical awaits require authorizeExisting', async t => {
  const r = runtime(t);
  const f = await fixture(t, { opencode: r.options });
  const risk = f.bridge.missions.riskAcceptance;
  assert.equal(risk.preference().enabled, false);
  assert.throws(() => risk.setPreference({ enabled: true, confirmed: false }, 'operator'), /confirmation/);
  assert.equal(risk.setPreference({ enabled: true, confirmed: true }, 'operator').enabled, true);
  const overview = await require('../src/product-observability').overview(f.bridge, { includeMissions: false });
  assert.equal(overview.acceptance_config.preference.enabled, true);
  assert.equal(overview.acceptance_config.waits.approval_expiry.configurable, false);

  const viaPref = f.create({
    preferred_agent: 'opencode',
    fallback_agents: [],
    dispatch_policy: { ...LOCAL_POLICY },
    objective: 'Preference-enabled Mission: change fixture.txt from alpha to beta. Make its test pass.'
  });
  assert.equal(viaPref.envelope.risk_auto_acceptance.authorized, true);
  assert.equal(viaPref.envelope.risk_auto_acceptance.source, 'operator_preference');
  f.bridge.missions.dispatch(viaPref.id, { request_id: randomUUID() });
  await f.settle(viaPref.id, 'completed');
  reset(f);

  risk.setPreference({ enabled: false, confirmed: true }, 'operator');
  const historical = f.create({
    preferred_agent: 'opencode',
    fallback_agents: [],
    dispatch_policy: { ...LOCAL_POLICY },
    objective: 'Historical awaiting Mission: change fixture.txt from alpha to beta. Make its test pass.',
    risk_auto_acceptance: false
  });
  assert.equal(historical.envelope.risk_auto_acceptance, undefined);
  f.bridge.missions.dispatch(historical.id, { request_id: randomUUID() });
  await f.settle(historical.id, 'awaiting_acceptance');
  risk.setPreference({ enabled: true, confirmed: true }, 'operator');
  risk.reconcile();
  assert.equal(f.bridge.missions.detail(historical.id).state, 'awaiting_acceptance');
  assert.equal(risk.attempt(historical.id).reason, 'not_preauthorized_risk');
  const authorized = risk.authorizeExisting(historical.id, { request_id: randomUUID(), confirmed: true }, 'operator');
  assert.equal(authorized.accepted, true);
  const done = f.bridge.missions.detail(historical.id);
  assert.equal(done.state, 'completed');
  assert.equal(done.acceptance.length, 1);
  assert.equal(done.acceptance[0].decision, 'accept');
});
