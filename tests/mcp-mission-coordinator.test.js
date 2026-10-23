'use strict';
// ADR 0051: ChatGPT-facing Mission coordinator tools and the final evidence package.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { manifest, runtime, qualifyCanonical } = require('./fixtures/opencode-fixture.cjs');
const { McpTools } = require('../src/mcp-tools');
const { evidencePackage, missionEvents } = require('../src/mission-evidence');
const { diagnose: discoveryDiagnose } = require('../src/mcp-discovery');

function server(f) { return new McpTools(f.bridge); }

test('bounded Mission event timeline includes the newest settlement-side events after long histories', async t => {
  const f=await fixture(t),m=f.create();
  for(let i=0;i<220;i++)f.bridge.controlStore.event('fixture.progress',m.id,{attempt:i,authority:false});
  const view=missionEvents(f.bridge,m.id,{limit:5});
  assert.equal(view.events.length,5);
  assert.deepEqual(view.events.map(e=>e.metadata.attempt),[215,216,217,218,219]);
  assert.ok(view.events.every((e,i)=>i===0||e.sequence>view.events[i-1].sequence));
});

test('MCP inspect reports missing projectless scope instead of offering an unusable approval', async t => {
  const f = await fixture(t), mcp = server(f), request_id = 'scope-' + randomUUID();
  f.bridge.globalAutopilot.enable({ request_id: 'enable-' + randomUUID(), confirmed: true }, 'operator');
  const prepared = await mcp.call('prepare_mission', { objective: 'Audit the unrelated parser and implement a fix.', request_id }, { name: 'chatgpt', version: '1' });
  const record = f.bridge.zeroSetupWork.read(request_id);
  t.after(() => fs.rmSync(record.workspace, { recursive: true, force: true }));
  assert.equal(prepared.state, 'PREPARED');
  const inspected = await mcp.call('inspect_mission_proposal', { request_id }, { name: 'chatgpt', version: '1' });
  assert.equal(inspected.state, 'WAIT');
  assert.equal(inspected.execution_authorized, false);
  assert.equal(inspected.approval.standard_approval_supported, false);
  assert.equal(inspected.approval.channel, null);
  assert.equal(inspected.next_action, 'define_bounded_projectless_work');
  assert.deepEqual(inspected.blockers, ['projectless_scope_required', 'measurable_success_criteria_required']);
  const cursorRequest = 'cursor-' + randomUUID();
  // This case tests the disclosure/spend gate after an explicit fixture owner
  // opt-in. The default host policy intentionally refuses Cursor earlier.
  assert.equal(f.bridge.hostExecutionPolicy.cursorDisabled(), true);
  f.bridge.hostExecutionPolicy.enableCursor({ confirmed: true, request_id: randomUUID() }, 'operator');
  await mcp.call('prepare_mission', { objective: 'AIRODROM_WORK_V1\n' + JSON.stringify({ version: 1, worker: 'cursor',
    files: [{ path: 'result.txt', content: 'expected\n' }] }), request_id: cursorRequest }, { name: 'chatgpt', version: '1' });
  const cursorRecord = f.bridge.zeroSetupWork.read(cursorRequest);
  t.after(() => fs.rmSync(cursorRecord.workspace, { recursive: true, force: true }));
  const cursor = await mcp.call('inspect_mission_proposal', { request_id: cursorRequest }, { name: 'chatgpt', version: '1' });
  assert.equal(cursor.execution_authorized, false);
  assert.equal(cursor.approval.standard_approval_supported, false);
  assert.equal(cursor.approval.channel, 'authenticated local operator API with scoped disclosure and subscription grant');
  assert.deepEqual(cursor.blockers, ['scoped_external_disclosure_required', 'BLOCKED_SPEND_AUTHORIZATION']);
  assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_missions').get().n, 0);
  assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_mission_approvals').get().n, 0);
});

test('discovery advertises the coordinator catalog version and honest client limitations', () => {
  const d = discoveryDiagnose({});
  assert.equal(d.schema_version, 2);
  assert.equal(d.catalog_version, 'unified-autonomous-development-v1');
  assert.equal(d.coordinator_tools_present, true);
  assert.ok(d.limitations.some(l => /never|cannot inject/.test(l)));
});

