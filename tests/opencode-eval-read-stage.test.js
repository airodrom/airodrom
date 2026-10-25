'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const G = require('../src/opencode-gateway');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { runtime, qualifyCanonical } = require('./fixtures/opencode-fixture.cjs');

test('read assignment brief forbids requiring mutations', () => {
  const brief = G.assignmentEvaluationBrief({
    assignment: { id: 'read-1', operation: 'read', paths: ['recovery-proof.txt'] },
    verification: { status: 'passed' },
    final: false,
    missionObjective: 'Read recovery-proof.txt then edit it to exact bytes 626574610a',
  });
  assert.equal(brief.operation, 'read');
  assert.equal(brief.require_file_modifications, false);
  assert.equal(brief.host_verification_status, 'passed');
  assert.ok(brief.do_not.some(line => /later dependent edit|Mission-level edit/i.test(line)));
  const objective = G.evaluationObjective({
    mission: { envelope: { objective: 'Read then edit recovery-proof.txt to exact bytes 626574610a' } },
    assignmentBrief: brief,
    specialistEnabled: true,
    final: false,
  });
  assert.match(objective, /READ assignment/i);
  assert.match(objective, /Do NOT require file modifications/i);
  assert.match(objective, /assignment_contract/);
  assert.doesNotMatch(objective, /^Evaluate the original objective:/);
});

test('edit assignment brief requires host-verified mutations', () => {
  const brief = G.assignmentEvaluationBrief({
    assignment: { id: 'change-1', operation: 'edit', paths: ['recovery-proof.txt'] },
    verification: { status: 'passed' },
    final: true,
    missionObjective: 'Edit recovery-proof.txt',
  });
  assert.equal(brief.require_file_modifications, true);
  assert.ok(brief.success_when.some(line => /host-observed changes/i.test(line)));
});

test('stage-confused blocked on host-verified read fails closed', () => {
  const brief = G.assignmentEvaluationBrief({
    assignment: { id: 'read-1', operation: 'read', paths: ['recovery-proof.txt'] },
    verification: { status: 'passed' },
    final: false,
  });
  const confused = {
    recommendation: 'blocked',
    summary: 'The objective requires editing result.txt to exact bytes 626574610a, but the current task is to read recovery-proof.txt. No edits have been made, and the assignment scope does not align with the objective.',
  };
  assert.equal(G.isStageConfusedBlocked(confused, brief), true);
  assert.throws(() => G.assertEvaluationSemantics(confused, brief), /gateway_evaluation_stage_mismatch/);
  assert.equal(G.isStageConfusedBlocked({ recommendation: 'blocked', summary: 'Unauthorized path access observed.' }, brief), false);
  assert.equal(G.isStageConfusedBlocked({ recommendation: 'ready', summary: 'Read verified.' }, brief), false);
  assert.equal(G.isStageConfusedBlocked(confused, {
    ...brief, operation: 'edit', require_file_modifications: true,
  }), false);
});

test('read-then-edit specialist graph advances after host-verified read evaluation', async t => {
  const f = await require('./fixtures/cursor-autonomy-fixture.cjs').setup(t,{repairs:0});
  const b = f.bridge;
  f.plan = [
    {
      id: 'read-1', worker: 'opencode', role: 'analysis', operation: 'read', paths: ['fixture.txt'],
      description: 'Read fixture.txt for context', depends_on: [], verification: [],
    },
    {
      id: 'change-1', worker: 'cursor', role: 'implementation', operation: 'edit', paths: ['fixture.txt'],
      description: 'Change alpha to beta', depends_on: ['read-1'], verification: [],
    },
  ];
  f.evaluations = [];
  f.calls = [];
  const adapter = b.opencodeAdapter;
  const worker = f.worker;
  adapter.execute = async (options) => {
    if (options.planning) {
      return {
        result: { summary: JSON.stringify({ ...options.planning, tasks: f.plan }) },
        changes: [], provenance: { termination_verified: true },
      };
    }
    if (options.coordination) {
      f.evaluations.push(options.coordination);
      assert.ok(options.coordination.assignment_contract, 'assignment_contract required');
      assert.match(options.objective, /assignment_contract/);
      if (options.coordination.assignment_contract.operation === 'read') {
        assert.equal(options.coordination.assignment_contract.require_file_modifications, false);
        assert.match(options.objective, /Do NOT require file modifications/i);
      }
      const body = {
        ...options.coordination.result_contract,
        recommendation: options.coordination.host_checks.some(c => c.status === 'failed') ? 'blocked' : 'ready',
        summary: options.coordination.assignment_contract.operation === 'read'
          ? 'Host-verified read of fixture.txt within authorized scope.'
          : 'Host-verified edit matched expected bytes.',
      };
      return {
        result: { summary: JSON.stringify(body) },
        changes: [],
        provenance: { runtime_id: 'opencode', sandbox: 'fixture', termination_verified: true, authority: false },
      };
    }
    f.calls.push({
      writable: options.writable,
      files: options.files,
      input: (() => { try { return JSON.parse(options.objective); } catch { return options.objective; } })(),
    });
    // Keep the fixture worker path for reads so leases, provenance, and host
    // verification stay identical to specialist-gateway coverage.
    return worker(options.writable.length ? options : {
      ...options,
      objective: 'Inspect fixture.txt without changes',
      objectiveProof: null,
    });
  };

  const request_id = randomUUID();
  const instruction = 'In Fixture project read fixture.txt then change fixture.txt from alpha to beta, preserving one final newline.';
  let view = await b.zeroSetupWork.ask({ request_id, instruction }, 'operator');
  for (let i = 0; i < 200 && view.state === 'PLANNING'; i++) {
    await new Promise(r => setTimeout(r, 20));
    view = await b.zeroSetupWork.ask({ request_id, instruction }, 'operator');
  }
  assert.ok(view.mission_id && ['DISPATCHED', 'RUNNING'].includes(view.state), JSON.stringify(view));
  const mission = await f.settle(view.mission_id, 'completed');
  assert.equal(f.evaluations.length, 2);
  assert.equal(f.evaluations[0].assignment_contract.operation, 'read');
  assert.equal(f.evaluations[1].assignment_contract.operation, 'edit');
  assert.equal(mission.specialists.assignments.length, 2);
  assert.ok(mission.specialists.assignments.every(a => a.state === 'ready'));
  assert.equal(
    require('node:fs').readFileSync(path.join(mission.envelope.workspace, 'fixture.txt'), 'utf8'),
    'beta\n'
  );
  assert.equal(
    b.controlStore.db.prepare("SELECT count(*) n FROM cp_leases WHERE mission_id=? AND state IN ('held','quarantined')").get(mission.id).n,
    0
  );
});

