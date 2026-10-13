'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');

const CONFIG = path.join(__dirname, '../config/research-profile-v1.json');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;
const STAGING_NAME = 'research-website-only';
const STAGING_README = '# Website-only research staging\n\nPrivate host staging for public website research. Not a product baseline.\n';
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const exactKeys = (value, keys) => !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const COMPARISON_DENIED = 'Repository comparison needs a configured and independently verified product repository. Website-only public research does not require it.';
const STAGING_UNSAFE = 'Website-only research staging is unsafe';
const STAGING_CHANGED = 'Website-only research staging changed';

/** Darwin system roots that may appear as symlinks in absolute paths (e.g. /tmp → /private/tmp). */
const APPROVED_SYSTEM_SYMLINKS = Object.freeze(process.platform === 'darwin'
  ? Object.freeze({ '/tmp': '/private/tmp', '/var': '/private/var' })
  : Object.freeze({}));

function loadConfig() {
  const c = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  if (c.version !== 1 || c.project !== 'Arecibo' || c.workspace_sibling !== 'arecibo-core') throw Error('Unreviewed research baseline profile');
  return c;
}

function researchBudgets(config = loadConfig()) {
  return { maxPages: config.maxPages, maxActions: config.maxActions, timeoutMs: config.timeoutMs };
}

function gitEnv() {
  return { PATH: '/usr/bin:/bin', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
}

function approvedSystemSymlink(lexicalComponent) {
  const expected = APPROVED_SYSTEM_SYMLINKS[lexicalComponent];
  if (!expected) return false;
  let real;
  try { real = fs.realpathSync(lexicalComponent); } catch { return false; }
  return real === expected;
}

/**
 * Inspect the original absolute path with lstat at every component.
 * Reject unapproved symlink traversal; allow only known macOS system roots.
 * The final component must be a real directory (never a symlink).
 */
function assertCanonicalDirectory(directory, { privateMode = false, mustExist = true } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0')) throw Error(STAGING_UNSAFE);
  const lexical = path.resolve(directory);
  const parts = lexical.split(path.sep).filter(Boolean);
  if (!parts.length) throw Error(STAGING_UNSAFE);

  let current = path.sep;
  for (let i = 0; i < parts.length; i++) {
    const next = path.join(current, parts[i]);
    const isLast = i === parts.length - 1;
    let st;
    try { st = fs.lstatSync(next); } catch (error) {
      if (!mustExist && isLast && error?.code === 'ENOENT') return { lexical, real: null, identity: null };
      throw Error(STAGING_UNSAFE);
    }
    if (st.isSymbolicLink()) {
      // Final directory must never be a symlink (blocks staging substitution).
      if (isLast) throw Error(STAGING_UNSAFE);
      if (!approvedSystemSymlink(next)) throw Error(STAGING_UNSAFE);
      current = fs.realpathSync(next);
      const followed = fs.lstatSync(current);
      if (followed.isSymbolicLink() || !followed.isDirectory()) throw Error(STAGING_UNSAFE);
      continue;
    }
    if (!st.isDirectory()) throw Error(STAGING_UNSAFE);
    current = next;
  }

  const real = fs.realpathSync(current);
  // After lexical walk, confirm the resolved leaf has no symlink aliasing and matches ownership.
  const leaf = fs.lstatSync(real);
  if (leaf.isSymbolicLink() || !leaf.isDirectory()) throw Error(STAGING_UNSAFE);
  if (leaf.uid !== process.getuid?.()) throw Error(STAGING_UNSAFE);
  if (privateMode && (leaf.mode & 0o077)) throw Error(STAGING_UNSAFE);
  // Reject if realpath escaped outside the followed lexical chain's final directory identity.
  if (fs.realpathSync(lexical) !== real) throw Error(STAGING_UNSAFE);
  return { lexical, real, identity: directoryIdentity(real, leaf) };
}

function directoryIdentity(real, st = fs.lstatSync(real)) {
  // nlink omitted: creating .git changes directory link count without replacement.
  return hash({
    path: real,
    dev: st.dev,
    ino: st.ino,
    uid: st.uid,
    mode: st.mode & 0o7777
  });
}

function assertConfiguredProductRepository(directory, config = loadConfig()) {
  const expectedLexical = path.resolve(__dirname, '../../', config.workspace_sibling);
  let expected, candidate;
  try {
    expected = assertCanonicalDirectory(expectedLexical, { privateMode: false });
    candidate = assertCanonicalDirectory(directory, { privateMode: false });
  } catch {
    throw Error(COMPARISON_DENIED);
  }
  if (!expected.real || !candidate.real || candidate.real !== expected.real) throw Error(COMPARISON_DENIED);
  const top = spawnSync('/usr/bin/git', ['-C', candidate.real, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 4096, env: gitEnv()
  });
  if (top.status !== 0) throw Error(COMPARISON_DENIED);
  let topReal;
  try { topReal = fs.realpathSync(String(top.stdout).trim()); } catch { throw Error(COMPARISON_DENIED); }
  if (topReal !== candidate.real) throw Error(COMPARISON_DENIED);
  const inside = spawnSync('/usr/bin/git', ['-C', candidate.real, 'rev-parse', '--is-inside-work-tree'], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 64, env: gitEnv()
  });
  if (inside.status !== 0 || String(inside.stdout).trim() !== 'true') throw Error(COMPARISON_DENIED);
  return candidate.real;
}

