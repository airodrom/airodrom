'use strict';
// ADR 0051 §33: one integrated disposable qualification. ChatGPT-compatible proposal →
// host validation → one owner approval (fixture channel) → durable Goal Plan → worker →
// controlled verification failure → exactly one corrective Mission (repair_of) → stage
// rebind → independent verification → exact bytes → evidence package → no duplicates,
// with a client disconnect mid-run. Owner Acceptance is never granted here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { runtime, qualifyCanonical } = require('./fixtures/opencode-fixture.cjs');
const { MARKER } = require('../src/self-repair-fixture');
const { McpTools } = require('../src/mcp-tools');
const terminal = require('../src/zero-setup-terminal');
const { evidencePackage } = require('../src/mission-evidence');

test('unified end-to-end: proposal → approval → failure → one repair → verified → evidence, no duplicates across a disconnect', async t => {
  // Generous bounds: the unified group runs test files concurrently and the fixture worker is CPU-sensitive.
  const f = await fixture(t, { opencode: runtime(t).options, settleTimeoutMs: 180000 });
  f.bridge.missionAuthority.initializeOperatorKey();
  qualifyCanonical(f.bridge);
  // Disposable self-repair marker: exactly one controlled wrong write before the first host verification.
  fs.writeFileSync(path.join(f.repo, '.gitignore'), '.airodrom/\n');
  require('node:child_process').execFileSync('/usr/bin/git', ['-C', f.repo, 'add', '.gitignore']);
  require('node:child_process').execFileSync('/usr/bin/git', ['-C', f.repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'ignore marker dir']);
  fs.mkdirSync(path.join(f.repo, '.airodrom'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(f.repo, MARKER), JSON.stringify({ version: 1, mode: 'exact_file_once', file: 'fixture.txt', wrong_content: 'gamma\n', expected_content: 'beta\n', authority: false }));
  try { const key = require('node:crypto').createHash('sha256').update(fs.realpathSync(f.repo)).digest('hex').slice(0, 32); fs.rmSync(path.join(require('node:os').homedir(), '.airodrom', 'self-repair-markers', key + '.applied.json'), { force: true }); } catch { /* none */ }
  const project = f.bridge.projects.createProject({ name: 'Self-Repair Acceptance', repositories: [f.repo], privacyPolicy: 'local_only' });
  f.bridge.projects.createGoal({ projectId: project.projectId, name: 'Exact-file alpha to beta' });
  assert.equal(Buffer.from(fs.readFileSync(path.join(f.repo, 'fixture.txt'))).toString('hex'), '616c7068610a', 'initial bytes alpha\\n');

  // 1-2. ChatGPT-compatible proposal via MCP; host validates and derives measurable criteria.
  const mcp = new McpTools(f.bridge);
  const request_id = 'e2e-' + randomUUID().replace(/-/g, '').slice(0, 24);
  const prepared = await mcp.call('prepare_mission', { objective: 'In the prepared self-repair test workspace, change fixture.txt from alpha to beta and verify it.', request_id }, { name: 'chatgpt', version: '1' });
  assert.equal(prepared.state, 'WAIT');
  const proposal = await mcp.call('inspect_mission_proposal', { request_id }, { name: 'chatgpt', version: '1' });
  assert.equal(proposal.proposal.measurable, true);
  assert.equal(proposal.approval.granted_by_chatgpt_text, false);
  assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_missions').get().n, 0, 'preparation creates no Mission');

  // 3. One authenticated owner approval (isolated fixture channel) → 4. durable Goal Plan → dispatch.
  const approved = await f.bridge.zeroSetupWork.approve({ request_id, confirmed: true, channel: 'fixture' }, 'operator');
  const parentId = approved.technical.mission_id;
  const planId = approved.technical.plan_id;
  terminal.rememberActive(f.root, request_id);
  const parent = f.bridge.controlStore.requireMission(parentId);
  assert.ok(parent.envelope.contract && parent.envelope.approval_id);
  assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_mission_approvals').get().n, 1);
  assert.equal(f.bridge.autonomousExecution.inspect(planId).autonomous.max_repairs, 1);

  // 5-12. Worker edits, controlled failure, scheduler diagnoses, one corrective Mission, rebind, correction.
  let repairId = null, disconnected = false, observations = 0;
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    await f.bridge.missions.tick();
    await f.bridge.autonomousExecution.tick();
    const a = f.bridge.autonomousExecution.inspect(planId).autonomous;
    repairId = a.repair_lineage?.work?.repair_mission_id || repairId;
    // Simulate the client disconnecting mid-run: stop polling status for a while; the scheduler keeps going.
    if (!disconnected && f.bridge.controlStore.requireMission(parentId).state === 'needs_rework') { disconnected = true; await new Promise(r => setTimeout(r, 300)); continue; }
    if (!disconnected) { const v = f.bridge.zeroSetupWork.refreshState(request_id); observations += 1; assert.notEqual(v.state, 'BLOCKED', 'never prematurely Blocked at phase ' + v.technical.phase); }
    if (repairId && f.bridge.controlStore.requireMission(repairId).state === 'awaiting_acceptance') break;
    await new Promise(r => setTimeout(r, 40));
  }
  const diag = () => { const a = f.bridge.autonomousExecution.inspect(planId).autonomous; const p = f.bridge.missions.detail(parentId); return JSON.stringify({ parent_state: p.state, parent_reason: p.reason, verifications: p.verifications.map(v => [v.result, v.evidence.filter(c => c.status !== 'passed').map(c => c.id)]), runs: p.runs.map(r => [r.agent_id, r.state, r.result?.resolution || r.result?.error_class || null]), blocked: a.repair_blocked, pending: a.repair_pending, phases: Object.values(a.phases).map(x => [x.phase, x.reason]), last: a.last_action, lifecycle: a.lifecycle, claims: a.claims }); };
  assert.ok(repairId, 'exactly one corrective Mission was created: ' + diag());
  assert.ok(disconnected, 'the parent reached needs_rework (controlled failure)');
  // 13-19. Independent verification passed, exact bytes, focused test, diff check, no unauthorized files, budget, Goal verified.
  const repaired = f.bridge.missions.detail(repairId);
  assert.equal(repaired.state, 'awaiting_acceptance');
  assert.equal(repaired.envelope.repair_of, parentId);
  assert.equal(repaired.envelope.approval_id, parent.envelope.approval_id, 'repair reused the one approval');
  assert.equal(repaired.envelope.contract.scope_fingerprint, parent.envelope.contract.scope_fingerprint);
  const v = repaired.verifications[0];
  // Owner-registered WORK keeps an operator_review criterion, so the host result is operator_review (never failed).
  assert.ok(['passed', 'operator_review'].includes(v.result), v.result);
  for (const id of ['task:fixture-test', 'task:diff-check', 'protected_files', 'expected_changes', 'verifier_inputs_unchanged', 'protected_tests_unchanged', 'contract_integrity', 'security:secret_scan', 'verification_workspace_stable']) assert.equal(v.evidence.find(c => c.id === id)?.status, 'passed', id);
  assert.ok(!v.evidence.some(c => c.status === 'failed'));
  assert.equal(Buffer.from(fs.readFileSync(path.join(f.repo, 'fixture.txt'))).toString('hex'), '626574610a');
  const stages = f.bridge.missions.goalPlanner.inspect(planId).stages;
  assert.equal(stages[0].mission_id, repairId, 'Goal stage rebound to the corrective Mission');
  assert.equal(stages[0].state, 'waiting_approval');
  const auto = f.bridge.autonomousExecution.inspect(planId).autonomous;
  assert.equal(auto.repair_counts.work, 1);
  assert.equal(auto.repair_lineage.work.parent_mission_id, parentId);
  assert.equal(auto.repair_lineage.work.classification, 'VERIFICATION');
  assert.equal(auto.phases.work.phase, 'REPAIR_VERIFIED');
  // 20. Acceptance remains owner-only.
  assert.equal(repaired.acceptance.length, 0);
  assert.equal(f.bridge.missions.detail(parentId).state, 'needs_rework', 'parent evidence preserved');
  // 21-22. Evidence package retrievable by the ChatGPT-compatible client.
  const evidence = await mcp.call('get_mission_evidence', { mission_id: parentId }, { name: 'chatgpt', version: '1' });
  assert.equal(evidence.mission_id, repairId);
  assert.equal(evidence.root_mission_id, parentId);
  assert.equal(evidence.status, 'VERIFIED_AWAITING_ACCEPTANCE');
  assert.equal(evidence.answers.repair_needed, true);
  assert.equal(evidence.answers.attempts, 2);
  assert.equal(evidence.answers.tests_passed, true);
  assert.equal(evidence.answers.security_passed, true);
  assert.equal(evidence.answers.unauthorized_changes, false);
  assert.equal(evidence.answers.original_goal_resumed, true);
  assert.deepEqual(evidence.answers.requires_owner, ['Acceptance']);
  assert.equal(evidence.approval_status.state, 'active');
  assert.equal(evidence.budget_consumed.repair_attempts, 1);
  assert.equal(evidence.budget_consumed.max_repair_attempts, 1);
  const status = await mcp.call('get_mission_status', { mission_id: repairId }, { name: 'chatgpt', version: '1' });
  assert.equal(status.phase.phase, 'REPAIR_VERIFIED');
  // 23. No duplicate Mission; reconnect from Terminal restores the same identity and only now clears it.
  assert.equal(f.bridge.controlStore.db.prepare("SELECT count(*) n FROM cp_missions WHERE json_extract(envelope,'$.repair_of')=?").get(parentId).n, 1);
  assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_missions').get().n, 2);
  assert.equal(terminal.readActive(f.root).request_id, request_id, 'identity retained through the disconnect');
  const reconnected = f.bridge.zeroSetupWork.refreshState(request_id);
  assert.equal(reconnected.state, 'AWAITING_ACCEPTANCE');
  assert.equal(reconnected.technical.mission_id, repairId);
  assert.equal(reconnected.technical.repair_of, parentId);
  assert.equal(reconnected.technical.phase_terminal, true);
  assert.match(terminal.resultText(reconnected), /Initial verification failed\.\nAirodrom repaired the file automatically\.\nRepair completed\. Verification passed\./);
  const dispatchesBefore = f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_dispatches').get().n;
  await f.bridge.autonomousExecution.tick();
  await f.bridge.autonomousExecution.tick();
  assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_dispatches').get().n, dispatchesBefore, 'reconnect and further ticks never redispatch');
  // Record of identities for the engineering report.
  const record = {
    parent_mission_id: parentId, corrective_mission_id: repairId, goal_plan_id: planId, approval_id: parent.envelope.approval_id,
    run_ids: repaired.runs.map(r => r.id), worker: repaired.runs.find(r => r.agent_id === 'opencode')?.result?.opencode_provenance?.runtime_version || 'fixture',
    dispatch_count: f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_dispatches WHERE mission_id IN (?,?)').get(parentId, repairId).n,
    repair_count: auto.repair_counts.work, verification_ids: [f.bridge.missions.detail(parentId).verifications[0]?.id, v.id], exact_bytes: '626574610a', final_phase: auto.phases.work.phase, observations,
  };
  assert.equal(record.dispatch_count, 2);
  t.diagnostic(JSON.stringify(record));
});
