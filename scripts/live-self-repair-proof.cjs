'use strict';
// One disposable live OpenCode + autonomous repair proof. Not the owner acceptance fixture.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const { fixture } = require(path.join(repoRoot, 'tests/fixtures/mission-fixture.cjs'));
const { manifest, qualifyCanonical } = require(path.join(repoRoot, 'tests/fixtures/opencode-fixture.cjs'));
const { MARKER, appliedReceipt } = require(path.join(repoRoot, 'src/self-repair-fixture'));

const options = {
  enabled: true,
  executable: '/opt/homebrew/bin/opencode',
  model: 'ollama/qwen3-coder:30b',
  timeoutMs: 120000,
};

function placeMarker(repo) {
  const ignore = path.join(repo, '.gitignore');
  const current = fs.existsSync(ignore) ? fs.readFileSync(ignore, 'utf8') : '';
  if (!current.split('\n').includes('.airodrom/')) {
    fs.writeFileSync(ignore, (current.endsWith('\n') || !current ? current : current + '\n') + '.airodrom/\n');
    spawnSync('git', ['-C', repo, 'add', '.gitignore'], { encoding: 'utf8' });
    spawnSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'Ignore self-repair marker dir'], { encoding: 'utf8' });
  }
  fs.mkdirSync(path.join(repo, '.airodrom'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(repo, MARKER), JSON.stringify({
    version: 1,
    mode: 'exact_file_once',
    file: 'fixture.txt',
    wrong_content: 'gamma\n',
    expected_content: 'beta\n',
    authority: false,
  }, null, 2) + '\n', { mode: 0o600 });
  try {
    const key = require('node:crypto').createHash('sha256').update(fs.realpathSync(repo)).digest('hex').slice(0, 32);
    const receipt = path.join(require('node:os').homedir(), '.airodrom', 'self-repair-markers', key + '.applied.json');
    fs.rmSync(receipt, { force: true });
  } catch { /* ignore */ }
}

async function main() {
  const after = [];
  const t = { after(fn) { after.push(fn); } };
  const f = await fixture(t, { opencode: options, settleTimeoutMs: 300000 });
  placeMarker(f.repo);
  fs.writeFileSync(path.join(f.repo, 'fixture.txt'), 'alpha\n');
  qualifyCanonical(f.bridge);

  const ready = await f.bridge.opencodeAdapter.readiness();
  if (!ready.ready) throw Error('OpenCode not ready: ' + (ready.reason || 'unknown'));

  const parent = f.create({
    preferred_agent: undefined,
    objective: 'In fixture.txt use the edit tool to replace only the literal text alpha with beta. Preserve the existing single LF byte exactly. Do not add or remove newline bytes. Return the exact result_contract JSON. The Airodrom host runs tests independently; do not invoke tests or shell tools.',
    manifest: manifest(f.repo),
    criteria: [{ id: 'expected_file', type: 'exact_file', path: 'fixture.txt', content: 'beta\n' }],
  });
  const plan = f.bridge.missions.goalPlanner.create({
    request_id: randomUUID(),
    goal_id: parent.goal_id,
    stages: [{
      id: 'one', depends_on: [], mission_id: parent.id,
      objective: 'Bounded exact-file step',
      acceptance_criteria: ['Exact file criterion passes'],
      verification_requirements: ['Independent registered tests'],
      human_checkpoint: false,
    }],
    max_runtime_hours: 1,
    max_attempts: 3,
  });
  f.bridge.autonomousExecution.authorize(plan.id, {
    request_id: randomUUID(),
    workers: ['opencode'],
    max_concurrent_missions: 1,
    max_dispatches: 10,
    max_repairs: 1,
    confirmed: true,
  });

  await f.bridge.autonomousExecution.tick();
  let repairId = null;
  let sawFail = false;
  const deadline = Date.now() + 280000;
  while (Date.now() < deadline && !repairId) {
    await f.bridge.missions.tick();
    await f.bridge.autonomousExecution.tick();
    if (f.bridge.missions.detail(parent.id).state === 'needs_rework') sawFail = true;
    repairId = f.bridge.autonomousExecution.inspect(plan.id).autonomous.repair_lineage?.one?.repair_mission_id || null;
    if (!repairId) await new Promise(r => setTimeout(r, 250));
  }
  if (!sawFail) throw Error('parent never reached needs_rework: ' + f.bridge.missions.detail(parent.id).state);
  if (!repairId) throw Error('no corrective Mission created');

  const repair = f.bridge.controlStore.requireMission(repairId);
  if (repair.envelope.repair_of !== parent.id) throw Error('repair_of mismatch');

  const repaired = await f.settle(repairId, 'awaiting_acceptance');
  const bytes = Buffer.from(fs.readFileSync(path.join(f.repo, 'fixture.txt'))).toString('hex');
  const rebind = f.bridge.missions.goalPlanner.inspect(plan.id).stages[0].mission_id;
  const parentDetail = f.bridge.missions.detail(parent.id);
  const repairDetail = f.bridge.missions.detail(repairId);
  const diff = spawnSync('git', ['-C', f.repo, 'diff', '--check'], { encoding: 'utf8' });
  const report = {
    ok: repaired.state === 'awaiting_acceptance' && bytes === '626574610a' && rebind === repairId && diff.status === 0,
    parent_mission: parent.id,
    parent_state: parentDetail.state,
    parent_verification: parentDetail.verifications?.[0]?.result || null,
    corrective_mission: repairId,
    repair_of: repair.envelope.repair_of,
    repair_state: repaired.state,
    repair_verification: repaired.verifications?.[0]?.result || null,
    goal_rebind: rebind,
    parent_opencode_runs: parentDetail.runs.filter(r => r.agent_id === 'opencode').length,
    repair_opencode_runs: repairDetail.runs.filter(r => r.agent_id === 'opencode').length,
    exact_bytes: bytes,
    marker_consumed: !fs.existsSync(path.join(f.repo, MARKER)),
    applied_receipt: !!appliedReceipt(f.repo),
    acceptance_count: repaired.acceptance?.length || 0,
    git_diff_check: diff.status === 0,
    workspace: f.repo,
  };
  console.log(JSON.stringify(report, null, 2));
  for (const fn of after) await fn();
  if (!report.ok) process.exit(1);
}

main().catch(error => {
  console.error(JSON.stringify({ ok: false, error: String(error.message || error) }));
  process.exit(1);
});
