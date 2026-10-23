'use strict';
// Host-owned literal request constraints. Parsing narrows enrollment; it never
// grants a path or chooses a substitute. No basename or repository alias lookup.
const path = require('node:path');
const C = require('./cognitive-contracts');
const { canonicalHash } = require('./authority-hash');
const unique = values => [...new Set(values)].sort();
function normalize(value) {
  if (typeof value !== 'string' || /[\\\x00-\x1f]/.test(value) || path.posix.isAbsolute(value)
      || value.split('/').includes('..')) C.fail('requested_file_path_invalid');
  const result = value.replace(/^(?:\.\/)+/, '');
  C.relative(result);
  if (path.posix.normalize(result) !== result) C.fail('requested_file_path_invalid');
  return result;
}
function parse(value) {
  C.object(value, ['version', 'bindings']);
  if (value.version !== 1) C.fail('requested_file_scope_version');
  C.list(value.bindings, b => {
    C.object(b, ['operation', 'path']);
    if (!['read', 'edit', 'create'].includes(b.operation)) C.fail('requested_file_operation_invalid');
    if (normalize(b.path) !== b.path) C.fail('requested_file_path_invalid');
  }, 24, 0);
  return value;
}
function extract(instruction) {
  const text = String(instruction);
  // Explicit operation followed by a quoted literal or an unquoted POSIX path
  // token. Bare tokens must contain a dot or slash; extensionless paths must be
  // quoted. Unsupported requests need clarification, never a guessed filename.
  const pattern = /\b(reads?|inspect|review|edits?|modify|change|update|rewrite|append(?:\s+to)?|write(?:\s+to)?|create)\s+(?:(?:the\s+)?file\s+)?(`[^`\n]+`|"[^"\n]+"|'[^'\n]+'|[^\s,;:!?()]+)(?:[,:;!?]|(?=\s|$))/gi;
  const bindings = []; let unresolvedOperation = false;
  for (const m of text.matchAll(pattern)) {
    const before = text.slice(0, m.index).split(/[.;\n]/).at(-1);
    if (/\b(?:not|never|without|don't)\b[^,;]*$/i.test(before)) continue;
    const quoted = /^[`"']/.test(m[2]);
    const token = quoted ? m[2].slice(1, -1) : m[2].replace(/\.$/, '');
    if (!quoted && !/[./\\]/.test(token) && !/^(?:reads?|inspect|review|edits?|modify|change|update|rewrite|append(?:\s+to)?|write(?:\s+to)?|create)\s+(?:the\s+)?file\s/i.test(m[0])) {
      unresolvedOperation = true;
      continue;
    }
    const verb = m[1].toLowerCase().replace(/^(read|edit)s$/, '$1');
    const operation = /^(read|inspect|review)$/.test(verb) ? 'read' : verb === 'create' ? 'create' : 'edit';
    const tokens = [token];
    // A literal list belongs to the same operation. Stop before prose or a new
    // operation; never silently accept just the first explicitly listed file.
    let tail = text.slice(m.index + m[0].length - (/[,:;!?]$/.test(m[0]) ? 1 : 0));
    const next = /^\s*(?:,\s*(?:and\s+)?|and\s+)(`[^`\n]+`|"[^"\n]+"|'[^'\n]+'|[^\s,;:!?()]+)/i;
    for (let n; (n = next.exec(tail));) {
      const q = /^[`"']/.test(n[1]), v = q ? n[1].slice(1, -1) : n[1].replace(/\.$/, '');
      if (!q && !/[./\\]/.test(v)) break;
      tokens.push(v); tail = tail.slice(n[0].length);
    }
    for (const value of tokens) {
      const file = normalize(value);
      if (!bindings.some(b => b.operation === operation && b.path === file)) bindings.push({ operation, path: file });
    }
  }
  if (unresolvedOperation) C.fail('requested_file_operation_required');
  // Bare dotted POSIX literals outside the supported operation grammar are
  // ambiguous, not permission to choose an enrollment default. This lexical
  // check does not resolve aliases or infer a file from repository contents.
  for (const m of text.matchAll(/(?:^|[\s`"'(])((?:\.\/)?[\w.-]+(?:\/[\w.-]+)*\.[a-z][a-z0-9_-]*)(?=\.(?:\s|$)|[\s`"'),;:!?]|$)/gi)) {
    const file = normalize(m[1].replace(/\.$/, ''));
    // A literal explicitly forbidden as a substitute is not an operation target.
    // Contradictory positive scope remains a clarification, never an extra grant.
    if (/^[`"']?\s+substitution\s+must\s+be\s+rejected\b/i.test(text.slice(m.index + m[0].length))) {
      if (bindings.some(b => b.path === file)) C.fail('requested_file_operation_required');
      continue;
    }
    const before = text.slice(0, m.index).split(/[.;\n]/).at(-1);
    if (/\b(?:not|never|without|don't)\b[^,;]*$/i.test(before)) continue;
    if (!bindings.some(b => b.path === file)) C.fail('requested_file_operation_required');
  }
  return parse({ version: 1, bindings });
}
function files(scope) { return unique(parse(scope).bindings.map(b => b.path)); }
function fail(code, scope, proposed = [], authorized = []) {
  const error = Error(code); error.code = code;
  error.details = { requested_files: files(scope), proposed_files: proposed, authorized_files: authorized,
    mismatched_paths: unique([...files(scope).filter(f => !authorized.includes(f)), ...proposed.filter(f => !files(scope).includes(f))]),
    correction: 'Keep the exact requested paths and operations. Enroll the missing file or submit a corrected request; never substitute another enrolled file.' };
  throw error;
}
function assertEnrollment(scope, enrolled) {
  if (files(scope).some(f => !enrolled.includes(f))) fail('requested_file_not_enrolled', scope, [], enrolled);
  // Cognitive enrollment currently requires existing regular files and provides
  // no creation grant. Creation must use a separately authorized creation flow.
  if (scope.bindings.some(b => b.operation === 'create')) fail('requested_file_creation_not_authorized', scope, [], enrolled);
}
function assertProposal(scope, proposal) {
  const requested = files(scope);
  if (!requested.length) return;
  if (!proposal || !Array.isArray(proposal.tasks) || !Array.isArray(proposal.files)) fail('requested_file_plan_mismatch', scope);
  const tasks = proposal.tasks, proposed = unique([...proposal.files, ...tasks.flatMap(t => Array.isArray(t?.paths) ? t.paths : [])]);
  const edits = scope.bindings.filter(b => b.operation === 'edit').map(b => b.path);
  if (canonicalHash(proposed) !== canonicalHash(requested)
      || tasks.some(t => !t || !['read', 'edit'].includes(t.operation) || !Array.isArray(t.paths) || !t.paths.length
        || t.paths.some(f => !requested.includes(f) || t.operation === 'edit' && !edits.includes(f)))
      || scope.bindings.some(b => !tasks.some(t => t.operation === b.operation && t.paths.includes(b.path)))) {
    fail('requested_file_plan_mismatch', scope, proposed, requested);
  }
  // Preserve an explicitly ordered read -> edit chain. An evaluator cannot
  // retroactively turn an edit-first graph into the requested read-first graph.
  const ancestor = (target, id, seen = new Set()) => {
    if (!target || seen.has(target.id)) return false;
    seen.add(target.id);
    return (target.depends_on || []).some(parent => parent === id || ancestor(tasks.find(t => t.id === parent), id, seen));
  };
  for (let i = 0; i < scope.bindings.length; i++) {
    const first = scope.bindings[i];
    if (first.operation !== 'read') continue;
    for (const next of scope.bindings.slice(i + 1).filter(b => b.operation === 'edit')) {
      const reads = tasks.filter(t => t.operation === 'read' && t.paths.includes(first.path));
      const edits = tasks.filter(t => t.operation === 'edit' && t.paths.includes(next.path));
      if (!edits.every(edit => reads.some(read => ancestor(edit, read.id)))) fail('requested_file_dependency_mismatch', scope, proposed, requested);
    }
  }
}
function assertOriginal(cognitive, instruction) {
  const scope = extract(instruction);
  if (cognitive.envelope.requested_scope && canonicalHash(scope) !== canonicalHash(cognitive.envelope.requested_scope)) C.fail('requested_file_constraint_changed');
  assertProposal(scope, cognitive.proposal);
  return scope;
}
function verification(mission, snapshot, assignment = null, baseline = null) {
  const c = mission.envelope.cognitive, scope = c?.envelope.requested_scope;
  if (!scope || !files(scope).length) return null; // Preserve historical evidence; never rewrite old seals.
  assertProposal(scope, c.proposal);
  const original = mission.envelope.baseline;
  const compare = assignment ? baseline : original;
  const changed = unique([...Object.keys(compare.files), ...Object.keys(snapshot.files)]).filter(f => compare.files[f] !== snapshot.files[f]);
  const requiredEdits = assignment ? assignment.operation === 'edit' ? assignment.paths : [] : unique(scope.bindings.filter(b => b.operation === 'edit').map(b => b.path));
  const writable = assignment ? requiredEdits : unique(scope.bindings.filter(b => b.operation === 'edit').map(b => b.path));
  const missing = requiredEdits.filter(f => !Object.hasOwn(snapshot.files, f) || original.files[f] === snapshot.files[f]);
  const unexpected = changed.filter(f => !writable.includes(f));
  return { id: 'requested_file_scope', status: missing.length || unexpected.length ? 'failed' : 'passed', evidence: {
    version: 1, requested: scope.bindings, proposed: c.proposal.tasks.map(t => ({ id: t.id, operation: t.operation, paths: t.paths })),
    authorized: mission.envelope.allowed_files, assignment: assignment?.id || null,
    executed_changes: changed, verified_paths: files(scope), missing_changes: missing, unexpected_changes: unexpected,
    read_evidence: 'sealed_assignment_and_runtime_receipt', change_evidence: 'host_repository_snapshot'
  } };
}
module.exports = { normalize, parse, extract, files, assertEnrollment, assertProposal, assertOriginal, verification };
