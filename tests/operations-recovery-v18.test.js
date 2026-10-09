'use strict';
// Focused checks for lifecycle settlement, CLI rendering, menu status and durable
// Claude Code results. In-memory SQLite and disposable homes only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const settle = require('../src/run-settlement');
const cli = require('../src/cli-render');
const { indicator } = require('../src/menu-status');
const { DevtoolsJobStore } = require('../src/devtools-job-store');
const { ClaudeCodeJobs } = require('../src/capability-devtools');

function runsDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE cp_runs(id TEXT PRIMARY KEY,agent_id TEXT,state TEXT,process_state TEXT,termination_verified INTEGER,liveness_state TEXT,pid INTEGER,ended_at INTEGER,updated_at INTEGER);
    CREATE TABLE cp_leases(id INTEGER PRIMARY KEY,run_id TEXT,state TEXT);
    CREATE TABLE cp_effect_outbox(id INTEGER PRIMARY KEY,status TEXT);`);
  return db;
}
const settledHost = { agent_id: 'host', state: 'cancelled', process_state: 'idle', termination_verified: 1, liveness_state: 'settled', pid: null, ended_at: 1 };
function addRun(db, id, over = {}) {
  const r = { ...settledHost, ...over };
  db.prepare('INSERT INTO cp_runs VALUES(?,?,?,?,?,?,?,?,1)').run(id, r.agent_id, r.state, r.process_state, r.termination_verified, r.liveness_state, r.pid, r.ended_at);
  db.prepare("INSERT INTO cp_leases(run_id,state) VALUES(?,'released')").run(id);
}

test('1 a terminal host run idle after verified termination is settled', () => {
  const db = runsDb();
  addRun(db, 'a'); addRun(db, 'b', { state: 'completed' }); addRun(db, 'c', { agent_id: 'opencode', process_state: 'exited' });
  assert.equal(settle.unresolvedRuns(db), 0);
  // The pre-fix gate rejected exactly these legitimate records.
  assert.equal(db.prepare("SELECT count(*) n FROM cp_runs WHERE process_state NOT IN ('exited','not_started')").get().n, 2);
});

test('2 active, uncertain or under-proven runs still block, including NULLs', () => {
  const cases = { running: { state: 'running' }, unverified: { termination_verified: 0 }, unknown: { process_state: 'unknown' },
    idle_not_host: { agent_id: 'opencode' }, unsettled: { liveness_state: 'unknown' }, live_pid: { pid: 4242 }, not_ended: { ended_at: null },
    null_state: { state: null }, null_verified: { termination_verified: null }, null_process: { process_state: null } };
  for (const [name, over] of Object.entries(cases)) {
    const db = runsDb(); addRun(db, name, over);
    assert.equal(settle.unresolvedRuns(db), 1, name);
    assert.equal(settle.unresolvedReasons(db).length, 1, name);
  }
});

test('3 an unreleased lease on the run or any uncertain effect blocks admission', () => {
  const db = runsDb(); addRun(db, 'a');
  db.prepare("UPDATE cp_leases SET state='held' WHERE run_id='a'").run();
  assert.equal(settle.durableBlockers(db).runs, 1); assert.equal(settle.durableBlockers(db).leases, 1);
  const effects = runsDb(); addRun(effects, 'b'); effects.prepare("INSERT INTO cp_effect_outbox(status) VALUES('delivery_unknown')").run();
  assert.deepEqual([settle.durableBlockers(effects).runs, settle.durableBlockers(effects).effects], [0, 1]);
});

test('4 status renders as readable text with a next action, styled only on a colour TTY', () => {
  const status = { healthy: true, pid: 9, opencode: { ready: true }, active_runs: 0, quarantined_leases: 0, product: { memory: 'Ready', active_missions: 0 } };
  const gate = { version: 1, state: 'draining', reconciled: true, idle: false, blockers: { runs: 4, leases: 0 } };
  const plain = cli.serviceStatus({ status, admission: gate, mcpReady: false }, { isTTY: false }, {});
  assert.match(plain, /AIRODROM · SERVICE STATUS/); assert.match(plain, /Service Admission\s+Maintenance hold/); assert.match(plain, /Unresolved Runs\s+4/);
  assert.match(plain, /Review unresolved execution records/); assert.match(plain, /Use --json for structured output/);
  assert.doesNotMatch(plain, /\x1b\[/);
  assert.doesNotMatch(cli.serviceStatus({ status, admission: gate }, { isTTY: true }, { NO_COLOR: '1' }), /\x1b\[/);
  assert.match(cli.serviceStatus({ status, admission: gate }, { isTTY: true }, {}), /\x1b\[/);
  assert.match(cli.admissionStatus({ ...gate, blockers: { runs: 0 }, idle: true }, { isTTY: false }, {}), /reopen admission with airodrom admission resume/);
});

test('5 the real CLI keeps --json structured and prints human text otherwise', () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'airo-cli-'))); fs.chmodSync(home, 0o700);
  try {
    const run = args => spawnSync(process.execPath, ['--experimental-sqlite', path.join(__dirname, '../src/interactive-cli.js'), ...args], { encoding: 'utf8', env: { ...process.env, AIRODROM_HOME: home, NO_COLOR: '1' } });
    assert.deepEqual(JSON.parse(run(['status', '--json']).stdout), { state: 'stopped' });
    const human = run(['status']).stdout;
    assert.match(human, /Control Plane\s+Stopped/); assert.match(human, /Airodrom is stopped. Start it from the menu/); assert.doesNotMatch(human, /^\{/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('6 menu indicator never equates a live process with an operational control plane', () => {
  const ready = { control: 'Ready', runtime: 'Ready', memory: 'Ready', quarantined_leases: 0 };
  assert.equal(indicator({ state: 'Connected', product: ready }).category, 'healthy');
  assert.equal(indicator({ state: 'Error', product: null }).category, 'disconnected'); // process present, status not answering
  assert.equal(indicator({ state: 'Stopped' }).category, 'disconnected');
  assert.equal(indicator({ state: 'Connected', product: ready, admission: { state: 'draining', blockers: { runs: 4 } } }).description, 'Airodrom is in maintenance — 4 unresolved runs');
  assert.equal(indicator({ state: 'Connected', product: { ...ready, runtime: 'Degraded' } }).category, 'degraded');
  assert.equal(indicator({ state: 'Stopped', supervisor: 'RECOVERING' }).category, 'starting');
  assert.equal(indicator({}).category, 'unknown');
});

test('7 Claude Code results persist; 8 unrelated tasks cannot read them; 9 secrets are withheld', () => {
  const db = new DatabaseSync(':memory:'), store = new DevtoolsJobStore(db);
  const job = { id: '11111111-1111-4111-8111-111111111111', taskId: 'task-a', startedAt: 1000, status: 'running' };
  store.started(job); store.progress(job.id, 'output_progress', { stdout_bytes: 2048, text: 'leak' });
  Object.assign(job, { status: 'completed', exitCode: 0, finishedAt: 2000, stdout: 'RAW OUTPUT', touched: ['src/a.js', 'token=sk-ant-api03-' + 'x'.repeat(40)],
    result: { is_error: false, text: 'Done. key sk-ant-api03-' + 'y'.repeat(40), num_turns: 3 } });
  store.settled(job, true);
  const view = store.forTask('task-a', job.id);
  assert.equal(view.status, 'completed'); assert.equal(view.exit_code, 0); assert.equal(view.error_category, null);
  assert.deepEqual(view.events.map(e => e.kind), ['started', 'output_progress', 'settled']); assert.equal(view.events[1].text, undefined);
  assert.equal(store.forTask('task-b', job.id), null);
  const jobs = new ClaudeCodeJobs(); jobs.store = store;
  assert.throws(() => jobs.status('task-b', job.id), /not owned/); assert.equal(jobs.status('task-a', job.id).durable, true);
  const text = JSON.stringify(store.list());
  assert.doesNotMatch(text, /sk-ant-api03|RAW OUTPUT/); assert.deepEqual(view.modified_files, ['src/a.js', 'token=[redacted-secret]']);
  const unparsed = { ...job, id: '22222222-2222-4222-8222-222222222222', stdout: 'stack trace with secrets' };
  store.started(unparsed); store.settled(unparsed, false);
  assert.deepEqual(store.forTask('task-a', unparsed.id).result, { is_error: true, text: null, output_bytes: 24 });
});

test('10 restart: running jobs become interrupted and crashed runs keep admission closed', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airo-jobs-')), file = path.join(dir, 'jobs.sqlite');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const before = new DatabaseSync(file);
  new DevtoolsJobStore(before).started({ id: '33333333-3333-4333-8333-333333333333', taskId: 't', startedAt: 1 });
  before.close();
  const after = new DevtoolsJobStore(new DatabaseSync(file)); // a new connection, as after a service restart
  assert.equal(after.forTask('t', '33333333-3333-4333-8333-333333333333').status, 'interrupted');
  const runs = runsDb(); addRun(runs, 'crashed', { state: 'interrupted', termination_verified: 0, process_state: 'unknown', liveness_state: 'unknown' });
  assert.equal(settle.unresolvedRuns(runs), 1); // the lifecycle cannot auto-reopen over unverified work
});