/** Comparison research only: independently verify the configured sibling repository. Never invent a baseline. */
function comparisonWorkspace(config = loadConfig()) {
  try {
    return assertConfiguredProductRepository(path.resolve(__dirname, '../../', config.workspace_sibling), config);
  } catch (error) {
    if (error?.message === COMPARISON_DENIED) throw error;
    throw Error(COMPARISON_DENIED);
  }
}

/**
 * Synthetic fixtures may supply an explicit workspace. Still reject symlinks and
 * non-toplevel Git checkouts; never treat an arbitrary directory as the product repo
 * unless it matches the configured sibling when not synthetic.
 */
function verifyComparisonWorkspace(directory, { configured = false, config = loadConfig() } = {}) {
  if (configured) return assertConfiguredProductRepository(directory, config);
  try {
    const checked = assertCanonicalDirectory(directory, { privateMode: false });
    const top = spawnSync('/usr/bin/git', ['-C', checked.real, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8', timeout: 5000, maxBuffer: 4096, env: gitEnv()
    });
    if (top.status !== 0) throw Error(COMPARISON_DENIED);
    const topReal = fs.realpathSync(String(top.stdout).trim());
    if (topReal !== checked.real) throw Error(COMPARISON_DENIED);
    return checked.real;
  } catch (error) {
    if (error?.message === COMPARISON_DENIED || error?.message === STAGING_UNSAFE) throw Error(COMPARISON_DENIED);
    throw Error(COMPARISON_DENIED);
  }
}

function researchProfile() {
  const config = loadConfig();
  const budgets = researchBudgets(config);
  // Lazy path only — existence is enforced when comparison research is created.
  return { workspace: path.resolve(__dirname, '../../', config.workspace_sibling), ...budgets };
}