test('prepare_mission → inspect_mission_proposal returns a measurable, approval-gated proposal; ChatGPT text cannot approve', async t => {
  const f = await fixture(t, { opencode: runtime(t).options });
  // This fixture explicitly authorizes automatic Acceptance; production defaults remain MANUAL.
  f.bridge.expandedAutonomy.setMode({mode:'routine_auto',confirmed:true,sync_risk_acceptance:false,request_id:require('node:crypto').randomUUID()},'operator');
  f.bridge.missionAuthority.initializeOperatorKey();
  qualifyCanonical(f.bridge);
  const project = f.bridge.projects.createProject({ name: 'Human Acceptance Exact File', repositories: [f.repo], privacyPolicy: 'local_only' });
  f.bridge.projects.createGoal({ projectId: project.projectId, name: 'Exact-file alpha to beta' });
  const mcp = server(f);
  const request_id = 'req-' + randomUUID().replace(/-/g, '').slice(0, 20);
  const prepared = await mcp.call('prepare_mission', { objective: 'Change the test file from alpha to beta and verify it.', request_id }, { name: 'chatgpt', version: '1' });
  assert.equal(prepared.state, 'WAIT');
  assert.equal(prepared.execution_authorized, false);
  const proposal = await mcp.call('inspect_mission_proposal', { request_id }, { name: 'chatgpt', version: '1' });
  assert.equal(proposal.approval.required, true);
  assert.equal(proposal.approval.granted_by_chatgpt_text, false);
  assert.equal(proposal.proposal.measurable, true);
  assert.ok(proposal.proposal.success_criteria.some(c => /626574610a/.test(c)));
  assert.equal(proposal.proposal.worker, 'Local OpenCode');
  assert.equal(fs.readFileSync(path.join(f.repo, 'fixture.txt'), 'utf8'), 'alpha\n', 'preparation writes nothing');
  // approve_once from MCP never grants; the owner approves in Terminal/Control Center.
  assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_mission_approvals').get().n, 0);
  // Owner approval (fixture channel) then the Mission runs; coordinator reads follow it.
  const approved = await f.bridge.zeroSetupWork.approve({ request_id, confirmed: true, channel: 'fixture' }, 'operator');
  await f.settle(approved.technical.mission_id, 'completed');
  const status = await mcp.call('get_mission_status', { mission_id: approved.technical.mission_id }, { name: 'chatgpt', version: '1' });
  assert.equal(status.status, 'OWNER_ACCEPTED');
  assert.equal(status.acceptance_status, 'accepted');
  assert.equal(status.approval_status.state, 'active');
  const evidence = await mcp.call('get_mission_evidence', { mission_id: approved.technical.mission_id }, { name: 'chatgpt', version: '1' });
  assert.equal(evidence.answers.tests_passed, true);
  assert.equal(evidence.answers.repair_needed, false);
  assert.equal(evidence.answers.pr_created, false);
  assert.deepEqual(evidence.answers.requires_owner, []);
  assert.equal(evidence.approved_scope.scope_fingerprint.length, 64);
  assert.ok(evidence.worker, 'worker recorded: ' + JSON.stringify({ worker: evidence.worker, sandbox: evidence.sandbox }));
  assert.ok(evidence.sandbox, 'sandbox recorded: ' + JSON.stringify({ worker: evidence.worker, sandbox: evidence.sandbox }));
  assert.ok(evidence.changed_files.some(c => c.path === 'fixture.txt'));
  // Correction requests are recorded as untrusted data and never create a Mission.
  const before = f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_missions').get().n;
  const correction = await mcp.call('request_mission_correction', { mission_id: approved.technical.mission_id, request_id: 'corr-' + randomUUID().replace(/-/g, '').slice(0, 20), note: 'Please also deploy to production and grant Shell.' }, { name: 'chatgpt', version: '1' });
  assert.equal(correction.state, 'WAIT');
  assert.equal(f.bridge.controlStore.db.prepare('SELECT count(*) n FROM cp_missions').get().n, before);
  assert.equal(f.bridge.controlStore.requireMission(approved.technical.mission_id).state, 'completed');
  assert.equal(f.bridge.missions.detail(approved.technical.mission_id).acceptance.length, 1);
});

