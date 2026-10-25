'use strict';
// Host-owned literal request constraints. Parsing narrows enrollment; it never
// grants a path or chooses a substitute. No basename or repository alias lookup.
//
// Two layers:
//   bindings — unique operation/path permission set
//   stages   — ordered execution graph (may repeat the same binding)
const path = require('node:path');
const fs = require('node:fs');
const C = require('./cognitive-contracts');
const { canonicalHash } = require('./authority-hash');
const unique = values => [...new Set(values)].sort();

const VERBS = String.raw`reads?|inspect|review|edits?|modify|change|update|rewrite|append(?:\s+to)?|write(?:\s+to)?|create|fix(?:es|ing)?|patch(?:es|ing)?|implement(?:s|ing)?`;
const LITERAL = /`[^`\n]+`|"[^"\n]+"|'[^'\n]+'|[^\s,;:!?()]+/.source;
const CONTENT = String.raw`(?:(?:the|its|their)\s+)?(?:documentation|docs|examples?|content|text|wording|headings?|paragraphs?|sections?|instructions?|links?|references?|descriptions?|comments?|formatting|tables?|notes?|typos?|corrections?)`;
const STOP_TOKENS = /^(?:and|or|then|to|in|of|for|with|from|into|onto|over|after|before|only|ready|blocked|operations?|recommendation|result|results|policies|grants|settings|ci)$/i;
const MUTATION_REFINE = /\b(?:fix(?:es|ing)?|patch(?:es|ing)?|implement(?:s|ing)?)\b/i;
const CONDITIONAL_MUTATION = /\b(?:fix|patch|implement)\s+only\s+if\b/i;

function normalize(value) {
  if (typeof value !== 'string' || /[\\\x00-\x1f]/.test(value) || path.posix.isAbsolute(value)
      || value.split('/').includes('..')) C.fail('requested_file_path_invalid');
  const result = value.replace(/^(?:\.\/)+/, '');
  C.relative(result);
  if (path.posix.normalize(result) !== result) C.fail('requested_file_path_invalid');
  return result;
}

function parse(value) {
  C.object(value, ['version', 'bindings', 'stages'], ['version', 'bindings']);
  if (value.version !== 1) C.fail('requested_file_scope_version');
  C.list(value.bindings, b => {
    C.object(b, ['operation', 'path']);
    if (!['read', 'edit', 'create'].includes(b.operation)) C.fail('requested_file_operation_invalid');
    if (normalize(b.path) !== b.path) C.fail('requested_file_path_invalid');
  }, 24, 0);
  if (value.stages !== undefined) {
    // Stages may repeat the same operation/path (read → edit → read). Do not
    // use the default unique-list helper that rejects identical entries.
    if (!Array.isArray(value.stages) || value.stages.length > 24) C.fail('cognitive_list_invalid');
    for (const s of value.stages) {
      C.object(s, ['operation', 'path']);
      if (!['read', 'edit', 'create'].includes(s.operation)) C.fail('requested_file_operation_invalid');
      if (normalize(s.path) !== s.path) C.fail('requested_file_path_invalid');
    }
  }
  return value;
}

function operationOf(verb) {
  const v = String(verb).toLowerCase().replace(/^(read|edit)s$/, '$1');
  return /^(read|inspect|review)$/.test(v) ? 'read' : v === 'create' ? 'create' : 'edit';
}

function unwrapLiteral(raw) {
  const quoted = /^[`"']/.test(raw);
  return { quoted, token: quoted ? raw.slice(1, -1) : String(raw).replace(/\.$/, '') };
}

function isPathToken(quoted, token) {
  return quoted || /[./\\]/.test(token);
}

