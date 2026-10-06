'use strict';

const { randomUUID } = require('node:crypto');
const { containsSecret } = require('./personal-memory');

const SCHEMA_VERSION = 1;
const PROJECT_STATUSES = new Set(['active', 'paused', 'completed', 'archived']);
const GOAL_STATUSES = new Set(['active', 'blocked', 'completed', 'archived']);
const MISSION_STATUSES = new Set(['planned', 'active', 'blocked', 'completed', 'cancelled', 'archived']);
const ENTITY_TYPES = new Set(['goal', 'mission']);
const AGENTS = new Set(['chatgpt', 'pi', 'cursor', 'research']);
const AUTONOMY = new Set(['observe', 'suggest', 'auto_safe', 'auto_development', 'auto_personal', 'custom']);
const MAX_TEXT = 4_000;
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,160}$/;

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value, allowed, name) {
  if (!plainObject(value) || Object.keys(value).some(key => !allowed.has(key))) throw new Error(`Invalid ${name}`);
}
function text(value, name, maximum = MAX_TEXT, { optional = false } = {}) {
  if (value === undefined || value === null) {
    if (optional) return null;
    throw new Error(`${name} is required`);
  }
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > maximum || value.includes('\0')) throw new Error(`Invalid ${name}`);
  if (containsSecret(value)) throw new Error(`${name} cannot contain secret-like content`);
  return value.normalize('NFC').trim();
}
function id(value, name, { optional = false } = {}) {
  if (value === undefined || value === null) {
    if (optional) return null;
    throw new Error(`${name} is required`);
  }
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(`Invalid ${name}`);
  return value;
}
function priority(value, fallback = 50) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error('Invalid priority');
  return value;
}
function strings(value, name, maximum = 24, itemMaximum = 500) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`Invalid ${name}`);
  return value.map((item, index) => text(item, `${name}[${index}]`, itemMaximum));
}
function agents(value) {
  const list = strings(value, 'preferredAgents', 8, 32);
  if (list.some(agent => !AGENTS.has(agent))) throw new Error('Unsupported preferred agent');
  return list;
}
function json(value) { return JSON.stringify(value); }
function projectRow(row) {
  if (!row) return null;
  return { projectId: row.project_id, name: row.name, description: row.description, status: row.status, priority: row.priority,
    desiredOutcomes: JSON.parse(row.desired_outcomes), currentPhase: row.current_phase, nextAction: row.next_action,
    preferredAgents: JSON.parse(row.preferred_agents), autonomyLevel: row.autonomy_level, privacyPolicy: row.privacy_policy,
    costPolicy: row.cost_policy, memoryNamespace: row.memory_namespace, repositories: JSON.parse(row.repositories),
    references: JSON.parse(row.references_json), decisions: JSON.parse(row.decisions), limitations: JSON.parse(row.limitations),
    createdAt: row.created_at, updatedAt: row.updated_at, archivedAt: row.archived_at };
}
function goalRow(row) {
  if (!row) return null;
  return { goalId: row.goal_id, projectId: row.project_id, name: row.name, description: row.description, status: row.status,
    priority: row.priority, desiredOutcome: row.desired_outcome, nextAction: row.next_action, createdAt: row.created_at, updatedAt: row.updated_at };
}
function missionRow(row) {
  if (!row) return null;
  return { missionId: row.mission_id, projectId: row.project_id, goalId: row.goal_id, name: row.name, description: row.description,
    status: row.status, acceptanceCriteria: JSON.parse(row.acceptance_criteria), nextAction: row.next_action,
    preferredAgents: JSON.parse(row.preferred_agents), createdAt: row.created_at, updatedAt: row.updated_at };
}

