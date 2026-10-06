'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Credential, key, session and private-communication material is denied for both
// read and write in every scope, before and after symlink resolution.
const SENSITIVE_SEGMENT = /^(?:\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker|\.gcloud|gcloud|\.pi|\.codex|\.git|\.netrc|\.npmrc|\.pypirc|\.git-credentials|\.credentials\.json|\.claude\.json|\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|auth\.json|hosts\.yml|id_(?:rsa|ed25519|ecdsa|dsa)(?:\.pub)?|.+\.(?:pem|key|p12|pfx|keychain|keychain-db|kdbx|ovpn)|.+\.vscdb(?:\..*)?|Keychains|Cookies(?:-journal)?|Local Storage|Session Storage|IndexedDB|Login Data(?:-journal)?|Web Data(?:-journal)?|Network Persistent State|TransportSecurity|Trust Tokens|Messages|Mail|Safari|com\.apple\.TCC|\.(?:bash|zsh|python|node_repl|psql|mysql|sqlite)_history|\.history|\.zshrc|\.zshenv|\.zprofile|\.bashrc|\.bash_profile|\.profile)$/i;

// Any path segment that names token-like material is also denied.
const SENSITIVE_WORD = /(?:token|oauth|secret|credential|passw(?:or)?d|api[-_]?key|cookie|private[-_]?key|keychain)/i;
// Tool directories under ~/.config that are known to hold login tokens.
const CONFIG_TOKEN_DIRS = new Set(['gh', 'hub', 'github-copilot', 'op', '1password', 'bitwarden', 'rclone', 'heroku', 'doctl', 'netlify', 'vercel', 'stripe', 'configstore', 'fly', 'gcloud', 'sentry-cli', 'twilio', 'railway', 'supabase', 'firebase', 'git-credential-manager']);

function contained(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

// Resolve symlinks for the longest existing prefix; a dangling link is refused.
function realTarget(target) {
  try { return fs.realpathSync(target); } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    let linkStat = null;
    try { linkStat = fs.lstatSync(target); } catch { /* absent is fine */ }
    if (linkStat?.isSymbolicLink()) throw new Error('Dangling symbolic link is not allowed');
    const parent = path.dirname(target);
    if (parent === target) throw error;
    return path.join(realTarget(parent), path.basename(target));
  }
}

function sensitivePath(target, home) {
  const relative = contained(home, target) ? path.relative(home, target) : target;
  const parts = relative.split(path.sep).filter(Boolean);
  if (parts[0] === '.config' && parts[1] && CONFIG_TOKEN_DIRS.has(parts[1].toLowerCase())) return true;
  return parts.some(part => SENSITIVE_SEGMENT.test(part) || SENSITIVE_WORD.test(part));
}

class FilesystemScopes {
  constructor({ home = os.homedir(), bridgeRoot = path.resolve(__dirname, '..'), dataDir = null, protectedRoots = [], trustedFiles = [], extraScopes = [] } = {}) {
    this.home = realTarget(path.resolve(home));
    this.bridgeRoot = realTarget(bridgeRoot);
    const h = (...parts) => path.join(this.home, ...parts);
    const appSupport = h('Library', 'Application Support');
    this.piOwnedRoot = dataDir ? path.join(path.resolve(dataDir), 'pi-owned') : null;
    // Scope order matters only for reporting; access is the union of matching scopes.
    this.scopes = [
      { name: 'approved_project_roots', roots: [h('code')], read: true, write: true },
      { name: 'user_documents', roots: [h('Documents')], read: true, write: true },
      { name: 'user_downloads', roots: [h('Downloads')], read: true, write: true },
      { name: 'user_desktop', roots: [h('Desktop')], read: true, write: true },
      { name: 'developer_config', roots: [h('.config'), h('.gitconfig'), h('.claude', 'settings.json'), h('.cursor', 'extensions'), h('.vscode', 'extensions'), h('.ollama', 'models', 'manifests')], read: true, write: false },
      { name: 'application_support', roots: ['Cursor', 'Code', 'Claude', 'Ollama'].map(app => path.join(appSupport, app)).concat([h('Library', 'Logs')]), read: true, write: false },
      { name: 'system_readonly', roots: ['/Applications', '/opt/homebrew/Cellar', '/opt/homebrew/bin', '/usr/local/bin', '/usr/local/Cellar', '/Library/Developer/CommandLineTools/usr/bin'], read: true, write: false },
      ...(this.piOwnedRoot ? [{ name: 'pi_owned', roots: [this.piOwnedRoot], read: true, write: true }] : []),
      ...extraScopes
    ].map(scope => ({ ...scope, roots: scope.roots.map(root => { try { return realTarget(root); } catch { return path.resolve(root); } }) }));
    // Never readable or writable through V2 file capabilities: bridge runtime
    // state (tokens, sockets, ledger) and the bridge's own data directory.
    this.privateRoots = [path.join(this.bridgeRoot, '.runtime'), ...(dataDir ? [path.resolve(dataDir)] : [])].map(root => { try { return realTarget(root); } catch { return path.resolve(root); } });
    // Readable but never writable: enforcement files and protected worktrees.
    this.writeProtected = [...protectedRoots, ...trustedFiles.map(file => path.join(this.bridgeRoot, file))].map(root => { try { return realTarget(root); } catch { return path.resolve(root); } });
  }