function stagingDigest(root) {
  const entries = fs.readdirSync(root).sort();
  if (entries.some(name => name !== 'README.md' && name !== '.git')) throw Error(STAGING_CHANGED);
  if (!entries.includes('README.md') || !entries.includes('.git')) throw Error(STAGING_CHANGED);
  const readmePath = path.join(root, 'README.md');
  const gitPath = path.join(root, '.git');
  const readmeStat = fs.lstatSync(readmePath);
  const gitStat = fs.lstatSync(gitPath);
  if (readmeStat.isSymbolicLink() || !readmeStat.isFile() || readmeStat.uid !== process.getuid?.() || (readmeStat.mode & 0o077)) throw Error(STAGING_UNSAFE);
  if (gitStat.isSymbolicLink() || (!gitStat.isDirectory() && !gitStat.isFile()) || gitStat.uid !== process.getuid?.()) throw Error(STAGING_UNSAFE);
  const fd = fs.openSync(readmePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let readme;
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.() || (st.mode & 0o077) || st.size > 4096) throw Error(STAGING_UNSAFE);
    readme = fs.readFileSync(fd, 'utf8');
  } finally { fs.closeSync(fd); }
  if (readme !== STAGING_README) throw Error(STAGING_CHANGED);
  const head = spawnSync('/usr/bin/git', ['-C', root, 'rev-parse', 'HEAD'], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 64, env: gitEnv()
  });
  if (head.status !== 0 || !/^[a-f0-9]{40}$/.test(String(head.stdout).trim())) throw Error(STAGING_CHANGED);
  const gitDir = spawnSync('/usr/bin/git', ['-C', root, 'rev-parse', '--git-dir'], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 256, env: gitEnv()
  });
  if (gitDir.status !== 0 || String(gitDir.stdout).trim() !== '.git') throw Error(STAGING_CHANGED);
  return hash({
    entries,
    readme: hash(readme),
    git: gitStat.isDirectory() ? 'dir' : 'file',
    head: String(head.stdout).trim(),
    identity: directoryIdentity(root)
  });
}

function ensureWebsiteOnlyWorkspace(dataDir) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw Error('Private research data directory required');
  // Lexical walk of dataDir and parent before any staging create/write.
  const dataChecked = assertCanonicalDirectory(dataDir, { privateMode: true });
  const parentChecked = assertCanonicalDirectory(path.dirname(dataChecked.real), { privateMode: false });
  const lexical = path.resolve(path.join(parentChecked.real, STAGING_NAME));
  if (path.basename(lexical) !== STAGING_NAME || path.dirname(lexical) !== parentChecked.real) throw Error(STAGING_UNSAFE);

  let existed = false;
  try {
    const existing = fs.lstatSync(lexical);
    existed = true;
    // Reject unsafe existing directories without chmod or writes.
    if (existing.isSymbolicLink() || !existing.isDirectory()) throw Error(STAGING_UNSAFE);
    assertCanonicalDirectory(lexical, { privateMode: true });
  } catch (error) {
    if (existed || error?.message === STAGING_UNSAFE) throw Error(STAGING_UNSAFE);
    if (error?.code !== 'ENOENT') throw Error(STAGING_UNSAFE);
  }

  if (!existed) {
    fs.mkdirSync(lexical, { recursive: false, mode: 0o700 });
    assertCanonicalDirectory(lexical, { privateMode: true });
  }

  const rootChecked = assertCanonicalDirectory(lexical, { privateMode: true });
  const root = rootChecked.real;
  const gitDir = path.join(root, '.git');
  let hasGit = false;
  try {
    const g = fs.lstatSync(gitDir);
    if (g.isSymbolicLink()) throw Error(STAGING_UNSAFE);
    hasGit = g.isDirectory() || g.isFile();
  } catch (error) {
    if (error?.message === STAGING_UNSAFE) throw error;
    if (error?.code !== 'ENOENT') throw Error(STAGING_UNSAFE);
  }

  if (!hasGit) {
    const readme = path.join(root, 'README.md');
    try {
      const prior = fs.lstatSync(readme);
      if (prior.isSymbolicLink() || !prior.isFile() || prior.uid !== process.getuid?.() || (prior.mode & 0o077)) throw Error(STAGING_UNSAFE);
      const existing = fs.readFileSync(readme, 'utf8');
      if (existing !== STAGING_README) throw Error(STAGING_UNSAFE);
    } catch (error) {
      if (error?.message === STAGING_UNSAFE) throw error;
      if (error?.code !== 'ENOENT') throw Error(STAGING_UNSAFE);
      fs.writeFileSync(readme, STAGING_README, { mode: 0o600, flag: 'wx' });
    }
    const git = (args) => {
      const r = spawnSync('/usr/bin/git', ['-C', root, ...args], { encoding: 'utf8', timeout: 10000, env: gitEnv() });
      if (r.status !== 0) throw Error('Website-only research staging could not be prepared');
    };
    git(['init', '-q']);
    git(['add', 'README.md']);
    git(['-c', 'user.name=Airodrom Research', '-c', 'user.email=research@localhost', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'Website-only research staging']);
  }

  const verified = assertCanonicalDirectory(root, { privateMode: true });
  if (verified.real !== root || verified.identity !== rootChecked.identity) throw Error(STAGING_UNSAFE);
  stagingDigest(verified.real);
  return verified.real;
}

