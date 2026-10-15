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

// Neutralize spreadsheet formula injection while keeping the literal value on read.
function esc(v) {
  let s = String(v == null ? '' : v);
  // Strip formula-triggering prefixes after leading whitespace/control chars.
  if (/^[\s\u0000-\u001f\u007f]*[=+\-@]/.test(s)) s = "'" + s;
  if (/[",\n\r]/.test(s) || s.startsWith("'")) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function unescapeCell(v) {
  const s = String(v == null ? '' : v);
  return s.startsWith("'") && /^'?[\s\u0000-\u001f\u007f]*[=+\-@]/.test(s.slice(1)) ? s.slice(1) : s;
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

function createJobSearchManager({ dataDir, audit, actor = 'operator' } = {}) {
  if (!dataDir) throw Error('dataDir required');
  const root = path.resolve(dataDir, 'job-search');
  const statePath = path.join(root, 'manager.json');
  const defaultPath = path.join(root, TRACKER_NAME);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });

  function assertInsideRoot(candidate) {
    const resolved = path.resolve(candidate);
    const rootReal = fs.realpathSync(root);
    let targetReal;
    try {
      if (fs.existsSync(resolved)) {
        const st = fs.lstatSync(resolved);
        if (st.isSymbolicLink()) {
          const err = Error('Tracker path must not be a symlink');
          err.code = 'invalid_path';
          throw err;
        }
        targetReal = fs.realpathSync(resolved);
      } else {
        const parent = path.dirname(resolved);
        if (!fs.existsSync(parent)) {
          const err = Error('Tracker parent directory must exist inside job-search root');
          err.code = 'invalid_path';
          throw err;
        }
        const parentSt = fs.lstatSync(parent);
        if (parentSt.isSymbolicLink()) {
          const err = Error('Tracker parent must not be a symlink');
          err.code = 'invalid_path';
          throw err;
        }
        targetReal = path.join(fs.realpathSync(parent), path.basename(resolved));
      }
    } catch (e) {
      if (e.code === 'invalid_path') throw e;
      const err = Error('Tracker path refused');
      err.code = 'invalid_path';
      throw err;
    }
    if (targetReal !== path.join(rootReal, TRACKER_NAME) && !targetReal.startsWith(rootReal + path.sep)) {
      const err = Error('Tracker path must remain inside the selected job-search directory');
      err.code = 'invalid_path';
      throw err;
    }
    if (path.basename(targetReal) !== TRACKER_NAME && path.extname(targetReal) !== '.csv') {
      const err = Error('Tracker file must be applications.csv (CSV, Excel-openable)');
      err.code = 'invalid_path';
      throw err;
    }
    return targetReal;
  }

  function loadState() {
    try {
      const st = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      st.path = assertInsideRoot(st.path || defaultPath);
      return st;
    } catch (e) {
      if (e.code === 'invalid_path') throw e;
      return { path: defaultPath, created_at: null };
    }
  }

  function saveState(st) {
    st.path = assertInsideRoot(st.path || defaultPath);
    fs.writeFileSync(statePath, JSON.stringify(st, null, 2) + '\n', { mode: 0o600 });
  }

  function ensureWorkbook(st) {
    st.path = assertInsideRoot(st.path || defaultPath);
    if (!fs.existsSync(st.path)) {
      fs.mkdirSync(path.dirname(st.path), { recursive: true, mode: 0o700 });
      fs.writeFileSync(st.path, HEADERS.join(',') + '\n', { mode: 0o600 });
    } else {
      const stStat = fs.lstatSync(st.path);
      if (stStat.isSymbolicLink()) {
        const err = Error('Tracker path must not be a symlink');
        err.code = 'invalid_path';
        throw err;
      }
    }
  }

  function readRows(st) {
    ensureWorkbook(st);
    const text = fs.readFileSync(st.path, 'utf8');
    const rows = parseCsv(text);
    if (!rows.length) return [];
    const headers = rows[0].map(h => String(h).trim());
    return rows.slice(1).map(r => rowToObj(headers.length === HEADERS.length ? headers : HEADERS, r));
  }

  function writeRows(st, rows) {
    st.path = assertInsideRoot(st.path);
    ensureWorkbook(st);
    // Preserve prior content as a same-directory backup before replace.
    if (fs.existsSync(st.path) && fs.statSync(st.path).size > 0) {
      const backup = st.path + '.bak';
      fs.copyFileSync(st.path, backup);
      try { fs.chmodSync(backup, 0o600); } catch { /* */ }
    }
    const body = [HEADERS.join(',')].concat(rows.map(r => objToRow(r).join(','))).join('\n') + '\n';
    const tmp = st.path + '.tmp';
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    fs.renameSync(tmp, st.path);
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
      return {
        active,
        path: st.path,
        format: 'csv_excel_openable_not_xlsx',
        applications: count,
        standing_local_updates: !!st.standing_local_updates,
        actor: who
      };
    },

    createTracker({ trackerPath, standingLocalUpdates = false } = {}) {
      const st = loadState();
      if (trackerPath) st.path = assertInsideRoot(trackerPath);
      else st.path = defaultPath;
      ensureWorkbook(st);
      st.created_at = st.created_at || new Date().toISOString();
      st.standing_local_updates = standingLocalUpdates === true;
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
      let existing = rows.find(r =>
        (input.id && r.id === input.id) ||
        (posting && r.posting_url === posting) ||
        (r.company.toLowerCase() === company.toLowerCase() && r.role.toLowerCase() === role.toLowerCase() && (!recruiter || r.recruiter_email === recruiter))
      );
      const now = new Date().toISOString();
      if (existing) {
        // Preserve higher-progress status unless the caller supplies an explicit valid status.
        const nextStatus = STATUSES.includes(input.status) ? input.status : existing.status;
        existing.company = company;
        existing.role = role;
        existing.source = String(input.source || existing.source || 'operator').trim();
        existing.status = nextStatus;
        if (input.applied_at != null && String(input.applied_at).trim()) existing.applied_at = String(input.applied_at).trim();
        if (recruiter) existing.recruiter_email = recruiter;
        if (posting) existing.posting_url = posting;
        existing.evidence = evidence;
        if (input.follow_up_at) existing.follow_up_at = String(input.follow_up_at);
        if (input.notes) existing.notes = String(input.notes).slice(0, 2000);
        existing.updated_at = now;
        writeRows(st, rows);
        log('job_search.application_updated', { id: existing.id, company, role, status: existing.status });
        return { ok: true, duplicate: true, application: existing, status: this.status() };
      }
      const status = STATUSES.includes(input.status) ? input.status : 'discovered';
      // Do not invent applied_at; require explicit date when applying.
      const applied_at = input.applied_at != null && String(input.applied_at).trim() ? String(input.applied_at).trim() : '';
      if (status === 'applied' && !applied_at) {
        const err = Error('applied status requires explicit applied_at date');
        err.code = 'invalid_application';
        throw err;
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
      log('job_search.application_created', { id: app.id, company, role, status });
      return { ok: true, duplicate: false, application: app, status: this.status() };
    },

    recordFollowUp({ id, company, role, follow_up_at, notes, evidence } = {}) {
      if (evidence == null) {
        const err = Error('Typed evidence required for follow-up (no automatic operator_confirmation)');
        err.code = 'evidence_required';
        throw err;
      }
      const e = normalizeEvidence(evidence);
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
      row.follow_up_at = String(follow_up_at || '');
      if (!row.follow_up_at) {
        const err = Error('follow_up_at required');
        err.code = 'invalid_application';
        throw err;
      }
      // Preserve applied/interview/etc.; only promote discovered → follow_up.
      if (row.status === 'discovered') row.status = 'follow_up';
      if (notes) row.notes = (row.notes ? row.notes + ' | ' : '') + String(notes).slice(0, 500);
      row.evidence = e;
      row.updated_at = new Date().toISOString();
      writeRows(st, rows);
      log('job_search.follow_up', { id: row.id, follow_up_at: row.follow_up_at });
      return { ok: true, application: row };
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
      const st = loadState();
      st.standing_local_updates = enabled === true;
      saveState(st);
      log('job_search.standing_local_updates', { enabled: enabled === true });
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
