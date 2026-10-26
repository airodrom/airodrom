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
    const before = lower.slice(Math.max(0, idx - 64), idx).split(/[.;\n]/).at(-1);
    const negated = /\b(?:no|not|neither|except|excluding|without|instead\s+of|rather\s+than|other\s+than|outside)\b[\s\w,/'"-]*$/i.test(before)
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
  // Match and negate the SAME target phrase. A success marker containing the
  // product name must not make a separate "do not edit Airodrom source" positive.
  for (const re of target.instruction_res || []) {
    for (const match of text.matchAll(new RegExp(re.source, re.flags.replace('g', '') + 'g'))) {
      const before = text.slice(0, match.index).split(/[.;\n]/).at(-1);
      if (/\b(?:not|never|neither|except|excluding|without|instead\s+of|rather\s+than|other\s+than|outside|don't)\b[\s\w,/'"-]*$/i.test(before)) continue;
      return true;
    }
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
  // Authoritative product work requires an active DA policy on the matched root.
  // A registered project alone never authorizes Cursor/OpenCode execution.
  const enrolled = hits.filter(h => activeRepositories.has(h.workspace));
  if (!enrolled.length) {
    return {
      ok: false,
      clarify: true,
      code: target.not_enrolled_code || 'SOURCE_REPOSITORY_NOT_ENROLLED',
      target_id: target.id,
      repository_id: target.repository_id,
      message: `${target.display_name} project is registered, but there is no active Developer Autonomy policy for ${target.repository_id}. Fixture/handoff grants from other projects never authorize this repository. Enroll from Control Center → Developer Autonomy (include Cursor on the worker allowlist), then retry.`,
      choices: hits.map(h => ({ project_name: h.project.name, workspace_label: h.workspace })),
    };
  }
  let pool = enrolled;
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

/** Strip trailing punctuation ChatGPT often appends to absolute paths. */
function normalizeAbsolutePathCandidate(raw) {
  let value = String(raw || '').trim();
  // Drop wrapping backticks/quotes first, then trailing sentence punctuation.
  value = value.replace(/^[`'"]+/, '').replace(/[`'"]+$/, '');
  value = value.replace(/[.,;:)\]]+$/g, '');
  return value;
}

/**
 * Absolute filesystem paths named in the instruction.
 * Text is untrusted selection only; host registry still grants authority.
 */
function extractAbsolutePaths(instruction) {
  const paths = String(instruction || '').match(/\/(?:Users|private|tmp|var|opt|home)\/[^\s'"`]+/g) || [];
  const out = [];
  for (const raw of paths) {
    const candidate = normalizeAbsolutePathCandidate(raw);
    if (!candidate.startsWith('/')) continue;
    out.push(candidate);
  }
  return [...new Set(out)];
}

function realpathOrNull(value) {
  try { return fs.realpathSync(value); } catch { return null; }
}

/**
 * Shared enrolled-scope resolution for Zero Setup and Cognitive Router.
 * Precedence (host registry is still the only authority):
 *   1. Exact absolute path → enrolled policy/project
 *   2. Exact policy alias
 *   3. Exact project full name
 *   4. Authoritative development targets (Airodrom Source / Arecibo / …)
 *   5. Fuzzy name/alias tokens (never alone against an explicit selector)
 * Explicit selectors that do not resolve fail closed — never projectless fallback.
 * Authoritative product prose never overrides a uniquely resolved enrolled selector.
 *
 * @returns {{ok, projectless?, code?, message?, choices?, selector_kind?,
 *   project?, workspace?, policy?, policies?, authoritative?}}
 */
function resolveEnrolledScope(instruction, {
  projects = [],
  policies = [],
  activeRepositories = new Set(),
  defaultProjectIds = new Set(),
} = {}) {
  const liveProjects = (projects || []).map(p => ({
    ...p,
    repositories: (p.repositories || []).map(realpathOrNull).filter(Boolean),
  })).filter(p => p.repositories.length);
  const activePolicies = (policies || []).filter(p => p && p.state === 'active'
    && (!p.expires_at || p.expires_at > Date.now()));
  const cognitivePolicies = activePolicies.filter(p => p.cognitive);

  function policyForWorkspace(workspace, projectId = null) {
    return cognitivePolicies.filter(p => {
      const root = realpathOrNull(p.repository);
      if (!root || root !== workspace) return false;
      // Same repo enrolled under multiple projects: bind by project_id when known.
      if (projectId && p.project_id && p.project_id !== projectId) return false;
      return true;
    });
  }

  function projectsForWorkspace(workspace) {
    return liveProjects.filter(p => (p.repositories || []).includes(workspace));
  }

  function projectForWorkspace(workspace, preferredId = null) {
    const hits = projectsForWorkspace(workspace);
    if (preferredId) {
      const preferred = hits.find(p => (p.projectId || p.project_id) === preferredId);
      if (preferred) return preferred;
    }
    if (hits.length > 1) return null; // shared root → caller must fail closed
    return hits[0] || null;
  }

  function projectIdOf(project) {
    return project?.projectId || project?.project_id || null;
  }

  function mentionedPolicyAliases() {
    return cognitivePolicies.filter(p => {
      const alias = String(p.alias || '').toLowerCase().trim();
      return alias && instructionMentions(instruction, '', p.alias)?.kind === 'alias';
    });
  }

  const absolutePaths = extractAbsolutePaths(instruction);
  const resolvedPaths = [];
  const unresolvedPaths = [];
  for (const candidate of absolutePaths) {
    const root = realpathOrNull(candidate);
    if (!root) { unresolvedPaths.push(candidate); continue; }
    resolvedPaths.push(root);
  }

  // 1) Exact absolute path(s)
  if (resolvedPaths.length || unresolvedPaths.length) {
    // Any unresolved or unenrolled absolute path claim fails closed — never
    // silently keep only the enrolled subset.
    if (unresolvedPaths.length) {
      return {
        ok: false, projectless: false, code: 'ENROLLED_WORKSPACE_REQUIRED',
        selector_kind: 'absolute_path',
        message: 'That repository path could not be resolved on this host. No files were opened.',
        choices: [],
      };
    }
    const enrolledHits = [];
    const unenrolledRoots = [];
    for (const root of resolvedPaths) {
      const owners = projectsForWorkspace(root);
      if (owners.length > 1) {
        return {
          ok: false, projectless: false, code: 'ENROLLED_REPOSITORY_AMBIGUOUS',
          selector_kind: 'absolute_path',
          message: 'Multiple enrolled projects share that repository path. Name the exact project or policy alias.',
          choices: owners.map(p => ({ project_name: p.name, workspace_label: root })),
        };
      }
      const project = owners[0] || null;
      const matchedPolicies = policyForWorkspace(root, projectIdOf(project));
      if (project || matchedPolicies.length) {
        enrolledHits.push({ workspace: root, project, policies: matchedPolicies });
      } else {
        unenrolledRoots.push(root);
      }
    }
    if (unenrolledRoots.length) {
      return {
        ok: false, projectless: false, code: 'ENROLLED_WORKSPACE_REQUIRED',
        selector_kind: 'absolute_path',
        message: 'That repository is not authorized. No files were opened.',
        choices: [],
      };
    }
    if (enrolledHits.length === 1) {
      const hit = enrolledHits[0];
      const scopedPolicies = policyForWorkspace(hit.workspace, projectIdOf(hit.project));
      if (scopedPolicies.length > 1) {
        return {
          ok: false, projectless: false, code: 'ENROLLED_POLICY_AMBIGUOUS',
          selector_kind: 'absolute_path',
          message: 'Multiple active Developer Autonomy policies cover that repository. Name the exact policy alias.',
          choices: scopedPolicies.map(p => ({ alias: p.alias, policy_id: p.policy_id, workspace_label: path.basename(hit.workspace) })),
          project: hit.project, workspace: hit.workspace, policies: scopedPolicies,
        };
      }
      // Path named a registered project root but no cognitive DA policy.
      if (!scopedPolicies.length) {
        return {
          ok: false, projectless: false, code: 'STANDING_ENROLLMENT_REQUIRED',
          selector_kind: 'absolute_path',
          message: 'That repository is registered, but there is no active cognitive Developer Autonomy policy for it. Enroll once, then retry. Do not use projectless two-file syntax for enrolled work.',
          choices: [], project: hit.project, workspace: hit.workspace, policies: [],
        };
      }
      const aliasMentions = mentionedPolicyAliases();
      if (aliasMentions.length === 1 && aliasMentions[0].policy_id !== scopedPolicies[0].policy_id) {
        return {
          ok: false, projectless: false, code: 'ENROLLED_POLICY_MISMATCH',
          selector_kind: 'absolute_path',
          message: 'Named repository path and policy alias belong to different enrollments. Correct the path or the policy, then retry.',
          choices: [
            { alias: scopedPolicies[0].alias, policy_id: scopedPolicies[0].policy_id, workspace_label: path.basename(hit.workspace) },
            { alias: aliasMentions[0].alias, policy_id: aliasMentions[0].policy_id, workspace_label: path.basename(aliasMentions[0].repository || '') },
          ],
          project: hit.project, workspace: hit.workspace, policies: [scopedPolicies[0], aliasMentions[0]],
        };
      }
      if (aliasMentions.length > 1) {
        return {
          ok: false, projectless: false, code: 'ENROLLED_POLICY_AMBIGUOUS',
          selector_kind: 'absolute_path',
          message: 'Multiple policy aliases were named with that repository path. Keep one policy alias.',
          choices: aliasMentions.map(p => ({ alias: p.alias, policy_id: p.policy_id })),
          project: hit.project, workspace: hit.workspace, policies: aliasMentions,
        };
      }
      // Explicit enrolled path always outranks product-name heuristics.
      return {
        ok: true, projectless: false, selector_kind: 'absolute_path',
        project: hit.project || projectForWorkspace(hit.workspace, scopedPolicies[0].project_id),
        workspace: hit.workspace,
        policy: scopedPolicies[0], policies: scopedPolicies,
      };
    }
    if (enrolledHits.length > 1) {
      return {
        ok: false, projectless: false, code: 'ENROLLED_REPOSITORY_AMBIGUOUS',
        selector_kind: 'absolute_path',
        message: 'Multiple enrolled repositories were named. Pick one absolute path.',
        choices: enrolledHits.map(h => ({
          project_name: h.project?.name || null,
          workspace_label: h.workspace,
        })),
      };
    }
    // Explicit path present but not enrolled / not resolvable — fail closed.
    return {
      ok: false, projectless: false, code: 'ENROLLED_WORKSPACE_REQUIRED',
      selector_kind: 'absolute_path',
      message: 'That repository is not authorized. No files were opened.',
      choices: [],
    };
  }

  // 2) Exact policy alias
  const aliasHits = mentionedPolicyAliases();
  if (aliasHits.length === 1) {
    const policy = aliasHits[0];
    const workspace = realpathOrNull(policy.repository);
    if (!workspace) {
      return {
        ok: false, projectless: false, code: 'ENROLLED_WORKSPACE_REQUIRED',
        selector_kind: 'policy_alias',
        message: 'Named policy repository is not available on this host.',
        choices: [], policy,
      };
    }
    const project = projectForWorkspace(workspace, policy.project_id)
      || liveProjects.find(p => (p.projectId || p.project_id) === policy.project_id)
      || null;
    if (!project && projectsForWorkspace(workspace).length > 1) {
      return {
        ok: false, projectless: false, code: 'ENROLLED_REPOSITORY_AMBIGUOUS',
        selector_kind: 'policy_alias',
        message: 'Named policy repository is shared by multiple projects. Name the exact project.',
        choices: projectsForWorkspace(workspace).map(p => ({ project_name: p.name, workspace_label: workspace })),
        policy, policies: [policy],
      };
    }
    return {
      ok: true, projectless: false, selector_kind: 'policy_alias',
      project, workspace, policy, policies: [policy],
    };
  }
  if (aliasHits.length > 1) {
    return {
      ok: false, projectless: false, code: 'ENROLLED_POLICY_AMBIGUOUS',
      selector_kind: 'policy_alias',
      message: 'Multiple enrolled policies match that alias mention.',
      choices: aliasHits.map(p => ({ alias: p.alias, policy_id: p.policy_id })),
      policies: aliasHits,
    };
  }

  // 3) Exact project full name
  const namedExactRaw = matchNamedProjects(instruction, liveProjects)
    .filter(hit => hit.mention?.kind === 'full_name');
  // Drop shorter full-name hits whose span overlaps a longer matched name in the
  // same instruction ("Fixture project" inside "Self-Repair Scope Fixture project").
  // Genuinely separate exact names remain ambiguous below.
  const namedExact = (() => {
    const lower = String(instruction || '').toLowerCase();
    const spans = namedExactRaw.map(hit => {
      const name = String(hit.project.name || '').toLowerCase();
      const idx = lower.indexOf(name);
      return { hit, name, idx, end: idx < 0 ? -1 : idx + name.length, len: name.length };
    }).filter(s => s.idx >= 0).sort((a, b) => b.len - a.len || a.idx - b.idx);
    const kept = [];
    for (const cand of spans) {
      if (kept.some(k => !(cand.end <= k.idx || cand.idx >= k.end))) continue;
      kept.push(cand);
    }
    return kept.map(s => s.hit);
  })();
  // Distinct exact project names in one instruction are ambiguous — do not
  // break ties by name length (that helper is for nested Arecibo-style names).
  const distinctExactIds = new Set(namedExact.map(h => h.project.projectId || h.project.project_id));
  if (distinctExactIds.size > 1) {
    return {
      ok: false, projectless: false, code: 'cognitive_repository_ambiguous',
      selector_kind: 'project_name',
      message: 'Multiple enrolled projects were named. Pick one repository or policy alias.',
      choices: namedExact.map(h => ({
        project_name: h.project.name,
        workspace_label: path.basename((h.repositories || h.project.repositories || [])[0] || ''),
      })),
      policies: cognitivePolicies.filter(p => distinctExactIds.has(p.project_id)),
    };
  }
  const namedChoice = preferUniqueProject(namedExact, { activeRepositories, defaultProjectIds });
  if (namedChoice.ok) {
    const repos = namedChoice.project.repositories || [];
    if (repos.length === 1) {
      const workspace = repos[0];
      const matchedPolicies = policyForWorkspace(workspace, projectIdOf(namedChoice.project));
      if (matchedPolicies.length === 1) {
        return {
          ok: true, projectless: false, selector_kind: 'project_name',
          project: namedChoice.project, workspace,
          policy: matchedPolicies[0], policies: matchedPolicies,
        };
      }
      if (matchedPolicies.length > 1) {
        return {
          ok: false, projectless: false, code: 'ENROLLED_POLICY_AMBIGUOUS',
          selector_kind: 'project_name',
          message: 'Multiple active policies cover that project repository. Name the policy alias.',
          choices: matchedPolicies.map(p => ({ alias: p.alias, policy_id: p.policy_id })),
          project: namedChoice.project, workspace, policies: matchedPolicies,
        };
      }
      return {
        ok: false, projectless: false, code: 'ENROLLED_WORKSPACE_REQUIRED',
        selector_kind: 'project_name',
        message: 'Project was recognized, but standing cognitive enrollment is required before Mission preparation. Do not use the projectless two-file fixture syntax for enrolled work.',
        choices: [], project: namedChoice.project, workspace, policies: [],
      };
    }
    // Exact project name with multiple repositories must not fall through to
    // authoritative/Source heuristics.
    return {
      ok: false, projectless: false, code: 'ENROLLED_REPOSITORY_AMBIGUOUS',
      selector_kind: 'project_name',
      message: 'That project has more than one enrolled repository. Name the exact absolute path or policy alias.',
      choices: repos.map(workspace => ({
        project_name: namedChoice.project.name,
        workspace_label: path.basename(workspace),
      })),
      project: namedChoice.project, policies: [],
    };
  }
  if (namedChoice.clarify) {
    return {
      ok: false, projectless: false, code: 'ENROLLED_REPOSITORY_AMBIGUOUS',
      selector_kind: 'project_name',
      message: 'Which authorized repository should I use?',
      choices: namedChoice.matches.flatMap(hit => (hit.project.repositories || []).map(workspace => ({
        project_name: hit.project.name, workspace_label: path.basename(workspace),
      }))),
    };
  }

  // 4) Authoritative development targets — only when no explicit enrolled selector.
  const authoritative = resolveAuthoritativeDevelopment(instruction, liveProjects, { activeRepositories });
  if (authoritative.matched) {
    if (!authoritative.ok) {
      return { ...authoritative, projectless: false, selector_kind: 'authoritative_target' };
    }
    const matchedPolicies = policyForWorkspace(authoritative.workspace, projectIdOf(authoritative.project));
    if (matchedPolicies.length === 1) {
      return {
        ok: true, projectless: false, selector_kind: 'authoritative_target',
        project: authoritative.project, workspace: authoritative.workspace,
        policy: matchedPolicies[0], policies: matchedPolicies,
        authoritative,
      };
    }
    if (matchedPolicies.length > 1) {
      return {
        ok: false, projectless: false, code: 'ENROLLED_POLICY_AMBIGUOUS',
        selector_kind: 'authoritative_target',
        message: 'Multiple active policies cover the selected product repository. Name the policy alias.',
        choices: matchedPolicies.map(p => ({ alias: p.alias, policy_id: p.policy_id })),
        project: authoritative.project, workspace: authoritative.workspace,
        policies: matchedPolicies, authoritative,
      };
    }
    return {
      ...authoritative,
      ok: false,
      projectless: false,
      selector_kind: 'authoritative_target',
      code: authoritative.code || 'SOURCE_REPOSITORY_NOT_ENROLLED',
      policies: [],
    };
  }

  // 5) Fuzzy project / alias tokens among cognitive policies
  const excludeFixtures = /\b(?:not|neither|except|excluding)\b[\s\w,/.'"-]{0,120}\b(?:chatgpt-handoff|recovery[- ]proof|fixture)\b/i.test(instruction);
  const fuzzy = [];
  for (const policy of cognitivePolicies) {
    if (excludeFixtures && isFixtureOrHandoffPath(policy.repository)) continue;
    const workspace = realpathOrNull(policy.repository);
    if (!workspace) continue;
    const project = projectForWorkspace(workspace, policy.project_id)
      || liveProjects.find(p => (p.projectId || p.project_id) === policy.project_id)
      || null;
    if (!project) continue;
    if (excludeFixtures && isFixtureOrHandoffPath(project.name)) continue;
    const mention = instructionMentions(instruction, project.name, policy.alias);
    if (!mention) continue;
    fuzzy.push({ policy, project, workspace, mention });
  }
  if (fuzzy.length === 1) {
    return {
      ok: true, projectless: false, selector_kind: 'fuzzy',
      project: fuzzy[0].project, workspace: fuzzy[0].workspace,
      policy: fuzzy[0].policy, policies: [fuzzy[0].policy],
    };
  }
  if (fuzzy.length > 1) {
    const exact = fuzzy.filter(h => h.mention.kind === 'alias' || h.mention.kind === 'full_name');
    const pool = exact.length ? exact : fuzzy;
    if (pool.length === 1) {
      return {
        ok: true, projectless: false, selector_kind: 'fuzzy',
        project: pool[0].project, workspace: pool[0].workspace,
        policy: pool[0].policy, policies: [pool[0].policy],
      };
    }
    return {
      ok: false, projectless: false, code: 'cognitive_repository_ambiguous',
      selector_kind: 'fuzzy',
      message: 'Multiple enrolled repositories match that request. Name the exact repository path or policy alias.',
      choices: pool.map(h => ({
        alias: h.policy.alias, project_name: h.project.name, workspace_label: path.basename(h.workspace),
      })),
      policies: pool.map(h => h.policy),
    };
  }

  // 6) Named registered projects without a cognitive DA policy still fail closed —
  // never fall through to projectless two-file syntax for recognized enrollments.
  let namedHits = matchNamedProjects(instruction, liveProjects);
  if (excludeFixtures) {
    namedHits = namedHits.filter(hit => !isFixtureOrHandoffPath(hit.project.name)
      && !(hit.repositories || []).some(isFixtureOrHandoffPath));
  }
  const namedOnly = preferUniqueProject(namedHits, { activeRepositories, defaultProjectIds });
  if (namedOnly.ok) {
    const repos = namedOnly.project.repositories || [];
    const workspace = repos.length === 1 ? repos[0] : null;
    return {
      ok: false, projectless: false, code: 'ENROLLED_WORKSPACE_REQUIRED',
      selector_kind: 'project_name',
      message: 'Project was recognized, but standing cognitive enrollment is required before Mission preparation. Do not use the projectless two-file fixture syntax for enrolled work.',
      choices: [], project: namedOnly.project, workspace, policies: [],
    };
  }
  if (namedOnly.clarify) {
    return {
      ok: false, projectless: false, code: 'ENROLLED_REPOSITORY_AMBIGUOUS',
      selector_kind: 'project_name',
      message: 'Which authorized repository should I use?',
      choices: namedOnly.matches.flatMap(hit => (hit.repositories || hit.project.repositories || []).map(workspace => ({
        project_name: hit.project.name, workspace_label: path.basename(workspace),
      }))),
    };
  }

  // No registered match and no explicit enrolled-target claim → projectless allowed.
  return { ok: true, projectless: true, project: null, workspace: null, policy: null, policies: [], selector_kind: 'none' };
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
  normalizeAbsolutePathCandidate,
  extractAbsolutePaths,
  resolveEnrolledScope,
};