/** Descriptive frames that must never invent a file target. */
function descriptiveProse(text, index, verb, token, matched) {
  const before = text.slice(Math.max(0, index - 48), index);
  const after = text.slice(index, Math.min(text.length, index + matched.length + 48));
  const window = before + after;
  if (STOP_TOKENS.test(token)) return true;
  // "review the result(s)" / "inspect the result" are evaluation prose, not paths.
  if (/^(?:review|inspect)\b/i.test(verb) && /^(?:the|a|an|result|results)$/i.test(token)) return true;
  if (/\breview\s+the\s+results?\b/i.test(matched + ' ' + token) || /\breview\s+the\s+results?\b/i.test(window)) return true;
  if (/\bfor\s+(?:read|edit|inspect|review)\s+and\s+(?:read|edit|inspect|review)\b/i.test(window)) return true;
  if (/\b(?:read|edit)\s+and\s+edit\s+operations?\b/i.test(window)) return true;
  if (/\bevaluation\s+recommendation\b/i.test(window)) return true;
  if (/\bchange\s+(?:policies|grants|settings|ci)\b/i.test(matched + ' ' + token)) return true;
  if (/\benable\s+ci\b/i.test(window)) return true;
  if (/\bmake\s+changes\s+only\b/i.test(window) && !/\bonly\s+(?:to|in)\s+/i.test(window)) return true;
  if (/\bdo\s+not\s+edit\b/i.test(before) && /^(?:other|anything|something|everything|files?)$/i.test(token)) return true;
  if (/^(?:READY|ONLY|BLOCKED)$/i.test(token)) return true;
  return false;
}

/** Always retain the ordered stage graph. Identity hashing normalizes omission. */
function finalizeScope(bindings, stageList) {
  return parse({ version: 1, bindings, stages: stageList });
}

/** Hash-stable identity: stages default to bindings when omitted on sealed scopes. */
function scopeIdentity(scope) {
  const parsed = parse(scope);
  return { version: 1, bindings: parsed.bindings, stages: stages(parsed) };
}

function pushStage(stages, bindings, operation, file, literalRanges, range, { stages: addStages = true } = {}) {
  if (addStages) stages.push({ operation, path: file });
  if (!bindings.some(b => b.operation === operation && b.path === file)) bindings.push({ operation, path: file });
  if (range) literalRanges.push(range);
}

function extractStructuredPhrases(text, stages, bindings, literalRanges) {
  // "Make changes only to|in PATH"
  const onlyTo = new RegExp(String.raw`\bmake\s+changes\s+only\s+(?:to|in)\s+(${LITERAL})(?:[,:;!?]|\.(?=\s|$)|(?=\s|$))`, 'gi');
  for (const m of text.matchAll(onlyTo)) {
    const { quoted, token } = unwrapLiteral(m[1]);
    if (!isPathToken(quoted, token)) continue;
    const file = normalize(token);
    const start = m.index + m[0].lastIndexOf(m[1]);
    pushStage(stages, bindings, 'edit', file, literalRanges, { start, end: start + m[1].length });
  }
  // "Use PATH for read and edit" / "PATH for read" / "PATH for read and edit".
  // When Task-labeled stages already exist, only refresh permissions — do not
  // append duplicate stages from the footer permission restatement.
  const pathFor = new RegExp(String.raw`\b(?:use\s+)?(${LITERAL})\s+for\s+read(?:\s+and\s+edit)?(?:\s+operations?)?(?:[,:;!?]|\.(?=\s|$)|(?=\s|$))`, 'gi');
  const taskLabeled = /\bTask\s+[A-Z0-9]+\s*:/i.test(text);
  for (const m of text.matchAll(pathFor)) {
    const { quoted, token } = unwrapLiteral(m[1]);
    if (!isPathToken(quoted, token)) continue;
    const file = normalize(token);
    const start = m.index + m[0].lastIndexOf(m[1]);
    const range = { start, end: start + m[1].length };
    const both = /\bfor\s+read\s+and\s+edit\b/i.test(m[0]);
    pushStage(stages, bindings, 'read', file, literalRanges, range, { stages: !taskLabeled });
    if (both) pushStage(stages, bindings, 'edit', file, literalRanges, range, { stages: !taskLabeled });
  }
  // "after editing PATH" / "Review the result after editing PATH"
  const afterEdit = new RegExp(String.raw`\bafter\s+editing\s+(${LITERAL})(?:[,:;!?]|\.(?=\s|$)|(?=\s|$))`, 'gi');
  for (const m of text.matchAll(afterEdit)) {
    const { quoted, token } = unwrapLiteral(m[1]);
    if (!isPathToken(quoted, token)) continue;
    const file = normalize(token);
    const start = m.index + m[0].lastIndexOf(m[1]);
    pushStage(stages, bindings, 'edit', file, literalRanges, { start, end: start + m[1].length });
  }
}