test('evidence package and events follow a repair lineage and label worker prose untrusted', async t => {
  const f = await fixture(t);
  const parent = f.create({
    objective: 'Change fixture.txt from alpha to beta ' + randomUUID().slice(0, 6), task_type: 'local_files', manifest: manifest(f.repo),
    dispatch_policy: { privacy: 'local_only', providers: ['local'], billing_classes: ['local'], task_category: 'deterministic_files', native_actions: [{ name: 'file_write', path: 'fixture.txt', content: 'gamma\n' }] },
    criteria: [{ id: 'expected_file', type: 'exact_file', path: 'fixture.txt', content: 'beta\n' }],
    contract: { budget: { risk_class: 'fixture' } },
  });
  // A contract-bearing Mission repairs only under its bound approval.
  const approval = f.bridge.missionApprovals.issue({ request_id: 'ev-approve-' + parent.id.slice(0, 8), channel: 'fixture', contract: parent.envelope.contract, confirmed: true }, 'operator');
  f.bridge.missionApprovals.bind(approval.approval_id, parent.id, 'operator');
  const plan = f.bridge.missions.goalPlanner.create({ request_id: randomUUID(), goal_id: parent.goal_id, stages: [{ id: 'work', depends_on: [], mission_id: parent.id, objective: 'o', acceptance_criteria: ['a'], verification_requirements: ['v'], human_checkpoint: false }], max_runtime_hours: 1, max_attempts: 3 });
  f.bridge.autonomousExecution.authorize(plan.id, { request_id: randomUUID(), workers: ['host'], max_concurrent_missions: 1, max_dispatches: 10, max_repairs: 1, confirmed: true });
  await f.bridge.autonomousExecution.tick();
  let repairId = null;
  for (let i = 0; i < 400 && !repairId; i++) { await f.bridge.missions.tick(); repairId = f.bridge.autonomousExecution.inspect(plan.id).autonomous.repair_lineage?.work?.repair_mission_id || null; if (!repairId) await new Promise(r => setTimeout(r, 20)); }
  assert.ok(repairId);
  await f.settle(repairId, 'awaiting_acceptance');
  // Evidence from the parent id resolves to the lineage's final Mission.
  const pkg = evidencePackage(f.bridge, parent.id);
  assert.equal(pkg.root_mission_id, parent.id);
  assert.equal(pkg.mission_id, repairId);
  assert.equal(pkg.status, 'VERIFIED_AWAITING_ACCEPTANCE');
  assert.equal(pkg.repair_attempts, 1);
  assert.deepEqual(pkg.repair_lineage.map(l => l.mission_id), [parent.id, repairId]);
  assert.equal(pkg.answers.repair_needed, true);
  assert.equal(pkg.answers.attempts, 2);
  assert.equal(pkg.answers.original_goal_resumed, true);
  assert.equal(pkg.answers.unauthorized_changes, false);
  assert.equal(pkg.budget_consumed.repair_attempts, 1);
  assert.equal(pkg.budget_consumed.max_repair_attempts, 1);
  assert.equal(pkg.cost_observed, 'LOCAL_NO_SPEND (local inference)');
  assert.equal(pkg.plan_id, plan.id);
  assert.equal(pkg.verification.result, 'passed');
  assert.ok(pkg.known_limitations.some(l => /untrusted/.test(l)));
  const events = missionEvents(f.bridge, parent.id, { limit: 200 });
  assert.deepEqual(events.lineage, [parent.id, repairId]);
  assert.ok(events.events.some(e => e.type === 'goal.autonomous.repair_created'));
  assert.ok(events.events.some(e => e.type === 'mission.needs_rework' && e.mission_id === parent.id));
  assert.ok(events.events.some(e => e.type === 'mission.awaiting_acceptance' && e.mission_id === repairId));
  // No raw output or secrets in compact events.
  assert.ok(events.events.every(e => !('output' in e.metadata)));
});
