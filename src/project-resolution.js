'use strict';
// Shared enrolled-project matching for Zero Setup and the Cognitive Mission Router.
// Names and aliases discover candidates; authorization still comes from enrollment.
// Negated mentions ("not chatgpt-handoff", "not Arecibo") never select a project.
// Authoritative development targets (config/development-targets-v1.json) resolve
// before opportunistic named matches and never fall through to fixture enrollments.
const fs = require('node:fs');
const path = require('node:path');

const STOP = new Set([
  'project', 'product', 'research', 'core', 'test', 'tests', 'fixture', 'acceptance',
  'proof', 'live', 'exact', 'file', 'files', 'human', 'self', 'repair', 'work', 'repo',
  'repository', 'gateway', 'release', 'qualification', 'development', 'autonomous',
  'bounded', 'pilot', 'disposable', 'cursor', 'opencode', 'airodrom', 'assistant',
  'requests', 'routine', 'auto', 'event', 'validator', 'remediation', 'observatory',
  'standalone', 'readiness', 'coding', 'reliability', 'mission', 'missions',
]);

const FIXTURE_REPO = /chatgpt-handoff|recovery-proof|milestone-b1|self-repair|event-qualify|event-remediate|v13-|fixture|disposable-mission|human-acceptance|coding-reliability|dev-pilot|observatory-live/i;

let _targetsCache = null;

