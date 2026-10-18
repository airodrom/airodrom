'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');

function contained(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function hashFile(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// Copy without following links, then restore each recorded file mode.
// The process umask is left unchanged; a private parent directory stays private
// even when a restored payload file is 0644.
function copyPayload(source, destination) {
  const root = path.resolve(source);
  fs.cpSync(root, destination, { recursive: true, preserveTimestamps: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false });
  const restore = directory => {
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      const original = path.join(root, path.relative(destination, file));
      if (!contained(destination, file) || !contained(root, original)) throw Error('Checkpoint path escapes verification root');
      if (stat.isSymbolicLink()) {
        const link = fs.readlinkSync(file);
        if (path.isAbsolute(link)) throw Error('Checkpoint symlink escapes verification root');
        const resolved = path.resolve(path.dirname(file), link);
        if (!contained(destination, resolved)) throw Error('Checkpoint symlink escapes verification root');
        continue;
      }
      if (stat.isDirectory()) { restore(file); continue; }
      if (!stat.isFile()) throw Error('Checkpoint entry is not a file');
      fs.chmodSync(file, fs.lstatSync(original).mode & 0o777);
    }
  };
  restore(destination);
}

function assertTree(root, manifest) {
  for (const item of manifest) {
    if (typeof item.file !== 'string' || item.file.includes('\0') || path.isAbsolute(item.file)) throw Error('Checkpoint path escapes verification root');
    const file = path.resolve(root, item.file);
    if (!contained(path.resolve(root), file)) throw Error('Checkpoint path escapes verification root');
    const stat = fs.lstatSync(file);
    if (item.symlink !== undefined) {
      if (!stat.isSymbolicLink() || fs.readlinkSync(file) !== item.symlink) throw Error('Checkpoint link mismatch');
      if (path.isAbsolute(item.symlink) || !contained(path.resolve(root), path.resolve(path.dirname(file), item.symlink))) throw Error('Checkpoint symlink escapes verification root');
      continue;
    }
    if (!stat.isFile() || stat.size !== item.bytes || (stat.mode & 0o777) !== item.mode || hashFile(file) !== item.sha256) throw Error('Checkpoint file integrity mismatch');
  }
}

module.exports = { copyPayload, assertTree, contained, hashFile };
