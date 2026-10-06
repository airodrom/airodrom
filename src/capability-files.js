'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { keys, text, integer, bool, list, fail, sha256 } = require('./capability-util');

const MAX_READ_BYTES = 1024 * 1024;
const MAX_WRITE_BYTES = 4 * 1024 * 1024;
const MAX_COPY_ENTRIES = 5_000;
const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', '.venv', 'venv', '__pycache__', '.next', 'dist', 'build', '.cache', 'DerivedData']);
const TAR = '/usr/bin/tar';

const read = (ctx, value, extra = {}) => ctx.scopes.resolve(value, { mode: 'read', workspace: ctx.task.workspace, ...extra });
const write = (ctx, value, extra = {}) => ctx.scopes.resolve(value, { mode: 'write', workspace: ctx.task.workspace, mustExist: false, ...extra });
const display = (ctx, target) => ctx.scopes.display(target);

function regularFile(target) {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) fail('Symbolic links are not followed for this operation');
  if (!stat.isFile()) fail('Only regular files are supported');
  return stat;
}

function atomicWrite(target, content, { exclusive = false } = {}) {
  const parent = path.dirname(target);
  if (!fs.statSync(parent).isDirectory()) fail('Parent directory does not exist');
  let mode = 0o644;
  if (fs.existsSync(target)) {
    if (exclusive) fail('File already exists');
    mode = regularFile(target).mode & 0o777;
  }
  const temp = path.join(parent, `.${path.basename(target)}.pi-${randomBytes(6).toString('hex')}.tmp`);
  fs.writeFileSync(temp, content, { flag: 'wx', mode });
  try {
    if (exclusive) { fs.linkSync(temp, target); fs.unlinkSync(temp); }
    else fs.renameSync(temp, target);
  } catch (error) { try { fs.unlinkSync(temp); } catch {} throw error; }
  return { bytes: Buffer.byteLength(content), sha256: sha256(content) };
}

function walk(ctx, root, { maxDepth = 6, maxEntries = MAX_COPY_ENTRIES, includeSkipped = false } = {}, visit) {
  let seen = 0;
  const step = (directory, depth) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (++seen > maxEntries) return false;
      const full = path.join(directory, entry.name);
      if (ctx.scopes.isSensitive(full)) { visit({ full, entry, sensitive: true }); continue; }
      if (entry.isSymbolicLink()) { visit({ full, entry, symlink: true }); continue; }
      if (visit({ full, entry }) === false) return false;
      if (entry.isDirectory() && depth < maxDepth && (includeSkipped || !SKIP_DIRS.has(entry.name))) if (step(full, depth + 1) === false) return false;
    }
    return true;
  };
  const complete = step(root, 0);
  return { complete, seen };
}

function destinationFree(ctx, destination) {
  const resolved = write(ctx, destination);
  return { resolved, exists: fs.existsSync(resolved.lexical) || fs.existsSync(resolved.canonical) };
}