  expand(supplied, base) {
    if (typeof supplied !== 'string' || !supplied || supplied.length > 4096 || supplied.includes('\0')) throw new Error('Invalid file path');
    if (supplied === '~' || supplied.startsWith('~/')) return path.join(this.home, supplied.slice(2));
    if (supplied.startsWith('~')) throw new Error('Only the current user home may be referenced');
    if (path.isAbsolute(supplied)) return path.normalize(supplied);
    if (!base) throw new Error('Relative paths require a task workspace');
    return path.resolve(base, supplied);
  }

  _matching(target, mode, workspace) {
    const scopes = this.scopes.filter(scope => scope[mode] && scope.roots.some(root => contained(root, target))).map(scope => scope.name);
    if (workspace && contained(workspace, target)) scopes.unshift('workspace');
    return scopes;
  }

  /**
   * Resolve a caller path for `read` or `write`. Both the lexical path and the
   * canonical (symlink-resolved) path must lie inside a scope granting the mode,
   * so `..` traversal and symlink escapes fail closed.
   */
  resolve(supplied, { mode = 'read', workspace = null, mustExist = mode === 'read' } = {}) {
    if (!['read', 'write'].includes(mode)) throw new Error('Invalid scope mode');
    const base = workspace ? realTarget(workspace) : null;
    const lexical = this.expand(supplied, base);
    if (sensitivePath(lexical, this.home)) throw Object.assign(new Error('Sensitive credential or private path is denied'), { sensitive: true });
    const canonical = realTarget(lexical);
    if (sensitivePath(canonical, this.home)) throw Object.assign(new Error('Sensitive credential or private path is denied'), { sensitive: true });
    const piOwned = this.piOwnedRoot && contained(realTarget(this.piOwnedRoot), canonical) && contained(this.piOwnedRoot, lexical);
    // A bridge-created isolated workspace lives inside the data directory but is
    // the task's own working tree, not bridge state. Only paths that stay inside
    // it both lexically and after symlink resolution are exempt; sessions, other
    // tasks and the rest of the data directory remain private.
    const ownIsolatedWorkspace = base && this.privateRoots.some(root => contained(root, base) && path.relative(root, base) !== '') && contained(base, lexical) && contained(base, canonical);
    if (!piOwned && !ownIsolatedWorkspace && this.privateRoots.some(root => contained(root, lexical) || contained(root, canonical))) throw Object.assign(new Error('Bridge private state is denied'), { sensitive: true });
    const lexicalScopes = this._matching(lexical, mode, base);
    const canonicalScopes = this._matching(canonical, mode, base);
    if (!lexicalScopes.length) throw new Error(`Path is outside every ${mode} scope`);
    if (!canonicalScopes.length) throw new Error(`Symbolic link resolves outside every ${mode} scope`);
    if (mode === 'write' && this.writeProtected.some(root => contained(root, canonical) || contained(root, lexical))) throw new Error('Path is write-protected');
    if (mustExist && !fs.existsSync(canonical)) throw new Error('Path does not exist');
    return { lexical, canonical, scope: canonicalScopes[0], scopes: canonicalScopes };
  }

  isSensitive(target) { return sensitivePath(path.resolve(target), this.home); }

  approvedRepository(supplied, { workspace = null, write = false } = {}) {
    const resolved = this.resolve(supplied, { mode: write ? 'write' : 'read', workspace, mustExist: true });
    if (!['workspace', 'approved_project_roots'].includes(resolved.scope)) throw new Error('Repository must be the task workspace or inside an approved project root');
    if (!fs.statSync(resolved.canonical).isDirectory()) throw new Error('Repository must be a directory');
    return resolved;
  }

  describe() {
    return {
      home_relative: true,
      scopes: this.scopes.map(scope => ({ name: scope.name, read: scope.read, write: scope.write, roots: scope.roots.map(root => this.display(root)) })),
      private_roots: this.privateRoots.map(root => this.display(root)),
      write_protected: this.writeProtected.map(root => this.display(root)),
      sensitive_policy: 'credentials, keys, tokens, browser/session stores, shell rc/history, mail/messages and .git internals are denied in every scope'
    };
  }

  display(target) { return contained(this.home, target) ? `~/${path.relative(this.home, target)}`.replace(/\/$/, '') : target; }
}

module.exports = { FilesystemScopes, SENSITIVE_SEGMENT, contained, realTarget, sensitivePath };
