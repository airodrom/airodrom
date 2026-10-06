'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { EventLedger } = require('../src/event-ledger');
const { PersonalMemory } = require('../src/personal-memory');
const { ProjectMissionOrchestrator, SCHEMA_VERSION } = require('../src/project-orchestrator');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-projects-'));
  const file = path.join(root, 'memory.sqlite'); const db = new DatabaseSync(file); db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 2500;');
  let now = 1_790_000_000_000; const events = []; const ledger = new EventLedger(db, { now: () => now });
  const memory = new PersonalMemory({ db, now: () => now, record: event => events.push(event) });
  const tasks = new Set(['task-a', 'task-b']);
  const projects = new ProjectMissionOrchestrator({ db, now: () => now, personalMemory: memory, record: event => events.push(event), taskExists: taskId => tasks.has(taskId), eventExists: eventId => Boolean(db.prepare('SELECT 1 FROM event_ledger_events WHERE event_id=?').get(eventId)) });
  t.after(() => { try { db.close(); } catch { /* Restart test already closed it. */ } fs.rmSync(root, { recursive: true, force: true }); });
  return { root, file, db, ledger, memory, projects, events, tick: () => ++now };
}
function project(overrides = {}) { return { name: 'Pi Personal Assistant', description: 'Local assistant foundation.', desiredOutcomes: ['Durable, bounded personal memory'], currentPhase: 'foundation', nextAction: 'Build Personal Memory V1', preferredAgents: ['chatgpt', 'host', 'cursor'], autonomyLevel: 'suggest', privacyPolicy: 'Local-first', costPolicy: 'No unapproved spend', repositories: ['pi-chatgpt-bridge'], references: ['docs/MEMORY-V2.md'], decisions: ['Use SQLite'], limitations: ['No connector integration'], ...overrides }; }

test('fresh initialization migrates an existing database without replacing existing tables', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-project-migration-')); const file = path.join(root, 'memory.sqlite');
  const db = new DatabaseSync(file); db.exec("CREATE TABLE old_state (id TEXT PRIMARY KEY); INSERT INTO old_state VALUES ('kept')");
  const projects = new ProjectMissionOrchestrator({ db });
  assert.equal(projects.listProjects().length, 0);
  assert.equal(db.prepare('SELECT count(*) AS count FROM old_state').get().count, 1);
  assert.equal(db.prepare("SELECT value FROM project_orchestrator_meta WHERE key='schema_version'").get().value, String(SCHEMA_VERSION));
  db.close(); fs.rmSync(root, { recursive: true, force: true });
});

test('creates project, goal, mission, and persists a complete hierarchy across reopen', t => {
  const f = fixture(t); const created = f.projects.createProject(project());
  const goal = f.projects.createGoal({ projectId: created.projectId, name: 'Personal Memory', desiredOutcome: 'Persistent personal preferences', nextAction: 'Add retrieval' });
  const mission = f.projects.createMission({ goalId: goal.goalId, name: 'Memory schema', acceptanceCriteria: ['SQLite migration', 'restart persistence'], preferredAgents: ['cursor', 'host'] });
  assert.equal(mission.projectId, created.projectId); assert.equal(mission.goalId, goal.goalId);
  const summary = f.projects.summary(created.projectId); assert.equal(summary.goals.length, 1); assert.equal(summary.missions.length, 1);
  f.db.close(); const reopenedDb = new DatabaseSync(f.file); const reopened = new ProjectMissionOrchestrator({ db: reopenedDb });
  assert.equal(reopened.summary(created.projectId).missions[0].missionId, mission.missionId); reopenedDb.close();
});