function fileCapabilities() {
  return {
    file_read: {
      validate: input => { keys(input, ['path'], ['offset', 'limit']); text(input.path, 'path'); integer(input.offset, 'offset', { min: 1, optional: true }); integer(input.limit, 'limit', { min: 1, max: 5_000, optional: true }); return input; },
      assess: (ctx, input) => ({ scope: read(ctx, input.path).scope }),
      perform: (ctx, input) => {
        const target = read(ctx, input.path).canonical;
        const stat = regularFile(target);
        if (stat.size > MAX_READ_BYTES * 8) fail('File is too large; use file_hash or file_metadata');
        const buffer = fs.readFileSync(target);
        if (buffer.subarray(0, 8_000).includes(0)) return { path: display(ctx, target), binary: true, bytes: stat.size, sha256: sha256(buffer) };
        const lines = buffer.toString('utf8').split('\n');
        const offset = (input.offset || 1) - 1, limit = input.limit || 2_000;
        let content = lines.slice(offset, offset + limit).join('\n');
        const truncated = Buffer.byteLength(content) > MAX_READ_BYTES || offset + limit < lines.length;
        if (Buffer.byteLength(content) > MAX_READ_BYTES) content = content.slice(0, MAX_READ_BYTES);
        return { path: display(ctx, target), bytes: stat.size, totalLines: lines.length, offset: offset + 1, content, truncated };
      }
    },
    file_search: {
      validate: input => {
        keys(input, ['root'], ['query', 'namePattern', 'maxResults', 'maxDepth']); text(input.root, 'root');
        text(input.query, 'query', { max: 1_000, optional: true }); text(input.namePattern, 'namePattern', { max: 200, optional: true, multiline: false });
        if (input.query === undefined && input.namePattern === undefined) fail('file_search requires query or namePattern');
        integer(input.maxResults, 'maxResults', { min: 1, max: 500, optional: true }); integer(input.maxDepth, 'maxDepth', { min: 0, max: 12, optional: true }); return input;
      },
      assess: (ctx, input) => ({ scope: read(ctx, input.root).scope }),
      perform: (ctx, input) => {
        const root = read(ctx, input.root).canonical;
        if (!fs.statSync(root).isDirectory()) fail('Search root must be a directory');
        const maxResults = input.maxResults || 100, matches = []; let hidden = 0;
        const glob = input.namePattern ? new RegExp(`^${input.namePattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i') : null;
        const walked = walk(ctx, root, { maxDepth: input.maxDepth ?? 6, maxEntries: 20_000 }, ({ full, entry, sensitive, symlink }) => {
          if (sensitive || symlink) { hidden++; return true; }
          if (matches.length >= maxResults) return false;
          if (!entry.isFile()) return true;
          if (glob && !glob.test(entry.name)) return true;
          if (input.query === undefined) { matches.push({ path: display(ctx, full) }); return true; }
          let stat; try { stat = fs.statSync(full); } catch { return true; }
          if (stat.size > 2 * 1024 * 1024) return true;
          const buffer = fs.readFileSync(full);
          if (buffer.subarray(0, 8_000).includes(0)) return true;
          buffer.toString('utf8').split('\n').forEach((line, index) => {
            if (matches.length < maxResults && line.includes(input.query)) matches.push({ path: display(ctx, full), line: index + 1, text: line.slice(0, 300) });
          });
          return true;
        });
        return { root: display(ctx, root), matches, truncated: matches.length >= maxResults || !walked.complete, hiddenSensitiveOrLinked: hidden };
      }
    },
    directory_list: {
      validate: input => { keys(input, ['path'], ['maxEntries']); text(input.path, 'path'); integer(input.maxEntries, 'maxEntries', { min: 1, max: 2_000, optional: true }); return input; },
      assess: (ctx, input) => ({ scope: read(ctx, input.path).scope }),
      perform: (ctx, input) => {
        const target = read(ctx, input.path).canonical;
        if (!fs.statSync(target).isDirectory()) fail('Path is not a directory');
        const max = input.maxEntries || 500, entries = []; let hidden = 0, total = 0;
        for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
          total++;
          const full = path.join(target, entry.name);
          if (ctx.scopes.isSensitive(full)) { hidden++; continue; }
          if (entries.length >= max) continue;
          let stat = null; try { stat = fs.lstatSync(full); } catch {}
          entries.push({ name: entry.name, type: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other', size: stat?.isFile() ? stat.size : null, modifiedAt: stat ? stat.mtime.toISOString() : null });
        }
        return { path: display(ctx, target), entries, total, hiddenSensitive: hidden, truncated: total - hidden > entries.length };
      }
    },
    file_metadata: {
      validate: input => { keys(input, ['path']); text(input.path, 'path'); return input; },
      assess: (ctx, input) => ({ scope: read(ctx, input.path).scope }),
      perform: (ctx, input) => {
        const { lexical, canonical } = read(ctx, input.path);
        const link = fs.lstatSync(lexical), stat = fs.statSync(canonical);
        return { path: display(ctx, canonical), type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other', symlink: link.isSymbolicLink(), size: stat.size, mode: (stat.mode & 0o7777).toString(8), ownedByCurrentUser: stat.uid === process.getuid?.(), modifiedAt: stat.mtime.toISOString(), createdAt: stat.birthtime.toISOString() };
      }
    },
    file_hash: {
      validate: input => { keys(input, ['path'], ['algorithm']); text(input.path, 'path'); if (input.algorithm !== undefined && !['sha256', 'sha1', 'md5'].includes(input.algorithm)) fail('Invalid algorithm'); return input; },
      assess: (ctx, input) => ({ scope: read(ctx, input.path).scope }),
      perform: (ctx, input) => new Promise((resolve, reject) => {
        const target = read(ctx, input.path).canonical;
        const stat = regularFile(target);
        const digest = createHash(input.algorithm || 'sha256');
        fs.createReadStream(target).on('data', chunk => digest.update(chunk)).on('error', reject).on('end', () => resolve({ path: display(ctx, target), algorithm: input.algorithm || 'sha256', digest: digest.digest('hex'), bytes: stat.size }));
      })
    },
    file_write: {
      validate: input => { keys(input, ['path', 'content']); text(input.path, 'path'); text(input.content, 'content', { max: MAX_WRITE_BYTES, min: 0 }); return input; },
      assess: (ctx, input) => ({ scope: write(ctx, input.path).scope }),
      perform: (ctx, input) => { const target = write(ctx, input.path).canonical; const existed = fs.existsSync(target); const result = atomicWrite(target, input.content); ctx.touch(target); return { path: display(ctx, target), created: !existed, ...result }; }
    },
    file_create: {
      validate: input => { keys(input, ['path'], ['content']); text(input.path, 'path'); text(input.content, 'content', { max: MAX_WRITE_BYTES, min: 0, optional: true }); return input; },
      assess: (ctx, input) => ({ scope: write(ctx, input.path).scope }),
      perform: (ctx, input) => { const target = write(ctx, input.path).canonical; const result = atomicWrite(target, input.content || '', { exclusive: true }); ctx.touch(target); return { path: display(ctx, target), created: true, ...result }; }
    },
    file_edit: {
      validate: input => {
        keys(input, ['path', 'edits']); text(input.path, 'path');
        list(input.edits, 'edits', { max: 32, item: edit => { keys(edit, ['oldText', 'newText'], [], 'edit'); text(edit.oldText, 'oldText', { max: MAX_WRITE_BYTES }); text(edit.newText, 'newText', { max: MAX_WRITE_BYTES, min: 0 }); return edit; } });
        if (!input.edits.length) fail('Invalid edits'); return input;
      },
      assess: (ctx, input) => ({ scope: write(ctx, input.path, { mustExist: true }).scope }),
      perform: (ctx, input) => {
        const target = write(ctx, input.path, { mustExist: true }).canonical;
        regularFile(target);
        const { applyEdits } = require('./capability-broker');
        const result = atomicWrite(target, applyEdits(fs.readFileSync(target, 'utf8'), input.edits));
        ctx.touch(target); return { path: display(ctx, target), edits: input.edits.length, ...result };
      }
    },
    directory_create: {
      validate: input => { keys(input, ['path'], ['recursive']); text(input.path, 'path'); bool(input.recursive, 'recursive'); return input; },
      assess: (ctx, input) => ({ scope: write(ctx, input.path).scope }),
      perform: (ctx, input) => { const target = write(ctx, input.path).canonical; const existed = fs.existsSync(target); fs.mkdirSync(target, { recursive: input.recursive === true, mode: 0o755 }); return { path: display(ctx, target), created: !existed }; }
    },
    file_copy: {
      validate: input => { keys(input, ['source', 'destination'], ['overwrite']); text(input.source, 'source'); text(input.destination, 'destination'); bool(input.overwrite, 'overwrite'); return input; },
      assess: (ctx, input) => {
        read(ctx, input.source);
        const { resolved, exists } = destinationFree(ctx, input.destination);
        if (exists && input.overwrite !== true) return { scope: resolved.scope, dynamic: { decision: 'deny', kind: 'capability_denied', reason: 'Destination exists; pass overwrite:true to request an approved overwrite' } };
        return { scope: resolved.scope, dynamic: exists ? { decision: 'approval_required', riskClass: 'DESTRUCTIVE', reason: 'Overwriting an existing destination requires approval' } : null };
      },
      perform: (ctx, input) => {
        const source = read(ctx, input.source).canonical, destination = write(ctx, input.destination).canonical;
        const stat = fs.statSync(source);
        if (stat.isDirectory()) {
          let blocked = 0;
          const scan = walk(ctx, source, { maxDepth: 64, includeSkipped: true }, ({ sensitive, symlink }) => { if (sensitive || symlink) blocked++; return true; });
          if (blocked || !scan.complete) fail(blocked ? 'Directory contains sensitive files or symbolic links; copy a narrower path' : 'Directory is too large to copy');
          fs.cpSync(source, destination, { recursive: true, force: input.overwrite === true, errorOnExist: input.overwrite !== true, preserveTimestamps: true });
          return { source: display(ctx, source), destination: display(ctx, destination), entries: scan.seen };
        }
        regularFile(source);
        fs.copyFileSync(source, destination, input.overwrite === true ? 0 : fs.constants.COPYFILE_EXCL);
        ctx.touch(destination); return { source: display(ctx, source), destination: display(ctx, destination), bytes: stat.size };
      }
    },
    file_move: {
      validate: input => { keys(input, ['source', 'destination'], ['overwrite']); text(input.source, 'source'); text(input.destination, 'destination'); bool(input.overwrite, 'overwrite'); return input; },
      assess: (ctx, input) => {
        write(ctx, input.source, { mustExist: true });
        const { resolved, exists } = destinationFree(ctx, input.destination);
        if (exists && input.overwrite !== true) return { scope: resolved.scope, dynamic: { decision: 'deny', kind: 'capability_denied', reason: 'Destination exists; pass overwrite:true to request an approved overwrite' } };
        return { scope: resolved.scope, dynamic: exists ? { decision: 'approval_required', riskClass: 'DESTRUCTIVE', reason: 'Replacing an existing destination requires approval' } : null };
      },
      perform: (ctx, input) => {
        const source = write(ctx, input.source, { mustExist: true }).lexical, destination = write(ctx, input.destination).canonical;
        if (fs.existsSync(destination) && input.overwrite !== true) fail('Destination exists');
        fs.renameSync(source, destination); ctx.touch(source); ctx.touch(destination);
        return { source: display(ctx, source), destination: display(ctx, destination) };
      }
    },
    file_trash: {
      validate: input => { keys(input, ['path']); text(input.path, 'path'); return input; },
      assess: (ctx, input) => {
        const resolved = write(ctx, input.path, { mustExist: true });
        const stat = fs.lstatSync(resolved.lexical);
        return { scope: resolved.scope, dynamic: stat.isDirectory() ? { decision: 'approval_required', riskClass: 'DESTRUCTIVE', reason: 'Trashing a directory may remove unique work and requires approval' } : null };
      },
      perform: (ctx, input) => {
        const source = write(ctx, input.path, { mustExist: true }).lexical;
        const trash = ctx.trashDir;
        if (!trash || !fs.existsSync(trash)) fail('User Trash is unavailable');
        const destination = path.join(trash, `${path.basename(source)} ${new Date().toISOString().replace(/[:.]/g, '-')}`);
        try { fs.renameSync(source, destination); }
        catch (error) { if (error.code === 'EXDEV') fail('Cross-volume Trash is not supported; use file_delete_permanent with approval'); throw error; }
        ctx.touch(source); return { path: display(ctx, source), trashedAs: path.basename(destination), reversible: true };
      }
    },
    file_delete_permanent: {
      validate: input => { keys(input, ['path'], ['recursive']); text(input.path, 'path'); bool(input.recursive, 'recursive'); return input; },
      assess: (ctx, input) => ({ scope: write(ctx, input.path, { mustExist: true }).scope }),
      perform: (ctx, input) => {
        const target = write(ctx, input.path, { mustExist: true }).lexical;
        const stat = fs.lstatSync(target);
        if (stat.isDirectory() && input.recursive !== true) fail('Directory deletion requires recursive:true in the approved request');
        fs.rmSync(target, { recursive: stat.isDirectory(), force: false }); ctx.touch(target);
        return { path: display(ctx, target), deleted: true, reversible: false };
      }
    },
    archive_create: {
      validate: input => { keys(input, ['sources', 'destination']); list(input.sources, 'sources', { max: 64 }); if (!input.sources.length) fail('Invalid sources'); text(input.destination, 'destination'); if (!/\.(?:tar\.gz|tgz|tar|zip)$/i.test(input.destination)) fail('Destination must end in .tar.gz, .tgz, .tar or .zip'); return input; },
      assess: (ctx, input) => {
        for (const source of input.sources) read(ctx, source);
        const { resolved, exists } = destinationFree(ctx, input.destination);
        if (exists) return { scope: resolved.scope, dynamic: { decision: 'deny', kind: 'capability_denied', reason: 'Archive destination already exists' } };
        return { scope: resolved.scope };
      },
      perform: async (ctx, input) => {
        const sources = input.sources.map(source => read(ctx, source).canonical);
        const parent = path.dirname(sources[0]);
        if (sources.some(source => path.dirname(source) !== parent)) fail('Archive sources must share one parent directory');
        let blocked = 0;
        for (const source of sources) {
          if (ctx.scopes.isSensitive(source)) blocked++;
          else if (fs.statSync(source).isDirectory()) walk(ctx, source, { maxDepth: 64, maxEntries: 50_000, includeSkipped: true }, ({ sensitive }) => { if (sensitive) blocked++; return true; });
        }
        if (blocked) fail('Sources contain sensitive files; archive a narrower path');
        const destination = write(ctx, input.destination).canonical;
        if (fs.existsSync(destination)) fail('Archive destination already exists');
        const format = /\.zip$/i.test(destination) ? ['--format', 'zip', '-cf'] : /\.tar$/i.test(destination) ? ['-cf'] : ['-czf'];
        const result = await ctx.exec.run(TAR, [...format, destination, '-C', parent, '--', ...sources.map(source => path.basename(source))], { cwd: parent, timeoutMs: 120_000 });
        if (result.exitCode !== 0) fail(`Archive creation failed: ${result.stderr.slice(0, 300)}`);
        ctx.touch(destination); return { destination: display(ctx, destination), sources: sources.length, bytes: fs.statSync(destination).size };
      }
    },
    archive_extract: {
      validate: input => { keys(input, ['archive', 'destination']); text(input.archive, 'archive'); text(input.destination, 'destination'); return input; },
      assess: (ctx, input) => {
        read(ctx, input.archive);
        const resolved = write(ctx, input.destination);
        if (fs.existsSync(resolved.canonical) && fs.readdirSync(resolved.canonical).length) return { scope: resolved.scope, dynamic: { decision: 'approval_required', riskClass: 'DESTRUCTIVE', reason: 'Extracting into a non-empty directory may overwrite files and requires approval' } };
        return { scope: resolved.scope };
      },
      perform: async (ctx, input) => {
        const archive = read(ctx, input.archive).canonical, destination = write(ctx, input.destination).canonical;
        const listing = await ctx.exec.run(TAR, ['-tvf', archive], { timeoutMs: 60_000 });
        if (listing.exitCode !== 0 || listing.truncated) fail('Archive listing failed or is too large');
        const names = await ctx.exec.run(TAR, ['-tf', archive], { timeoutMs: 60_000 });
        const entries = names.stdout.split('\n').filter(Boolean);
        if (entries.length > 50_000) fail('Archive has too many entries');
        for (const line of listing.stdout.split('\n').filter(Boolean)) if (/^[lh]/.test(line)) fail('Archive contains links; extraction refused');
        for (const entry of entries) {
          const normalized = path.normalize(entry);
          if (path.isAbsolute(entry) || normalized.split(path.sep).includes('..')) fail('Archive entry escapes the destination');
          if (ctx.scopes.isSensitive(path.join(destination, normalized))) fail('Archive contains sensitive paths');
        }
        fs.mkdirSync(destination, { recursive: true });
        const result = await ctx.exec.run(TAR, ['-xf', archive, '-C', destination, '--no-same-owner', '--no-same-permissions'], { cwd: destination, timeoutMs: 300_000 });
        if (result.exitCode !== 0) fail(`Extraction failed: ${result.stderr.slice(0, 300)}`);
        ctx.touch(destination); return { archive: display(ctx, archive), destination: display(ctx, destination), entries: entries.length };
      }
    }
  };
}

module.exports = { fileCapabilities, atomicWrite, walk, TAR };
