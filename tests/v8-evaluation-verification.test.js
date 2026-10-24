'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { canonicalHash } = require('../src/authority-hash');
const G = require('../src/opencode-gateway');

test('parseEvaluation accepts exact JSON and one embedded JSON object', () => {
  const binding = { version: 1, mission_id: randomUUID(), worker_run_id: randomUUID(),
    contract_hash: 'ab'.repeat(32), result_hash: 'cd'.repeat(32), integrity_hash: 'ef'.repeat(32),
    verification_hash: '01'.repeat(32), workspace_hash: '23'.repeat(32) };
  const binding_hash = canonicalHash(binding);
  const body = { version: 1, binding_hash, recommendation: 'repair', summary: 'Host expected_changes failed.' };
  assert.equal(G.parseEvaluation(JSON.stringify(body), binding).recommendation, 'repair');
  assert.equal(G.parseEvaluation('Here is the review:\n```json\n' + JSON.stringify(body) + '\n```\n', binding).recommendation, 'repair');
  assert.equal(G.extractEvaluationJSON('no object here'), null);
  assert.throws(() => G.parseEvaluation('not json at all', binding), /gateway_json_required/);
  assert.throws(() => G.parseEvaluation(JSON.stringify({ ...body, recommendation: 'ready', binding_hash: '00'.repeat(32) }), binding), /gateway_result_binding_mismatch/);
});

async function specialistSetup(t, { repairs = 0 } = {}) {
  const f = await require('./fixtures/cursor-autonomy-fixture.cjs').setup(t, {repairs}), b = f.bridge;
  f.plan = [{id:'change',worker:'cursor',role:'implementation',operation:'edit',paths:['fixture.txt'],description:'Change alpha to beta',depends_on:[],verification:[]}];
  f.evaluations = [];
  f.evaluateBroken = false;
  f.evaluateWrapped = false;
  const adapter = b.opencodeAdapter;
  f.worker = adapter.execute.bind(adapter);
  adapter.execute = async o => {
    if (o.planning) {
      return { result: { summary: JSON.stringify({ ...o.planning, tasks: f.plan }) }, changes: [],
        provenance: { termination_verified: true } };
    }
    if (o.coordination) {
      f.evaluations.push(o.coordination);
      if (f.evaluateBroken) throw Object.assign(Error('gateway_json_required'), { code: 'gateway_json_required' });
      const body = {
        ...o.coordination.result_contract,
        recommendation: o.coordination.host_checks.some(c => c.status === 'failed') ? 'repair' : 'ready',
        summary: 'Reviewed host evidence.'
      };
      const summary = f.evaluateWrapped
        ? 'Evaluation complete.\n```json\n' + JSON.stringify(body) + '\n```\n'
        : JSON.stringify(body);
      return { result: { summary }, changes: [],
        provenance: { runtime_id: 'opencode', sandbox: 'fixture', termination_verified: true, authority: false } };
    }
    return f.worker(o);
  };
  f.ask = async () => {
    const request_id = randomUUID();
    const instruction = 'In Fixture project change fixture.txt from alpha to beta.';
    let view = await b.zeroSetupWork.ask({ request_id, instruction }, 'operator');
    for (let i = 0; i < 200 && view.state === 'PLANNING'; i++) {
      await new Promise(r => setTimeout(r, 20));
      view = await b.zeroSetupWork.ask({ request_id, instruction }, 'operator');
    }
    return view;
  };
  return f;
}

test('edit claim with no host-observed changes settles needs_rework without evaluator JSON', async t => {
  const f = await specialistSetup(t);
  f.cursorMode = 'fabricate';
  const p = await f.ask();
  const m = await f.settle(p.mission_id, 'needs_rework');
  assert.match(m.reason, /no host-observed file changes/);
  assert.equal(f.evaluations.length, 0);
  const node = JSON.parse(f.bridge.controlStore.db.prepare(
    "SELECT input FROM cp_mission_program_nodes WHERE program_id=?").get(m.id).input);
  const verification = node.attempts[0].verification;
  assert.equal(verification.status, 'failed');
  assert.ok(verification.checks.some(c => c.status === 'failed'), JSON.stringify(verification.checks.map(c => ({ id: c.id, status: c.status }))));
  assert.equal(f.bridge.controlStore.db.prepare(
    "SELECT count(*) n FROM cp_leases WHERE mission_id=? AND state IN ('held','quarantined')").get(m.id).n, 0);
  assert.equal(fsRead(f, m), 'alpha\n');
});

test('failed host verification plus evaluator JSON failure settles needs_rework not EVALUATION_UNAVAILABLE', async t => {
  const f = await specialistSetup(t);
  f.cursorMode = 'trailing_lf';
  const gateway = require('../src/opencode-gateway');
  const evaluate = gateway.evaluate;
  gateway.evaluate = async (...args) => {
    f.evaluations.push(args[3]);
    throw Object.assign(Error('gateway_json_required'), { code: 'gateway_json_required' });
  };
  t.after(() => { gateway.evaluate = evaluate; });
  const p = await f.ask();
  const m = await f.settle(p.mission_id, 'needs_rework');
  const worker = m.runs.find(r => r.agent_id === 'cursor');
  assert.ok(worker, 'worker run missing');
  assert.ok((worker.result.artifacts || []).length >= 1, 'expected host-applied artifact: ' + JSON.stringify(worker.result.artifacts));
  assert.match(m.reason || '', /Host verification failed; evaluation unavailable/);
  assert.ok(!/EVALUATION_UNAVAILABLE/.test(m.reason || ''));
  assert.equal(f.evaluations.length, 1, m.reason);
  assert.equal(fsRead(f, m), 'beta\n\n');
});

test('wrapped evaluator JSON still yields a durable recommendation', async t => {
  const f = await specialistSetup(t);
  f.evaluateWrapped = true;
  const p = await f.ask();
  const m = await f.settle(p.mission_id, 'completed');
  assert.equal(m.acceptance.length, 1);
  assert.equal(f.evaluations.length, 1);
  assert.equal(fsRead(f, m), 'beta\n');
});

function fsRead(f, m) {
  return require('node:fs').readFileSync(path.join(m.envelope.workspace, 'fixture.txt'), 'utf8');
}
