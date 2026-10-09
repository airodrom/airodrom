'use strict';
// Durable Claude Code job results on the canonical store. Sanitized metadata only:
// no stdout/stderr, prompts, environment, credentials or private reasoning. Results
// are unverified worker output and never carry authority or acceptance.
const { redactText } = require('./secret-observation');
const { secretLike } = require('./provider-policy');

const MAX_EVENTS = 50, MAX_FILES = 500;
const reconciled = new WeakSet();

function errorCategory(job, parsed) {
  if (job.status === 'timed_out') return 'timed_out';
  if (job.status === 'cancelled') return 'cancelled';
  if (!parsed) return 'unparseable_output';
  if (job.exitCode !== 0) return 'nonzero_exit';
  return job.result?.is_error ? 'reported_error' : null;
}
const clean = text => { const value = redactText(String(text ?? ''), 24_000); return secretLike(value) ? '[withheld: secret-like content]' : value; };

class DevtoolsJobStore {
  constructor(db, { now = Date.now } = {}) {
    this.db = db; this.now = now;
    db.exec(`CREATE TABLE IF NOT EXISTS cp_devtools_jobs(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,worker TEXT NOT NULL,state TEXT NOT NULL,
      started_at INTEGER NOT NULL,finished_at INTEGER,exit_code INTEGER,error_category TEXT,events TEXT NOT NULL,result TEXT,modified_files TEXT,updated_at INTEGER NOT NULL)`);
    // A job recorded as running by an earlier process lost its child: report it, never resume it.
    if (!reconciled.has(db)) { reconciled.add(db); db.prepare("UPDATE cp_devtools_jobs SET state='interrupted',error_category='interrupted',finished_at=COALESCE(finished_at,?),updated_at=? WHERE state='running'").run(now(), now()); }
  }
  started(job, worker = 'claude_code') {
    this.db.prepare('INSERT OR IGNORE INTO cp_devtools_jobs(id,task_id,worker,state,started_at,events,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run(job.id, job.taskId, worker, 'running', job.startedAt, JSON.stringify([{ at: job.startedAt, kind: 'started' }]), this.now());
  }
  // Progress carries fixed kinds and numbers only, never output text.
  progress(jobId, kind, detail = {}) {
    const row = this.db.prepare("SELECT events FROM cp_devtools_jobs WHERE id=? AND state='running'").get(jobId);
    if (!row) return;
    const numbers = Object.fromEntries(Object.entries(detail).filter(([, v]) => Number.isSafeInteger(v)));
    const events = [...JSON.parse(row.events), { at: this.now(), kind, ...numbers }].slice(-MAX_EVENTS);
    this.db.prepare('UPDATE cp_devtools_jobs SET events=?,updated_at=? WHERE id=?').run(JSON.stringify(events), this.now(), jobId);
  }
  settled(job, parsed) {
    const row = this.db.prepare('SELECT events FROM cp_devtools_jobs WHERE id=?').get(job.id);
    if (!row) return;
    const category = errorCategory(job, parsed);
    const result = parsed ? { is_error: job.result?.is_error === true, text: clean(job.result?.text), num_turns: job.result?.num_turns ?? null } : { is_error: true, text: null, output_bytes: Buffer.byteLength(job.stdout || '') };
    const files = (job.touched || []).slice(0, MAX_FILES).map(f => redactText(String(f), 300)).filter(f => !secretLike(f));
    const events = [...JSON.parse(row.events), { at: job.finishedAt || this.now(), kind: 'settled', exit_code: Number.isSafeInteger(job.exitCode) ? job.exitCode : null }].slice(-MAX_EVENTS);
    this.db.prepare('UPDATE cp_devtools_jobs SET state=?,finished_at=?,exit_code=?,error_category=?,events=?,result=?,modified_files=?,updated_at=? WHERE id=?')
      .run(job.status, job.finishedAt || this.now(), Number.isSafeInteger(job.exitCode) ? job.exitCode : null, category, JSON.stringify(events), JSON.stringify(result), JSON.stringify(files), this.now(), job.id);
  }
  view(row) {
    return row ? { job_id: row.id, task_id: row.task_id, worker: row.worker, status: row.state, started_at: new Date(row.started_at).toISOString(),
      finished_at: row.finished_at ? new Date(row.finished_at).toISOString() : null, exit_code: row.exit_code, error_category: row.error_category,
      events: JSON.parse(row.events), result: row.result ? JSON.parse(row.result) : null, modified_files: row.modified_files ? JSON.parse(row.modified_files) : [],
      durable: true, accepted: false, execution_authority: false } : null;
  }
  // Owning task only. An unrelated task gets nothing, not even existence.
  forTask(taskId, jobId) { return this.view(this.db.prepare('SELECT * FROM cp_devtools_jobs WHERE id=? AND task_id=?').get(jobId, taskId)); }
  // Operator history for the Control Center.
  list(limit = 50) { return this.db.prepare('SELECT * FROM cp_devtools_jobs ORDER BY started_at DESC LIMIT ?').all(Math.min(Math.max(1, limit), 200)).map(r => this.view(r)); }
}

module.exports = { DevtoolsJobStore, errorCategory };