function loadDevelopmentTargets() {
  if (_targetsCache) return _targetsCache;
  const file = path.join(__dirname, '..', 'config', 'development-targets-v1.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!raw || raw.version !== 1 || !Array.isArray(raw.targets)) {
    throw Error('development-targets-v1 catalog is invalid');
  }
  _targetsCache = raw.targets.map(t => ({
    ...t,
    instruction_res: (t.instruction_patterns || []).map(p => new RegExp(p, 'i')),
    project_name_res: (t.project_name_patterns || []).map(p => new RegExp(p, 'i')),
    exclude_name_res: (t.exclude_name_patterns || []).map(p => new RegExp(p, 'i')),
    remote_res: (t.remote_patterns || []).map(p => new RegExp(escapeRegExp(p).replace(/\\\//g, '\\/'), 'i')),
  }));
  return _targetsCache;
}

function developmentTargets() {
  return loadDevelopmentTargets().map(t => ({
    id: t.id,
    repository_id: t.repository_id,
    display_name: t.display_name,
    not_enrolled_code: t.not_enrolled_code,
    default_worker: t.default_worker || 'cursor',
    notes: t.notes || null,
  }));
}

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

function isFixtureOrHandoffPath(value) {
  return FIXTURE_REPO.test(String(value || ''));
}

function pathMatchesTarget(root, target) {
  const base = String(root || '').replace(/\/+$/, '');
  if (!base) return false;
  if (isFixtureOrHandoffPath(base)) return false;
  for (const suffix of target.path_suffixes || []) {
    if (base.endsWith(suffix) || base === suffix) return true;
  }
  return false;
}

function projectExcludedByTarget(project, target) {
  const name = String(project?.name || '');
  return (target.exclude_name_res || []).some(re => re.test(name));
}

function targetInstructionHit(instruction, target) {
  const text = String(instruction || '');
  if (!text) return false;
  // Negating the display name or repository id must not select the target.
  if (mentionIsNegated(instruction, target.display_name)) return false;
  if (mentionIsNegated(instruction, target.repository_id)) return false;
  if (mentionIsNegated(instruction, target.id)) return false;
  for (const re of target.instruction_res || []) {
    if (!re.test(text)) continue;
    // If the only matches sit under negation of a related product token, skip.
    const product = target.display_name.toLowerCase();
    if (mentionIsNegated(instruction, product)) continue;
    return true;
  }
  return false;
}

/**
 * Detect which authoritative development target(s) an instruction names.
 * Returns zero, one, or many ids. Callers fail closed when more than one.
 */
function detectAuthoritativeTargets(instruction) {
  const hits = [];
  for (const target of loadDevelopmentTargets()) {
    if (targetInstructionHit(instruction, target)) hits.push(target);
  }
  return hits;
}

/**
 * Locate an enrolled live root for one authoritative target.
 * Fixture / handoff / disposable roots never qualify.
 * Prefer preferred_basename, then active DA repositories, then any live match.
 */
function findEnrolledTarget(target, projects, { activeRepositories = new Set() } = {}) {
  const hits = [];
  for (const project of projects || []) {
    if (projectExcludedByTarget(project, target)) continue;
    for (const root of project.repositories || []) {
      if (typeof root !== 'string' || !root) continue;
      if (isFixtureOrHandoffPath(root) || isFixtureOrHandoffPath(project.name)) continue;
      if (!pathMatchesTarget(root, target)) continue;
      hits.push({ project, workspace: root.replace(/\/+$/, ''), target });
    }
  }
  if (!hits.length) {
    return {
      ok: false,
      clarify: true,
      code: target.not_enrolled_code || 'SOURCE_REPOSITORY_NOT_ENROLLED',
      target_id: target.id,
      repository_id: target.repository_id,
      message: `${target.display_name} development requires an enrolled Developer Autonomy policy for ${target.repository_id}. Fixture/handoff grants from other projects never authorize this repository. Enroll from Control Center → Developer Autonomy (include Cursor on the worker allowlist), then retry.`,
      choices: [],
    };
  }
  // Prefer active DA repositories when present.
  const enrolled = hits.filter(h => activeRepositories.has(h.workspace));
  let pool = enrolled.length ? enrolled : hits;
  if (target.preferred_basename) {
    const preferred = pool.filter(h => path.basename(h.workspace) === target.preferred_basename);
    if (preferred.length) pool = preferred;
  }
  // Prefer project name patterns when multiple remain.
  const named = pool.filter(h => (target.project_name_res || []).some(re => re.test(String(h.project.name || ''))));
  if (named.length === 1) return { ok: true, ...named[0] };
  if (pool.length === 1) return { ok: true, ...pool[0] };
  if (named.length > 1) pool = named;
  return {
    ok: false,
    clarify: true,
    code: target.ambiguous_code || 'ENROLLED_REPOSITORY_AMBIGUOUS',
    target_id: target.id,
    repository_id: target.repository_id,
    message: `Multiple enrolled ${target.display_name} checkouts match. Name the exact authorized repository path.`,
    choices: pool.map(h => ({ project_name: h.project.name, workspace_label: h.workspace })),
  };
}

/**
 * Resolve instruction → authoritative target → enrolled project/workspace.
 * Precedence: explicit target detection → fail closed if missing/ambiguous.
 * Does not fall back to unrelated active projects.
 */
function resolveAuthoritativeDevelopment(instruction, projects, options = {}) {
  const detected = detectAuthoritativeTargets(instruction);
  if (!detected.length) return { ok: false, matched: false };
  if (detected.length > 1) {
    return {
      ok: false,
      matched: true,
      clarify: true,
      code: 'DEVELOPMENT_TARGET_AMBIGUOUS',
      message: 'That request names more than one development product. Say which repository to use: '
        + detected.map(t => t.repository_id).join(' or ') + '.',
      choices: detected.map(t => ({ target_id: t.id, repository_id: t.repository_id, display_name: t.display_name })),
    };
  }
  const target = detected[0];
  const found = findEnrolledTarget(target, projects, options);
  if (!found.ok) return { ...found, matched: true };
  return {
    ok: true,
    matched: true,
    project: found.project,
    workspace: found.workspace,
    target_id: target.id,
    repository_id: target.repository_id,
    display_name: target.display_name,
    default_worker: target.default_worker || 'cursor',
    repository_binding: {
      target_id: target.id,
      repository_id: target.repository_id,
      workspace: found.workspace,
      project_id: found.project.projectId || found.project.project_id || null,
      authority: false,
    },
  };
}

/** ChatGPT / operator prose that names the real airodrom/airodrom source tree. */
function requestsAirodromSource(instruction) {
  const targets = detectAuthoritativeTargets(instruction);
  return targets.some(t => t.id === 'airodrom');
}

/** ChatGPT / operator prose that names arecibo-inc/arecibo-core. */
function requestsAreciboCore(instruction) {
  const targets = detectAuthoritativeTargets(instruction);
  return targets.some(t => t.id === 'arecibo');
}

/**
 * Locate an enrolled live root that is the airodrom/airodrom source tree.
 * Fixture / handoff / disposable roots never qualify. Install trees are not source.
 */
function findEnrolledAirodromSource(projects, options = {}) {
  const target = loadDevelopmentTargets().find(t => t.id === 'airodrom');
  if (!target) {
    return {
      ok: false, clarify: true, code: 'SOURCE_REPOSITORY_NOT_ENROLLED',
      message: 'Airodrom source target catalog is missing.', choices: [],
    };
  }
  return findEnrolledTarget(target, projects, options);
}

function findEnrolledAreciboCore(projects, options = {}) {
  const target = loadDevelopmentTargets().find(t => t.id === 'arecibo');
  if (!target) {
    return {
      ok: false, clarify: true, code: 'ARECIBO_REPOSITORY_NOT_ENROLLED',
      message: 'Arecibo target catalog is missing.', choices: [],
    };
  }
  return findEnrolledTarget(target, projects, options);
}

module.exports = {
  STOP,
  significantTokens,
  instructionMentions,
  matchNamedProjects,
  preferUniqueProject,
  mentionIsNegated,
  requestsAirodromSource,
  requestsAreciboCore,
  isFixtureOrHandoffPath,
  findEnrolledAirodromSource,
  findEnrolledAreciboCore,
  loadDevelopmentTargets,
  developmentTargets,
  detectAuthoritativeTargets,
  resolveAuthoritativeDevelopment,
  findEnrolledTarget,
  pathMatchesTarget,
};
