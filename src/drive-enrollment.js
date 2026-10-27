'use strict';
// Owner-controlled Drive resource enrollment. Chat text never grants access.
const ID = /^[A-Za-z0-9_-]{1,200}$/;

const TABLE = `
CREATE TABLE IF NOT EXISTS drive_enrolled_resources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT,
  mime_type TEXT,
  operator TEXT NOT NULL,
  account_email TEXT,
  enrolled_at INTEGER NOT NULL,
  revoked_at INTEGER
);
`;

function ensure(db) {
  if (!db || typeof db.exec !== 'function') return null;
  db.exec(TABLE);
  return db;
}

class DriveEnrollment {
  constructor({ db = null, now = Date.now } = {}) {
    this.db = ensure(db);
    this.now = now;
  }

  enroll({ id, kind = 'file', name = null, mime_type = null, operator = 'operator', account_email = null } = {}) {
    if (!this.db) throw Error('Drive enrollment store unavailable.');
    if (!ID.test(id || '')) {
      const err = Error('Exact Google Drive file or folder id required for enrollment.');
      err.code = 'drive_enrollment_id_invalid';
      throw err;
    }
    if (kind !== 'file' && kind !== 'folder') {
      const err = Error('Enrollment kind must be file or folder.');
      err.code = 'drive_enrollment_kind_invalid';
      throw err;
    }
    if (operator !== 'operator') {
      const err = Error('Drive enrollment is operator-only.');
      err.code = 'drive_enrollment_operator_forbidden';
      throw err;
    }
    const at = this.now();
    this.db.prepare(`
      INSERT INTO drive_enrolled_resources(id, kind, name, mime_type, operator, account_email, enrolled_at, revoked_at)
      VALUES(?,?,?,?,?,?,?,NULL)
      ON CONFLICT(id) DO UPDATE SET
        kind=excluded.kind,
        name=COALESCE(excluded.name, drive_enrolled_resources.name),
        mime_type=COALESCE(excluded.mime_type, drive_enrolled_resources.mime_type),
        account_email=COALESCE(excluded.account_email, drive_enrolled_resources.account_email),
        enrolled_at=excluded.enrolled_at,
        revoked_at=NULL
    `).run(id, kind, name, mime_type, operator, account_email, at);
    return this.get(id, { operator, includeRevoked: false });
  }

  revoke(id, { operator = 'operator' } = {}) {
    if (!this.db || !ID.test(id || '')) return { revoked: false };
    const row = this.db.prepare('SELECT * FROM drive_enrolled_resources WHERE id=? AND operator=?').get(id, operator);
    if (!row || row.revoked_at) return { revoked: false, id };
    this.db.prepare('UPDATE drive_enrolled_resources SET revoked_at=? WHERE id=? AND operator=?').run(this.now(), id, operator);
    return { revoked: true, id };
  }

  revokeAll({ operator = 'operator' } = {}) {
    if (!this.db) return { revoked: 0 };
    const info = this.db.prepare(
      'UPDATE drive_enrolled_resources SET revoked_at=? WHERE operator=? AND revoked_at IS NULL',
    ).run(this.now(), operator);
    return { revoked: info.changes || 0 };
  }

  get(id, { operator = 'operator', includeRevoked = false } = {}) {
    if (!this.db || !ID.test(id || '')) return null;
    const row = this.db.prepare('SELECT * FROM drive_enrolled_resources WHERE id=? AND operator=?').get(id, operator);
    if (!row) return null;
    if (!includeRevoked && row.revoked_at) return null;
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      mime_type: row.mime_type,
      account_email: row.account_email,
      enrolled_at: row.enrolled_at,
      revoked_at: row.revoked_at || null,
      active: !row.revoked_at,
    };
  }

  list({ operator = 'operator', includeRevoked = false } = {}) {
    if (!this.db) return [];
    const rows = includeRevoked
      ? this.db.prepare('SELECT * FROM drive_enrolled_resources WHERE operator=? ORDER BY enrolled_at DESC LIMIT 200').all(operator)
      : this.db.prepare('SELECT * FROM drive_enrolled_resources WHERE operator=? AND revoked_at IS NULL ORDER BY enrolled_at DESC LIMIT 200').all(operator);
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      name: row.name,
      mime_type: row.mime_type,
      account_email: row.account_email,
      enrolled_at: row.enrolled_at,
      revoked_at: row.revoked_at || null,
      active: !row.revoked_at,
    }));
  }

  assertEnrolled(id, { operator = 'operator', kind = null } = {}) {
    const row = this.get(id, { operator, includeRevoked: false });
    if (!row) {
      const err = Error('That Drive resource is not enrolled. Owner must enroll the exact file or folder id after /connect drive.');
      err.code = 'drive_resource_not_enrolled';
      throw err;
    }
    if (kind && row.kind !== kind) {
      const err = Error(`Enrolled Drive resource ${id} is a ${row.kind}, not a ${kind}.`);
      err.code = 'drive_enrollment_kind_mismatch';
      throw err;
    }
    return row;
  }

  /**
   * Reads require exact file enrollment under drive.file.
   * Parent-folder enrollment must NOT authorize child file reads: Google’s drive.file
   * scope only covers app-created or app-opened files, not every child of a folder.
   */
  assertReadable(id, { operator = 'operator' } = {}) {
    const direct = this.get(id, { operator, includeRevoked: false });
    if (direct && direct.kind === 'file') return { enrollment: direct, via: 'direct' };
    if (direct && direct.kind === 'folder') {
      const err = Error('Folder enrollment does not authorize document reads. Enroll each file with /drive enroll file <id> after it is opened with this app under drive.file.');
      err.code = 'drive_folder_read_not_authorized';
      throw err;
    }
    const err = Error('That Drive file is not enrolled. Under drive.file, enroll each exact file id the owner opened with this app — folder enrollment does not grant child access.');
    err.code = 'drive_resource_not_enrolled';
    throw err;
  }
}

module.exports = { DriveEnrollment, ID };
