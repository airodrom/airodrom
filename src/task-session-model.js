'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { transaction, afterCommit, afterRollback } = require('./control-transaction');
const { atomicJSON } = require('./config');
class TaskSessionManager extends EventEmitter {
  constructor(dataDir, db = null) {
    super(); this.db = db; this.saved = new Map();
    db?.exec(`CREATE TABLE IF NOT EXISTS task_states (id TEXT PRIMARY KEY, snapshot TEXT NOT NULL); CREATE TABLE IF NOT EXISTS task_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, at INTEGER NOT NULL, previous TEXT, state TEXT NOT NULL); CREATE INDEX IF NOT EXISTS task_event_scope ON task_events(task_id, seq);`);
    this.root = path.join(dataDir, 'tasks'); this.tasks = new Map(); fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if(db)require('./retained-context-files').attachRetainedFiles(db,dataDir,{isActive:id=>this.isErasureActive?.(id)===true,onTaskRedacted:(id,safeTask)=>{
      const task=this.tasks.get(id);if(task){for(const key of Object.keys(task))delete task[key];Object.assign(task,safeTask);}
    }});
    for (const id of fs.readdirSync(this.root)) {
      if (!/^[0-9a-f-]{36}$/.test(id)) continue;
      const file = path.join(this.root, id, 'task.json');
      if (!fs.existsSync(file)) continue;
      const persisted = db?.prepare('SELECT snapshot FROM task_states WHERE id = ?').get(id);
      const task = JSON.parse(persisted?.snapshot || fs.readFileSync(file, 'utf8'));
      this.saved.set(id, task.status);
      if (task.id !== id || task.sessionDir !== path.join(this.root, id, 'sessions')) throw new Error('Invalid persisted task location');
      // Erased snapshots are immutable tombstones. Recovery must not replay or
      // enrich their content, including execution evidence or session metadata.
      if (task.content_state === 'erased') { if(db)require('./memory-content-erasure').assertReadable(db); this.tasks.set(id, task); continue; }
      task.status = ['waiting_for_provider','waiting_for_operator','queued','completed','idle','cancelled','error','failed','deadline','stalled','approval_expired','blocked','interrupted','awaiting_operator_grant','awaiting_mcp_continuation'].includes(task.status) ? task.status : 'interrupted';
      if (task.status === 'queued' && task.mission?.started) task.status = 'interrupted';
      // Records predating runtime identity were Pi sessions; retain their historical identity.
      task.executionAgent ||= require('./removed-runtime').REMOVED_RUNTIME;
      const historical = require('./removed-runtime').removed(task);
      if (historical) { task.runtimeRemoved=true; task.runtimeLabel='Historical runtime removed'; }
      else if (task.status === 'completed' && !require('./execution-evidence').satisfied(task)) { task.status = 'failed'; task.failureKind = 'native_tool_required'; task.lastRunBlocked = true; }
      task.connected = false; task.safetyLoaded = false; task.recoveredAt = Date.now();
      this.tasks.set(id, task); this.save(task);
    }
  }
  create(description, workspace) {
    if (typeof description !== 'string' || !description.trim() || description.length > 500) throw new Error('Task description required (max 500 characters)');
    const id = randomUUID(), dir = path.join(this.root, id);
    fs.mkdirSync(dir, { mode: 0o700 });
    workspace ||= path.join(dir, 'workspace'); fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const task = { id, description, workspace: fs.realpathSync(workspace), sessionId: randomUUID(), sessionDir: path.join(dir, 'sessions'), status: 'queued', createdAt: Date.now(), updatedAt: Date.now(), lastActivityAt: null, lastHeartbeatAt: null, connected: false, safetyLoaded: false, compactions: 0, context: null, lastResult: null, events: [], retrievedMemory: [] };
    fs.mkdirSync(task.sessionDir, { mode: 0o700 }); this.tasks.set(id, task); if(this.db)afterRollback(this.db,()=>this.tasks.delete(id)); this.save(task); return task;
  }
  get(id) { if(this.db)require('./memory-content-erasure').assertReadable(this.db);const task = this.tasks.get(id); if (!task) throw new Error('Task not found'); return task; }
  save(task) {
    task.updatedAt = Date.now();
    const previous = this.saved.get(task.id) || null, changed = previous !== task.status;
    const prior=this.db?.prepare('SELECT snapshot FROM task_states WHERE id=?').get(task.id)?.snapshot;
    const persist = () => {
      if(this.db&&prior)afterRollback(this.db,()=>{for(const key of Object.keys(task))delete task[key];Object.assign(task,JSON.parse(prior));});
      if (this.db) {
        this.db.prepare('INSERT INTO task_states(id,snapshot) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET snapshot=excluded.snapshot').run(task.id, JSON.stringify(task));
        if (changed) this.db.prepare('INSERT INTO task_events(task_id,at,previous,state) VALUES (?,?,?,?)').run(task.id, task.updatedAt, previous, task.status);
      }
      const snapshot = JSON.parse(JSON.stringify(task));
      const committed = () => {
        atomicJSON(path.join(this.root, task.id, 'task.json'), snapshot);
        this.saved.set(task.id, snapshot.status);
        if (changed) this.emit('transition', task.id);
      };
      if (this.db) afterCommit(this.db, committed); else committed();
    };
    if (this.db) transaction(this.db, persist); else persist();
  }
  transitions(id) { return this.db ? this.db.prepare('SELECT seq,at,previous,state FROM task_events WHERE task_id = ? ORDER BY seq DESC LIMIT 80').all(id).reverse() : []; }
  list() { if(this.db)require('./memory-content-erasure').assertReadable(this.db);return [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id)); }
}
module.exports = TaskSessionManager;