test('status transitions, dependencies, blockers, next actions, and archive semantics remain project-scoped', t => {
  const f = fixture(t); const one = f.projects.createProject(project());
  const a = f.projects.createGoal({ projectId: one.projectId, name: 'Memory', nextAction: 'Design schema' });
  const b = f.projects.createGoal({ projectId: one.projectId, name: 'Orchestrator' });
  const mission = f.projects.createMission({ goalId: a.goalId, name: 'Memory V1' });
  assert.equal(f.projects.setMissionStatus(mission.missionId, 'active', { nextAction: 'Implement migrations' }).status, 'active');
  const dependency = f.projects.addDependency({ ownerType: 'goal', ownerId: b.goalId, dependsOnType: 'goal', dependsOnId: a.goalId });
  assert.equal(dependency.projectId, one.projectId);
  const blocker = f.projects.addBlocker({ ownerType: 'mission', ownerId: mission.missionId, detail: 'Awaiting local test evidence' });
  assert.equal(f.projects.listBlockers(one.projectId)[0].blockerId, blocker.blockerId);
  assert.equal(f.projects.archiveProject(one.projectId).status, 'archived');
  assert.throws(() => f.projects.createGoal({ projectId: one.projectId, name: 'Later' }), /Archived/);
});

test('project updates validate supplied fields and reject secret-like project metadata', t => {
  const f = fixture(t); const created = f.projects.createProject(project());
  assert.equal(f.projects.updateProject(created.projectId, { priority: 75, nextAction: null }).priority, 75);
  assert.equal(f.projects.getProject(created.projectId).nextAction, null);
  assert.throws(() => f.projects.updateProject(created.projectId, { priority: 101 }), /priority/);
  assert.throws(() => f.projects.updateProject(created.projectId, { preferredAgents: ['unknown'] }), /agent/);
  assert.throws(() => f.projects.updateProject(created.projectId, { references: ['authorization: Bearer super-secret-token-value'] }), /secret-like/);
});

test('cross-project dependencies and task, run, and event links are rejected', t => {
  const f = fixture(t); const one = f.projects.createProject(project()); const two = f.projects.createProject(project({ name: 'Arecibo' }));
  const first = f.projects.createGoal({ projectId: one.projectId, name: 'Memory' }); const second = f.projects.createGoal({ projectId: two.projectId, name: 'Engineering' });
  assert.throws(() => f.projects.addDependency({ ownerType: 'goal', ownerId: first.goalId, dependsOnType: 'goal', dependsOnId: second.goalId }), /Cross-project/);
  assert.throws(() => f.projects.associateTask(one.projectId, 'missing-task'), /Task not found/);
  f.projects.associateTask(one.projectId, 'task-a'); assert.throws(() => f.projects.associateTask(two.projectId, 'task-a'), /another project/);
  assert.throws(() => f.projects.associateRun(one.projectId, 'run-a', { taskId: 'task-b' }), /not linked/);
  f.projects.associateRun(one.projectId, 'run-a', { taskId: 'task-a' }); assert.throws(() => f.projects.associateRun(two.projectId, 'run-a'), /another project/);
  const event = f.ledger.record({ eventType: 'task.created', agent: 'bridge', direction: 'internal', taskId: 'task-a', metadata: {} });
  f.projects.associateEvent(one.projectId, event.event_id, { taskId: 'task-a' }); assert.throws(() => f.projects.associateEvent(two.projectId, event.event_id), /another project/);
});

test('project-scoped personal memory retrieves only that project and ledger events contain no content', t => {
  const f = fixture(t); const one = f.projects.createProject(project()); const two = f.projects.createProject(project({ name: 'Arecibo' }));
  f.memory.remember({ domain: 'project', projectId: one.projectId, type: 'fact', subject: 'region', content: 'Pi project uses local-only storage.', source: 'project_derived', sensitivity: 'normal' });
  f.memory.remember({ domain: 'project', projectId: two.projectId, type: 'fact', subject: 'region', content: 'Arecibo uses a separate engineering context.', source: 'project_derived', sensitivity: 'normal' });
  const matches = f.projects.projectMemory(one.projectId, 'local storage');
  assert.equal(matches.items.length, 1); assert.equal(matches.items[0].projectId, one.projectId);
  assert.ok(f.events.some(event => event.eventType === 'project.created'));
  assert.doesNotMatch(JSON.stringify(f.events), /local-only storage|separate engineering/);
});
