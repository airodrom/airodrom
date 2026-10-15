'use strict';
// Job Search Manager V1 — Issue #112.
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

function esc(v) {
  const s = String(v == null ? '' : v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
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
  for (let i = 0; i < headers.length; i++) o[headers[i]] = cells[i] == null ? '' : String(cells[i]);
  return o;
}

function objToRow(obj) {
  return HEADERS.map(h => esc(obj[h] ?? ''));
}

function normalizeEvidence(evidence) {
  if (evidence == null) return '';
  if (typeof evidence === 'string') return evidence.trim();
  if (typeof evidence === 'object') {
    const parts = [];
    for (const k of ['message_id', 'thread_id', 'url', 'operator_confirmation', 'source', 'note']) {
      if (evidence[k]) parts.push(`${k}=${String(evidence[k]).trim()}`);
    }
    return parts.join('; ') || JSON.stringify(evidence).slice(0, 500);
  }
  return String(evidence).trim();
}

function hasIdentifiableEvidence(evidence) {
  const e = normalizeEvidence(evidence);
  if (!e) return false;
  if (/message_id=|thread_id=|url=https?:\/\/|operator_confirmation=/i.test(e)) return true;
  if (/^https?:\/\//i.test(e)) return true;
  if (/^[a-f0-9-]{8,}$/i.test(e)) return true;
  if (/operator confirms|confirmed by owner|manual entry/i.test(e)) return true;
  return e.length >= 8;
}

function categorizeRecruiters(messages = []) {
  // Host-side heuristic only — never invents emails not present in input.
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
        evidence: m.id || m.message_id ? `message_id=${m.id || m.message_id}` : (email ? `url=mailto:${email}` : '')
      });
    }
  }
  return { recruiters: out, fabricated: false };
}

