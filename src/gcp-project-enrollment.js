'use strict';
// Explicit, revocable GCP project enrollment. Enrollment ≠ write authority.
const { DatabaseSync } = require('node:sqlite');

function openDb(db) {
  if (db && typeof db.exec === 'function' && typeof db.prepare === 'function') return db;
  return new DatabaseSync(':memory:');
}

class GcpProjectEnrollment {
  constructor({ db = null, now = () => Date.now() } = {}) {
    this.db = openDb(db);
    this.now = now;
    this._migrate();
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS gcp_enrolled_projects (
        project_id TEXT NOT NULL,
        project_number TEXT NOT NULL,
        operator TEXT NOT NULL,
        account_email TEXT,
        note TEXT,
        enrolled_at INTEGER NOT NULL,
        revoked_at INTEGER,
        PRIMARY KEY (project_id, operator)
      );
      CREATE INDEX IF NOT EXISTS gcp_enrolled_projects_active
        ON gcp_enrolled_projects(operator, revoked_at);
    `);
  }

  enroll({ project_id, project_number, operator = 'operator', account_email = null, note = null } = {}) {
    if (typeof project_id !== 'string' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project_id)) {
      const err = Error('Invalid GCP project_id.');
      err.code = 'gcp_enrollment_invalid';
      throw err;
    }
    if (typeof project_number !== 'string' || !/^[0-9]{6,20}$/.test(project_number)) {
      const err = Error('Invalid GCP project_number.');
      err.code = 'gcp_enrollment_invalid';
      throw err;
    }
    if (operator !== 'operator') {
      const err = Error('GCP enrollment is operator-local only.');
      err.code = 'gcp_enrollment_forbidden';
      throw err;
    }
    const now = this.now();
    this.db.prepare(`
      INSERT INTO gcp_enrolled_projects(project_id, project_number, operator, account_email, note, enrolled_at, revoked_at)
      VALUES(?,?,?,?,?,?,NULL)
      ON CONFLICT(project_id, operator) DO UPDATE SET
        project_number=excluded.project_number,
        account_email=excluded.account_email,
        note=excluded.note,
        enrolled_at=excluded.enrolled_at,
        revoked_at=NULL
    `).run(project_id, project_number, operator, account_email, note, now);
    return this.get(project_id, operator);
  }

  revoke(project_id, operator = 'operator') {
    const now = this.now();
    const result = this.db.prepare(`
      UPDATE gcp_enrolled_projects SET revoked_at=?
      WHERE project_id=? AND operator=? AND revoked_at IS NULL
    `).run(now, project_id, operator);
    return { revoked: result.changes > 0, project_id, at: now };
  }

  get(project_id, operator = 'operator') {
    const row = this.db.prepare(`
      SELECT * FROM gcp_enrolled_projects WHERE project_id=? AND operator=?
    `).get(project_id, operator);
    if (!row || row.revoked_at != null) return null;
    return {
      project_id: row.project_id,
      project_number: row.project_number,
      operator: row.operator,
      account_email: row.account_email || null,
      note: row.note || null,
      enrolled_at: row.enrolled_at,
    };
  }

  list(operator = 'operator') {
    return this.db.prepare(`
      SELECT project_id, project_number, operator, account_email, note, enrolled_at
      FROM gcp_enrolled_projects
      WHERE operator=? AND revoked_at IS NULL
      ORDER BY enrolled_at DESC
    `).all(operator).map(row => ({
      project_id: row.project_id,
      project_number: row.project_number,
      operator: row.operator,
      account_email: row.account_email || null,
      note: row.note || null,
      enrolled_at: row.enrolled_at,
    }));
  }

  assertEnrolled(project_id, project_number, operator = 'operator') {
    const row = this.get(project_id, operator);
    if (!row) {
      const err = Error(`GCP project ${project_id} is not enrolled for governed cloud writes.`);
      err.code = 'gcp_project_not_enrolled';
      err.safe = true;
      throw err;
    }
    if (String(row.project_number) !== String(project_number)) {
      const err = Error('Enrolled project_number does not match the requested operation.');
      err.code = 'gcp_enrollment_project_number_mismatch';
      err.safe = true;
      throw err;
    }
    return row;
  }
}

module.exports = { GcpProjectEnrollment };
