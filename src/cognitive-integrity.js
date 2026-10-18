'use strict';
// Content-based anchor over the existing bounded, streaming repository inventory.
const fs = require('node:fs');
const path = require('node:path');
const { repositorySnapshot, inspect } = require('./repository-verification');
const { canonicalHash } = require('./authority-hash');
function capture(workspace, permitted) {
  if (fs.realpathSync(workspace) !== workspace || fs.lstatSync(workspace).isSymbolicLink()) throw Error('cognitive_workspace_identity_changed');
  const st = fs.lstatSync(workspace), snapshot = repositorySnapshot(workspace);
  const directories = new Map();
  for (const name of Object.keys(snapshot.inventory)) {
    for (let dir = path.posix.dirname(name); dir !== '.'; dir = path.posix.dirname(dir)) {
      if (directories.has(dir)) break;
      const s = fs.lstatSync(path.join(workspace, dir));
      if (!s.isDirectory() || s.isSymbolicLink()) throw Error('cognitive_symlink_directory');
      directories.set(dir, { path: dir, type: 'directory', mode: s.mode & 0o777 });
    }
  }
  for (const name of permitted) {
    // An ignored/untracked path cannot evade the hashed inventory and enter discovery.
    if (!Object.hasOwn(snapshot.inventory, name)) throw Error('cognitive_path_excluded');
    const item = inspect(workspace, name, { owned: true });
    if (!item.exists || item.type !== 'file' || item.size > 262144 || fs.lstatSync(path.join(workspace, name)).nlink !== 1) throw Error('cognitive_discovery_file_invalid');
  }
  const entries = Object.entries(snapshot.inventory).map(([name, item]) => ({ path: name, type: item.exists ? item.type : 'missing', mode: item.exists ? item.mode & 0o777 : null, digest: item.digest || null }));
  entries.push(...directories.values()); entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return {
    workspace_identity: { dev: st.dev, ino: st.ino, mode: st.mode & 0o777 },
    head: snapshot.head,
    integrity: { version: 1, hash: canonicalHash({ entries, root_mode: st.mode & 0o777, index: snapshot.index, exclusions: snapshot.policy.exclusions }), entries: Object.keys(snapshot.inventory).length, bytes: snapshot.total_bytes, exclusions: snapshot.policy.exclusions },
  };
}
function assertCurrent(workspace, envelope, identity) {
  const now = capture(workspace, envelope.permitted_paths);
  if (canonicalHash(now.workspace_identity) !== canonicalHash(identity) || now.head !== envelope.git_anchor || now.integrity.hash !== envelope.integrity.hash) throw Error('cognitive_workspace_drift_revalidation_required');
  return now;
}
module.exports = { capture, assertCurrent };
