'use strict';
// Developer Autonomy V1 — ADR 0053 / Issue #111.
// Standing owner enrollment per exact repository, short-lived Mission grants,
// automatic disposable workspaces, safe cleanup. Never merges, deploys, or
// expands protected operations. WORK templates remain immutable and separate.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile, execFileSync } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { object, identifier, text, fingerprint } = require('./control-plane-store');
const { transaction } = require('./control-transaction');
const POLICY = require('./default-runtime').LOCAL_POLICY;

const WORKFLOWS = Object.freeze([
  'routine_edit', 'test', 'lint', 'typecheck', 'build', 'repair', 'draft_pr', 'feature_branch'
]);
const NEVER_AUTO = Object.freeze([
  'protected_branch_merge', 'production_deploy', 'credentials_secrets',
  'security_policy_change', 'destructive_operations', 'access_outside_registered_repos',
  'external_ai_disclosure', 'paid_usage', 'privileged_infrastructure'
]);
const DEFAULT_BUDGETS = Object.freeze({
  max_repairs: 2,
  max_concurrent_missions: 1,
  grant_ttl_minutes: 120,
  max_files: 8,
  max_worktrees: 4,
  max_runtime_hours: 4,
  // Retained for signed-policy shape compatibility only. Not an admission ceiling.
  max_disk_mb: 2048
});
// Protect a floor of free space on the volume used for disposable clones.
// Not an aggregate DA policy budget; never substitute another fixed GB ceiling.
const FREE_SPACE_RESERVE_BYTES = 5 * 1024 * 1024 * 1024;
const FREE_SPACE_RESERVE_RATIO = 0.05;
const ALIAS = v => {
  if (typeof v !== 'string' || !/^[a-z][a-z0-9_-]{0,79}$/.test(v)) throw Error('Exact policy alias required');
  return v;
};
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BRANCH = /^[A-Za-z0-9._\/-]{1,120}$/;

const AUXILIARY_TEST = /^(?:tests?|__tests__)\/.+\.(?:ts|tsx|js|jsx|cjs|mjs)$/;

function externalWorkerEligible(bridge, workerId) {
  if (process.env.NODE_ENV === 'test' && bridge.options?.allowFixtureWorker) return true;
  if (workerId === 'cursor') {
    const ready = bridge.cursorWorker?.lastReadiness;
    return ready?.governed_worker === true && ready?.ready === true && ready?.tiers?.qualified === true;
  }
  return !!bridge.workers?.current?.(workerId)?.qualified;
}
function auxiliaryApplicationTest(name) {
  return typeof name === 'string' && AUXILIARY_TEST.test(name) && !/(^|\/)(credentials|secrets)(\/|$)/.test(name);
}

function writableFile(root, name) {
  if (!AUXILIARY_TEST.test(name) || /(^|\/)(credentials|secrets)(\/|$)/.test(name)) return file(root, name);
  if (typeof name !== 'string' || name.length > 240 || name.includes('\\') || /[\x00-\x1f*?\[\]{}]/.test(name)
    || name.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.'))
    || path.isAbsolute(name)) {
    throw Error('Exact non-secret, non-verifier file required');
  }
  const target = path.join(root, name);
  const s = fs.lstatSync(target);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || fs.realpathSync(target) !== target) {
    throw Error('Existing regular file without symlinks required');
  }
  return target;
}

function file(root, name) {
  if (typeof name !== 'string' || name.length > 240 || name.includes('\\') || /[\x00-\x1f*?\[\]{}]/.test(name)
    || name.split('/').some(p => !p || p === '.' || p === '..' || p.startsWith('.'))
    || path.isAbsolute(name)
    || /(^|\/)(tests?|__tests__|credentials|secrets)(\/|$)|(^|\/)(package(?:-lock)?\.json|[^/]+\.(test|spec)\.[^/]+)$/.test(name)) {
    throw Error('Exact non-secret, non-verifier file required');
  }
  const target = path.join(root, name);
  const s = fs.lstatSync(target);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || fs.realpathSync(target) !== target) {
    throw Error('Existing regular file without symlinks required');
  }
  return target;
}

function git(cwd, args, opts = {}) {
  return execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: opts.timeout || 30000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...(opts.env || {}) }
  }).trim();
}

function gitAsync(cwd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: opts.timeout || 300000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...(opts.env || {}) }
    }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        return reject(error);
      }
      resolve(String(stdout || '').trim());
    });
  });
}

function safeGit(cwd, args) {
  try { return { ok: true, out: git(cwd, args) }; }
  catch (e) { return { ok: false, err: String(e.stderr || e.message || e).slice(0, 400) }; }
}

async function safeGitAsync(cwd, args, opts = {}) {
  try { return { ok: true, out: await gitAsync(cwd, args, opts) }; }
  catch (e) { return { ok: false, err: String(e.stderr || e.message || e).slice(0, 400) }; }
}

function workspaceDirty(root) {
  const snap = require('./control-context').workspaceSnapshot(root);
  return Array.isArray(snap.dirty) ? snap.dirty : [];
}

function directoryIdentity(name, owned = false) {
  const st = fs.lstatSync(name);
  if (!st.isDirectory() || st.isSymbolicLink() || fs.realpathSync(name) !== name
    || (owned && ((typeof process.getuid === 'function' && st.uid !== process.getuid()) || (st.mode & 0o022)))) {
    throw Error('Workspace identity or ownership is unsafe');
  }
  return { path: name, dev: st.dev, ino: st.ino };
}
function identityChain(name) {
  const result = [];
  for (let current = name;; current = path.dirname(current)) {
    result.push(directoryIdentity(current));
    if (current === path.dirname(current)) break;
  }
  return result;
}
function assertIdentities(identities) {
  if (!Array.isArray(identities) || !identities.length) throw Error('Workspace identity unavailable');
  for (const expected of identities) {
    const actual = directoryIdentity(expected.path);
    if (actual.dev !== expected.dev || actual.ino !== expected.ino) throw Error('Workspace identity changed');
  }
}
function privateDirectory(name) {
  if (!fs.existsSync(name)) fs.mkdirSync(name, { mode: 0o700 });
  directoryIdentity(name, true);
  return name;
}
function diskBytes(root, ceiling = Infinity) {
  let bytes = 0, entries = 0;
  function walk(name) {
    const st = fs.lstatSync(name);
    if (++entries > 200000) throw Error('Workspace disk inventory exceeds bounded inspection');
    bytes += st.size;
    if (bytes > ceiling) throw Error('Workspace disk inventory exceeds bounded inspection');
    if (st.isDirectory() && !st.isSymbolicLink()) {
      for (const child of fs.readdirSync(name)) {
        walk(path.join(name, child));
      }
    }
  }
  walk(root);
  return bytes;
}

function filesystemCapacity(root) {
  const target = fs.existsSync(root) ? root : path.dirname(root);
  const st = typeof fs.statfsSync === 'function'
    ? fs.statfsSync(target)
    : null;
  if (!st || !Number.isFinite(st.bavail) || !Number.isFinite(st.blocks) || !Number.isFinite(st.bsize)) {
    throw Error('Filesystem capacity is unavailable for Developer Autonomy workspace preparation');
  }
  const block = Number(st.bsize);
  const free = Number(st.bavail) * block;
  const total = Number(st.blocks) * block;
  const reserve = Math.max(FREE_SPACE_RESERVE_BYTES, Math.floor(total * FREE_SPACE_RESERVE_RATIO));
  return {
    free_bytes: free,
    total_bytes: total,
    reserve_bytes: reserve,
    available_bytes: Math.max(0, free - reserve),
  };
}

function estimateTreeBytes(root, limit = 512 * 1024 * 1024) {
  if (!fs.existsSync(root)) return 0;
  try { return diskBytes(root, limit + 1); }
  catch (error) {
    if (/exceeds bounded inspection/i.test(String(error.message || error))) return limit + 1;
    throw error;
  }
}

