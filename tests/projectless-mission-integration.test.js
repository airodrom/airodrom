'use strict';
// Real MissionService, contract/approval normalization, durable store, routing,
// Cursor staging, result processing, SafetyPolicy and host verification, composed
// in a lightweight host bridge. Provider output and capability process transport
// are synthetic; subprocesses, Git, files and registered tests are real. This
// suite does not prove macOS containment, live billing or a host installation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { EventLedger } = require('../src/event-ledger');
const { ControlPlaneStore } = require('../src/control-plane-store');
const { ProjectMissionOrchestrator } = require('../src/project-orchestrator');
const { PersonalMemory } = require('../src/personal-memory');
const { ControlContext } = require('../src/control-context');
const { CapabilityPolicy } = require('../src/capability-policy');
const { SafetyPolicy } = require('../src/safety-policy');
const { MissionService } = require('../src/mission-service');
const { MissionApprovals } = require('../src/mission-approval');
const { DeveloperAutonomy } = require('../src/developer-autonomy');
const { WorkTemplates } = require('../src/work-templates');
const { FixtureAcceptance } = require('../src/fixture-acceptance');
const { ResultInbox } = require('../src/result-inbox');
const { CursorWorker } = require('../src/cursor-worker');
const { ZeroSetupWork } = require('../src/zero-setup-work');
const permissions = require('../src/mission-permissions');
const sandbox = require('../src/projectless-sandbox');
const digest = value => createHash('sha256').update(value).digest('hex');
const work = worker => ({ version: 1, worker, files: [
  { path: 'first.txt', content: 'one\n' }, { path: 'nested/second.txt', content: 'two\n' },
] });

