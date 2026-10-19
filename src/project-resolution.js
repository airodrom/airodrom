'use strict';
// Shared enrolled-project matching for Zero Setup and the Cognitive Mission Router.
// Names and aliases discover candidates; authorization still comes from enrollment.
const STOP = new Set([
  'project', 'product', 'research', 'core', 'test', 'tests', 'fixture', 'acceptance',
  'proof', 'live', 'exact', 'file', 'files', 'human', 'self', 'repair', 'work', 'repo',
  'repository', 'gateway', 'release', 'qualification', 'development', 'autonomous',
  'bounded', 'pilot', 'disposable', 'cursor', 'opencode', 'airodrom', 'assistant',
  'requests', 'routine', 'auto', 'event', 'validator', 'remediation', 'observatory',
  'standalone', 'readiness', 'coding', 'reliability', 'mission', 'missions',
]);

function significantTokens(name) {
  return String(name || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length >= 4 && !STOP.has(token));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function instructionMentions(instruction, name, alias) {
  const text = String(instruction || '');
  const lower = text.toLowerCase();
  const full = String(name || '').toLowerCase().trim();
  if (full && lower.includes(full)) return { kind: 'full_name', value: full };
  const aliased = String(alias || '').toLowerCase().trim();
  if (aliased && lower.includes(aliased)) return { kind: 'alias', value: aliased };
  for (const token of [...significantTokens(name), ...significantTokens(alias)]) {
    if (new RegExp('\\b' + escapeRegExp(token) + '\\b', 'i').test(text)) {
      return { kind: 'token', value: token };
    }
  }
  return null;
}

function matchNamedProjects(instruction, projects) {
  const hits = [];
  for (const project of projects || []) {
    const mention = instructionMentions(instruction, project.name);
    if (!mention) continue;
    hits.push({
      project,
      mention,
      repositories: Array.isArray(project.repositories) ? project.repositories : [],
    });
  }
  return hits;
}

function preferUniqueProject(hits, { activeRepositories = new Set(), defaultProjectIds = new Set() } = {}) {
  if (!hits.length) return { ok: false, clarify: false, matches: [] };
  if (hits.length === 1) return { ok: true, project: hits[0].project, matches: hits };
  // Exact full-name or alias beats shared tokens ("Arecibo Core" over "Arecibo …").
  const exact = hits.filter(hit => hit.mention?.kind === 'full_name' || hit.mention?.kind === 'alias');
  // Prefer the longest exact name so "Self-Repair Scope Fixture" wins over a
  // shorter "Fixture project" that only matched as a trailing phrase.
  let ranked = exact.length ? exact : hits;
  if (exact.length > 1) {
    const maxLen = Math.max(...exact.map(hit => String(hit.project.name || '').length));
    const longest = exact.filter(hit => String(hit.project.name || '').length === maxLen);
    if (longest.length === 1) return { ok: true, project: longest[0].project, matches: hits };
    ranked = longest;
  }
  const defaulted = ranked.filter(hit => defaultProjectIds.has(hit.project.projectId));
  if (defaulted.length === 1) return { ok: true, project: defaulted[0].project, matches: hits };
  const enrolled = ranked.filter(hit => (hit.repositories || []).some(repo => activeRepositories.has(repo)));
  const pool = enrolled.length ? enrolled : ranked;
  const singleRepo = pool.filter(hit => (hit.repositories || []).length === 1);
  const candidates = singleRepo.length ? singleRepo : pool;
  if (candidates.length === 1) return { ok: true, project: candidates[0].project, matches: hits };
  return { ok: false, clarify: true, matches: candidates.length ? candidates : hits };
}

module.exports = {
  STOP,
  significantTokens,
  instructionMentions,
  matchNamedProjects,
  preferUniqueProject,
};