test('stage-confused evaluator response does not unlock the dependent edit', async t => {
  const f = await require('./fixtures/cursor-autonomy-fixture.cjs').setup(t,{repairs:0});
  const b = f.bridge;
  f.plan = [
    {
      id: 'read-1', worker: 'opencode', role: 'analysis', operation: 'read', paths: ['fixture.txt'],
      description: 'Read fixture.txt', depends_on: [], verification: [],
    },
    {
      id: 'change-1', worker: 'cursor', role: 'implementation', operation: 'edit', paths: ['fixture.txt'],
      description: 'Change alpha to beta', depends_on: ['read-1'], verification: [],
    },
  ];
  const adapter = b.opencodeAdapter;
  const worker = f.worker;
  adapter.execute = async (options) => {
    if (options.planning) {
      return {
        result: { summary: JSON.stringify({ ...options.planning, tasks: f.plan }) },
        changes: [], provenance: { termination_verified: true },
      };
    }
    if (options.coordination) {
      // Reproduce Mission c8a62931… evaluator confusion.
      const body = {
        ...options.coordination.result_contract,
        recommendation: 'blocked',
        summary: 'The objective requires editing result.txt to exact bytes 626574610a, but the current task is to read. No edits have been made, and the assignment scope does not align with the objective.',
      };
      return {
        result: { summary: JSON.stringify(body) },
        changes: [],
        provenance: { runtime_id: 'opencode', sandbox: 'fixture', termination_verified: true, authority: false },
      };
    }
    return worker(options.writable.length ? options : {
      ...options,
      objective: 'Inspect fixture.txt without changes',
      objectiveProof: null,
    });
  };

  const request_id = randomUUID();
  let view = await b.zeroSetupWork.ask({
    request_id,
    instruction: 'In Fixture project read fixture.txt then change fixture.txt from alpha to beta.',
  }, 'operator');
  for (let i = 0; i < 200 && view.state === 'PLANNING'; i++) {
    await new Promise(r => setTimeout(r, 20));
    view = await b.zeroSetupWork.ask({
      request_id,
      instruction: 'In Fixture project read fixture.txt then change fixture.txt from alpha to beta.',
    }, 'operator');
  }
  assert.ok(view.mission_id, JSON.stringify(view));
  const mission = await f.settle(view.mission_id, 'blocked');
  // A bounded recovery can encounter a later authority failure. The Mission
  // reason reports that latest error; the original stage rejection is durable.
  assert.ok(mission.runs.some(r => r.result?.gateway?.failure_code === 'gateway_evaluation_stage_mismatch'));
  assert.equal(mission.acceptance.length, 0);
  const assignments = mission.specialists?.assignments || [];
  assert.ok(assignments.every(a => a.id !== 'change-1' || !['ready', 'running', 'evaluating'].includes(a.state)));
  assert.equal(
    require('node:fs').readFileSync(path.join(f.repo, 'fixture.txt'), 'utf8'),
    'alpha\n'
  );
  const workerCompletions = b.controlStore.db.prepare(
    "SELECT id, result FROM cp_runs WHERE mission_id=? AND agent_id='opencode' AND state='completed'"
  ).all(mission.id).filter(row => {
    try {
      const result = typeof row.result === 'string' ? JSON.parse(row.result) : row.result;
      return !result?.gateway;
    } catch { return true; }
  });
  assert.equal(workerCompletions.length, 1, 'exactly one worker read; no dependent edit dispatch');
  // Stop deferred local evaluation retries before fixture teardown closes the DB.
  b.missions.program.cancel(mission.id, randomUUID());
  await f.settle(mission.id, 'cancelled');
  await new Promise(r => setTimeout(r, 2500));
});
