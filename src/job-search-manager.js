'use strict';
// Job Search Manager V1 — Issue #112 (review hardening).
// Local CSV tracker (Excel-openable). Evidence-grounded. No fabricated jobs or outcomes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const HEADERS = Object.freeze([
  'id', 'company', 'role', 'source', 'status', 'applied_at', 'recruiter_email',
  'posting_url', 'evidence', 'follow_up_at', 'notes', 'updated_at'
]);

const STATUSES = Object.freeze([
  'discovered', 'applied', 'screening', 'interview', 'offer', 'rejected', 'withdrawn', 'follow_up'
]);

const EVIDENCE_KINDS = Object.freeze(['message_id', 'thread_id', 'url', 'operator_confirmation']);
const TRACKER_NAME = 'applications.csv';

// Formula-like after optional leading whitespace/control chars (Excel/Sheets injection).
const FORMULA_LIKE = /^[\s\u0000-\u001f\u007f]*[=+\-@]/;

// Reversible escape: neutralize spreadsheet formula injection without losing literal apostrophes.
// - formula-like values get one leading apostrophe on disk
// - values that already start with "'" get a second apostrophe so unescape can restore them
function esc(v) {
  let s = String(v == null ? '' : v);
  if (FORMULA_LIKE.test(s) || s.startsWith("'")) s = "'" + s;
  if (/[",\n\r]/.test(s) || s.startsWith("'")) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function unescapeCell(v) {
  const s = String(v == null ? '' : v);
  if (!s.startsWith("'")) return s;
  const rest = s.slice(1);
  // Double leading apostrophe: first was our escape for a literal apostrophe value.
  if (rest.startsWith("'")) return rest;
  // Single apostrophe before formula-like content: restore the literal formula text.
  if (FORMULA_LIKE.test(rest)) return rest;
  return s;
}

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', i = 0, q = false;
  const push = () => { row.push(cell); cell = ''; };
  const end = () => { if (row.length || cell) { push(); rows.push(row); row = []; } };
  while (i < text.length) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
        q = false; i++; continue;
      }
      cell += c; i++; continue;
    }
    if (c === '"') { q = true; i++; continue; }
    if (c === ',') { push(); i++; continue; }
    if (c === '\n') { end(); i++; continue; }
    if (c === '\r') { i++; continue; }
    cell += c; i++;
  }
  end();
  return rows.filter(r => r.some(x => String(x || '').trim()));
}

function rowToObj(headers, cells) {
  const o = {};
  for (let i = 0; i < headers.length; i++) o[headers[i]] = unescapeCell(cells[i] == null ? '' : String(cells[i]));
  return o;
}

function objToRow(obj) {
  return HEADERS.map(h => esc(obj[h] ?? ''));
}