function fixture(t, { wrongSecondFile = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'projectless-integration-')));
  const stagingRoots = [], originalMkdtemp = fs.mkdtempSync;
  t.mock.method(fs, 'mkdtempSync', (prefix, options) => {
    const created = originalMkdtemp(prefix, options);
    if (typeof prefix === 'string' && ['ad-', 'airodrom-cursor-'].includes(path.basename(prefix)))
      stagingRoots.push(fs.realpathSync(created));
    return created;
  });
  const db = new DatabaseSync(':memory:'), ledger = new EventLedger(db);
  const projects = new ProjectMissionOrchestrator({ db });
  const controlStore = new ControlPlaneStore({ db, ledger });
  const tasks = new Map(), policy = new SafetyPolicy(), capabilityPolicy = new CapabilityPolicy();
  const bridge = {
    options: { allowFixtureWorker: true }, dataDir: root, closed: false,
    controlStore, ledger, projects, policy,
    capabilityHost: { policy: capabilityPolicy, agentStatus: async () => ({}) },
    tasks: { get: id => tasks.get(id), save: task => tasks.set(task.id, task) },
    emit() {},
    createTask(description, options) {
      const task = { id: randomUUID(), sessionId: randomUUID(), workspace: options.workspace,
        description, executionAgent: options.executionAgent, capabilityScopes: options.capabilityScopes,
        mission: { budget: {}, authority: permissions.normalizeAuthority(options.missionAuthority,
          { workspace: options.workspace, operator: options.authorityOperator }) } };
      tasks.set(task.id, task); return task;
    },
    _recordPolicyDenial(task, call, decision) { policy.latchSafetyStop(task.id, decision.reason); },
  };
  bridge.developerAutonomy = new DeveloperAutonomy(bridge);
  bridge.workTemplates = new WorkTemplates(bridge);
  bridge.personalMemory = new PersonalMemory({ db });
  bridge.controlContext = new ControlContext(bridge, controlStore);
  bridge.fixtureAcceptance = new FixtureAcceptance(bridge);
  bridge.missions = new MissionService(bridge);
  bridge.missions.stopped = true; // Drive the real launch/result methods deterministically.
  bridge.missionApprovals = new MissionApprovals(bridge);
  bridge.resultInbox = new ResultInbox(bridge);
  bridge.zeroSetupWork = new ZeroSetupWork(bridge);
  // No real OpenCode/provider probe; Cursor selection still goes through the real
  // MissionAgents router with its actual governed Cursor readiness observation.
  bridge.opencodeAdapter = {
    readiness: async () => ({ ready: false, available: false, availability: 'unavailable' }), capabilities: () => [],
    assertEvidence: run => assert.notEqual(run.agent_id, 'opencode'),
  };
  const executable = path.join(root, 'cursor-fixture.cjs');
  fs.writeFileSync(executable, "'use strict';\n" +
    "const fs=require('node:fs'),path=require('node:path');\n" +
    "const brief=JSON.parse(fs.readFileSync(path.join(process.env.AIRODROM_FIXTURE_ROOT,'brief/mission.json'),'utf8'));\n" +
    "const expected=[...brief.objective.matchAll(/^- (.+?): exact UTF-8 bytes \\[([0-9a-f ]+)\\]/gm)];\n" +
    "if(expected.length!==brief.allowed_files.length)throw Error('fixture expected-byte guidance missing');\n" +
    "for(const [i,m]of expected.entries()){if(!brief.allowed_files.includes(m[1]))throw Error('fixture scope');fs.writeFileSync(m[1]," +
      (wrongSecondFile ? "i===1?Buffer.from('wrong\\n'):" : '') + "Buffer.from(m[2].replaceAll(' ',''),'hex'));}\n" +
    "const result={status:'completed',summary:'Synthetic two-file result',changed_files:brief.allowed_files,tests:[],artifacts:[],limitations:[]};\n" +
    "fs.writeSync(1,JSON.stringify({type:'result',subtype:'success',result:JSON.stringify(result),session_id:'synthetic-projectless'})+'\\n');\n",
  { mode: 0o700 });
  bridge.cursorWorker = new CursorWorker(bridge, { fixtureExecutable: executable });
  const dispatchCursor = bridge.cursorWorker.dispatch.bind(bridge.cursorWorker);
  bridge.cursorWorker.dispatch = async input => {
    try { return await dispatchCursor(input); }
    catch (error) { t.diagnostic(error.stack); throw error; }
  };
  const calls = [];
  bridge.invokeCapability = async (taskId, { name, input, requestId }) => {
    const task = tasks.get(taskId);
    const assessment = capabilityPolicy.decide(name, { taskScopes: task.capabilityScopes });
    const decision = policy.check(taskId, { toolName: 'capability', toolCallId: requestId,
      input: { name, input }, capabilityAssessment: assessment }, { brokered: true });
    calls.push({ name, input, decision });
    if (!decision.allow) return { status: 'denied', decision };
    // Only these exact fixture transports exist. Neither a shell nor an arbitrary
    // task command can be supplied by a worker or a test input.
    if (name === 'file_write') {
      fs.writeFileSync(input.path, input.content); return { status: 'completed', result: {} };
    }
    if (name === 'file_hash') return { status: 'completed', result: { digest: digest(fs.readFileSync(input.path)) } };
    if (name === 'git_status' || name === 'git_diff') {
      const args = name === 'git_status' ? ['status', '--porcelain'] : ['diff', '--stat', '--', ...input.paths];
      const result = spawnSync('/usr/bin/git', args, { cwd: input.repo, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return { status: 'completed', result: { output: result.stdout } };
    }
    assert.equal(name, 'vscode_run_task');
    const tasksFile = JSON.parse(fs.readFileSync(path.join(input.repo, '.vscode/tasks.json'), 'utf8'));
    const registered = tasksFile.tasks.find(item => item.label === input.label);
    const args = input.label === 'diff-check' ? ['diff', '--check'] : ['--test', 'tests/projectless-files.test.cjs'];
    assert.equal(registered.command, input.label === 'diff-check' ? 'git' : 'node');
    assert.deepEqual(registered.args, args);
    const result = spawnSync(input.label === 'diff-check' ? '/usr/bin/git' : process.execPath, args,
      { cwd: input.repo, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LANG: 'C' } });
    return { status: 'completed', result: { exit_code: result.status, timed_out: false, output: result.stdout + result.stderr } };
  };
  t.after(async () => {
    await bridge.cursorWorker.shutdown();
    for (const { request_id } of db.prepare('SELECT request_id FROM cp_zero_setup_requests').all()) {
      const workspace = bridge.zeroSetupWork.read(request_id)?.workspace;
      if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
    }
    db.close(); fs.rmSync(root, { recursive: true, force: true });
  });
  return { bridge, db, calls, stagingRoots };
}

for (const worker of ['opencode', 'cursor']) test(worker + ': host verifier reads stay separate from worker file access and writes', t => {
  const spec = work(worker), { workspace } = sandbox.allocate();
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  sandbox.seedWork(workspace, spec);
  const input = sandbox.workMissionInput(workspace, randomUUID(), spec, { externalConfirmed: worker === 'cursor' });
  const authority = permissions.normalizeAuthority(input.authority, { workspace, operator: true });
  for (const name of ['git_status', 'git_diff', 'vscode_run_task']) {
    const requirements = permissions.callRequirements({ toolName: 'capability', input: { name, input: { repo: workspace } } }, workspace);
    assert.equal(permissions.checkAuthority(authority, requirements).allow, true, name + ' must read the host verification repository');
  }
  for (const target of ['TASK.md', 'tests/projectless-files.test.cjs', '.vscode/tasks.json', 'unlisted.txt'])
    assert.equal(permissions.checkAuthority(authority, { filesystem: { write: [path.join(workspace, target)] } }).allow, false);
  assert.equal(permissions.checkAuthority(authority, { filesystem: { read: [path.dirname(workspace)] } }).allow, false);
});