/** Stable empty product baseline — never claims Arecibo coverage or invents repository evidence. */
class WebsiteOnlyBaseline {
  constructor(workspace) {
    if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) throw Error('Website-only workspace required');
    const checked = assertCanonicalDirectory(workspace, { privateMode: true });
    this.workspace = checked.real;
    this.workspace_identity = checked.identity;
    this.files = Object.freeze([]);
    this.features = Object.freeze([]);
    Object.freeze(this);
  }
  capture() {
    const staging_digest = stagingDigest(this.workspace);
    const core = {
      version: 1,
      id: randomUUID(),
      project: 'WebsiteOnly',
      head: '0'.repeat(40),
      evidence: [],
      unavailable: [],
      features: [],
      authority: false,
      workspace_identity: this.workspace_identity,
      staging_digest
    };
    return Object.freeze({ ...core, digest: hash({ ...core, scope: 'website_only_no_repository' }) });
  }
  verify(snapshot) {
    const keys = ['version', 'id', 'project', 'head', 'evidence', 'unavailable', 'features', 'authority', 'workspace_identity', 'staging_digest', 'digest'];
    if (!exactKeys(snapshot, keys)) throw Error('Invalid website-only baseline provenance');
    if (snapshot.version !== 1 || snapshot.project !== 'WebsiteOnly' || snapshot.authority !== false) throw Error('Invalid website-only baseline provenance');
    if (!UUID.test(snapshot.id) || !SHA.test(snapshot.digest) || snapshot.head !== '0'.repeat(40)) throw Error('Invalid website-only baseline provenance');
    if (!Array.isArray(snapshot.evidence) || snapshot.evidence.length || !Array.isArray(snapshot.unavailable) || snapshot.unavailable.length
      || !Array.isArray(snapshot.features) || snapshot.features.length) throw Error('Invalid website-only baseline provenance');
    if (snapshot.workspace_identity !== this.workspace_identity || !SHA.test(snapshot.workspace_identity)) throw Error('Website-only workspace identity changed');
    const { digest, ...core } = snapshot;
    if (hash({ ...core, scope: 'website_only_no_repository' }) !== digest) throw Error('Website-only baseline digest mismatch');
    const current = assertCanonicalDirectory(this.workspace, { privateMode: true });
    if (current.identity !== this.workspace_identity || current.real !== this.workspace) throw Error('Website-only workspace identity changed');
    if (stagingDigest(current.real) !== snapshot.staging_digest) throw Error(STAGING_CHANGED);
    return true;
  }
  workspaceSnapshot(_snapshot) {
    const staging_digest = stagingDigest(this.workspace);
    const core = {
      version: 1,
      scope: 'website_only_no_repository',
      head: '0'.repeat(40),
      files: {},
      dirty: [],
      unavailable: [],
      authority: false,
      workspace_identity: this.workspace_identity,
      staging_digest
    };
    return Object.freeze({ ...core, hash: hash(core) });
  }
}

function wantsRepositoryComparison(objective = '') {
  const prose = String(objective || '').replace(/https?:\/\/[^\s<>"'`]+/gi, ' ');
  return /\barecibo\b/i.test(prose) && (/\b(?:compare|comparison|versus|vs\.?|adopt|gap)\b/i.test(prose) || /\bfeatures\b/i.test(prose));
}

module.exports = {
  researchProfile,
  researchBudgets,
  comparisonWorkspace,
  verifyComparisonWorkspace,
  ensureWebsiteOnlyWorkspace,
  WebsiteOnlyBaseline,
  wantsRepositoryComparison,
  loadConfig,
  assertCanonicalDirectory,
  directoryIdentity,
  stagingDigest,
  STAGING_README,
  COMPARISON_DENIED,
  STAGING_UNSAFE,
  STAGING_CHANGED,
  APPROVED_SYSTEM_SYMLINKS
};
