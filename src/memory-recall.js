'use strict';
// Deterministic host recall query normalization — Issue #112 review.
// Narrow compound phrases only. Does not broaden FTS generally or leak sensitive Memory.

const COMPOUND = Object.freeze({
  'job search': { primary: 'job', alternates: ['application', 'career', 'recruiter', 'interview'] },
  'job-search': { primary: 'job', alternates: ['application', 'career', 'recruiter', 'interview'] },
  'job hunting': { primary: 'job', alternates: ['application', 'career'] },
  applications: { primary: 'application', alternates: ['job'] }
});

function normalizeRecallQuery(query) {
  const raw = String(query || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!raw) return { query: '', primary: '', alternates: [], compound: false };
  const mapped = COMPOUND[raw];
  if (mapped) return { query: mapped.primary, primary: mapped.primary, alternates: mapped.alternates, compound: true, original: raw };
  return { query: raw, primary: raw, alternates: [], compound: false, original: raw };
}

function recall(server, query) {
  const norm = normalizeRecallQuery(query);
  const seen = new Set();
  const items = [];
  const push = (list) => {
    for (const m of list || []) {
      if (!m?.memoryId || seen.has(m.memoryId)) continue;
      if (m.sensitivity && m.sensitivity !== 'normal') continue;
      seen.add(m.memoryId);
      items.push(m);
    }
  };
  push(server.interactiveMemory(norm.query).items);
  if (norm.compound) {
    for (const alt of norm.alternates) push(server.interactiveMemory(alt).items);
  }
  // Host job-tracker summary is not Memory — attach as a separate non-authoritative note.
  let tracker_note = null;
  if (norm.compound || /\bjob\b|\bapplication\b|\bcareer\b/.test(norm.original || '')) {
    try {
      const manager = server.bridge?.jobSearchManager;
      if (manager) {
        const st = manager.status();
        tracker_note = st.active
          ? `Local job-search tracker is active (${st.applications} evidence-backed row(s); CSV Excel-openable, not .xlsx). Ask for a daily digest for details.`
          : 'No local job-search tracker yet. Say “create a local job-search tracker” to start one.';
      }
    } catch { /* */ }
  }
  const message = items.length
    ? null
    : (norm.compound
      ? `No ordinary Memory matched “${norm.original}” (searched “${norm.primary}” and related job terms). ${tracker_note || ''}`.trim()
      : 'No matching ordinary Memory.');
  return {
    kind: 'memory',
    items,
    memory_generation: require('./product-observability').memoryStatus(server.bridge).generation,
    query: norm.query,
    original_query: norm.original,
    compound: norm.compound,
    tracker_note,
    message,
    authority: false
  };
}

module.exports = { normalizeRecallQuery, recall, COMPOUND };
