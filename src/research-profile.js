'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');

const CONFIG = path.join(__dirname, '../config/research-profile-v1.json');
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

function loadConfig() {
  const c = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  if (c.version !== 1 || c.project !== 'Arecibo' || c.workspace_sibling !== 'arecibo-core') throw Error('Unreviewed research baseline profile');
  return c;
}

function researchBudgets(config = loadConfig()) {
  return { maxPages: config.maxPages, maxActions: config.maxActions, timeoutMs: config.timeoutMs };
}

/** Comparison research only: independently verify the configured sibling repository. Never invent a baseline. */
function comparisonWorkspace(config = loadConfig()) {
  const workspace = path.resolve(__dirname, '../../', config.workspace_sibling);
  try {
    const real = fs.realpathSync(workspace);
    const st = fs.lstatSync(real);
    if (!st.isDirectory() || st.isSymbolicLink()) throw Error('missing');
    const git = spawnSync('/usr/bin/git', ['-C', real, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8', timeout: 5000, maxBuffer: 64, env: { PATH: '/usr/bin:/bin', GIT_OPTIONAL_LOCKS: '0' }
    });
    if (git.status !== 0 || String(git.stdout).trim() !== 'true') throw Error('missing');
    return real;
  } catch {
    // Fail closed without leaking private install paths to the operator.
    throw Error('Repository comparison needs a configured and independently verified product repository. Website-only public research does not require it.');
  }
}

function researchProfile() {
  const config = loadConfig();
  const budgets = researchBudgets(config);
  // Lazy path only — existence is enforced when comparison research is created.
  return { workspace: path.resolve(__dirname, '../../', config.workspace_sibling), ...budgets };
}

function ensureWebsiteOnlyWorkspace(dataDir) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw Error('Private research data directory required');
  // Sibling of dataDir so SafetyPolicy does not treat bridge state as the Mission workspace.
  const parent = path.dirname(fs.realpathSync(dataDir));
  const root = path.join(parent, 'research-website-only');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(root, 0o700); } catch { /* best-effort private mode */ }
  const readme = path.join(root, 'README.md');
  if (!fs.existsSync(path.join(root, '.git'))) {
    fs.writeFileSync(readme, '# Website-only research staging\n\nPrivate host staging for public website research. Not a product baseline.\n', { mode: 0o600 });
    const git = (args) => {
      const r = spawnSync('/usr/bin/git', ['-C', root, ...args], {
        encoding: 'utf8', timeout: 10000, env: { PATH: '/usr/bin:/bin', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
      });
      if (r.status !== 0) throw Error('Website-only research staging could not be prepared');
    };
    git(['init', '-q']);
    git(['add', 'README.md']);
    git(['-c', 'user.name=Airodrom Research', '-c', 'user.email=research@localhost', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'Website-only research staging']);
  }
  const real = fs.realpathSync(root);
  const st = fs.lstatSync(real);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o077)) throw Error('Website-only research staging is unsafe');
  return real;
}

/** Stable empty product baseline — never claims Arecibo coverage or invents repository evidence. */
class WebsiteOnlyBaseline {
  constructor(workspace) {
    if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) throw Error('Website-only workspace required');
    this.workspace = fs.realpathSync(workspace);
    this.files = Object.freeze([]);
    this.features = Object.freeze([]);
    Object.freeze(this);
  }
  capture() {
    const core = { version: 1, project: 'WebsiteOnly', head: '0'.repeat(40), evidence: [], unavailable: [], features: [], authority: false };
    return Object.freeze({ ...core, id: randomUUID(), digest: hash({ ...core, scope: 'website_only_no_repository' }) });
  }
  verify(snapshot) {
    return !!snapshot && snapshot.version === 1 && snapshot.project === 'WebsiteOnly' && snapshot.authority === false
      && Array.isArray(snapshot.evidence) && snapshot.evidence.length === 0
      && Array.isArray(snapshot.features) && snapshot.features.length === 0
      && snapshot.head === '0'.repeat(40);
  }
  workspaceSnapshot(_snapshot) {
    const core = { version: 1, scope: 'website_only_no_repository', head: '0'.repeat(40), files: {}, dirty: [], unavailable: [], authority: false };
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
  ensureWebsiteOnlyWorkspace,
  WebsiteOnlyBaseline,
  wantsRepositoryComparison,
  loadConfig
};
