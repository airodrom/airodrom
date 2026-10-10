'use strict';
// Host-owned Conversation grounding. Model prose cannot redefine Mission counts.
const { ACTIVE } = require('./product-observability');
const TERMINAL = new Set(['completed', 'cancelled']);

function missionFactSnapshot(bridge) {
  require('./memory-content-erasure').assertReadable(bridge.controlStore.db);
  const rows = bridge.controlStore.db.prepare('SELECT state FROM cp_missions').all();
  let active = 0, current = 0, completed = 0, historical = 0;
  for (const row of rows) {
    if (ACTIVE.includes(row.state)) active++;
    if (!TERMINAL.has(row.state)) current++;
    if (row.state === 'completed') completed++;
    if (TERMINAL.has(row.state)) historical++;
  }
  return {
    source: 'host_overview',
    authority: false,
    active,
    current,
    completed,
    historical,
    retained: rows.length,
    semantics: {
      active: 'dispatching, running, or verifying',
      current: 'not completed or cancelled',
      completed: 'state completed',
      historical: 'completed or cancelled retained Missions'
    }
  };
}

function formatMissionFacts(facts) {
  if (!facts) return '';
  return [
    'Host-verified Mission counts (authoritative; never contradict these numbers):',
    `active=${facts.active} (${facts.semantics.active});`,
    `current=${facts.current} (${facts.semantics.current});`,
    `completed=${facts.completed} (${facts.semantics.completed});`,
    `historical=${facts.historical} (${facts.semantics.historical});`,
    `retained=${facts.retained}.`,
    'Never call current Missions active. Suggestions may be interpretation; counts are host facts.'
  ].join(' ');
}

function rewriteCountClaim(match, claimed, facts, field, label) {
  const n = Number(claimed);
  if (!Number.isSafeInteger(n) || n === facts[field]) return match;
  return `${facts[field]} ${label} (host-verified; model claimed ${n} unverified)`;
}

function groundMissionClaims(text, facts) {
  if (!facts || typeof text !== 'string' || !text.trim()) return { text, disputed: false, corrections: [] };
  const corrections = [];
  let disputed = false;
  let out = text;

  const patterns = [
    {
      re: /\b(\d+)\s+active\s+missions?\b/gi,
      field: 'active',
      label: 'active Missions',
      note: 'active_count'
    },
    {
      re: /\bactive\s+missions?\s*(?:[:=]|are|is)\s*(\d+)\b/gi,
      field: 'active',
      label: 'active Missions',
      note: 'active_count'
    },
    {
      re: /\b(\d+)\s+current\s+missions?\b/gi,
      field: 'current',
      label: 'current Missions',
      note: 'current_count'
    },
    {
      re: /\bcurrent\s+missions?\s*(?:[:=]|are|is)\s*(\d+)\b/gi,
      field: 'current',
      label: 'current Missions',
      note: 'current_count'
    }
  ];

  for (const pattern of patterns) {
    out = out.replace(pattern.re, (match, claimed) => {
      const next = rewriteCountClaim(match, claimed, facts, pattern.field, pattern.label);
      if (next !== match) {
        disputed = true;
        corrections.push(pattern.note);
      }
      return next;
    });
  }

  // Catch “the 62 active …” when 62 is the host current count and active differs.
  if (facts.current !== facts.active && facts.current > 0) {
    const confused = new RegExp(`\\b(?:the\\s+)?${facts.current}\\s+active\\s+missions?\\b`, 'gi');
    if (confused.test(out)) {
      disputed = true;
      corrections.push('current_as_active');
      out = out.replace(confused, `${facts.active} active / ${facts.current} current Missions (host-verified)`);
    }
  }

  if (disputed) {
    out = out.replace(/\s+$/, '') + `\n\nHost-verified Mission counts: active=${facts.active}, current=${facts.current}, completed=${facts.completed}, historical=${facts.historical}.`;
  }
  return { text: out, disputed, corrections: [...new Set(corrections)] };
}

function formatDevelopmentFacts(session) {
  if (!session || typeof session !== 'object') return '';
  const meta = {
    id: session.id || null,
    branch: session.branch || null,
    worktree: session.worktree_basename || null,
    repository: session.repository_basename || null,
    integration: session.integration_state || null,
    related_missions: Number.isSafeInteger(session.mission_count) ? session.mission_count : null
  };
  // JSON keeps branch tokens away from display SESSION<space>value redaction shapes.
  return 'Host-authorized development workstream metadata (reference only; no authority): ' + JSON.stringify(meta);
}

module.exports = {
  missionFactSnapshot,
  formatMissionFacts,
  groundMissionClaims,
  formatDevelopmentFacts
};