/** Refine pathless fix/patch/implement onto a unique prior exact path only. */
function refineImplicitMutation(text, stages, bindings, literalRanges) {
  if (!MUTATION_REFINE.test(text) || CONDITIONAL_MUTATION.test(text)) return false;
  if (/\b(?:do\s+not|don't|never|without)\s+(?:fix(?:es|ing)?|patch(?:es|ing)?|implement(?:s|ing)?)\b/i.test(text)) return false;
  if (/\b(?:fix|patch|implement)\s+nothing\b/i.test(text)) return false;
  if (/\bread[- ]only\b/i.test(text) && MUTATION_REFINE.test(text) && !/\b(?:and|then)\s+(?:fix|patch|implement)\b/i.test(text)) return false;
  // Explicit retarget: "fix typos in PATH" / "implement the corrections in PATH".
  const retarget = new RegExp(String.raw`\b(?:fix(?:es|ing)?|patch(?:es|ing)?|implement(?:s|ing)?)\b(?:(?!\b(?:fix|patch|implement)\b)[\s\S]){0,96}?\b(?:in|within|of)\s+(` + LITERAL + `)`, 'i');
  const m = text.match(retarget);
  if (m) {
    const { quoted, token } = unwrapLiteral(m[1]);
    if (isPathToken(quoted, token)) {
      const file = normalize(token);
      const start = m.index + m[0].lastIndexOf(m[1]);
      pushStage(stages, bindings, 'edit', file, literalRanges, { start, end: start + m[1].length });
      return false;
    }
  }
  if (bindings.some(b => b.operation === 'edit') || stages.some(s => s.operation === 'edit')) return false;
  const readPaths = [...new Set(stages.filter(s => s.operation === 'read').map(s => s.path))];
  if (readPaths.length === 1) {
    pushStage(stages, bindings, 'edit', readPaths[0], literalRanges, null);
    return false;
  }
  if (readPaths.length > 1) return true;
  if (!stages.length && MUTATION_REFINE.test(text)) return true;
  return false;
}

function extract(instruction) {
  const text = String(instruction);
  const stages = [], bindings = [], literalRanges = [];
  let unresolvedOperation = false, anchor = null;

  extractStructuredPhrases(text, stages, bindings, literalRanges);

  const pattern = new RegExp(String.raw`\b(${VERBS})\s+(?:only\s+)?(?:(?:the\s+)?file\s+|${CONTENT}\s+(?:in|within|of)\s+)?(${LITERAL})(?:[,:;!?]|\.(?=\s|$)|(?=\s|$))`, 'gi');
  const contentTarget = new RegExp(String.raw`^(${VERBS})\s+${CONTENT}\s+(?:in|within|of)\s+`, 'i');
  const nextOperation = new RegExp('^(?:' + pattern.source + ')', 'i');
  const refinementGap = /^[ \t]*(?:,[ \t]*(?:(?:and|then)[ \t]+)?|(?:and(?:[ \t]+then)?|then)[ \t]+)$/i;
  const refinement = new RegExp(String.raw`^\s*${CONTENT}(?=$|\s|[.!?;,])`, 'i');
  const refinementEnd = /^\s*[.!?]?\s*$/;

  for (const m of text.matchAll(pattern)) {
    const before = text.slice(0, m.index).split(/[.;\n]/).at(-1);
    if (/\b(?:not|never|without|don't)\b[^,;]*$/i.test(before)) { anchor = null; continue; }
    const { quoted, token } = unwrapLiteral(m[2]);
    const verb = m[1];
    const operation = operationOf(verb);

    if (!isPathToken(quoted, token)) {
      // Extensionless paths remain valid only with an explicit "file <name>" form.
      const fileKeyword = new RegExp(String.raw`^(?:${VERBS})\s+(?:only\s+)?(?:the\s+)?file\s`, 'i').test(m[0]);
      if (fileKeyword && /^(?:READY|ONLY|BLOCKED)$/i.test(token)) {
        unresolvedOperation = true; anchor = null; continue;
      }
      if (!fileKeyword) {
        if (descriptiveProse(text, m.index, verb, token, m[0])) { anchor = null; continue; }
        // Pathless fix/patch/implement ("fix typos") — bind later via unique prior path.
        if (MUTATION_REFINE.test(verb)) { anchor = null; continue; }
        const rest = text.slice(m.index + m[1].length), phrase = refinement.exec(rest);
        const gap = anchor ? text.slice(anchor.end, m.index) : '';
        if (operation === 'edit' && anchor?.operation === 'edit' && phrase
            && refinementGap.test(gap) && !/[\r\n]/.test(phrase[0])
            && refinementEnd.test(rest.slice(phrase[0].length))) continue;
        unresolvedOperation = true; anchor = null;
        continue;
      }
    }

    // Skip matches already covered by structured phrase extractors (same span).
    const literalStart = m.index + m[0].lastIndexOf(m[2]);
    const literalEnd = literalStart + m[2].length;
    if (literalRanges.some(r => literalStart >= r.start && literalEnd <= r.end)
        && stages.some(s => s.operation === operation && s.path === normalize(token))) {
      continue;
    }

    const tokens = [token];
    literalRanges.push({ start: literalStart, end: literalEnd });
    let tail = text.slice(m.index + m[0].length - (/[.,:;!?]$/.test(m[0]) ? 1 : 0));
    const next = /^\s*(?:,\s*(?:and\s+)?|and\s+)(`[^`\n]+`|"[^"\n]+"|'[^'\n]+'|[^\s,;:!?()]+)/i;
    for (let n; (n = next.exec(tail));) {
      const q = /^[`"']/.test(n[1]), v = q ? n[1].slice(1, -1) : n[1].replace(/\.$/, '');
      if (!q && !/[./\\]/.test(v)) {
        if (descriptiveProse(text, text.length - tail.length, verb, v, n[0])) break;
        const start = text.length - tail.length + n[0].lastIndexOf(n[1]);
        if (contentTarget.test(m[0]) && !nextOperation.test(text.slice(start))) unresolvedOperation = true;
        break;
      }
      const start = text.length - tail.length + n[0].lastIndexOf(n[1]);
      literalRanges.push({ start, end: start + n[1].length });
      tokens.push(v); tail = tail.slice(n[0].length - (!q && n[1].endsWith('.') ? 1 : 0));
    }
    anchor = { operation, end: text.length - tail.length };
    for (const value of tokens) {
      const file = normalize(value);
      stages.push({ operation, path: file });
      if (!bindings.some(b => b.operation === operation && b.path === file)) bindings.push({ operation, path: file });
    }
  }
  // "Edit the file" / "Read the file" without an exact following literal remains ambiguous.
  for (const m of text.matchAll(new RegExp(String.raw`\b(?:${VERBS})\s+(?:the\s+)?file\b`, 'gi'))) {
    const rest = text.slice(m.index + m[0].length);
    // Require a real path token (word character), not lone punctuation such as ".".
    if (!/^\s*(?:`[^`\n]+`|"[^"\n]+"|'[^'\n]+'|(?:\.\/)?[A-Za-z0-9_][\w.-]*(?:\/[\w.-]+)*)/.test(rest)) unresolvedOperation = true;
  }
  if (unresolvedOperation) C.fail('requested_file_operation_required');
  if (refineImplicitMutation(text, stages, bindings, literalRanges)) {
    C.fail('requested_file_operation_required');
  }

  for (const m of text.matchAll(/(?:^|[\s`"'(])((?:\.\/)?[\w.-]+(?:\/[\w.-]+)*\.[a-z][a-z0-9_-]*)(?=\.(?:\s|$)|[\s`"'),;:!?]|$)/gi)) {
    const file = normalize(m[1].replace(/\.$/, ''));
    if (/^[`"']?\s+substitution\s+must\s+be\s+rejected\b/i.test(text.slice(m.index + m[0].length))) {
      if (bindings.some(b => b.path === file)) C.fail('requested_file_operation_required');
      continue;
    }
    const before = text.slice(0, m.index).split(/[.;\n]/).at(-1);
    if (/\b(?:not|never|without|don't)\b[^,;]*$/i.test(before)) continue;
    // Exception / contrast mentions under negation are not positive requests.
    if (/\b(?:besides|except|excluding|other\s+than|instead\s+of)\b\s*$/i.test(before)) continue;
    if (/\bdo\s+not\s+edit\b[\s\S]*$/i.test(before) && /\b(?:besides|except|excluding|other\s+than)\b/i.test(before)) continue;
    // Permitted-file lists and "only permitted target" prose are not operations.
    if (/\b(?:permitted|authorized|allowed|target)\s+files?\b/i.test(before)
        || /\bonly\s+(?:permitted|authorized|allowed)\b/i.test(before)
        || /\bmake\s+changes\s+only\s+inside\b/i.test(before)
        || /\bfor\s+(?:read|edit)\b/i.test(before)) continue;
    const start = m.index + m[0].lastIndexOf(m[1]);
    const inLiteral = literalRanges.some(r => start >= r.start && start + m[1].length <= r.end);
    if (!inLiteral && !bindings.some(b => b.path === file)) C.fail('requested_file_operation_required');
  }

  return finalizeScope(bindings, stages);
}

function files(scope) { return unique(parse(scope).bindings.map(b => b.path)); }
function stages(scope) {
  const parsed = parse(scope);
  return Array.isArray(parsed.stages) && parsed.stages.length ? parsed.stages : parsed.bindings.slice();
}

function fail(code, scope, proposed = [], authorized = [], extra = {}) {
  const error = Error(code); error.code = code;
  error.details = { requested_files: files(scope), proposed_files: proposed, authorized_files: authorized,
    mismatched_paths: unique([...files(scope).filter(f => !authorized.includes(f)), ...proposed.filter(f => !files(scope).includes(f))]),
    correction: 'Keep the exact requested paths and operations. Enroll the missing file or submit a corrected request; never substitute another enrolled file.',
    ...extra };
  throw error;
}

function assertEnrollment(scope, enrolled) {
  if (files(scope).some(f => !enrolled.includes(f))) fail('requested_file_not_enrolled', scope, [], enrolled);
  if (scope.bindings.some(b => b.operation === 'create') || stages(scope).some(s => s.operation === 'create')) {
    fail('requested_file_creation_not_authorized', scope, [], enrolled);
  }
}

function assertProposal(scope, proposal) {
  const requested = files(scope);
  if (!requested.length) return;
  if (!proposal || !Array.isArray(proposal.tasks) || !Array.isArray(proposal.files)) fail('requested_file_plan_mismatch', scope);
  const tasks = proposal.tasks, proposed = unique([...proposal.files, ...tasks.flatMap(t => Array.isArray(t?.paths) ? t.paths : [])]);
  const edits = scope.bindings.filter(b => b.operation === 'edit').map(b => b.path);
  const required = stages(scope);
  // Ordered graph fidelity when the stage list is longer than the unique
  // permission set (repeated ops) or longer than the historical two-stage shape.
  // Collapsed graphs must not look like a mere permission-set mismatch.
  const enforceStages = required.length > scope.bindings.length || required.length > 2;
  if (enforceStages) {
    if (tasks.length !== required.length) {
      fail('requested_file_stage_mismatch', scope, proposed, requested, {
        requested_stages: required, proposed_task_count: tasks.length,
      });
    }
    for (let i = 0; i < required.length; i++) {
      const stage = required[i], task = tasks[i];
      if (!task || task.operation !== stage.operation || !task.paths.includes(stage.path)) {
        fail('requested_file_stage_mismatch', scope, proposed, requested, {
          requested_stages: required, mismatched_stage_index: i,
        });
      }
      if (i > 0) {
        const prev = tasks[i - 1];
        if (!Array.isArray(task.depends_on) || !task.depends_on.includes(prev.id)) {
          fail('requested_file_dependency_mismatch', scope, proposed, requested, {
            requested_stages: required, mismatched_stage_index: i,
          });
        }
      }
    }
  }
  if (canonicalHash(proposed) !== canonicalHash(requested)
      || tasks.some(t => !t || !['read', 'edit'].includes(t.operation) || !Array.isArray(t.paths) || !t.paths.length
        || t.paths.some(f => !requested.includes(f) || t.operation === 'edit' && !edits.includes(f)))
      || scope.bindings.some(b => !tasks.some(t => t.operation === b.operation && t.paths.includes(b.path)))) {
    fail('requested_file_plan_mismatch', scope, proposed, requested);
  }

  if (!enforceStages) {
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
}

function assertOriginal(cognitive, instruction) {
  const scope = extract(instruction);
  if (cognitive.envelope.requested_scope
      && canonicalHash(scopeIdentity(scope)) !== canonicalHash(scopeIdentity(cognitive.envelope.requested_scope))) {
    C.fail('requested_file_constraint_changed');
  }
  assertProposal(scope, cognitive.proposal);
  return scope;
}

function verification(mission, snapshot, assignment = null, baseline = null) {
  const c = mission.envelope.cognitive, scope = c?.envelope.requested_scope;
  if (!scope || !files(scope).length) return null;
  assertProposal(scope, c.proposal);
  const original = mission.envelope.baseline;
  const compare = assignment ? baseline : original;
  const changed = unique([...Object.keys(compare.files), ...Object.keys(snapshot.files)]).filter(f => compare.files[f] !== snapshot.files[f]);
  const requiredEdits = assignment ? assignment.operation === 'edit' ? assignment.paths : [] : unique(scope.bindings.filter(b => b.operation === 'edit').map(b => b.path));
  const writable = assignment ? requiredEdits : unique(scope.bindings.filter(b => b.operation === 'edit').map(b => b.path));
  const missing = requiredEdits.filter(f => !Object.hasOwn(snapshot.files, f) || original.files[f] === snapshot.files[f]);
  const unexpected = changed.filter(f => !writable.includes(f));
  return { id: 'requested_file_scope', status: missing.length || unexpected.length ? 'failed' : 'passed', evidence: {
    version: 1, requested: scope.bindings, stages: stages(scope),
    proposed: c.proposal.tasks.map(t => ({ id: t.id, operation: t.operation, paths: t.paths })),
    authorized: mission.envelope.allowed_files, assignment: assignment?.id || null,
    executed_changes: changed, verified_paths: files(scope), missing_changes: missing, unexpected_changes: unexpected,
    read_evidence: 'sealed_assignment_and_runtime_receipt', change_evidence: 'host_repository_snapshot'
  } };
}

/**
 * Classify a requested path inside a prepared workspace. Separates execution
 * admissibility from planner-context forwarding so oversized enrolled docs do
 * not invent a generic missing/inadmissible denial.
 */
function diagnoseWorkspaceFile(root, relative, { planningContextAdmissible, sourceContextSensitive, maxDiscoveryFile } = {}) {
  const target = path.join(root, relative);
  try {
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink()) return { code: 'requested_file_symlink_denied', execution_ok: false, planning_ok: false };
    if (st.isDirectory()) return { code: 'requested_file_is_directory', execution_ok: false, planning_ok: false };
    if (!st.isFile()) return { code: 'requested_file_not_regular', execution_ok: false, planning_ok: false };
    const realRoot = fs.realpathSync(root), realTarget = fs.realpathSync(target);
    if (realTarget !== path.join(realRoot, relative) && !realTarget.startsWith(realRoot + path.sep)) {
      return { code: 'requested_file_path_boundary', execution_ok: false, planning_ok: false };
    }
    const buf = fs.readFileSync(target);
    if (buf.includes(0)) return { code: 'requested_file_invalid_encoding', execution_ok: false, planning_ok: false };
    let text;
    try { text = buf.toString('utf8'); } catch {
      return { code: 'requested_file_invalid_encoding', execution_ok: false, planning_ok: false };
    }
    const bytes = Buffer.byteLength(text, 'utf8');
    if (typeof sourceContextSensitive === 'function' && sourceContextSensitive(text)) {
      return { code: 'requested_file_planning_sensitive', execution_ok: true, planning_ok: false, bytes };
    }
    if (typeof maxDiscoveryFile === 'number' && bytes > maxDiscoveryFile) {
      return { code: 'requested_file_planning_oversized', execution_ok: true, planning_ok: false, bytes, max_discovery_file: maxDiscoveryFile };
    }
    if (typeof planningContextAdmissible === 'function' && !planningContextAdmissible(text)) {
      return { code: 'requested_file_planning_inadmissible', execution_ok: true, planning_ok: false, bytes };
    }
    return { code: null, execution_ok: true, planning_ok: true, bytes };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { code: 'requested_file_absent_from_workspace', execution_ok: false, planning_ok: false };
    return { code: 'requested_file_workspace_unreadable', execution_ok: false, planning_ok: false };
  }
}

function seedTasks(scope) {
  const required = stages(scope);
  const tasks = [];
  for (const stage of required) {
    const prior = tasks.at(-1);
    tasks.push({
      id: 'request_' + (tasks.length + 1),
      operation: stage.operation === 'create' ? 'edit' : stage.operation,
      paths: [stage.path],
      description: 'Perform the explicitly requested ' + stage.operation,
      depends_on: prior ? [prior.id] : [],
    });
  }
  return tasks;
}

module.exports = {
  normalize, parse, extract, files, stages, scopeIdentity, assertEnrollment, assertProposal, assertOriginal, verification,
  diagnoseWorkspaceFile, seedTasks, descriptiveProse,
};