class DeveloperAutonomy {
  constructor(bridge) {
    this.bridge = bridge;
    this.db = bridge.controlStore.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cp_developer_autonomy_policies(
        policy_id TEXT PRIMARY KEY,
        alias TEXT NOT NULL UNIQUE,
        repository TEXT NOT NULL,
        record TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('active','revoked','expired')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cp_developer_autonomy_grants(
        grant_id TEXT PRIMARY KEY,
        policy_id TEXT NOT NULL,
        request_id TEXT NOT NULL UNIQUE,
        record TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('active','revoked','expired','consumed')),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        FOREIGN KEY(policy_id) REFERENCES cp_developer_autonomy_policies(policy_id)
      );
      CREATE TABLE IF NOT EXISTS cp_developer_autonomy_workspaces(
        workspace_id TEXT PRIMARY KEY,
        policy_id TEXT NOT NULL,
        grant_id TEXT,
        mission_id TEXT,
        path TEXT NOT NULL,
        repository TEXT NOT NULL,
        branch TEXT NOT NULL,
        base_sha TEXT,
        disposable INTEGER NOT NULL DEFAULT 1,
        state TEXT NOT NULL CHECK(state IN ('ready','bound','cleaned','held','invalid')),
        record TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(policy_id) REFERENCES cp_developer_autonomy_policies(policy_id)
      );
      CREATE INDEX IF NOT EXISTS cp_da_policy_repo ON cp_developer_autonomy_policies(repository, state);
      CREATE INDEX IF NOT EXISTS cp_da_grant_policy ON cp_developer_autonomy_grants(policy_id, state);
      CREATE INDEX IF NOT EXISTS cp_da_ws_policy ON cp_developer_autonomy_workspaces(policy_id, state);
    `);
  }

  owner(owner) {
    if (owner !== 'operator') throw Error('Authenticated local operator required');
  }

  dataRoot(repository) {
    const parent = path.dirname(fs.realpathSync(repository));
    let root = path.join(parent, '.airodrom-da-worktrees');
    if (root === this.bridge.dataDir || root.startsWith(this.bridge.dataDir + path.sep)) {
      const token = createHash('sha256').update(String(this.bridge.dataDir || '')).digest('hex').slice(0, 16);
      const base = privateDirectory(path.join(fs.realpathSync(os.tmpdir()), 'airodrom-da'));
      root = path.join(base, token);
    }
    privateDirectory(root);
    privateDirectory(path.join(root, 'worktrees'));
    return root;
  }

  boundAuxiliaryFiles(source) {
    const envelope = source?.envelope || source;
    const ref = envelope?.developer_autonomy;
    if (!ref) return [];
    const scope = this.grantScope(ref.grant_id);
    if (!scope || fingerprint(ref) !== fingerprint(scope.developer_autonomy)) {
      throw Error('Developer Autonomy grant expired, revoked or changed');
    }
    const allowed = envelope.allowed_files;
    const workspace = envelope.workspace;
    if (!Array.isArray(allowed) || fingerprint(allowed) !== fingerprint(scope.allowed_files)) {
      throw Error('Immutable grant ceiling mismatch');
    }
    if (typeof workspace !== 'string' || path.resolve(workspace) !== path.resolve(scope.workspace)) {
      throw Error('Workspace grant mismatch');
    }
    const projectId = source.project_id || source.projectId;
    const goalId = source.goal_id || source.goalId;
    if ((projectId && projectId !== scope.project_id) || (goalId && goalId !== scope.goal_id)) {
      throw Error('Immutable grant ceiling mismatch');
    }
    const recorded = envelope.verification_manifest?.authorized_auxiliary_files;
    const derived = scope.allowed_files.filter(auxiliaryApplicationTest);
    if (recorded && fingerprint([...recorded].sort()) !== fingerprint([...derived].sort())) {
      throw Error('Authorized application-test scope mismatch');
    }
    return derived;
  }

  assertWorkspace(workspace) {
    if (!workspace || !['ready', 'bound', 'held'].includes(workspace.state)) throw Error('Workspace not usable');
    assertIdentities(workspace.identities);
    directoryIdentity(workspace.path, true);
    if (path.dirname(workspace.path) !== workspace.container) throw Error('Workspace containment changed');
    if (require('./control-execution').repositoryRoot(workspace.path) !== workspace.path) throw Error('Workspace repository changed');
  }

  workspacePath(value) {
    // A host-generated UUID can contain digits that pass the card checksum.
    // Only a registered, identity-verified workspace basename is a typed ID.
    // Parent paths and all unregistered values retain ordinary secret screening.
    if (typeof value !== 'string' || Buffer.byteLength(value) > 1000 || value.includes('\0')) return text(value, 'workspace', 1000);
    const id = path.basename(value);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) return text(value, 'workspace', 1000);
    const ws = this.inspectWorkspace(id);
    if (!ws || ws.path !== value || path.join(ws.container, ws.workspace_id) !== value) return text(value, 'workspace', 1000);
    this.assertWorkspace(ws);
    text(path.join(ws.container, 'host-workspace-id'), 'workspace', 1000);
    return value;
  }

  assertAuxiliaryText(policy, name, currentText) {
    const trusted = policy.verifier_baseline;
    const expected = new Map((trusted?.files || []).map(entry => [entry.path, entry.sha256]));
    const previous = trusted?.assertion_profile?.find(entry => entry.path === name);
    const baseline = fs.readFileSync(path.join(policy.repository, name));
    if (createHash('sha256').update(baseline).digest('hex') !== expected.get(name)) throw Error('Enrolled verifier inputs changed or overlap writable scope');
    const baselineText = baseline.toString('utf8');
    // Counts are not a strength proof. The enrolled source must remain an
    // exact prefix, and only a recognized added assertion may follow it.
    if (!currentText.startsWith(baselineText)) throw Error('Authorized application test weakened existing assertions');
    for (const line of currentText.slice(baselineText.length).split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//')) continue;
      if (/^(?:assert|expect)(?:\.[A-Za-z]+)?\([^;\n]*\);?$/.test(trimmed)) continue;
      throw Error('Authorized application test change is not a recognized additive assertion');
    }
    const current = require('./verifier-baseline').profileText(currentText);
    if (!previous || current.assertions < previous.assertions
      || current.negative_assertions < previous.negative_assertions
      || current.skips > previous.skips) {
      throw Error('Authorized application test weakened existing assertions');
    }
  }

  assertVerifiers(policy, workspace, allowed = []) {
    const taskFile = path.join(workspace, '.vscode/tasks.json');
    const st = fs.lstatSync(taskFile);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || fs.realpathSync(taskFile) !== taskFile
      || st.size > 65536 || fingerprint(fs.readFileSync(taskFile, 'utf8')) !== policy.verifier_hash) {
      throw Error('Registered verification definitions changed');
    }
    const snapshot = require('./control-context').workspaceSnapshot(workspace);
    const trusted = policy.verifier_baseline;
    if (!trusted || !Array.isArray(trusted.files)) throw Error('Enrolled verifier baseline unavailable');
    const expected = new Map(trusted.files.map(entry => [entry.path, entry.sha256]));
    // An auxiliary application test can be edited when explicitly named in the
    // Mission and the enrolled verifier only runs a pinned static typecheck.
    // It is never trusted as verification evidence. Registered tests, task
    // definitions and referenced verification inputs remain immutable.
    const configured = JSON.parse(fs.readFileSync(taskFile, 'utf8')).tasks || [];
    const typecheckTasks = configured.filter(task => policy.verification_defaults.tests.includes(task.label));
    let staticOnly = typecheckTasks.length > 0
      && typecheckTasks.length === policy.verification_defaults.tests.length
      && typecheckTasks.every(task => task.type === 'process' && task.command === 'npm'
        && JSON.stringify(task.args) === '["run","typecheck"]');
    if (staticOnly) {
      try {
        const originalPkg = fs.readFileSync(path.join(policy.repository, 'package.json'), 'utf8');
        const currentPkg = fs.readFileSync(path.join(workspace, 'package.json'), 'utf8');
        staticOnly = originalPkg === currentPkg
          && JSON.parse(originalPkg).scripts?.typecheck === 'tsc --noEmit'
          && !allowed.includes('package.json');
      } catch { staticOnly = false; }
    }
    const editable = new Set(staticOnly ? allowed.filter(name =>
      /^(?:tests?|__tests__)\/.+\.(?:ts|tsx|js|jsx|cjs|mjs)$/.test(name)
      && expected.has(name)
      && !trusted.referenced?.includes(name)) : []);
    if (allowed.some(name => expected.has(name) && !editable.has(name))
      || trusted.files.some(entry => snapshot.files[entry.path] !== entry.sha256 && !editable.has(entry.path))
      || Object.keys(snapshot.files).some(name => require('./verifier-baseline').isVerifierOwned(name) && !expected.has(name))) {
      throw Error('Enrolled verifier inputs changed or overlap writable scope');
    }
    // Authorized auxiliary tests are not independent verification. Assertion
    // counts do not prove strength. An edit is accepted only when the enrolled
    // bytes remain an exact prefix and the suffix is a recognized added
    // assertion. Replacements, skips, control-flow bypasses and import changes
    // fail closed. An appended tautology is still not proof.
    for (const name of editable) {
      this.assertAuxiliaryText(policy, name, fs.readFileSync(path.join(workspace, name), 'utf8'));
    }
    for (const entry of trusted.files) {
      const target = path.join(workspace, entry.path), stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || fs.realpathSync(target) !== target) throw Error('Verifier path must be canonical');
    }
  }

  /**
   * Admission uses real filesystem free space minus a protected reserve.
   * policy.budgets.max_disk_mb remains on signed records for compatibility and
   * is never treated as an aggregate clone/history/node_modules ceiling.
   * Existing worktrees are never deleted here to create capacity.
   */
  assertPreparationCapacity(policy, neededBytes = 0, { label = 'workspace preparation' } = {}) {
    const need = Math.max(0, Number(neededBytes) || 0);
    const root = path.join(this.dataRoot(policy.repository), 'worktrees');
    privateDirectory(path.dirname(root));
    privateDirectory(root);
    const cap = filesystemCapacity(root);
    if (need > cap.available_bytes) {
      const needMb = Math.ceil(need / (1024 * 1024));
      const availMb = Math.floor(cap.available_bytes / (1024 * 1024));
      const freeMb = Math.floor(cap.free_bytes / (1024 * 1024));
      const reserveMb = Math.ceil(cap.reserve_bytes / (1024 * 1024));
      throw Error(
        `Insufficient filesystem free space for Developer Autonomy ${label} `
        + `(need ${needMb} MB, available ${availMb} MB after ${reserveMb} MB reserve; `
        + `volume free ${freeMb} MB). This is not a legacy max_disk_mb policy budget. `
        + 'Existing worktrees were preserved.'
      );
    }
    return cap.available_bytes;
  }

  // Compatibility alias used by older call sites and tests documentation.
  // Does not enforce policy max_disk_mb.
  assertDiskBudget(policy, additional = 0) {
    return this.assertPreparationCapacity(policy, additional);
  }

  preparationEstimate(policy) {
    // Hardlinked local clones share Git objects; charge only a small metadata
    // cushion plus the enrolled node_modules tree if it must be materialized.
    const modules = path.join(policy.repository, 'node_modules');
    const moduleBytes = estimateTreeBytes(modules, 8 * 1024 * 1024 * 1024);
    const metadata = 64 * 1024 * 1024;
    return metadata + Math.max(0, moduleBytes);
  }

  grantMissions(grantId) {
    return this.db.prepare("SELECT id FROM cp_missions WHERE json_extract(envelope,'$.developer_autonomy.grant_id')=?")
      .all(grantId).map(row => this.bridge.controlStore.requireMission(row.id));
  }

  workspaceIdle(workspace) {
    const missions = this.db.prepare("SELECT id FROM cp_missions WHERE json_extract(envelope,'$.workspace')=?").all(workspace);
    if (this.db.prepare("SELECT 1 FROM cp_leases WHERE resource=? AND state IN ('held','quarantined')").get(workspace)) return false;
    for (const { id } of missions) {
      if (this.db.prepare("SELECT 1 FROM cp_runs WHERE mission_id=? AND (termination_verified<>1 OR state NOT IN ('completed','failed','cancelled','interrupted'))").get(id)) return false;
      if (this.db.prepare("SELECT 1 FROM cp_dispatches WHERE mission_id=? AND state NOT IN ('settled','cancelled','blocked')").get(id)) return false;
      if (this.db.prepare("SELECT 1 FROM cp_invocations i JOIN cp_mission_tasks t ON t.task_id=i.task_id WHERE t.mission_id=? AND i.state<>'settled'").get(id)) return false;
    }
    return true;
  }

  lineageSettled(missions) {
    if (!missions.length) return false;
    const parents = new Set(missions.map(m => m.envelope.repair_of).filter(Boolean));
    return missions.filter(m => !parents.has(m.id)).every(m => {
      if (['completed', 'cancelled'].includes(m.state)) return true;
      // needs_rework / blocked remain reserved only while a corrective Mission
      // can still be admitted under this grant. A zero repair budget or a
      // policy without repair must not hold the concurrent slot forever.
      if (!['needs_rework', 'blocked'].includes(m.state)) return false;
      const ref = m.envelope.developer_autonomy;
      if (!ref?.grant_id || !ref.policy_id) return true;
      const grantRow = this.db.prepare('SELECT record FROM cp_developer_autonomy_grants WHERE grant_id=?').get(ref.grant_id);
      const policyRow = this.db.prepare('SELECT record FROM cp_developer_autonomy_policies WHERE policy_id=?').get(ref.policy_id);
      if (!grantRow || !policyRow) return true;
      const grant = JSON.parse(grantRow.record).record;
      const policy = JSON.parse(policyRow.record).record;
      const repairs = this.grantMissions(ref.grant_id).filter(x => x.envelope.repair_of).length;
      const canRepair = Array.isArray(policy.workflows) && policy.workflows.includes('repair')
        && Number.isInteger(grant.repair_budget) && repairs < grant.repair_budget;
      return !canRepair;
    });
  }

  // Concurrent max_worktrees is an active-prep / unsettled-execution ceiling.
  // Idle grantless ready clones (including interrupted planning leftovers) and
  // settled evidence may remain on disk but must not consume execution slots.
  // Active writers, unsettled Mission lineages, active grants, and invalid prep
  // continue to occupy capacity until safely reconciled.
  workspaceOccupiesBudget(row) {
    if (!row || !['ready', 'bound', 'held', 'invalid'].includes(row.state)) return false;
    if (row.state === 'invalid') return true;
    const idle = this.workspaceIdle(row.path);
    if (row.state === 'ready') {
      // Unbound ready: occupy only while writers/leases remain; idle leftovers
      // are reclaimable evidence and must not strand the concurrent ceiling.
      if (!row.grant_id) return !idle;
      const grant = this.db.prepare('SELECT state FROM cp_developer_autonomy_grants WHERE grant_id=?').get(row.grant_id);
      return !grant || grant.state === 'active';
    }
    const missions = this.db.prepare("SELECT id FROM cp_missions WHERE json_extract(envelope,'$.workspace')=?")
      .all(row.path).map(item => this.bridge.controlStore.requireMission(item.id));
    if (!idle) return true;
    if (missions.length) return !this.lineageSettled(missions);
    if (row.grant_id) {
      const grant = this.db.prepare('SELECT state FROM cp_developer_autonomy_grants WHERE grant_id=?').get(row.grant_id);
      return !grant || grant.state === 'active';
    }
    return false;
  }

  // Disposable disk capacity excludes unbound ready clones and settled evidence.
  // Bound/held work with active writers or unsettled lineage still charges.
  workspaceOccupiesDiskBudget(row) {
    if (!row || !['ready', 'bound', 'held', 'invalid'].includes(row.state)) return false;
    if (row.state === 'invalid') return true;
    if (row.state === 'ready' && !row.grant_id) return false;
    return this.workspaceOccupiesBudget(row);
  }

  /** Classify one workspace for capacity diagnostics (no secrets / absolute home expansion). */
  classifyWorkspaceCapacity(row) {
    if (!row) return null;
    const basename = (() => { try { return path.basename(row.path); } catch { return row.workspace_id; } })();
    const idle = (() => { try { return this.workspaceIdle(row.path); } catch { return false; } })();
    const missions = this.db.prepare("SELECT id FROM cp_missions WHERE json_extract(envelope,'$.workspace')=?")
      .all(row.path).map(item => {
        try { return this.bridge.controlStore.requireMission(item.id); }
        catch { return { id: item.id, state: 'unknown' }; }
      });
    let grantState = null;
    if (row.grant_id) {
      try { grantState = this.db.prepare('SELECT state FROM cp_developer_autonomy_grants WHERE grant_id=?').get(row.grant_id)?.state || null; }
      catch { grantState = 'unknown'; }
    }
    const occupies = this.workspaceOccupiesBudget(row);
    let classification = 'unknown';
    if (row.state === 'invalid') classification = 'invalid_or_orphaned_prep';
    else if (!idle) classification = 'active_or_uncertain_writer';
    else if (missions.length && !this.lineageSettled(missions)) classification = 'unsettled_mission';
    else if (row.grant_id && (!grantState || grantState === 'active') && !missions.length) classification = 'active_grant_reservation';
    else if (row.state === 'held') classification = 'retained_evidence';
    else if (row.state === 'ready' && !row.grant_id) classification = 'idle_unbound_ready';
    else if (row.state === 'bound' && idle && (!missions.length || this.lineageSettled(missions))) classification = 'idle_bound_settled';
    else if (occupies) classification = 'active_execution';
    else classification = 'non_occupying';
    return {
      workspace_id: row.workspace_id,
      workspace_label: basename,
      state: row.state,
      classification,
      occupies_capacity: occupies,
      grant_id: row.grant_id || null,
      grant_state: grantState,
      mission_ids: missions.map(m => m.id),
      mission_states: missions.map(m => m.state),
      idle,
      disposable: row.disposable === 1,
      authority: false,
    };
  }

  capacityInventory(policyId) {
    const rows = this.db.prepare(
      "SELECT * FROM cp_developer_autonomy_workspaces WHERE policy_id=? AND state IN ('ready','bound','held','invalid')"
    ).all(policyId);
    const slots = rows.map(row => this.classifyWorkspaceCapacity(row));
    const occupied = slots.filter(s => s.occupies_capacity);
    return {
      policy_id: policyId,
      total_tracked: slots.length,
      occupied_count: occupied.length,
      occupied: occupied,
      non_occupying: slots.filter(s => !s.occupies_capacity),
      authority: false,
    };
  }

  worktreeBudgetError(policy) {
    const inventory = this.capacityInventory(policy.policy_id);
    const limit = policy.budgets.max_worktrees;
    const blocking = inventory.occupied.map(s => ({
      workspace_id: s.workspace_id,
      classification: s.classification,
      mission_ids: s.mission_ids,
      grant_id: s.grant_id,
    }));
    const needsOwner = inventory.occupied.some(s =>
      ['active_or_uncertain_writer', 'unsettled_mission', 'active_grant_reservation', 'active_execution'].includes(s.classification));
    const error = Error(
      'Worktree budget exhausted: ' + inventory.occupied_count + '/' + limit
      + ' concurrent slots in use for policy ' + policy.policy_id.slice(0, 8)
      + '. Occupied: ' + (blocking.map(b => b.classification + '(' + b.workspace_id.slice(0, 8) + ')').join(', ') || 'none')
      + (needsOwner
        ? '. Owner intervention required for active or uncertain executions.'
        : '. Reclaim idle unbound ready clones or wait for settlement; protected workspaces stay preserved.')
    );
    error.code = 'WORKTREE_BUDGET_EXHAUSTED';
    error.details = {
      policy_id: policy.policy_id,
      max_worktrees: limit,
      occupied_count: inventory.occupied_count,
      occupied: blocking,
      non_occupying_count: inventory.non_occupying.length,
      recovery: needsOwner
        ? 'inspect_active_missions_grants_and_leases'
        : 'reclaim_idle_ready_or_retry_after_settlement',
      owner_intervention_required: needsOwner,
      authority: false,
    };
    return error;
  }

  // Remove only clean, idle ready clones so physical disk can recover. Idle
  // grantless ready no longer occupy concurrent slots even when cleanup holds
  // unique/dirty evidence. Never promote unique/dirty clones to held here.
  reclaimIdleReadyWorkspaces(policy, owner) {
    const idleBefore = Date.now() - 60_000;
    const rows = this.db.prepare(
      "SELECT * FROM cp_developer_autonomy_workspaces WHERE policy_id=? AND state='ready' AND (grant_id IS NULL OR grant_id='') AND created_at<=?"
    ).all(policy.policy_id, idleBefore);
    for (const row of rows) {
      try {
        if (!this.workspaceIdle(row.path)) continue;
        const record = JSON.parse(row.record);
        if (this.cleanupDecision(row, record).action !== 'clean') continue;
        this.cleanupOwnedWorkspace({ workspace_id: row.workspace_id, confirmed: true }, owner);
      } catch { /* best-effort reclaim; prepare still fail-closed on genuine budget */ }
    }
  }

  occupiedWorktrees(policyId) {
    return this.db.prepare("SELECT * FROM cp_developer_autonomy_workspaces WHERE policy_id=? AND state IN ('ready','bound','held','invalid')")
      .all(policyId).filter(row => this.workspaceOccupiesBudget(row)).length;
  }

  reservations(policyId) {
    let count = 0;
    for (const row of this.db.prepare('SELECT * FROM cp_developer_autonomy_grants WHERE policy_id=?').all(policyId)) {
      const grant = JSON.parse(row.record).record, missions = this.grantMissions(row.grant_id);
      const settled = this.lineageSettled(missions) && this.workspaceIdle(grant.scope.workspace);
      if (settled && row.state === 'active') this.db.prepare("UPDATE cp_developer_autonomy_grants SET state='consumed' WHERE grant_id=?").run(row.grant_id);
      if (!missions.length) {
        if (row.state === 'active' && row.expires_at > Date.now()) count++;
        continue;
      }
      if (settled) continue;
      // Idle needs_rework/blocked lineages keep the grant for possible repair, but
      // must not occupy concurrent admission slots once writers are gone.
      const idleTerminal = this.workspaceIdle(grant.scope.workspace)
        && missions.every(m => ['needs_rework', 'blocked', 'completed', 'cancelled'].includes(m.state));
      if (idleTerminal) continue;
      count++;
    }
    return count;
  }

  assertRepair(parent) {
    const ref = parent.envelope.developer_autonomy;
    if (!ref) return;
    this.assertMission(parent);
    const grant = this.inspectGrant(ref.grant_id), policy = this.inspect(ref.policy_id);
    if (!policy.workflows.includes('repair') || this.grantMissions(ref.grant_id).filter(m => m.envelope.repair_of).length >= grant.repair_budget) {
      throw Error('Developer Autonomy repair budget exhausted');
    }
    if (!this.workspaceIdle(parent.envelope.workspace)) throw Error('Developer Autonomy repair termination unverified');
    if (this.grantMissions(ref.grant_id).some(m => m.envelope.repair_of === parent.id)) throw Error('Developer Autonomy repair already exists');
  }

  contractFor(input) {
    const grant = this.inspectGrant(input.developer_autonomy.grant_id);
    if (!grant || grant.state !== 'active') throw Error('Developer Autonomy grant unavailable');
    const cognitive=input.cognitive_request_id?this.bridge.zeroSetupWork.read(input.cognitive_request_id)?.cognitive:null;
    const assignments=cognitive?.envelope?.version===3?cognitive.proposal.tasks:null;
    return { identity: { expires_at: grant.expires_at },
      ...(assignments?{execution:{worker_allowlist:[...new Set(assignments.map(t=>t.worker))]}}:{}),
      objective: { original_instruction: input.objective },
      permissions: { allowed_write_paths: input.cognitive_request_id && input.preferred_agent === 'host' ? [] : [...input.allowed_files], ...(input.cognitive_request_id && input.preferred_agent === 'host' ? { allowed_tools: ['read'] } : {}) },
      budget: { risk_class: 'normal', max_repair_attempts: grant.repair_budget,
        max_wall_clock_ms: Math.min(grant.expires_at - grant.created_at, grant.manifest.mission.budget.max_runtime_hours * 3600000),
        max_worker_invocations: grant.repair_budget + (assignments?assignments.length:1) } };
  }

  assertCreation(input) {
    const parent = input.repair_of ? this.bridge.controlStore.requireMission(input.repair_of) : null;
    if (parent?.envelope.developer_autonomy) {
      if (fingerprint(input.developer_autonomy || null) !== fingerprint(parent.envelope.developer_autonomy)) throw Error('Corrective Mission must retain Developer Autonomy grant');
      this.assertRepair(parent);
    }
    if (!input.developer_autonomy) return;
    this.assertInput(input);
    const missions = this.grantMissions(input.developer_autonomy.grant_id);
    if (missions.length && !parent?.envelope.developer_autonomy) throw Error('Developer Autonomy grant already bound to a Mission');
    if (parent && !missions.some(m => m.id === parent.id)) throw Error('Corrective Mission grant lineage mismatch');
  }

  bindMission(mission) {
    const ref = mission.envelope.developer_autonomy;
    if (!ref?.workspace_id) return;
    const ws = this.inspectWorkspace(ref.workspace_id);
    this.assertWorkspace(ws);
    if (ws.grant_id !== ref.grant_id) throw Error('Workspace grant mismatch');
    this.db.prepare('UPDATE cp_developer_autonomy_workspaces SET mission_id=?,updated_at=? WHERE workspace_id=?')
      .run(mission.id, Date.now(), ws.workspace_id);
  }

  assertChanges(mission, changes) {
    const ref = mission.envelope.developer_autonomy;
    if (!ref) return;
    this.assertMission(mission);
    const policy = this.inspect(ref.policy_id);
    let growth = 0;
    for (const change of changes) {
      const name = writableFile(mission.envelope.workspace, change.path);
      if (AUXILIARY_TEST.test(change.path)) this.assertAuxiliaryText(policy, change.path, String(change.content ?? ''));
      growth += Math.max(0, Buffer.byteLength(change.content || '') - fs.statSync(name).size);
    }
    this.assertPreparationCapacity(policy, growth, { label: 'worker output application' });
  }

  // --- Standing policy -------------------------------------------------------

  enroll(input, owner) {
    this.owner(owner);
    object(input, [
      'alias', 'repository', 'project_id', 'goal_id', 'workflows', 'budgets',
      'workers', 'duration_days', 'confirmed', 'diff_check', 'default_tests', 'cognitive'
    ]);
    if (input.confirmed !== true) throw Error('Explicit owner enrollment consent required');
    ALIAS(input.alias);
    identifier(input.project_id);
    identifier(input.goal_id);
    text(input.repository, 'repository', 1000);
    if (!Number.isInteger(input.duration_days) || input.duration_days < 1 || input.duration_days > 90) {
      throw Error('Standing policy duration must be 1 to 90 days');
    }
    if (!Array.isArray(input.workflows) || !input.workflows.length || input.workflows.length > 12
      || new Set(input.workflows).size !== input.workflows.length
      || input.workflows.some(w => !WORKFLOWS.includes(w))) {
      throw Error('Named permitted workflows required from the Developer Autonomy catalog');
    }
    if (input.workflows.includes('draft_pr') && !input.workflows.includes('feature_branch')) {
      throw Error('draft_pr requires feature_branch workflow');
    }
    const workers = input.workers === undefined ? ['opencode'] : input.workers;
    if (!Array.isArray(workers) || !workers.length || workers.length > 4
      || workers.some(w => !['opencode', 'cursor', 'claude_code', 'codex'].includes(w))
      || !workers.includes('opencode')) {
      throw Error('Workers must include opencode; external workers only when explicitly listed');
    }
    if (workers.some(w => w !== 'opencode')) {
      // External workers remain admission-gated at dispatch; enrollment only permits consideration.
      // Cursor's generic bounded-worker qualification is a separate no-tools path and stays denied.
      // Specialist enrollment uses the governed sandboxed Cursor worker readiness instead.
      for (const w of workers.filter(x => x !== 'opencode')) {
        if (!externalWorkerEligible(this.bridge, w)) {
          throw Error('External worker ' + w + ' is not independently qualified');
        }
      }
    }
    text(input.diff_check, 'registered diff-check task', 100);
    if (!Array.isArray(input.default_tests) || !input.default_tests.length || input.default_tests.length > 4) {
      throw Error('One to four default focused tests required');
    }
    for (const label of input.default_tests) text(label, 'registered task label', 100);

    const repository = fs.realpathSync(input.repository);
    if (!path.isAbsolute(repository) || require('./control-execution').repositoryRoot(repository) !== repository) {
      throw Error('Exact canonical repository root required');
    }
    const s = fs.statSync(repository);
    const p = this.bridge.projects.getProject(input.project_id);
    const g = this.bridge.projects.getGoal(input.goal_id);
    if (p.status === 'archived' || g.projectId !== p.projectId || !p.repositories.includes(repository)) {
      throw Error('Project, goal and repository boundary mismatch');
    }

    const taskFile = path.join(repository, '.vscode/tasks.json');
    const raw = fs.readFileSync(taskFile, 'utf8');
    if (Buffer.byteLength(raw) > 65536) throw Error('Verifier definitions too large');
    if (fs.realpathSync(taskFile) !== taskFile) throw Error('Verifier path must be canonical');
    const tasks = JSON.parse(raw).tasks;
    if (!Array.isArray(tasks)) throw Error('Registered tasks required');
    for (const label of [input.diff_check, ...input.default_tests]) {
      const matches = tasks.filter(t => t.label === label);
      if (matches.length !== 1 || matches[0].type !== 'process') throw Error('Unique registered process task required');
    }
    const diff = tasks.find(t => t.label === input.diff_check);
    if (diff.command !== 'git' || JSON.stringify(diff.args) !== '["diff","--check"]') {
      throw Error('Diff check must be exactly git diff --check');
    }

    const budgets = { ...DEFAULT_BUDGETS, ...(input.budgets && typeof input.budgets === 'object' ? input.budgets : {}) };
    for (const [k, v] of Object.entries(budgets)) {
      if (!Object.prototype.hasOwnProperty.call(DEFAULT_BUDGETS, k) || !Number.isInteger(v) || v < 0) {
        throw Error('Invalid budget field ' + k);
      }
    }
    if (budgets.max_repairs > require('./mission-contract').ABSOLUTE_MAX_REPAIRS || budgets.max_concurrent_missions > 2 || budgets.grant_ttl_minutes < 5
      || budgets.grant_ttl_minutes > 1440 || budgets.max_files < 1 || budgets.max_files > 16
      || budgets.max_worktrees < 1 || budgets.max_worktrees > 8 || budgets.max_runtime_hours < 1
      || budgets.max_runtime_hours > 24 || budgets.max_disk_mb < 64 || budgets.max_disk_mb > 8192) {
      // max_disk_mb remains a signed-record field (64–8192) for compatibility with
      // existing policies. It is not an aggregate admission ceiling for clones,
      // Git history, or node_modules; preparation uses filesystem free space.
      throw Error('Budget outside Developer Autonomy V1 ceilings');
    }

    const now = Date.now();
    const record = {
      version: 1,
      policy_id: randomUUID(),
      alias: input.alias,
      project_id: input.project_id,
      goal_id: input.goal_id,
      repository,
      identity: { dev: s.dev, ino: s.ino },
      ...(input.cognitive === undefined ? {} : { cognitive: require('./cognitive-router').enrollment(input.cognitive, repository) }),
      workflows: [...input.workflows].sort(),
      budgets,
      workers: [...workers],
      privacy: 'local_only',
      data_class: 'public',
      verification_defaults: {
        diff_check: input.diff_check,
        tests: [...input.default_tests],
        syntax: []
      },
      verifier_hash: fingerprint(raw),
      verifier_baseline: require('./verifier-baseline').capture(repository, { verification: { diff_check: input.diff_check, tests: input.default_tests }, baseline: require('./control-context').workspaceSnapshot(repository) }),
      never_auto: [...NEVER_AUTO],
      enrolled_at: now,
      expires_at: now + input.duration_days * 86400000,
      authority: false
    };
    this.assertPolicyBoundaries(record);
    const hash = fingerprint(record);
    const seal = this.bridge.missionAuthority.sealManifest({
      mission_id: 'developer-autonomy:' + record.policy_id,
      manifest_hash: hash
    });
    if (!seal) throw Error('Existing operator signing authority required');
    this.db.prepare('INSERT INTO cp_developer_autonomy_policies VALUES(?,?,?,?,?,?,?)')
      .run(record.policy_id, record.alias, repository, JSON.stringify({ record, hash, seal }), 'active', now, now);
    this.bridge.controlStore.event('developer_autonomy.enrolled', null, {
      policy_id: record.policy_id, alias: record.alias, repository, hash, authority: false
    });
    return this.inspect(record.policy_id);
  }

  assertPolicyBoundaries(t) {
    if (!path.isAbsolute(t.repository) || fs.realpathSync(t.repository) !== t.repository
      || require('./control-execution').repositoryRoot(t.repository) !== t.repository) {
      throw Error('Exact canonical repository root required');
    }
    const s = fs.statSync(t.repository);
    if (s.dev !== t.identity.dev || s.ino !== t.identity.ino) throw Error('Repository identity changed');
    const p = this.bridge.projects.getProject(t.project_id);
    const g = this.bridge.projects.getGoal(t.goal_id);
    if (p.status === 'archived' || g.projectId !== p.projectId || !p.repositories.includes(t.repository)) {
      throw Error('Project, goal and repository boundary mismatch');
    }
    this.assertVerifiers(t, t.repository);
  }

  readPolicy(policyId) {
    identifier(policyId);
    const row = this.db.prepare('SELECT * FROM cp_developer_autonomy_policies WHERE policy_id=?').get(policyId);
    if (!row) return null;
    const r = JSON.parse(row.record);
    if (r.record.policy_id !== policyId || r.record.version !== 1 || fingerprint(r.record) !== r.hash
      || !this.bridge.missionAuthority.verifyManifestSeal(r.seal, {
        mission_id: 'developer-autonomy:' + policyId,
        manifest_hash: r.hash
      })) {
      throw Error('Developer Autonomy policy integrity mismatch');
    }
    return { ...r, state: row.state, repository: row.repository };
  }

  policyState(r) {
    let state = r.state;
    if (state === 'active' && r.record.expires_at <= Date.now()) state = 'expired';
    if (state === 'active') {
      try { this.assertPolicyBoundaries(r.record); }
      catch { state = 'invalid'; }
    }
    return state;
  }

  inspect(policyId) {
    const r = this.readPolicy(policyId);
    if (!r) return null;
    const state = this.policyState(r);
    return {
      ...r.record,
      policy_hash: r.hash,
      state,
      never_auto: NEVER_AUTO,
      authority: false
    };
  }

  list(owner) {
    this.owner(owner);
    return this.db.prepare('SELECT policy_id FROM cp_developer_autonomy_policies ORDER BY created_at DESC')
      .all()
      .map(row => {
        try { return this.inspect(row.policy_id); }
        catch { return { policy_id: row.policy_id, state: 'invalid', authority: false }; }
      });
  }

  activePolicyForRepository(repository) {
    const root = fs.realpathSync(repository);
    const rows = this.db.prepare("SELECT policy_id FROM cp_developer_autonomy_policies WHERE repository=? AND state='active'")
      .all(root);
    const active = [];
    for (const row of rows) {
      try {
        const inspected = this.inspect(row.policy_id);
        if (inspected?.state === 'active') active.push(inspected);
      } catch { /* skip invalid */ }
    }
    return active;
  }

  // Reuse prior same-repo cognitive discovery or Autopilot-admissible files so an
  // already-authorized standing enrollment does not require manual re-enrollment
  // solely to attach planning discovery for Cursor. Never expands repository scope.
  resolveCognitiveFiles(policy) {
    const root = fs.realpathSync(policy.repository);
    const { DEFAULT_DENIED_PATHS, globMatch } = require('./mission-contract');
    const { planningContextAdmissible } = require('./opencode-adapter');
    const usable = (file) => {
      if (typeof file !== 'string' || !file || DEFAULT_DENIED_PATHS.some(pattern => globMatch(pattern, file))) return false;
      try {
        const target = path.join(root, file);
        return fs.lstatSync(target).isFile() && fs.realpathSync(target) === target
          && planningContextAdmissible(fs.readFileSync(target, 'utf8'));
      } catch { return false; }
    };
    const fromRelated = [];
    for (const row of this.db.prepare('SELECT policy_id FROM cp_developer_autonomy_policies WHERE repository=?').all(root)) {
      try {
        const related = this.readPolicy(row.policy_id)?.record;
        for (const file of related?.cognitive?.files || []) if (usable(file) && !fromRelated.includes(file)) fromRelated.push(file);
      } catch { /* skip invalid related policies */ }
    }
    if (fromRelated.length) return fromRelated.slice(0, 8);
    return [
      'README.md', 'CHANGELOG.md', 'docs/README.md',
      'docs/operations/founder-current-state.md', 'lib/platform/manifest.json',
      'src/index.js', 'fixture.txt', 'recovery-proof.txt',
    ].filter(usable).slice(0, 8);
  }

  // Attach cognitive discovery (and Cursor worker when host Cursor is enabled) to an
  // already-active standing policy. Re-seals the policy; does not widen repository,
  // budgets, or NEVER_AUTO. Spend/disclosure stay separately gated.
  ensureCognitiveDiscovery(policyId, owner = 'operator') {
    this.owner(owner);
    identifier(policyId);
    const current = this.inspect(policyId);
    if (!current || current.state !== 'active') throw Error('Active Developer Autonomy policy required');
    const files = current.cognitive?.files?.length ? [...current.cognitive.files] : this.resolveCognitiveFiles(current);
    if (!files.length) return current;
    const cursorAllowed = !this.bridge.hostExecutionPolicy?.cursorDisabled?.();
    const workers = [...new Set([...(Array.isArray(current.workers) ? current.workers : ['opencode']), ...(cursorAllowed ? ['cursor'] : [])])]
      .filter(w => ['opencode', 'cursor'].includes(w));
    workers.sort();
    const sameCognitive = current.cognitive?.files?.length
      && current.cognitive.files.length === files.length
      && current.cognitive.files.every((file, i) => file === files[i]);
    const sameWorkers = Array.isArray(current.workers)
      && current.workers.length === workers.length
      && current.workers.every((w, i) => w === workers[i]);
    // Cursor multi-task assignments need the 120s cognitive execution ceiling.
    // Do not leave older 60s enrollments stale when files/workers already match.
    const timingStale = !Number.isSafeInteger(current.cognitive?.execution_ms)
      || current.cognitive.execution_ms < 120000
      || !Number.isSafeInteger(current.cognitive?.planning_ms)
      || current.cognitive.planning_ms < 120000;
    if (sameCognitive && sameWorkers && !timingStale) return current;

    const r = this.readPolicy(policyId);
    const repairAttempts = Math.min(1, Number(current.budgets?.max_repairs) || 0);
    const cognitive = require('./cognitive-router').enrollment({
      version: 3,
      files,
      delegated_callers: Array.isArray(current.cognitive?.delegated_callers) ? [...current.cognitive.delegated_callers] : [],
      planning_attempts: 2,
      planning_ms: 120000,
      execution_ms: 120000,
      repair_attempts: repairAttempts,
      max_assignments: 2,
      acceptance: 'automatic',
    }, current.repository);
    const next = { ...r.record, cognitive, workers };
    this.assertPolicyBoundaries(next);
    const hash = fingerprint(next);
    const seal = this.bridge.missionAuthority.sealManifest({
      mission_id: 'developer-autonomy:' + policyId,
      manifest_hash: hash
    });
    if (!seal) throw Error('Existing operator signing authority required');
    const now = Date.now();
    this.db.prepare('UPDATE cp_developer_autonomy_policies SET record=?, updated_at=? WHERE policy_id=? AND state=?')
      .run(JSON.stringify({ record: next, hash, seal }), now, policyId, 'active');
    this.bridge.controlStore.event('developer_autonomy.cognitive_ensured', null, {
      policy_id: policyId, files: files.length, workers, authority: false
    });
    return this.inspect(policyId);
  }

  revoke(input, owner) {
    this.owner(owner);
    object(input, ['policy_id', 'policy_hash', 'confirmed']);
    if (input.confirmed !== true) throw Error('Explicit revocation consent required');
    identifier(input.policy_id);
    // This is an opaque SHA-256 coordinate, not user prose. Decimal substrings
    // in a valid digest can accidentally match the content scanner's card rule.
    if (typeof input.policy_hash !== 'string' || input.policy_hash.length !== 64 || !/^[a-f0-9]{64}$/.test(input.policy_hash)) throw Error('Invalid policy hash');
    const r = this.readPolicy(input.policy_id);
    if (!r || r.hash !== input.policy_hash) throw Error('Exact current policy required');
    const now = Date.now();
    this.db.prepare("UPDATE cp_developer_autonomy_policies SET state='revoked', updated_at=? WHERE policy_id=?")
      .run(now, input.policy_id);
    this.db.prepare("UPDATE cp_developer_autonomy_grants SET state='revoked' WHERE policy_id=? AND state='active'")
      .run(input.policy_id);
    this.bridge.controlStore.event('developer_autonomy.revoked', null, {
      policy_id: input.policy_id, hash: r.hash, authority: false
    });
    return this.inspect(input.policy_id);
  }

  // --- Workspaces ------------------------------------------------------------

  #workspacePreparePrelude(input, owner) {
    this.owner(owner);
    object(input, ['policy_id', 'request_id', 'prefer_disposable', 'branch_prefix']);
    identifier(input.policy_id);
    identifier(input.request_id);
    const policy = this.inspect(input.policy_id);
    if (!policy || policy.state !== 'active') throw Error('Active Developer Autonomy policy required');
    this.assertPolicyBoundaries(policy);

    const prior = this.db.prepare("SELECT workspace_id FROM cp_developer_autonomy_workspaces WHERE json_extract(record,'$.request_id')=?").get(input.request_id);
    const requestHash = fingerprint({ policy_id: input.policy_id, prefer_disposable: input.prefer_disposable === true, branch_prefix: input.branch_prefix || 'airodrom/da' });
    if (prior) {
      const ws = this.inspectWorkspace(prior.workspace_id);
      if (ws.request_hash !== requestHash) throw Error('Workspace request replay scope mismatch');
      this.assertWorkspace(ws);
      return { prior: ws };
    }
    this.reclaimIdleReadyWorkspaces(policy, owner);
    // Do not charge Git history or retained clones against a fixed max_disk_mb.
    // Admission is filesystem free space after reserve; existing trees stay put.
    this.assertPreparationCapacity(policy, this.preparationEstimate(policy), { label: 'workspace preparation' });
    if (this.occupiedWorktrees(policy.policy_id) >= policy.budgets.max_worktrees) {
      throw this.worktreeBudgetError(policy);
    }

    const dirty = workspaceDirty(policy.repository);
    const forceDisposable = input.prefer_disposable === true || dirty.length > 0;
    const workspaceId = randomUUID();
    const branchPrefix = typeof input.branch_prefix === 'string' && /^[a-z0-9][a-z0-9._-]{0,40}$/.test(input.branch_prefix)
      ? input.branch_prefix
      : 'airodrom/da';
    const branch = branchPrefix + '/' + workspaceId.slice(0, 8);
    if (!BRANCH.test(branch)) throw Error('Invalid feature branch name');
    const trees = path.join(this.dataRoot(policy.repository), 'worktrees');
    const workPath = path.join(trees, workspaceId);
    const baseSha = git(policy.repository, ['rev-parse', 'HEAD']);
    return { policy, requestHash, dirty, forceDisposable, workspaceId, branch, trees, workPath, baseSha };
  }

  #workspacePrepareFinalize(input, ctx, { disposable, reason }) {
    const { policy, requestHash, dirty, workspaceId, branch, trees, workPath, baseSha } = ctx;
    try {
      const project = this.bridge.projects.getProject(policy.project_id);
      if (!project.repositories.includes(workPath)) {
        this.bridge.projects.updateProject(policy.project_id, {
          repositories: [...project.repositories, workPath]
        });
      }
    } catch (e) {
      throw e;
    }
    const now = Date.now();
    const record = {
      workspace_id: workspaceId,
      policy_id: policy.policy_id,
      request_id: input.request_id,
      request_hash: requestHash,
      container: trees,
      identities: identityChain(workPath),
      path: workPath,
      repository: policy.repository,
      branch,
      base_sha: baseSha,
      disposable,
      reason,
      preserved_dirty: dirty.slice(0, 40),
      created_at: now
    };
    this.db.prepare('INSERT INTO cp_developer_autonomy_workspaces VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(workspaceId, policy.policy_id, null, null, workPath, policy.repository, branch, baseSha,
        disposable ? 1 : 0, 'ready', JSON.stringify(record), now, now);
    this.bridge.controlStore.event('developer_autonomy.workspace_prepared', null, {
      workspace_id: workspaceId, policy_id: policy.policy_id, path: workPath, disposable, reason, authority: false
    });
    this.assertPreparationCapacity(policy, 0, { label: 'workspace finalization' });
    return { ...record, state: 'ready', authority: false };
  }

  prepareWorkspace(input, owner) {
    const prelude = this.#workspacePreparePrelude(input, owner);
    if (prelude.prior) return prelude.prior;
    const { policy, dirty, forceDisposable, branch, workPath } = prelude;
    // Use a local clone (not `git worktree add`). Linked worktrees point `.git` into
    // the source object's worktrees metadata, which capability sandboxing rejects.
    // A local clone stays a self-contained repository root and never mutates dirty
    // files in the enrolled checkout. Hardlinks share immutable Git objects on the
    // same volume so large histories are not duplicated into the DA disk budget.
    const clone = safeGit(policy.repository, ['clone', '--local', policy.repository, workPath]);
    if (!clone.ok) {
      throw Error((forceDisposable || dirty.length
        ? 'Unable to prepare disposable workspace while preserving dirty work: '
        : 'Unable to prepare isolated workspace: ') + clone.err);
    }
    directoryIdentity(workPath, true);
    // Materialize enrolled JS/TS dependencies into the disposable clone. Symlinks
    // do not grant Seatbelt read access to an external tree; clonefile/copy keeps
    // modules inside the mission filesystem read root without network install.
    // Capacity is filesystem free space after reserve — not policy max_disk_mb.
    try {
      const availableBytes = this.assertPreparationCapacity(policy, 0, { label: 'dependency materialization' });
      require('./js-verification-runtime').materializeNodeModules(policy.repository, workPath, { maxBytes: availableBytes });
      this.assertPreparationCapacity(policy, 0, { label: 'dependency materialization' });
    } catch (error) {
      // Only this freshly created, unregistered disposable clone is removed.
      fs.rmSync(workPath, { recursive: true, force: true });
      throw error;
    }
    const branched = safeGit(workPath, ['checkout', '-b', branch]);
    if (!branched.ok) {
      fs.rmSync(workPath, { recursive: true, force: true });
      throw Error('Unable to create task feature branch: ' + branched.err);
    }
    const disposable = true;
    const reason = (!forceDisposable && dirty.length === 0)
      ? 'clean_reusable_clone'
      : (dirty.length ? 'dirty_source_preserved_disposable_created' : 'explicit_disposable');
    return this.#workspacePrepareFinalize(input, prelude, { disposable, reason });
  }

  // Cognitive MCP planning must not block the bridge event loop while cloning
  // multi-GB enrolled trees. Status tools keep answering during this await.
  async prepareWorkspaceAsync(input, owner) {
    const prelude = this.#workspacePreparePrelude(input, owner);
    if (prelude.prior) return prelude.prior;
    const { policy, dirty, forceDisposable, branch, workPath } = prelude;
    const clone = await safeGitAsync(policy.repository, ['clone', '--local', policy.repository, workPath], { timeout: 300000 });
    if (!clone.ok) {
      throw Error((forceDisposable || dirty.length
        ? 'Unable to prepare disposable workspace while preserving dirty work: '
        : 'Unable to prepare isolated workspace: ') + clone.err);
    }
    directoryIdentity(workPath, true);
    try {
      const availableBytes = this.assertPreparationCapacity(policy, 0, { label: 'dependency materialization' });
      await require('./js-verification-runtime').materializeNodeModulesAsync(policy.repository, workPath, { maxBytes: availableBytes });
      this.assertPreparationCapacity(policy, 0, { label: 'dependency materialization' });
    } catch (error) {
      fs.rmSync(workPath, { recursive: true, force: true });
      throw error;
    }
    const branched = await safeGitAsync(workPath, ['checkout', '-b', branch]);
    if (!branched.ok) {
      fs.rmSync(workPath, { recursive: true, force: true });
      throw Error('Unable to create task feature branch: ' + branched.err);
    }
    const disposable = true;
    const reason = (!forceDisposable && dirty.length === 0)
      ? 'clean_reusable_clone'
      : (dirty.length ? 'dirty_source_preserved_disposable_created' : 'explicit_disposable');
    return this.#workspacePrepareFinalize(input, prelude, { disposable, reason });
  }

  bindWorkspace(workspaceId, { grant_id, mission_id }) {
    identifier(workspaceId);
    if (grant_id) identifier(grant_id);
    if (mission_id) identifier(mission_id);
    const row = this.db.prepare('SELECT * FROM cp_developer_autonomy_workspaces WHERE workspace_id=?').get(workspaceId);
    if (!row || row.state !== 'ready') throw Error('Ready task workspace required');
    const now = Date.now();
    const record = JSON.parse(row.record);
    record.grant_id = grant_id || null;
    record.mission_id = mission_id || null;
    record.bound_at = now;
    this.db.prepare("UPDATE cp_developer_autonomy_workspaces SET grant_id=?, mission_id=?, state='bound', record=?, updated_at=? WHERE workspace_id=?")
      .run(grant_id || null, mission_id || null, JSON.stringify(record), now, workspaceId);
    return this.inspectWorkspace(workspaceId);
  }

  inspectWorkspace(workspaceId) {
    identifier(workspaceId);
    const row = this.db.prepare('SELECT * FROM cp_developer_autonomy_workspaces WHERE workspace_id=?').get(workspaceId);
    if (!row) return null;
    return {
      ...JSON.parse(row.record),
      grant_id: row.grant_id,
      mission_id: row.mission_id,
      state: row.state,
      disposable: row.disposable === 1,
      authority: false
    };
  }

  cleanupWorkspace(input, owner) {
    return transaction(this.db, () => this.cleanupOwnedWorkspace(input, owner));
  }

  cleanupOwnedWorkspace(input, owner) {
    this.owner(owner);
    object(input, ['workspace_id', 'confirmed']);
    if (input.confirmed !== true) throw Error('Explicit cleanup confirmation required');
    identifier(input.workspace_id);
    const row = this.db.prepare('SELECT * FROM cp_developer_autonomy_workspaces WHERE workspace_id=?').get(input.workspace_id);
    if (!row) throw Error('Unknown workspace');
    if (!['ready', 'bound', 'held'].includes(row.state)) throw Error('Workspace not eligible for cleanup');
    const record = JSON.parse(row.record);
    const decision = this.cleanupDecision(row, record);
    const now = Date.now();
    if (decision.action !== 'clean') {
      this.db.prepare("UPDATE cp_developer_autonomy_workspaces SET state='held', record=?, updated_at=? WHERE workspace_id=?")
        .run(JSON.stringify({ ...record, cleanup: decision }), now, input.workspace_id);
      this.bridge.controlStore.event('developer_autonomy.cleanup_held', null, {
        workspace_id: input.workspace_id, reason: decision.reason, authority: false
      });
      return { workspace_id: input.workspace_id, state: 'held', cleanup: decision, authority: false };
    }
    // Remove only the disposable clone directory. Never touch the source repository.
    try {
      this.assertWorkspace({ ...record, state: row.state });
      const quarantine = path.join(record.container, '.cleanup-' + randomUUID());
      fs.renameSync(row.path, quarantine);
      const moved = directoryIdentity(quarantine, true), expected = record.identities[0];
      if (moved.dev !== expected.dev || moved.ino !== expected.ino) throw Error('Workspace identity changed during cleanup; preserved for review');
      assertIdentities(record.identities.slice(1));
      fs.rmSync(quarantine, { recursive: true });
    } catch (e) {
      const held = { ...record, cleanup: { action: 'hold', reason: 'workspace_remove_failed', detail: String(e.message || e).slice(0, 200) } };
      this.db.prepare("UPDATE cp_developer_autonomy_workspaces SET state='held', record=?, updated_at=? WHERE workspace_id=?")
        .run(JSON.stringify(held), now, input.workspace_id);
      return { workspace_id: input.workspace_id, state: 'held', cleanup: held.cleanup, authority: false };
    }
    try {
      const policy = this.inspect(row.policy_id);
      if (policy?.project_id) {
        const project = this.bridge.projects.getProject(policy.project_id);
        if (project?.repositories?.includes(row.path)) {
          this.bridge.projects.updateProject(project.projectId, {
            repositories: project.repositories.filter(r => r !== row.path)
          });
        }
      }
    } catch { /* project unbind is best-effort; Mission history retained */ }
    this.db.prepare("UPDATE cp_developer_autonomy_workspaces SET state='cleaned', record=?, updated_at=? WHERE workspace_id=?")
      .run(JSON.stringify({ ...record, cleanup: decision, cleaned_at: now }), now, input.workspace_id);
    this.bridge.controlStore.event('developer_autonomy.workspace_cleaned', null, {
      workspace_id: input.workspace_id, reason: decision.reason, authority: false
    });
    return { workspace_id: input.workspace_id, state: 'cleaned', cleanup: decision, authority: false };
  }

  cleanupDecision(row, record) {
    if (row.disposable !== 1) {
      return { action: 'hold', reason: 'not_disposable', note: 'Only task-owned disposable workspaces may be removed automatically.' };
    }
    try { this.assertWorkspace({ ...record, state: row.state }); }
    catch { return { action: 'hold', reason: 'workspace_identity_or_containment_changed' }; }
    const missions = this.db.prepare("SELECT id FROM cp_missions WHERE json_extract(envelope,'$.workspace')=?").all(row.path)
      .map(item => this.bridge.controlStore.requireMission(item.id));
    if (!this.workspaceIdle(row.path)) return { action: 'hold', reason: 'active_or_unverified_writer' };
    if (missions.length && !this.lineageSettled(missions)) return { action: 'hold', reason: 'mission_not_settled' };
    if (row.grant_id && !missions.length && this.inspectGrant(row.grant_id)?.state === 'active') return { action: 'hold', reason: 'grant_not_settled' };
    const flags = safeGit(row.path, ['ls-files', '-v', '-z']);
    if (!flags.ok || flags.out.split('\0').some(entry => entry && (/^[a-z]/.test(entry) || entry[0] === 'S'))) return { action: 'hold', reason: 'hidden_index_content_retained' };
    const ignored = safeGit(row.path, ['ls-files', '--others', '--ignored', '--exclude-standard']);
    if (!ignored.ok || ignored.out) return { action: 'hold', reason: 'ignored_or_unknown_content_retained' };
    let dirty = [];
    try { dirty = workspaceDirty(record.path); }
    catch {
      return { action: 'hold', reason: 'workspace_status_unknown' };
    }
    if (dirty.length) {
      return { action: 'hold', reason: 'uncommitted_or_unique_content', dirty: dirty.slice(0, 20) };
    }
    // Unique commits on the task branch beyond base are evidence — HOLD unless empty of unique content.
    const ahead = safeGit(record.path, ['rev-list', '--count', '--all', '--reflog', '--not', record.base_sha || 'HEAD']);
    if (!ahead.ok) return { action: 'hold', reason: 'history_unknown' };
    const count = Number(ahead.out || 0);
    if (Number.isFinite(count) && count > 0) {
      return { action: 'hold', reason: 'unique_commits_retained', commits_ahead: count };
    }
    return { action: 'clean', reason: 'task_owned_disposable_clean', note: 'Mission and evidence records remain in the control plane.' };
  }

  // --- Short-lived grants ----------------------------------------------------

  issueGrant(input, owner) {
    return transaction(this.db, () => this.issueGrantRecord(input, owner));
  }

  issueGrantRecord(input, owner) {
    this.owner(owner);
    object(input, [
      'policy_id', 'request_id', 'workspace', 'workspace_id', 'allowed_files',
      'diff_check', 'tests', 'workflow', 'repair_budget', 'objective'
    ]);
    identifier(input.policy_id);
    identifier(input.request_id);
    text(input.objective, 'objective', 4000);
    this.workspacePath(input.workspace);
    const policy = this.inspect(input.policy_id);
    if (!policy || policy.state !== 'active') throw Error('Active Developer Autonomy policy required');
    this.assertPolicyBoundaries(policy);
    if (!WORKFLOWS.includes(input.workflow) || !policy.workflows.includes(input.workflow)) {
      throw Error('Workflow not permitted by standing policy');
    }
    const existing = this.db.prepare('SELECT * FROM cp_developer_autonomy_grants WHERE request_id=?').get(input.request_id);
    if (existing) {
      const prev = JSON.parse(existing.record).record;
      if (prev.policy_id !== input.policy_id || prev.workspace_id !== (input.workspace_id || null) || fingerprint(prev.scope) !== fingerprint(this.grantScopePayload(input, policy))) {
        throw Error('Grant request_id replay with different scope denied');
      }
      return this.inspectGrant(existing.grant_id);
    }

    const concurrent = this.reservations(policy.policy_id);
    if (concurrent >= policy.budgets.max_concurrent_missions) throw Error('Concurrent Mission budget exhausted');

    const workspace = fs.realpathSync(input.workspace);
    if (require('./control-execution').repositoryRoot(workspace) !== workspace) {
      throw Error('Grant workspace must be repository root');
    }
    // Workspace must be the enrolled repository or a task-owned disposable derived from it.
    let workspaceId = input.workspace_id || null;
    if (workspaceId) {
      identifier(workspaceId);
      const ws = this.inspectWorkspace(workspaceId);
      if (!ws || ws.policy_id !== policy.policy_id || fs.realpathSync(ws.path) !== workspace) {
        throw Error('Workspace binding mismatch');
      }
      this.assertWorkspace(ws);
      if (ws.grant_id) throw Error('Workspace already bound to a grant');
    } else if (workspace !== policy.repository) {
      throw Error('Unregistered disposable workspace; prepareWorkspace first');
    }

    if (!Array.isArray(input.allowed_files) || !input.allowed_files.length
      || input.allowed_files.length > policy.budgets.max_files
      || new Set(input.allowed_files).size !== input.allowed_files.length) {
      throw Error('Exact allowed files within policy budget required');
    }
    for (const f of input.allowed_files) writableFile(workspace, f);
    this.assertVerifiers(policy, workspace, input.allowed_files);
    this.assertPreparationCapacity(policy, 0, { label: 'grant issuance' });

    const diffCheck = input.diff_check || policy.verification_defaults.diff_check;
    const tests = input.tests || policy.verification_defaults.tests;
    text(diffCheck, 'diff-check', 100);
    if (!Array.isArray(tests) || !tests.length || tests.length > 4) throw Error('Focused tests required');
    for (const label of [diffCheck, ...tests]) text(label, 'registered task label', 100);
    if (diffCheck !== policy.verification_defaults.diff_check || fingerprint([...tests].sort()) !== fingerprint([...policy.verification_defaults.tests].sort())) throw Error('Verification must use enrolled tasks');
    const raw = fs.readFileSync(path.join(workspace, '.vscode/tasks.json'), 'utf8');
    const tasks = JSON.parse(raw).tasks;
    for (const label of [diffCheck, ...tests]) {
      const matches = tasks.filter(t => t.label === label);
      if (matches.length !== 1 || matches[0].type !== 'process') throw Error('Unique registered process task required');
    }
    const dirty = workspaceDirty(workspace);
    if (dirty.some(f => input.allowed_files.includes(f))) throw Error('Requested changes overlap dirty work');

    const repairBudget = input.repair_budget === undefined ? policy.budgets.max_repairs : input.repair_budget;
    if (!Number.isInteger(repairBudget) || repairBudget < 0 || repairBudget > policy.budgets.max_repairs) {
      throw Error('Repair budget exceeds standing policy');
    }

    const now = Date.now();
    const ttl = policy.budgets.grant_ttl_minutes * 60000;
    const grantId = randomUUID();
    const scope = this.grantScopePayload(input, policy, { workspace, diffCheck, tests, repairBudget });
    // Mission authority mirrors WORK templates: scoped read/write + local tests.
    // Feature branches and draft-PR metadata are host-prepared outside Manifest V1
    // publication permissions (push/merge remain forbidden in the Manifest).
    const permissions = {
      repository: ['read', 'write'],
      runtime: ['diagnostic', 'test'],
      network: ['localhost'],
      secrets: [],
      data: ['read', 'workspace_write']
    };
    const baseline = require('./control-context').workspaceSnapshot(workspace);
    const grantRecord = {
      version: 1,
      grant_id: grantId,
      policy_id: policy.policy_id,
      policy_hash: policy.policy_hash,
      request_id: input.request_id,
      workspace_id: workspaceId,
      objective: input.objective,
      workflow: input.workflow,
      scope,
      permissions,
      privacy: 'local_only',
      data_class: 'public',
      workers: policy.workers.filter(w => w === 'opencode' || policy.workers.includes(w)),
      capability_scopes: ['repo', 'developer_environment'],
      project_id: policy.project_id,
      goal_id: policy.goal_id,
      repair_budget: repairBudget,
      created_at: now,
      expires_at: now + ttl,
      never_auto: NEVER_AUTO,
      baseline: { head: baseline.head, branch: baseline.branch, dirty: baseline.dirty }
    };
    grantRecord.manifest = {
      mission: {
        id: 'da-grant-' + grantId,
        version: 1,
        title: 'Developer Autonomy grant',
        repository: { root: workspace, branch: baseline.branch },
        authority: { level: 'Development' },
        duration: { expires_after: policy.budgets.grant_ttl_minutes + 'm' },
        scope: { repositories: [workspace], include: scope.allowed_files, exclude: [] },
        permissions: {
          filesystem: { read: true, write: true, delete: false },
          repository: { branch: false, commit: false, push: false, merge: false },
          runtime: { test: true, lint: policy.workflows.includes('lint'), typecheck: policy.workflows.includes('typecheck'), restart_local: false },
          network: { localhost: true, internet: false },
          providers: { local_reasoning: true, approved_external: false },
          memory: { read: true, search: true, write: false, delete: false }
        },
        evidence: { required: ['tests', 'diff_check'], optional: [] },
        settlement: { review_required: true, merge_allowed: false, deploy_allowed: false },
        budget: {
          max_files_changed: scope.allowed_files.length,
          max_commits: 0,
          max_runtime_hours: Math.min(policy.budgets.max_runtime_hours, 24),
          max_external_reasoning_calls: 0,
          max_memory_injections: 20
        }
      }
    };
    require('./mission-manifest').normalizeManifest(grantRecord.manifest, {
      workspace,
      allowedFiles: scope.allowed_files,
      verification: scope.verification
    });
    const hash = fingerprint(grantRecord);
    const seal = this.bridge.missionAuthority.sealManifest({
      mission_id: 'developer-autonomy-grant:' + grantId,
      manifest_hash: hash
    });
    if (!seal) throw Error('Existing operator signing authority required');
    this.db.prepare('INSERT INTO cp_developer_autonomy_grants VALUES(?,?,?,?,?,?,?)')
      .run(grantId, policy.policy_id, input.request_id, JSON.stringify({ record: grantRecord, hash, seal }), 'active', now, grantRecord.expires_at);
    if (workspaceId) this.bindWorkspace(workspaceId, { grant_id: grantId });
    this.bridge.controlStore.event('developer_autonomy.grant_issued', null, {
      grant_id: grantId, policy_id: policy.policy_id, hash, expires_at: grantRecord.expires_at, authority: false
    });
    return this.inspectGrant(grantId);
  }

  grantScopePayload(input, policy, resolved = {}) {
    return {
      workspace: resolved.workspace || input.workspace,
      allowed_files: [...input.allowed_files].sort(),
      verification: {
        diff_check: resolved.diffCheck || input.diff_check || policy.verification_defaults.diff_check,
        tests: [...(resolved.tests || input.tests || policy.verification_defaults.tests)],
        syntax: []
      },
      workflow: input.workflow,
      repair_budget: resolved.repairBudget ?? input.repair_budget ?? policy.budgets.max_repairs,
      objective: input.objective
    };
  }

  readGrant(grantId) {
    identifier(grantId);
    const row = this.db.prepare('SELECT * FROM cp_developer_autonomy_grants WHERE grant_id=?').get(grantId);
    if (!row) return null;
    const r = JSON.parse(row.record);
    if (r.record.grant_id !== grantId || r.record.version !== 1 || fingerprint(r.record) !== r.hash
      || !this.bridge.missionAuthority.verifyManifestSeal(r.seal, {
        mission_id: 'developer-autonomy-grant:' + grantId,
        manifest_hash: r.hash
      })) {
      throw Error('Developer Autonomy grant integrity mismatch');
    }
    return { ...r, state: row.state, expires_at: row.expires_at };
  }

  inspectGrant(grantId) {
    const r = this.readGrant(grantId);
    if (!r) return null;
    this.reservations(r.record.policy_id);
    let state = this.db.prepare('SELECT state FROM cp_developer_autonomy_grants WHERE grant_id=?').get(grantId).state;
    if (state === 'active' && r.expires_at <= Date.now()) state = 'expired';
    if (state === 'active') {
      try {
        const policy = this.inspect(r.record.policy_id);
        if (!policy || policy.state !== 'active' || policy.policy_hash !== r.record.policy_hash) state = 'revoked';
      } catch { state = 'invalid'; }
    }
    return { ...r.record, grant_hash: r.hash, state, authority: false };
  }

  /**
   * Mission ceilings derived from an active grant — analogous to WorkTemplates.template().
   * allowExpired: owner Acceptance of an already-verified Mission may proceed after grant TTL
   * expiry; dispatch, repair, and new authorization still require an active grant.
   */
  grantScope(grantId, { allowExpired = false } = {}) {
    const g = this.inspectGrant(grantId);
    if (!g || (g.state !== 'active' && !(allowExpired && g.state === 'expired'))) return null;
    const policy = this.inspect(g.policy_id);
    if (!policy || policy.state !== 'active') return null;
    this.assertPolicyBoundaries(policy);
    const workspace = g.scope.workspace;
    if (g.workspace_id) this.assertWorkspace(this.inspectWorkspace(g.workspace_id));
    this.assertVerifiers(policy, workspace, g.scope.allowed_files);
    this.assertPreparationCapacity(policy, 0, { label: 'grant scope' });
    for (const f of g.scope.allowed_files) writableFile(workspace, f);
    return {
      project_id: g.project_id,
      goal_id: g.goal_id,
      workspace,
      allowed_files: g.scope.allowed_files,
      verification: g.scope.verification,
      capability_scopes: g.capability_scopes,
      criteria: [{
        id: 'owner-review',
        type: 'operator_review',
        description: 'Independent focused verification and explicit operator Acceptance required.'
      }],
      authority: {
        level: 'development',
        permissions: g.permissions,
        filesystem: { read: [workspace], write: [workspace] },
        expiresAt: g.expires_at
      },
      manifest: g.manifest,
      dispatch_policy: POLICY,
      fallback_agents: [],
      preferred_agent: 'opencode',
      developer_autonomy: {
        policy_id: g.policy_id,
        grant_id: g.grant_id,
        hash: g.grant_hash,
        workspace_id: g.workspace_id || null,
        repair_budget: g.repair_budget
      },
      privacy: g.privacy,
      data_class: g.data_class,
      workers: g.workers,
      repair_budget: g.repair_budget
    };
  }

  assertInput(input) {
    const ref = input.developer_autonomy;
    object(ref, ['policy_id', 'grant_id', 'hash', 'workspace_id', 'repair_budget']);
    let t = this.grantScope(ref.grant_id);
    if (t && input.cognitive_request_id && input.preferred_agent === 'host') t = require('./cognitive-router').readScope(t, this.bridge.zeroSetupWork.read(input.cognitive_request_id));
    if (!t || fingerprint(ref) !== fingerprint(t.developer_autonomy)) {
      throw Error('Developer Autonomy grant expired, revoked or changed');
    }
    // API projection placeholders are never authority. Fail closed rather than
    // treating redacted display values as a typed permission allowlist.
    if (input.authority?.permissions?.secrets === '[omitted]' || typeof input.authority?.permissions?.secrets === 'string') {
      throw Error('Immutable grant ceiling mismatch');
    }
    for (const key of ['project_id', 'goal_id', 'workspace', 'allowed_files', 'verification', 'capability_scopes', 'authority', 'dispatch_policy', 'fallback_agents', 'manifest']) {
      const canonical = value => key === 'dispatch_policy' ? require('./agent-dispatch').dispatchPolicy(value) : value;
      if (fingerprint(canonical(input[key])) !== fingerprint(canonical(t[key]))) throw Error('Immutable grant ceiling mismatch');
    }
    if (input.preferred_agent !== 'opencode' && !(t.workers || []).includes(input.preferred_agent)) {
      throw Error('Worker not permitted by Developer Autonomy grant');
    }
    if (input.preferred_agent !== 'opencode') {
      // External workers require independent qualification at dispatch; deny automatic Acceptance.
    }
    if (input.automatic_acceptance || input.fixture_auto_acceptance || input.risk_auto_acceptance) {
      throw Error('Developer Autonomy requires OpenCode-local defaults and explicit Acceptance');
    }
    if (input.preferred_agent === 'opencode' && (input.fallback_agents || []).length) {
      throw Error('OpenCode grant requires no fallbacks');
    }
  }

  assertMission(m, { allowExpiredGrant = false } = {}) {
    const ref = m.envelope?.developer_autonomy;
    if (!ref) return;
    if (!m.envelope.contract) throw Error('Developer Autonomy contract required');
    const t = this.grantScope(ref.grant_id, { allowExpired: allowExpiredGrant });
    if (!t || fingerprint(t.developer_autonomy) !== fingerprint(ref)) {
      throw Error(allowExpiredGrant
        ? 'Developer Autonomy grant revoked or changed'
        : 'Developer Autonomy grant expired, revoked or changed');
    }
  }

  assertDispatch(m) {
    this.assertMission(m);
    const ref = m.envelope?.developer_autonomy;
    if (!ref) return;
    const g = this.inspectGrant(ref.grant_id);
    if (!g || g.state !== 'active') throw Error('Developer Autonomy grant not active at dispatch');
  }

  // --- Draft PR preparation (never merge) ------------------------------------

  prepareDraftPr(input, owner) {
    this.owner(owner);
    object(input, ['grant_id', 'mission_id', 'title', 'body', 'confirmed']);
    if (input.confirmed !== true) throw Error('Explicit draft PR preparation consent required');
    identifier(input.grant_id);
    if (input.mission_id) identifier(input.mission_id);
    text(input.title, 'PR title', 200);
    text(input.body || 'Prepared by Developer Autonomy. Review required. Never auto-merged.', 'PR body', 8000);
    const g = this.inspectGrant(input.grant_id);
    if (!g || g.state !== 'active') throw Error('Active grant required');
    const policy = this.inspect(g.policy_id);
    if (!policy?.workflows.includes('draft_pr')) throw Error('Standing policy does not permit draft_pr');
    const workspace = g.scope.workspace;
    const branch = safeGit(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (!branch.ok || branch.out === 'HEAD' || branch.out === 'main' || branch.out === 'master') {
      throw Error('Feature branch required for draft PR preparation');
    }
    const head = safeGit(workspace, ['rev-parse', 'HEAD']);
    if (!head.ok) throw Error('HEAD unavailable');
    const dirty = workspaceDirty(workspace);
    if (dirty.length) throw Error('Commit or clean workspace before draft PR preparation');
    const plan = {
      version: 1,
      action: 'prepare_draft_pr',
      grant_id: g.grant_id,
      mission_id: input.mission_id || null,
      workspace,
      branch: branch.out,
      head_sha: head.out,
      title: input.title,
      body: input.body,
      draft: true,
      merge: false,
      deploy: false,
      push_required: true,
      status: 'prepared',
      note: 'Host prepares draft PR metadata only. Merge and deploy remain separately gated.',
      authority: false,
      prepared_at: Date.now()
    };
    this.bridge.controlStore.event('developer_autonomy.draft_pr_prepared', input.mission_id || null, {
      grant_id: g.grant_id, branch: plan.branch, head_sha: plan.head_sha, authority: false
    });
    return plan;
  }

  // --- Routine authorization helper (enroll once, then Fix this) -------------

  routineFiles(policy, instruction, exactFile) {
    const trusted = new Set(policy.verifier_baseline.files.map(item => item.path));
    const eligible = git(policy.repository, ['ls-files', '-z']).split('\0').filter(Boolean).filter(name => {
      try { file(policy.repository, name); return !trusted.has(name); } catch { return false; }
    });
    const named = exactFile ? eligible.filter(name => name === exactFile)
      : eligible.filter(name => instruction.split(/[\s`"'(),;:]+/).includes(name));
    const files = named.length ? named : eligible.length === 1 ? eligible : [];
    return files.length && files.length <= policy.budgets.max_files ? files : [];
  }

