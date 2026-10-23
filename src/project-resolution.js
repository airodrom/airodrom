'use strict';
// Shared enrolled-project matching for Zero Setup and the Cognitive Mission Router.
// Names and aliases discover candidates; authorization still comes from enrollment.
// Negated mentions ("not chatgpt-handoff") never select a project. Explicit
// airodrom/airodrom source requests never fall through to fixture enrollments.
const STOP = new Set([
  'project', 'product', 'research', 'core', 'test', 'tests', 'fixture', 'acceptance',
  'proof', 'live', 'exact', 'file', 'files', 'human', 'self', 'repair', 'work', 'repo',
  'repository', 'gateway', 'release', 'qualification', 'development', 'autonomous',
  'bounded', 'pilot', 'disposable', 'cursor', 'opencode', 'airodrom', 'assistant',
  'requests', 'routine', 'auto', 'event', 'validator', 'remediation', 'observatory',
  'standalone', 'readiness', 'coding', 'reliability', 'mission', 'missions',
]);

const FIXTURE_REPO = /chatgpt-handoff|recovery-proof|milestone-b1|self-repair|event-qualify|event-remediate|v13-|fixture|disposable-mission|human-acceptance|coding-reliability|dev-pilot|observatory-live/i;

function significantTokens(name) {
  return String(name || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length >= 4 && !STOP.has(token));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when every occurrence of needle sits under a negation cue. */
function mentionIsNegated(instruction, needle) {
  const lower = String(instruction || '').toLowerCase();
  const value = String(needle || '').toLowerCase().trim();
  if (!value) return false;
  let from = 0;
  let saw = false;
  while (from < lower.length) {
    const idx = lower.indexOf(value, from);
    if (idx < 0) break;
    saw = true;
    const before = lower.slice(Math.max(0, idx - 64), idx);
    const negated = /\b(?:not|neither|except|excluding|without|instead\s+of|rather\s+than|other\s+than|outside)\b[\s\w,/.'"-]*$/i.test(before)
      || /\(\s*not\b[\s\w,/.'"-]*$/i.test(before);
    if (!negated) return false;
    from = idx + value.length;
  }
  return saw;
}

function instructionMentions(instruction, name, alias) {
  const text = String(instruction || '');
  const lower = text.toLowerCase();
  const full = String(name || '').toLowerCase().trim();
  if (full && lower.includes(full) && !mentionIsNegated(instruction, full)) {
    return { kind: 'full_name', value: full };
  }
  const aliased = String(alias || '').toLowerCase().trim();
  if (aliased && lower.includes(aliased) && !mentionIsNegated(instruction, aliased)) {
    return { kind: 'alias', value: aliased };
  }
  for (const token of [...significantTokens(name), ...significantTokens(alias)]) {
    if (new RegExp('\\b' + escapeRegExp(token) + '\\b', 'i').test(text) && !mentionIsNegated(instruction, token)) {
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

/** ChatGPT / operator prose that names the real airodrom/airodrom source tree. */
function requestsAirodromSource(instruction) {
  const text = String(instruction || '');
  return /\bairodrom\s*\/\s*airodrom\b/i.test(text)
    || /\bgithub\.com\/airodrom\/airodrom\b/i.test(text)
    || /(?:^|[\s`"'(])(?:~\/code\/airodrom|\/Users\/[^/\s]+\/code\/airodrom)(?:\/|\b)/i.test(text)
    || /\bairodrom\s+source\s+(?:repository|repo|project|checkout|tree)\b/i.test(text)
    || /\b(?:existing\s+)?airodrom\s+SOURCE\s+repository\b/i.test(text)
    || /\bsource\s+repository\s+development\s+project\b/i.test(text)
    || /\b(?:real|canonical|operator)\s+airodrom\s+(?:source|repository|checkout)\b/i.test(text);
}

function isFixtureOrHandoffPath(value) {
  return FIXTURE_REPO.test(String(value || ''));
}

/**
 * Locate an enrolled live root that is the airodrom/airodrom source tree.
 * Fixture / handoff / disposable roots never qualify.
 */
function findEnrolledAirodromSource(projects, { activeRepositories = new Set() } = {}) {
  const hits = [];
  for (const project of projects || []) {
    for (const root of project.repositories || []) {
      if (typeof root !== 'string' || !root) continue;
      if (isFixtureOrHandoffPath(root) || isFixtureOrHandoffPath(project.name)) continue;
      const base = root.replace(/\/+$/, '');
      const isSourcePath = /\/code\/airodrom$/.test(base)
        || /\/airodrom\/airodrom$/.test(base)
        || /\/airodrom-install-[0-9a-f]+$/i.test(base);
      if (!isSourcePath && !activeRepositories.has(root)) continue;
      if (!isSourcePath) continue;
      hits.push({ project, workspace: root });
    }
  }
  if (hits.length === 1) return { ok: true, ...hits[0] };
  if (hits.length > 1) {
    return {
      ok: false,
      clarify: true,
      code: 'AIRODROM_SOURCE_AMBIGUOUS',
      message: 'Multiple enrolled Airodrom source checkouts match. Name the exact authorized repository path.',
      choices: hits.map(h => ({ project_name: h.project.name, workspace_label: h.workspace })),
    };
  }
  return {
    ok: false,
    clarify: true,
    code: 'SOURCE_REPOSITORY_NOT_ENROLLED',
    message: 'Airodrom source development requires an enrolled Developer Autonomy policy for the airodrom/airodrom repository (for example ~/code/airodrom). chatgpt-handoff and recovery-proof fixture grants never authorize source edits. Enroll the source repository from Control Center → Developer Autonomy, then retry.',
    choices: [],
  };
}

module.exports = {
  STOP,
  significantTokens,
  instructionMentions,
  matchNamedProjects,
  preferUniqueProject,
  mentionIsNegated,
  requestsAirodromSource,
  isFixtureOrHandoffPath,
  findEnrolledAirodromSource,
};