function isHttpUrl(value) {
  try {
    const u = new URL(String(value));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

function parseEvidence(evidence) {
  if (evidence == null) return null;
  if (typeof evidence === 'object' && !Array.isArray(evidence)) {
    const kind = String(evidence.kind || '').trim();
    const value = evidence.value != null ? String(evidence.value).trim()
      : evidence.message_id != null ? String(evidence.message_id).trim()
      : evidence.thread_id != null ? String(evidence.thread_id).trim()
      : evidence.url != null ? String(evidence.url).trim()
      : evidence.operator_confirmation != null ? String(evidence.operator_confirmation).trim()
      : '';
    const resolvedKind = EVIDENCE_KINDS.includes(kind) ? kind
      : evidence.message_id != null ? 'message_id'
      : evidence.thread_id != null ? 'thread_id'
      : evidence.url != null ? 'url'
      : evidence.operator_confirmation != null ? 'operator_confirmation'
      : '';
    if (!resolvedKind || !value) return null;
    return { kind: resolvedKind, value, explicit: evidence.explicit === true || evidence.operator_confirmed === true };
  }
  if (typeof evidence === 'string') {
    const raw = evidence.trim();
    const m = /^(message_id|thread_id|url|operator_confirmation)=(.+)$/i.exec(raw);
    if (m) return { kind: m[1].toLowerCase(), value: m[2].trim(), explicit: false };
    if (isHttpUrl(raw)) return { kind: 'url', value: raw, explicit: false };
    return null;
  }
  return null;
}

function validateEvidence(evidence) {
  const parsed = parseEvidence(evidence);
  if (!parsed) {
    const err = Error('Typed evidence required: {kind: message_id|thread_id|url|operator_confirmation, value}. Arbitrary text is not evidence.');
    err.code = 'evidence_required';
    throw err;
  }
  if (parsed.kind === 'url') {
    if (!isHttpUrl(parsed.value)) {
      const err = Error('Evidence url must be an http(s) URL');
      err.code = 'evidence_invalid';
      throw err;
    }
  } else if (parsed.kind === 'message_id' || parsed.kind === 'thread_id') {
    if (!/^[A-Za-z0-9_.:-]{6,200}$/.test(parsed.value)) {
      const err = Error('Evidence id must be a nonempty message/thread identifier');
      err.code = 'evidence_invalid';
      throw err;
    }
  } else if (parsed.kind === 'operator_confirmation') {
    if (parsed.explicit !== true || parsed.value.length < 3 || parsed.value.length > 200) {
      const err = Error('operator_confirmation requires explicit:true and a short confirmation value');
      err.code = 'evidence_invalid';
      throw err;
    }
  }
  return parsed;
}

function normalizeEvidence(evidence) {
  const parsed = validateEvidence(evidence);
  return `${parsed.kind}=${parsed.value}`;
}

function hasIdentifiableEvidence(evidence) {
  try { validateEvidence(evidence); return true; }
  catch { return false; }
}

function localDateString(timezone) {
  try {
    if (timezone && timezone !== 'local') {
      return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    }
  } catch { /* fall through */ }
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function categorizeRecruiters(messages = []) {
  const out = [];
  for (const m of messages) {
    const from = String(m.from || m.sender || '').trim();
    const subject = String(m.subject || '');
    const snippet = String(m.snippet || m.body || '');
    const emailMatch = from.match(/[\w.+-]+@[\w.-]+\.\w+/);
    const email = emailMatch ? emailMatch[0].toLowerCase() : '';
    const blob = `${subject} ${snippet} ${from}`.toLowerCase();
    const score =
      (/\brecruiter\b|\btalent\b|\bhiring\b|\bopportunity\b|\binterview\b|\bapplication\b/.test(blob) ? 2 : 0) +
      (/\b(job|role|position|opening)\b/.test(blob) ? 1 : 0) +
      (email ? 1 : 0);
    if (score >= 2 && email) {
      out.push({
        email,
        from,
        subject,
        message_id: m.id || m.message_id || null,
        thread_id: m.threadId || m.thread_id || null,
        score,
        evidence: m.id || m.message_id ? `message_id=${m.id || m.message_id}` : ''
      });
    }
  }
  return { recruiters: out, fabricated: false };
}

function pathError(message, code = 'invalid_path') {
  const err = Error(message);
  err.code = code;
  throw err;
}

function assertNotSymlink(candidate, label = 'path') {
  try {
    if (fs.lstatSync(candidate).isSymbolicLink()) pathError(`${label} must not be a symlink`);
  } catch (e) {
    if (e.code === 'invalid_path') throw e;
    if (e.code !== 'ENOENT') pathError(`${label} refused`);
  }
}

function pinJobSearchRoot(dataDir) {
  const dataResolved = path.resolve(dataDir);
  assertNotSymlink(dataResolved, 'dataDir');
  if (!fs.existsSync(dataResolved) || !fs.lstatSync(dataResolved).isDirectory()) {
    pathError('dataDir must be an existing directory');
  }
  const dataReal = fs.realpathSync(dataResolved);
  const root = path.join(dataReal, 'job-search');
  if (fs.existsSync(root)) {
    assertNotSymlink(root, 'job-search root');
    const st = fs.lstatSync(root);
    if (!st.isDirectory()) pathError('job-search root must be a directory');
  } else {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  assertNotSymlink(root, 'job-search root');
  const rootReal = fs.realpathSync(root);
  if (rootReal !== root && rootReal !== path.join(dataReal, 'job-search')) {
    pathError('job-search root realpath escaped dataDir');
  }
  if (!rootReal.startsWith(dataReal + path.sep)) pathError('job-search root must remain inside dataDir');
  return rootReal;
}

function exclusiveWrite(dirReal, basenameHint, bytes) {
  const safeBase = String(basenameHint).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'tracker';
  const name = `.${safeBase}.${crypto.randomBytes(12).toString('hex')}.tmp`;
  const full = path.join(dirReal, name);
  if (!full.startsWith(dirReal + path.sep)) pathError('temporary path escaped job-search root');
  if (fs.existsSync(full)) pathError('temporary path collision');
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
  const fd = fs.openSync(full, flags, 0o600);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1) pathError('temporary file identity refused');
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return full;
}

function createJobSearchManager({ dataDir, audit, actor = 'operator', policy = null } = {}) {
  if (!dataDir) throw Error('dataDir required');
  const root = pinJobSearchRoot(dataDir);
  const statePath = path.join(root, 'manager.json');
  const defaultPath = path.join(root, TRACKER_NAME);

  function liveStanding() {
    try {
      if (typeof policy?.allowsLocalTrackerUpdates === 'function') return policy.allowsLocalTrackerUpdates() === true;
    } catch { /* fail closed */ }
    return false;
  }

  function currentTrackerPath() {
    try {
      const st = loadState();
      return assertInsideRoot(st.path || defaultPath);
    } catch (e) {
      if (e.code === 'state_hold' || e.code === 'invalid_path') throw e;
      return defaultPath;
    }
  }

  function authorizeMutation(action, input = {}) {
    const standing = liveStanding();
    const approvalId = input.host_approval_id != null ? String(input.host_approval_id).trim() : '';
    // operator_confirmation is typed manual evidence (a claim), never an approval token.
    // Authorization is standing grant or a separately reviewed host_approval_id.
    let confirmation = null;
    try {
      confirmation = input.evidence != null ? parseEvidence(input.evidence) : null;
    } catch { confirmation = null; }
    if (confirmation && confirmation.kind === 'operator_confirmation') {
      if (standing) {
        confirmation.verification = 'standing_manual_claim';
      } else if (approvalId) {
        confirmation.verification = 'host_reviewed_manual_claim';
      } else {
        const err = Error('operator_confirmation evidence requires standing authorization or a reviewed host_approval_id');
        err.code = 'forged_operator_confirmation';
        throw err;
      }
    }
    if (standing) return { mode: 'standing', standing: true, approval_id: null, commit: null, fail: null };
    if (!approvalId || typeof policy?.prepareApproval !== 'function' || typeof policy?.buildMutationPayload !== 'function') {
      const err = Error('Tracker mutation requires current standing authorization or an approved host proposal');
      err.code = 'mutation_authorization_required';
      throw err;
    }
    const trackerPath = currentTrackerPath();
    const built = policy.buildMutationPayload(action, input, trackerPath);
    const prepared = policy.prepareApproval(approvalId, action, {
      digest: built.digest,
      trackerPath,
      requestId: built.payload.request_id,
      payload: built.payload
    });
    if (!prepared || prepared.ok !== true) {
      const err = Error('Host per-action approval missing, expired, or not approved');
      err.code = 'mutation_authorization_required';
      throw err;
    }
    return {
      mode: 'host_approval',
      standing: false,
      approval_id: prepared.approval_id,
      payload_digest: prepared.payload_digest,
      commit: () => policy.commitApproval(prepared.approval_id),
      fail: (reason) => policy.failApproval(prepared.approval_id, reason)
    };
  }

  function withMutationAuth(action, input, run) {
    const auth = authorizeMutation(action, input);
    try {
      const result = run(auth);
      if (typeof auth.commit === 'function') auth.commit();
      return result;
    } catch (e) {
      if (typeof auth.fail === 'function') auth.fail(e.code || e.message || 'mutation_failed');
      throw e;
    }
  }

  function assertInsideRoot(candidate) {
    const resolved = path.resolve(candidate);
    const rootReal = root;
    let targetReal;
    try {
      if (fs.existsSync(resolved)) {
        assertNotSymlink(resolved, 'Tracker path');
        targetReal = fs.realpathSync(resolved);
      } else {
        const parent = path.dirname(resolved);
        if (!fs.existsSync(parent)) pathError('Tracker parent directory must exist inside job-search root');
        assertNotSymlink(parent, 'Tracker parent');
        targetReal = path.join(fs.realpathSync(parent), path.basename(resolved));
      }
    } catch (e) {
      if (e.code === 'invalid_path') throw e;
      pathError('Tracker path refused');
    }
    if (targetReal !== path.join(rootReal, TRACKER_NAME) && !targetReal.startsWith(rootReal + path.sep)) {
      pathError('Tracker path must remain inside the selected job-search directory');
    }
    if (path.basename(targetReal) !== TRACKER_NAME && path.extname(targetReal) !== '.csv') {
      pathError('Tracker file must be applications.csv (CSV, Excel-openable)');
    }
    return targetReal;
  }

  function loadState() {
    if (!fs.existsSync(statePath)) return { path: defaultPath, created_at: null };
    assertNotSymlink(statePath, 'manager.json');
    let raw;
    try {
      const fd = fs.openSync(statePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const opened = fs.fstatSync(fd);
        if (!opened.isFile() || opened.nlink !== 1) pathError('manager.json identity refused');
        raw = JSON.parse(fs.readFileSync(fd, 'utf8'));
      } finally {
        fs.closeSync(fd);
      }
    } catch (e) {
      if (e.code === 'invalid_path') throw e;
      const err = Error('job-search manager state is HOLD — unreadable or tampered manager.json');
      err.code = 'state_hold';
      throw err;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      const err = Error('job-search manager state is HOLD — malformed manager.json');
      err.code = 'state_hold';
      throw err;
    }
    try {
      raw.path = assertInsideRoot(raw.path || defaultPath);
      return raw;
    } catch (e) {
      if (e.code === 'invalid_path') {
        const err = Error('job-search manager state is HOLD — tracker path refused');
        err.code = 'state_hold';
        throw err;
      }
      throw e;
    }
  }

  function saveState(st) {
    st.path = assertInsideRoot(st.path || defaultPath);
    if (fs.existsSync(statePath)) assertNotSymlink(statePath, 'manager.json');
    const bytes = Buffer.from(JSON.stringify(st, null, 2) + '\n', 'utf8');
    const tmp = exclusiveWrite(root, 'manager.json', bytes);
    try {
      if (fs.existsSync(statePath)) assertNotSymlink(statePath, 'manager.json');
      fs.renameSync(tmp, statePath);
      try { fs.chmodSync(statePath, 0o600); } catch { /* */ }
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* */ }
      throw e;
    }
  }

  function ensureWorkbook(st) {
    st.path = assertInsideRoot(st.path || defaultPath);
    const parent = path.dirname(st.path);
    if (!fs.existsSync(parent)) {
      fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    }
    assertNotSymlink(parent, 'Tracker parent');
    if (!fs.existsSync(st.path)) {
      const body = Buffer.from(HEADERS.join(',') + '\n', 'utf8');
      const tmp = exclusiveWrite(root, TRACKER_NAME, body);
      try {
        st.path = assertInsideRoot(st.path);
        assertNotSymlink(st.path, 'Tracker path');
        fs.renameSync(tmp, st.path);
      } catch (e) {
        try { fs.unlinkSync(tmp); } catch { /* */ }
        throw e;
      }
      try { fs.chmodSync(st.path, 0o600); } catch { /* */ }
    } else {
      assertNotSymlink(st.path, 'Tracker path');
    }
  }

  function readRows(st) {
    ensureWorkbook(st);
    assertNotSymlink(st.path, 'Tracker path');
    const fd = fs.openSync(st.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let text;
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile()) pathError('Tracker path must be a regular file');
      text = fs.readFileSync(fd, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
    const rows = parseCsv(text);
    if (!rows.length) return [];
    const headers = rows[0].map(h => String(h).trim());
    return rows.slice(1).map(r => rowToObj(headers.length === HEADERS.length ? headers : HEADERS, r));
  }

  function writeRows(st, rows) {
    st.path = assertInsideRoot(st.path);
    ensureWorkbook(st);
    assertNotSymlink(st.path, 'Tracker path');
    const dirReal = root;
    const body = Buffer.from(
      [HEADERS.join(',')].concat(rows.map(r => objToRow(r).join(','))).join('\n') + '\n',
      'utf8'
    );

    // Safe backup under an unpredictable name only. Never touch fixed .bak/.tmp paths or delete unexpected links.
    let srcFd;
    try {
      srcFd = fs.openSync(st.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const srcStat = fs.fstatSync(srcFd);
      if (!srcStat.isFile()) pathError('Tracker path must be a regular file');
      if (srcStat.size > 0) {
        const prior = fs.readFileSync(srcFd);
        const bakTmp = exclusiveWrite(dirReal, path.basename(st.path) + '.bak', prior);
        const bakFinal = path.join(dirReal, `.${path.basename(st.path)}.${crypto.randomBytes(10).toString('hex')}.bak`);
        if (!bakFinal.startsWith(dirReal + path.sep)) {
          try { fs.unlinkSync(bakTmp); } catch { /* */ }
          pathError('backup path escaped job-search root');
        }
        try {
          fs.renameSync(bakTmp, bakFinal);
          try { fs.chmodSync(bakFinal, 0o600); } catch { /* */ }
        } catch (e) {
          try { fs.unlinkSync(bakTmp); } catch { /* */ }
          throw e;
        }
      }
    } finally {
      if (srcFd != null) try { fs.closeSync(srcFd); } catch { /* */ }
    }

    const tmp = exclusiveWrite(dirReal, path.basename(st.path), body);
    try {
      st.path = assertInsideRoot(st.path);
      if (fs.existsSync(st.path)) assertNotSymlink(st.path, 'Tracker path');
      fs.renameSync(tmp, st.path);
      try { fs.chmodSync(st.path, 0o600); } catch { /* */ }
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* */ }
      throw e;
    }
  }

  function log(type, detail) {
    try { audit?.append?.(type, { ...detail, actor }); } catch { /* best effort */ }
  }

  return {
    status(who = actor) {
      const st = loadState();
      const active = !!st.created_at && fs.existsSync(st.path);
      let count = 0;
      try { if (active) count = readRows(st).length; } catch { /* */ }
      // Effective standing always derives from current host policy (fail closed on expiry).
      const standing = liveStanding();
      if (st.standing_local_updates !== standing) {
        st.standing_local_updates = standing;
        try { saveState(st); } catch { /* best effort sync */ }
      }
      return {
        active,
        path: st.path,
        format: 'csv_excel_openable_not_xlsx',
        applications: count,
        standing_local_updates: standing,
        actor: who
      };
    },

    createTracker({ trackerPath } = {}) {
      const st = loadState();
      if (trackerPath) st.path = assertInsideRoot(trackerPath);
      else st.path = defaultPath;
      ensureWorkbook(st);
      st.created_at = st.created_at || new Date().toISOString();
      st.standing_local_updates = liveStanding();
      saveState(st);
      log('job_search.tracker_created', { path: st.path, standing: st.standing_local_updates });
      return { ok: true, ...this.status() };
    },

    list() {
      const st = loadState();
      if (!st.created_at) return { applications: [], status: this.status() };
      return { applications: readRows(st), status: this.status() };
    },

    upsertApplication(input = {}) {
      // Validate before reserving a one-shot approval so rejected inputs do not burn consent.
      const evidence = normalizeEvidence(input.evidence);
      const company = String(input.company || '').trim();
      const role = String(input.role || '').trim();
      if (!company || !role) {
        const err = Error('company and role are required');
        err.code = 'invalid_application';
        throw err;
      }
      const st = loadState();
      if (!st.created_at) this.createTracker();
      const rows = readRows(st);
      const posting = String(input.posting_url || '').trim();
      if (posting && !isHttpUrl(posting)) {
        const err = Error('posting_url must be an http(s) URL when provided');
        err.code = 'invalid_application';
        throw err;
      }
      const recruiter = String(input.recruiter_email || '').trim().toLowerCase();
      const existing = rows.find(r =>
        (input.id && r.id === input.id) ||
        (posting && r.posting_url === posting) ||
        (r.company.toLowerCase() === company.toLowerCase() && r.role.toLowerCase() === role.toLowerCase() && (!recruiter || r.recruiter_email === recruiter))
      );
      const status = existing
        ? (STATUSES.includes(input.status) ? input.status : existing.status)
        : (STATUSES.includes(input.status) ? input.status : 'discovered');
      const applied_at = input.applied_at != null && String(input.applied_at).trim() ? String(input.applied_at).trim() : '';
      if (!existing && status === 'applied' && !applied_at) {
        const err = Error('applied status requires explicit applied_at date');
        err.code = 'invalid_application';
        throw err;
      }
      return withMutationAuth('upsert', input, (auth) => {
        const now = new Date().toISOString();
        const gate = { mode: auth.mode, standing: auth.standing, approval_id: auth.approval_id || null, payload_digest: auth.payload_digest || null };
        if (existing) {
          existing.company = company;
          existing.role = role;
          existing.source = String(input.source || existing.source || 'operator').trim();
          existing.status = status;
          if (applied_at) existing.applied_at = applied_at;
          if (recruiter) existing.recruiter_email = recruiter;
          if (posting) existing.posting_url = posting;
          existing.evidence = evidence;
          if (input.follow_up_at) existing.follow_up_at = String(input.follow_up_at);
          if (input.notes) existing.notes = String(input.notes).slice(0, 2000);
          existing.updated_at = now;
          writeRows(st, rows);
          log('job_search.application_updated', { id: existing.id, company, role, status: existing.status, auth_mode: auth.mode });
          return { ok: true, duplicate: true, application: existing, status: this.status(), mutation_gate: gate };
        }
        const app = {
          id: crypto.randomBytes(6).toString('hex'),
          company, role,
          source: String(input.source || 'operator').trim(),
          status,
          applied_at,
          recruiter_email: recruiter,
          posting_url: posting,
          evidence,
          follow_up_at: String(input.follow_up_at || ''),
          notes: String(input.notes || '').slice(0, 2000),
          updated_at: now
        };
        rows.push(app);
        writeRows(st, rows);
        log('job_search.application_created', { id: app.id, company, role, status, auth_mode: auth.mode });
        return { ok: true, duplicate: false, application: app, status: this.status(), mutation_gate: gate };
      });
    },

    recordFollowUp(input = {}) {
      const { id, company, role, follow_up_at, notes, evidence } = input;
      if (evidence == null) {
        const err = Error('Typed evidence required for follow-up (no automatic operator_confirmation)');
        err.code = 'evidence_required';
        throw err;
      }
      const e = normalizeEvidence(evidence);
      if (!String(follow_up_at || '').trim()) {
        const err = Error('follow_up_at required');
        err.code = 'invalid_application';
        throw err;
      }
      const st = loadState();
      const rows = readRows(st);
      const row = rows.find(r =>
        (id && r.id === id) ||
        (company && role && r.company.toLowerCase() === String(company).toLowerCase() && r.role.toLowerCase() === String(role).toLowerCase())
      );
      if (!row) {
        const err = Error('Application not found');
        err.code = 'not_found';
        throw err;
      }
      return withMutationAuth('follow_up', input, (auth) => {
        row.follow_up_at = String(follow_up_at);
        if (row.status === 'discovered') row.status = 'follow_up';
        if (notes) row.notes = (row.notes ? row.notes + ' | ' : '') + String(notes).slice(0, 500);
        row.evidence = e;
        row.updated_at = new Date().toISOString();
        writeRows(st, rows);
        log('job_search.follow_up', { id: row.id, follow_up_at: row.follow_up_at, auth_mode: auth.mode });
        return {
          ok: true,
          application: row,
          mutation_gate: { mode: auth.mode, standing: auth.standing, approval_id: auth.approval_id || null, payload_digest: auth.payload_digest || null }
        };
      });
    },

    dailyDigest({ timezone = 'local' } = {}) {
      const st = loadState();
      if (!st.created_at) {
        return {
          message: 'No job-search tracker yet. Create a local tracker first (CSV, Excel-openable — not an .xlsx workbook).',
          applications: 0,
          follow_ups_due: [],
          by_status: {},
          fabricated: false,
          timezone
        };
      }
      const rows = readRows(st);
      const by_status = {};
      for (const r of rows) by_status[r.status || 'unknown'] = (by_status[r.status || 'unknown'] || 0) + 1;
      const today = localDateString(timezone);
      const follow_ups_due = rows.filter(r => r.follow_up_at && r.follow_up_at.slice(0, 10) <= today);
      const recent = [...rows].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))).slice(0, 8);
      const lines = [
        `Job search digest (${timezone === 'local' ? 'local' : timezone}; date ${today}): ${rows.length} tracked application(s).`,
        `By status: ${Object.entries(by_status).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}.`,
        follow_ups_due.length
          ? `Follow-ups due: ${follow_ups_due.map(r => `${r.company}/${r.role} (${r.follow_up_at})`).join('; ')}.`
          : 'No follow-ups due today.',
        recent.length
          ? `Recent updates (evidence-grounded only):\n` + recent.map(r =>
            `- ${r.company} — ${r.role} [${r.status}] evidence=${(r.evidence || '').slice(0, 80)}`).join('\n')
          : 'No applications yet.',
        'Nothing here is invented. Empty means no evidence-backed entries. Tracker format is CSV (Excel-openable), not .xlsx.'
      ];
      return {
        message: lines.join('\n'),
        applications: rows.length,
        follow_ups_due,
        by_status,
        recent,
        fabricated: false,
        path: st.path,
        timezone,
        local_date: today
      };
    },

    categorizeRecruiters(messages = []) {
      return categorizeRecruiters(messages);
    },

    prepareMaterials({ company, role, evidence } = {}) {
      let e;
      try { e = normalizeEvidence(evidence); }
      catch {
        return {
          ok: false,
          message: 'Need company, role, and typed identifiable evidence before preparing materials. No fabricated resume content.',
          drafts: []
        };
      }
      if (!company || !role) {
        return { ok: false, message: 'Need company and role.', drafts: [] };
      }
      return {
        ok: true,
        message: `Draft checklist for ${company} — ${role} (evidence: ${e.slice(0, 120)}). Owner must review before any send.`,
        drafts: [
          { kind: 'cover_letter_outline', content: `Outline only: Why ${company} / ${role}; relevant evidence; ask for next step. Do not send without confirmation.` },
          { kind: 'talking_points', content: `Talking points grounded in stated role "${role}" only — no invented experience.` }
        ],
        never_auto_send: true
      };
    },

    suggestCalendarEvent({ company, role, when, timezone, evidence } = {}) {
      let e;
      try { e = normalizeEvidence(evidence); }
      catch {
        return { ok: false, message: 'Typed evidence required before suggesting a calendar event.', suggestion: null };
      }
      const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
      return {
        ok: true,
        message: 'Calendar connector is NOT_SUPPORTED in V1. Local suggestion only — no invite sent, no attendees added.',
        suggestion: {
          title: `Interview / follow-up: ${company || 'Company'} — ${role || 'Role'}`,
          when: when || null,
          timezone: tz,
          attendees: [],
          invite_sent: false,
          evidence: e
        },
        never_auto_invite: true
      };
    },

    setStandingLocalUpdates(enabled) {
      // Informational sync only — effective authority always comes from liveStanding().
      const st = loadState();
      st.standing_local_updates = liveStanding();
      if (enabled === true && !st.standing_local_updates) {
        st.standing_local_updates = false;
      }
      saveState(st);
      log('job_search.standing_local_updates', { enabled: st.standing_local_updates, requested: enabled === true });
      return this.status();
    },

    HEADERS,
    STATUSES,
    root
  };
}

module.exports = {
  createJobSearchManager,
  categorizeRecruiters,
  hasIdentifiableEvidence,
  normalizeEvidence,
  validateEvidence,
  parseEvidence,
  esc,
  unescapeCell,
  localDateString,
  HEADERS,
  STATUSES,
  EVIDENCE_KINDS,
  TRACKER_NAME
};