  authorizeRoutine(input, owner) {
    this.owner(owner);
    object(input, [
      'policy_id', 'request_id', 'objective', 'allowed_files', 'workflow',
      'prefer_disposable', 'diff_check', 'tests', 'repair_budget', 'criteria'
    ]);
    identifier(input.policy_id);
    identifier(input.request_id);
    const policy = this.inspect(input.policy_id);
    if (!policy || policy.state !== 'active') throw Error('Active Developer Autonomy policy required');
    const previous = this.db.prepare('SELECT grant_id FROM cp_developer_autonomy_grants WHERE request_id=?').get(input.request_id);
    if (!previous && this.reservations(policy.policy_id) >= policy.budgets.max_concurrent_missions) throw Error('Concurrent Mission budget exhausted');
    const workspace = this.prepareWorkspace({
      policy_id: policy.policy_id,
      request_id: input.request_id + ':workspace',
      prefer_disposable: input.prefer_disposable === true,
      branch_prefix: 'airodrom/da'
    }, owner);
    const grant = this.issueGrant({
      policy_id: policy.policy_id,
      request_id: input.request_id,
      workspace: workspace.path,
      workspace_id: workspace.workspace_id,
      allowed_files: input.allowed_files,
      diff_check: input.diff_check,
      tests: input.tests,
      workflow: input.workflow || 'routine_edit',
      repair_budget: input.repair_budget,
      objective: input.objective
    }, owner);
    const scope = this.grantScope(grant.grant_id);
    const criteria = input.criteria || scope.criteria;
    return {
      policy,
      workspace,
      grant,
      mission_input: {
        request_id: input.request_id + ':mission',
        project_id: scope.project_id,
        goal_id: scope.goal_id,
        objective: input.objective,
        workspace: scope.workspace,
        allowed_files: scope.allowed_files,
        criteria,
        verification: scope.verification,
        preferred_agent: 'opencode',
        fallback_agents: [],
        capability_scopes: scope.capability_scopes,
        authority: scope.authority,
        manifest: scope.manifest,
        dispatch_policy: scope.dispatch_policy,
        developer_autonomy: scope.developer_autonomy
      },
      authority: false
    };
  }

  status(owner = 'operator') {
    this.owner(owner);
    const policies = this.list(owner);
    const active = policies.filter(p => p.state === 'active');
    return {
      mechanism: 'developer_autonomy',
      active_count: active.length,
      policies: policies.slice(0, 40).map(p => ({
        policy_id: p.policy_id,
        policy_hash: p.policy_hash || null,
        alias: p.alias,
        repository: p.repository,
        state: p.state,
        expires_at: p.expires_at || null,
        workflows: p.workflows || [],
        workers: p.workers || ['opencode'],
        budgets: p.budgets || null,
        cognitive: p.cognitive || null
      })),
      never_auto: NEVER_AUTO,
      note: active.length
        ? 'Active standing Developer Autonomy policies authorize routine local work inside enrolled repositories without renewing WORK templates per task. Short-lived Mission grants remain validated at dispatch.'
        : 'No active Developer Autonomy policy. Authenticated local enrollment is required once per repository.',
      authority: false
    };
  }
}

module.exports = { DeveloperAutonomy, WORKFLOWS, NEVER_AUTO, DEFAULT_BUDGETS, auxiliaryApplicationTest, externalWorkerEligible };