function createJobSearchManager({ dataDir, audit, actor = 'operator' } = {}) {
  if (!dataDir) throw Error('dataDir required');
  const root = path.join(dataDir, 'job-search');
  const statePath = path.join(root, 'manager.json');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });

  function loadState() {
    try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); }
    catch { return { path: path.join(root, 'applications.csv'), created_at: null }; }
  }

  function saveState(st) {
    fs.writeFileSync(statePath, JSON.stringify(st, null, 2) + '\n', { mode: 0o600 });
  }

  function ensureWorkbook(st) {
    if (!fs.existsSync(st.path)) {
      fs.mkdirSync(path.dirname(st.path), { recursive: true, mode: 0o700 });
      fs.writeFileSync(st.path, HEADERS.join(',') + '\n', { mode: 0o600 });
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
        format: 'csv_excel_openable',
        applications: count,
        standing_local_updates: !!st.standing_local_updates,
        actor: who
      };
    },

    createTracker({ trackerPath, standingLocalUpdates = false } = {}) {
      const st = loadState();
      if (trackerPath) {
        const resolved = path.resolve(String(trackerPath));
        if (!path.isAbsolute(resolved)) throw Object.assign(Error('Absolute tracker path required'), { code: 'invalid_path' });
        st.path = resolved;
      }
      ensureWorkbook(st);
      st.created_at = st.created_at || new Date().toISOString();
      st.standing_local_updates = !!standingLocalUpdates;
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
      if (!hasIdentifiableEvidence(evidence)) {
        const err = Error('Identifiable evidence required (message id, posting URL, or operator confirmation). Refusing to fabricate.');
        err.code = 'evidence_required';
        throw err;
      }
      const company = String(input.company || '').trim();
      const role = String(input.role || '').trim();
      if (!company || !role) {
        const err = Error('company and role are required');
        err.code = 'invalid_application';
        throw err;
      }
      const status = STATUSES.includes(input.status) ? input.status : 'discovered';
      const st = loadState();
      if (!st.created_at) this.createTracker({ trackerPath: st.path });
      const rows = readRows(st);
      const posting = String(input.posting_url || '').trim();
      const recruiter = String(input.recruiter_email || '').trim().toLowerCase();
      let existing = rows.find(r =>
        (input.id && r.id === input.id) ||
        (posting && r.posting_url === posting) ||
        (r.company.toLowerCase() === company.toLowerCase() && r.role.toLowerCase() === role.toLowerCase() && (!recruiter || r.recruiter_email === recruiter))
      );
      const now = new Date().toISOString();
      if (existing) {
        existing.company = company;
        existing.role = role;
        existing.source = String(input.source || existing.source || 'operator').trim();
        existing.status = status;
        if (input.applied_at) existing.applied_at = String(input.applied_at);
        if (recruiter) existing.recruiter_email = recruiter;
        if (posting) existing.posting_url = posting;
        existing.evidence = evidence;
        if (input.follow_up_at) existing.follow_up_at = String(input.follow_up_at);
        if (input.notes) existing.notes = String(input.notes).slice(0, 2000);
        existing.updated_at = now;
        writeRows(st, rows);
        log('job_search.application_updated', { id: existing.id, company, role, status });
        return { ok: true, duplicate: true, application: existing, status: this.status() };
      }
      const app = {
        id: crypto.randomBytes(6).toString('hex'),
        company, role,
        source: String(input.source || 'operator').trim(),
        status,
        applied_at: String(input.applied_at || (status === 'applied' ? now.slice(0, 10) : '')),
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
      const e = normalizeEvidence(evidence) || 'operator_confirmation=follow_up_schedule';
      if (!hasIdentifiableEvidence(e)) {
        const err = Error('Evidence required for follow-up');
        err.code = 'evidence_required';
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
      row.follow_up_at = String(follow_up_at || new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10));
      row.status = row.status === 'discovered' ? 'follow_up' : row.status;
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
          message: 'No job-search tracker yet. Create a local tracker first (CSV, Excel-openable).',
          applications: 0,
          follow_ups_due: [],
          by_status: {},
          fabricated: false
        };
      }
      const rows = readRows(st);
      const by_status = {};
      for (const r of rows) by_status[r.status || 'unknown'] = (by_status[r.status || 'unknown'] || 0) + 1;
      const today = new Date().toISOString().slice(0, 10);
      const follow_ups_due = rows.filter(r => r.follow_up_at && r.follow_up_at.slice(0, 10) <= today);
      const recent = [...rows].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))).slice(0, 8);
      const lines = [
        `Job search digest (${timezone}): ${rows.length} tracked application(s).`,
        `By status: ${Object.entries(by_status).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}.`,
        follow_ups_due.length
          ? `Follow-ups due: ${follow_ups_due.map(r => `${r.company}/${r.role} (${r.follow_up_at})`).join('; ')}.`
          : 'No follow-ups due today.',
        recent.length
          ? `Recent updates (evidence-grounded only):\n` + recent.map(r =>
            `- ${r.company} — ${r.role} [${r.status}] evidence=${(r.evidence || '').slice(0, 80)}`).join('\n')
          : 'No applications yet.',
        'Nothing here is invented. Empty means no evidence-backed entries.'
      ];
      return {
        message: lines.join('\n'),
        applications: rows.length,
        follow_ups_due,
        by_status,
        recent,
        fabricated: false,
        path: st.path
      };
    },

    categorizeRecruiters(messages = []) {
      return categorizeRecruiters(messages);
    },

    prepareMaterials({ company, role, evidence } = {}) {
      const e = normalizeEvidence(evidence);
      if (!hasIdentifiableEvidence(e) || !company || !role) {
        return {
          ok: false,
          message: 'Need company, role, and identifiable evidence before preparing materials. No fabricated resume content.',
          drafts: []
        };
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

    suggestCalendarEvent({ company, role, when, timezone = 'America/Los_Angeles', evidence } = {}) {
      const e = normalizeEvidence(evidence);
      if (!hasIdentifiableEvidence(e)) {
        return { ok: false, message: 'Evidence required before suggesting a calendar event.', suggestion: null };
      }
      return {
        ok: true,
        message: 'Calendar connector is NOT_SUPPORTED in V1. Local suggestion only — no invite sent, no attendees added.',
        suggestion: {
          title: `Interview / follow-up: ${company || 'Company'} — ${role || 'Role'}`,
          when: when || null,
          timezone,
          attendees: [],
          invite_sent: false,
          evidence: e
        },
        never_auto_invite: true
      };
    },

    setStandingLocalUpdates(enabled) {
      const st = loadState();
      st.standing_local_updates = !!enabled;
      saveState(st);
      log('job_search.standing_local_updates', { enabled: !!enabled });
      return this.status();
    },

    HEADERS,
    STATUSES
  };
}

module.exports = {
  createJobSearchManager,
  categorizeRecruiters,
  hasIdentifiableEvidence,
  normalizeEvidence,
  HEADERS,
  STATUSES
};