class ProjectMissionOrchestrator {
  constructor({ db, now = () => Date.now(), record = null, taskExists = null, eventExists = null, personalMemory = null } = {}) {
    if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function') throw new Error('Project orchestrator requires a SQLite database');
    this.db = db; this.now = now; this.record = typeof record === 'function' ? record : null;
    this.taskExists = typeof taskExists === 'function' ? taskExists : () => true;
    this.eventExists = typeof eventExists === 'function' ? eventExists : () => true;
    this.personalMemory = personalMemory; this._migrate();
  }
  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS project_orchestrator_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects (
        project_id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT, status TEXT NOT NULL, priority INTEGER NOT NULL,
        desired_outcomes TEXT NOT NULL, current_phase TEXT, next_action TEXT, preferred_agents TEXT NOT NULL, autonomy_level TEXT NOT NULL,
        privacy_policy TEXT, cost_policy TEXT, memory_namespace TEXT NOT NULL UNIQUE, repositories TEXT NOT NULL, references_json TEXT NOT NULL,
        decisions TEXT NOT NULL, limitations TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS project_goals (
        goal_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT, status TEXT NOT NULL, priority INTEGER NOT NULL,
        desired_outcome TEXT, next_action TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(project_id, name),
        FOREIGN KEY(project_id) REFERENCES projects(project_id)
      );
      CREATE TABLE IF NOT EXISTS project_missions (
        mission_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, goal_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT, status TEXT NOT NULL,
        acceptance_criteria TEXT NOT NULL, next_action TEXT, preferred_agents TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(goal_id, name), FOREIGN KEY(project_id) REFERENCES projects(project_id), FOREIGN KEY(goal_id) REFERENCES project_goals(goal_id)
      );
      CREATE TABLE IF NOT EXISTS project_dependencies (
        dependency_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, owner_type TEXT NOT NULL, owner_id TEXT NOT NULL,
        depends_on_type TEXT NOT NULL, depends_on_id TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL,
        UNIQUE(owner_type, owner_id, depends_on_type, depends_on_id), FOREIGN KEY(project_id) REFERENCES projects(project_id)
      );
      CREATE TABLE IF NOT EXISTS project_blockers (
        blocker_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, owner_type TEXT NOT NULL, owner_id TEXT NOT NULL,
        detail TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, resolved_at INTEGER,
        FOREIGN KEY(project_id) REFERENCES projects(project_id)
      );
      CREATE TABLE IF NOT EXISTS project_task_links (
        project_id TEXT NOT NULL, task_id TEXT NOT NULL UNIQUE, linked_at INTEGER NOT NULL, PRIMARY KEY(project_id, task_id),
        FOREIGN KEY(project_id) REFERENCES projects(project_id)
      );
      CREATE TABLE IF NOT EXISTS project_run_links (
        project_id TEXT NOT NULL, run_id TEXT NOT NULL UNIQUE, task_id TEXT, linked_at INTEGER NOT NULL, PRIMARY KEY(project_id, run_id),
        FOREIGN KEY(project_id) REFERENCES projects(project_id)
      );
      CREATE TABLE IF NOT EXISTS project_event_links (
        project_id TEXT NOT NULL, event_id TEXT NOT NULL UNIQUE, task_id TEXT, linked_at INTEGER NOT NULL, PRIMARY KEY(project_id, event_id),
        FOREIGN KEY(project_id) REFERENCES projects(project_id)
      );
      CREATE INDEX IF NOT EXISTS project_goals_scope ON project_goals(project_id, status, priority DESC, updated_at DESC);
      CREATE INDEX IF NOT EXISTS project_missions_scope ON project_missions(project_id, goal_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS project_blockers_scope ON project_blockers(project_id, status, created_at DESC);
    `);
    const version = this.db.prepare("SELECT value FROM project_orchestrator_meta WHERE key='schema_version'").get();
    if (!version) this.db.prepare("INSERT INTO project_orchestrator_meta(key,value) VALUES ('schema_version',?)").run(String(SCHEMA_VERSION));
    else if (Number(version.value) > SCHEMA_VERSION) throw new Error('Project database is newer than this bridge');
    else if (Number(version.value) < SCHEMA_VERSION) this.db.prepare("UPDATE project_orchestrator_meta SET value=? WHERE key='schema_version'").run(String(SCHEMA_VERSION));
  }
  _record(eventType, metadata = {}) {
    this.record?.({ eventType, agent: 'bridge', direction: 'internal', status: 'completed', metadata });
  }
  _project(projectId, { writable = false } = {}) {
    const project = projectRow(this.db.prepare('SELECT * FROM projects WHERE project_id=?').get(id(projectId, 'projectId')));
    if (!project) throw new Error('Project not found');
    if (writable && project.status === 'archived') throw new Error('Archived project is read-only');
    return project;
  }
  _entity(type, entityId) {
    if (!ENTITY_TYPES.has(type)) throw new Error('Unsupported project entity');
    const row = type === 'goal'
      ? this.db.prepare('SELECT goal_id AS id, project_id FROM project_goals WHERE goal_id=?').get(id(entityId, 'entityId'))
      : this.db.prepare('SELECT mission_id AS id, project_id FROM project_missions WHERE mission_id=?').get(id(entityId, 'entityId'));
    if (!row) throw new Error('Project entity not found');
    return row;
  }
  createProject(input = {}) {
    exact(input, new Set(['name', 'description', 'status', 'priority', 'desiredOutcomes', 'currentPhase', 'nextAction', 'preferredAgents', 'autonomyLevel', 'privacyPolicy', 'costPolicy', 'repositories', 'references', 'decisions', 'limitations']), 'project');
    const name = text(input.name, 'project name', 200); const status = input.status ?? 'active';
    if (!PROJECT_STATUSES.has(status) || status === 'archived') throw new Error('Invalid project status');
    const autonomyLevel = input.autonomyLevel ?? 'suggest'; if (!AUTONOMY.has(autonomyLevel)) throw new Error('Invalid autonomy level');
    const projectId = randomUUID(); const now = this.now();
    this.db.prepare(`INSERT INTO projects(project_id,name,description,status,priority,desired_outcomes,current_phase,next_action,preferred_agents,autonomy_level,privacy_policy,cost_policy,memory_namespace,repositories,references_json,decisions,limitations,created_at,updated_at,archived_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`).run(projectId, name, text(input.description, 'project description', MAX_TEXT, { optional: true }), status, priority(input.priority), json(strings(input.desiredOutcomes, 'desiredOutcomes')), text(input.currentPhase, 'current phase', 500, { optional: true }), text(input.nextAction, 'next action', 1_000, { optional: true }), json(agents(input.preferredAgents)), autonomyLevel, text(input.privacyPolicy, 'privacy policy', 1_000, { optional: true }), text(input.costPolicy, 'cost policy', 1_000, { optional: true }), `project:${projectId}`, json(strings(input.repositories, 'repositories')), json(strings(input.references, 'references')), json(strings(input.decisions, 'decisions')), json(strings(input.limitations, 'limitations')), now, now);
    const project = this.getProject(projectId); this._record('project.created', { project_id: projectId }); return project;
  }
  getProject(projectId) { return this._project(projectId); }
  listProjects({ status = null, limit = 100 } = {}) {
    if (status !== null && !PROJECT_STATUSES.has(status)) throw new Error('Invalid project status');
    if (!Number.isInteger(limit) || limit < 0 || limit > 200) throw new Error('Invalid project limit');
    return this.db.prepare('SELECT * FROM projects WHERE (? IS NULL OR status=?) ORDER BY priority DESC, updated_at DESC, project_id ASC LIMIT ?').all(status, status, limit).map(projectRow);
  }
  updateProject(projectId, patch = {}) {
    exact(patch, new Set(['description', 'status', 'priority', 'desiredOutcomes', 'currentPhase', 'nextAction', 'preferredAgents', 'autonomyLevel', 'privacyPolicy', 'costPolicy', 'repositories', 'references', 'decisions', 'limitations']), 'project update');
    const project = this._project(projectId, { writable: true }); const status = patch.status ?? project.status;
    if (!PROJECT_STATUSES.has(status)) throw new Error('Invalid project status');
    const supplied = (key, current, validate) => Object.hasOwn(patch, key) ? validate(patch[key]) : current;
    const description = supplied('description', project.description, value => text(value, 'project description', MAX_TEXT, { optional: true }));
    const priorityValue = supplied('priority', project.priority, value => priority(value));
    const desiredOutcomes = supplied('desiredOutcomes', project.desiredOutcomes, value => strings(value, 'desiredOutcomes'));
    const currentPhase = supplied('currentPhase', project.currentPhase, value => text(value, 'current phase', 500, { optional: true }));
    const nextAction = supplied('nextAction', project.nextAction, value => text(value, 'next action', 1_000, { optional: true }));
    const preferredAgents = supplied('preferredAgents', project.preferredAgents, value => agents(value));
    const autonomyLevel = supplied('autonomyLevel', project.autonomyLevel, value => {
      if (typeof value !== 'string' || !AUTONOMY.has(value)) throw new Error('Invalid autonomy level');
      return value;
    });
    const privacyPolicy = supplied('privacyPolicy', project.privacyPolicy, value => text(value, 'privacy policy', 1_000, { optional: true }));
    const costPolicy = supplied('costPolicy', project.costPolicy, value => text(value, 'cost policy', 1_000, { optional: true }));
    const repositories = supplied('repositories', project.repositories, value => strings(value, 'repositories'));
    const references = supplied('references', project.references, value => strings(value, 'references'));
    const decisions = supplied('decisions', project.decisions, value => strings(value, 'decisions'));
    const limitations = supplied('limitations', project.limitations, value => strings(value, 'limitations'));
    const now = this.now(); const archivedAt = status === 'archived' ? now : null;
    this.db.prepare(`UPDATE projects SET description=?,status=?,priority=?,desired_outcomes=?,current_phase=?,next_action=?,preferred_agents=?,autonomy_level=?,privacy_policy=?,cost_policy=?,repositories=?,references_json=?,decisions=?,limitations=?,updated_at=?,archived_at=? WHERE project_id=?`).run(
      description, status, priorityValue, json(desiredOutcomes), currentPhase, nextAction, json(preferredAgents), autonomyLevel, privacyPolicy, costPolicy, json(repositories), json(references), json(decisions), json(limitations), now, archivedAt, projectId);
    const updated = this.getProject(projectId); this._record(status === 'archived' ? 'project.archived' : 'project.updated', { project_id: projectId, status }); return updated;
  }
  archiveProject(projectId) { return this.updateProject(projectId, { status: 'archived' }); }
  createGoal(input = {}) {
    exact(input, new Set(['projectId', 'name', 'description', 'status', 'priority', 'desiredOutcome', 'nextAction']), 'goal');
    const project = this._project(input.projectId, { writable: true }); const status = input.status ?? 'active'; if (!GOAL_STATUSES.has(status) || status === 'archived') throw new Error('Invalid goal status');
    const goalId = randomUUID(); const now = this.now();
    this.db.prepare('INSERT INTO project_goals(goal_id,project_id,name,description,status,priority,desired_outcome,next_action,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(goalId, project.projectId, text(input.name, 'goal name', 200), text(input.description, 'goal description', MAX_TEXT, { optional: true }), status, priority(input.priority), text(input.desiredOutcome, 'goal desired outcome', 1_000, { optional: true }), text(input.nextAction, 'goal next action', 1_000, { optional: true }), now, now);
    const goal = this.getGoal(goalId); this._record('goal.created', { project_id: project.projectId, goal_id: goalId }); return goal;
  }
  getGoal(goalId) { const row = goalRow(this.db.prepare('SELECT * FROM project_goals WHERE goal_id=?').get(id(goalId, 'goalId'))); if (!row) throw new Error('Goal not found'); return row; }
  createMission(input = {}) {
    exact(input, new Set(['goalId', 'name', 'description', 'status', 'acceptanceCriteria', 'nextAction', 'preferredAgents']), 'mission');
    const goal = this.getGoal(input.goalId); this._project(goal.projectId, { writable: true });
    if (goal.status === 'archived') throw new Error('Archived goal is read-only'); const status = input.status ?? 'planned'; if (!MISSION_STATUSES.has(status) || status === 'archived') throw new Error('Invalid mission status');
    const criteria = strings(input.acceptanceCriteria, 'acceptanceCriteria', 20, 500); const missionId = randomUUID(); const now = this.now();
    this.db.prepare('INSERT INTO project_missions(mission_id,project_id,goal_id,name,description,status,acceptance_criteria,next_action,preferred_agents,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(missionId, goal.projectId, goal.goalId, text(input.name, 'mission name', 200), text(input.description, 'mission description', MAX_TEXT, { optional: true }), status, json(criteria), text(input.nextAction, 'mission next action', 1_000, { optional: true }), json(agents(input.preferredAgents)), now, now);
    const mission = this.getMission(missionId); this._record('mission.created', { project_id: goal.projectId, goal_id: goal.goalId, mission_id: missionId }); return mission;
  }
  getMission(missionId) { const row = missionRow(this.db.prepare('SELECT * FROM project_missions WHERE mission_id=?').get(id(missionId, 'missionId'))); if (!row) throw new Error('Project mission not found'); return row; }
  setMissionStatus(missionId, status, { nextAction = undefined } = {}) {
    if (!MISSION_STATUSES.has(status)) throw new Error('Invalid mission status'); const mission = this.getMission(missionId); this._project(mission.projectId, { writable: true });
    this.db.prepare('UPDATE project_missions SET status=?,next_action=?,updated_at=? WHERE mission_id=?').run(status, nextAction === undefined ? mission.nextAction : text(nextAction, 'mission next action', 1_000, { optional: true }), this.now(), missionId);
    const updated = this.getMission(missionId); this._record('mission.status_changed', { project_id: mission.projectId, mission_id: missionId, status }); return updated;
  }
  addDependency(input = {}) {
    exact(input, new Set(['ownerType', 'ownerId', 'dependsOnType', 'dependsOnId']), 'dependency');
    const owner = this._entity(input.ownerType, input.ownerId); const target = this._entity(input.dependsOnType, input.dependsOnId);
    if (owner.project_id !== target.project_id || owner.id === target.id && input.ownerType === input.dependsOnType) throw new Error('Cross-project or self dependency is not allowed');
    this._project(owner.project_id, { writable: true }); const dependencyId = randomUUID();
    this.db.prepare('INSERT INTO project_dependencies(dependency_id,project_id,owner_type,owner_id,depends_on_type,depends_on_id,status,created_at) VALUES (?,?,?,?,?,?,?,?)').run(dependencyId, owner.project_id, input.ownerType, owner.id, input.dependsOnType, target.id, 'active', this.now());
    this._record('project.dependency_added', { project_id: owner.project_id, dependency_id: dependencyId }); return { dependencyId, projectId: owner.project_id, ownerType: input.ownerType, ownerId: owner.id, dependsOnType: input.dependsOnType, dependsOnId: target.id, status: 'active' };
  }
  addBlocker(input = {}) {
    exact(input, new Set(['ownerType', 'ownerId', 'detail']), 'blocker'); const owner = this._entity(input.ownerType, input.ownerId); this._project(owner.project_id, { writable: true });
    const blockerId = randomUUID(); this.db.prepare('INSERT INTO project_blockers(blocker_id,project_id,owner_type,owner_id,detail,status,created_at,resolved_at) VALUES (?,?,?,?,?,?,?,NULL)').run(blockerId, owner.project_id, input.ownerType, owner.id, text(input.detail, 'blocker detail', 1_500), 'open', this.now());
    this._record('project.blocker_added', { project_id: owner.project_id, blocker_id: blockerId }); return { blockerId, projectId: owner.project_id, ownerType: input.ownerType, ownerId: owner.id, status: 'open' };
  }
  listBlockers(projectId, { includeResolved = false } = {}) {
    if (typeof includeResolved !== 'boolean') throw new Error('includeResolved must be boolean'); this._project(projectId);
    return this.db.prepare(`SELECT * FROM project_blockers WHERE project_id=? ${includeResolved ? '' : "AND status='open'"} ORDER BY created_at DESC, blocker_id ASC`).all(projectId).map(row => ({ blockerId: row.blocker_id, projectId: row.project_id, ownerType: row.owner_type, ownerId: row.owner_id, detail: row.detail, status: row.status, createdAt: row.created_at, resolvedAt: row.resolved_at }));
  }
  associateTask(projectId, taskId) {
    const project = this._project(projectId, { writable: true }); id(taskId, 'taskId'); if (!this.taskExists(taskId)) throw new Error('Task not found');
    const existing = this.db.prepare('SELECT project_id FROM project_task_links WHERE task_id=?').get(taskId); if (existing?.project_id && existing.project_id !== project.projectId) throw new Error('Task is already linked to another project');
    this.db.prepare('INSERT OR IGNORE INTO project_task_links(project_id,task_id,linked_at) VALUES (?,?,?)').run(project.projectId, taskId, this.now()); this._record('project.task_linked', { project_id: project.projectId, task_id: taskId }); return { projectId: project.projectId, taskId };
  }
  associateRun(projectId, runId, { taskId = null } = {}) {
    const project = this._project(projectId, { writable: true }); id(runId, 'runId'); if (taskId !== null) { id(taskId, 'taskId'); const link = this.db.prepare('SELECT 1 FROM project_task_links WHERE project_id=? AND task_id=?').get(projectId, taskId); if (!link) throw new Error('Run task is not linked to this project'); }
    const existing = this.db.prepare('SELECT project_id FROM project_run_links WHERE run_id=?').get(runId); if (existing?.project_id && existing.project_id !== project.projectId) throw new Error('Run is already linked to another project');
    this.db.prepare('INSERT OR IGNORE INTO project_run_links(project_id,run_id,task_id,linked_at) VALUES (?,?,?,?)').run(projectId, runId, taskId, this.now()); this._record('project.run_linked', { project_id: projectId, run_id: runId, task_id: taskId }); return { projectId, runId, taskId };
  }
  associateEvent(projectId, eventId, { taskId = null } = {}) {
    const project = this._project(projectId, { writable: true }); id(eventId, 'eventId'); if (!this.eventExists(eventId)) throw new Error('Ledger event not found');
    if (taskId !== null) { id(taskId, 'taskId'); const link = this.db.prepare('SELECT 1 FROM project_task_links WHERE project_id=? AND task_id=?').get(projectId, taskId); if (!link) throw new Error('Event task is not linked to this project'); }
    const existing = this.db.prepare('SELECT project_id FROM project_event_links WHERE event_id=?').get(eventId); if (existing?.project_id && existing.project_id !== project.projectId) throw new Error('Event is already linked to another project');
    this.db.prepare('INSERT OR IGNORE INTO project_event_links(project_id,event_id,task_id,linked_at) VALUES (?,?,?,?)').run(projectId, eventId, taskId, this.now()); this._record('project.event_linked', { project_id: projectId, event_id: eventId, task_id: taskId }); return { projectId, eventId, taskId };
  }
  projectMemory(projectId, query, options = {}) {
    this._project(projectId); if (!this.personalMemory) throw new Error('Personal memory is unavailable');
    return this.personalMemory.search(query, { ...options, domain: 'project', projectId });
  }
  summary(projectId) {
    const project = this.getProject(projectId); const goals = this.db.prepare('SELECT * FROM project_goals WHERE project_id=? ORDER BY priority DESC, updated_at DESC').all(projectId).map(goalRow);
    const missions = this.db.prepare('SELECT * FROM project_missions WHERE project_id=? ORDER BY updated_at DESC').all(projectId).map(missionRow);
    return { project, goals, missions, blockers: this.listBlockers(projectId), tasks: this.db.prepare('SELECT task_id FROM project_task_links WHERE project_id=? ORDER BY linked_at DESC').all(projectId).map(row => row.task_id) };
  }
}

module.exports = { ProjectMissionOrchestrator, SCHEMA_VERSION };