for (const wrongSecondFile of [false, true]) test('canonical Cursor projectless Mission: ' + (wrongSecondFile ? 'second-file mismatch prevents Acceptance' : 'two-file result passes independent verification'), async t => {
  const { bridge, db, calls, stagingRoots } = fixture(t, { wrongSecondFile });
  const request_id = randomUUID(), spec = work('cursor');
  const prepared = await bridge.zeroSetupWork.ask({ request_id,
    instruction: sandbox.WORK_MARKER + '\n' + JSON.stringify(spec) }, 'mcp:' + randomUUID());
  assert.equal(prepared.state, 'PREPARED'); assert.equal(prepared.execution_authorized, false);
  assert.equal(db.prepare('SELECT count(*) n FROM cp_missions').get().n, 0);
  const approved = await bridge.zeroSetupWork.approve({ request_id, confirmed: true, channel: 'control_center',
    subscription_execution: { provider: 'cursor', acknowledge_unknown_cost: true, max_invocations: 1, max_runtime_ms: 10000 } }, 'operator');
  assert.equal(approved.state, 'DISPATCHED');
  const mission = bridge.missions.detail(approved.mission_id), contract = mission.envelope.contract;
  assert.equal(mission.envelope.developer_autonomy, undefined); assert.equal(mission.envelope.work_template, undefined);
  assert.equal(mission.project_id, null); assert.equal(mission.goal_id, null);
  assert.equal(bridge.projects.listProjects().length, 0);
  assert.equal(contract.execution.preferred_worker, 'cursor'); assert.equal(contract.execution.fallback_worker, null);
  assert.deepEqual(contract.permissions.allowed_read_paths, spec.files.map(file => file.path).sort());
  assert.deepEqual(contract.permissions.allowed_write_paths, spec.files.map(file => file.path).sort());
  assert.equal(contract.permissions.personal_memory.mode, 'none'); assert.equal(contract.permissions.vault_access.mode, 'none');
  assert.equal(contract.verification.acceptance_criteria.length, 2);
  assert.equal(contract.budget.max_actual_spend_usd, null);
  assert.equal(mission.envelope.risk_auto_acceptance, undefined, 'Cursor does not inherit OpenCode Acceptance');
  assert.equal(bridge.missionApprovals.view(mission.envelope.approval_id).principal, 'operator');
  const dispatch = db.prepare('SELECT * FROM cp_dispatches WHERE mission_id=?').get(mission.id);
  await bridge.missions.launch(dispatch);
  const row = db.prepare('SELECT * FROM cp_run_results WHERE mission_id=?').get(mission.id);
  assert.ok(row, JSON.stringify(bridge.missions.detail(mission.id)));
  await bridge.missions.processResult(row);
  const done = bridge.missions.detail(mission.id);
  assert.equal(JSON.parse(db.prepare('SELECT route FROM cp_dispatches WHERE id=?').get(dispatch.id).route).selected, 'cursor');
  assert.equal(done.runs.filter(run => run.agent_id === 'cursor').length, 1);
  assert.equal(done.runs.find(run => run.agent_id === 'cursor').termination_verified, 1);
  assert.equal(done.runs.find(run => run.agent_id === 'cursor').state, 'completed', JSON.stringify(done.runs));
  assert.equal(done.state, wrongSecondFile ? 'needs_rework' : 'awaiting_acceptance', JSON.stringify({ reason: done.reason, verifications: done.verifications, result: JSON.parse(row.normalized) }));
  assert.equal(done.verifications[0].result, wrongSecondFile ? 'failed' : 'passed', JSON.stringify(done.verifications));
  assert.equal(done.acceptance.length, 0, 'Only an explicit owner Acceptance can complete Cursor work');
  assert.ok(done.verifications[0].evidence.some(c => c.id === 'expected_file_1' && c.status === (wrongSecondFile ? 'failed' : 'passed')));
  assert.ok(done.verifications[0].evidence.some(c => c.id === 'task:projectless-files' && c.status === (wrongSecondFile ? 'failed' : 'passed')));
  assert.ok(calls.some(c => c.name === 'git_status' && c.decision.allow));
  assert.ok(calls.some(c => c.name === 'vscode_run_task' && c.decision.allow));
  assert.equal(db.prepare("SELECT count(*) n FROM cp_leases WHERE state IN ('held','quarantined')").get().n, 0);
  assert.equal(bridge.cursorWorker.active.size, 0);
  assert.equal(stagingRoots.length, 1);
  assert.equal(fs.existsSync(stagingRoots[0]), false, 'Verified Cursor termination removes its staging tree');
});
