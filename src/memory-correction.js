'use strict';

/**
 * Deterministic Personal Memory V2 correction identity.
 * Supersession must not depend on an LLM choosing among concurrent active facts.
 */

function stripCorrectionPreamble(content) {
  let text = String(content).normalize('NFC').trim();
  text = text.replace(/^(?:correction|update|actually|revised?|instead)\s*:\s*/i, '');
  text = text.replace(/^(?:please\s+)?(?:correct|update|revise|change)(?:\s+(?:that|this|it|my\s+(?:memory|fact)))?\s*(?:to|:|=|-)?\s*/i, '');
  return text.trim();
}

function subjectFor(content) {
  const normalized = stripCorrectionPreamble(content);
  const match = /^(?:my|our|the)\s+(.{1,100}?)\s+(?:is|are)(?:\s+(?:now|currently|still))?\s+/i.exec(normalized);
  if (match) return match[1].trim().toLowerCase().replace(/\s+/g, ' ');
  return normalized.slice(0, 120).trim().toLowerCase().replace(/\s+/g, ' ');
}

function factKey(itemOrContent) {
  if (itemOrContent && typeof itemOrContent === 'object') {
    const fromContent = subjectFor(itemOrContent.content || '');
    if (fromContent && fromContent !== String(itemOrContent.content || '').slice(0, 120).trim().toLowerCase()) return fromContent;
    return String(itemOrContent.subject || fromContent || '').trim().toLowerCase();
  }
  return subjectFor(itemOrContent);
}

function canonicalFactContent(content) {
  let text = stripCorrectionPreamble(content);
  text = text.replace(/\b(is|are)\s+(?:now|currently)\s+/gi, '$1 ');
  text = text.replace(/,\s*not\s+[^.,;]+/gi, '');
  text = text.replace(/\s+instead\s+of\s+[^.,;]+/gi, '');
  text = text.replace(/\s+no\s+longer\s+[^.,;]+/gi, '');
  text = text.replace(/\s+/g, ' ').trim();
  if (text && !/[.!?]$/.test(text)) text += '.';
  return text;
}

function isCorrectionStatement(content) {
  const raw = String(content).normalize('NFC').trim();
  if (/^(?:correction|update|actually|revised?)\s*:/i.test(raw)) return true;
  if (/\b(?:is|are)\s+now\b/i.test(raw) && /,\s*not\s+/i.test(raw)) return true;
  if (/\binstead\s+of\b/i.test(raw) || /\bno\s+longer\b/i.test(raw)) return true;
  return false;
}

function newerItem(a, b) {
  if (!a) return b;
  if (!b) return a;
  if ((a.updatedAt || 0) !== (b.updatedAt || 0)) return (a.updatedAt || 0) > (b.updatedAt || 0) ? a : b;
  return String(a.memoryId || a.id || '').localeCompare(String(b.memoryId || b.id || '')) > 0 ? a : b;
}

/** Collapse concurrent active rows that encode the same fact key; keep newest. */
function currentItems(items = []) {
  const winners = new Map();
  for (const item of items) {
    if (!item || item.status && item.status !== 'active') continue;
    const key = factKey(item);
    if (!key) continue;
    winners.set(key, newerItem(winners.get(key), item));
  }
  const allowed = new Set([...winners.values()].map(item => item.memoryId || item.id));
  return items.filter(item => allowed.has(item.memoryId || item.id));
}

/** Current-answer projection: collapse conflicts and strip correction scaffolding from content. */
function presentCurrentItems(items = []) {
  return currentItems(items).map(item => {
    const key = factKey(item);
    if (!item?.content || !isCorrectionStatement(item.content)) {
      return key && item.subject !== key ? { ...item, subject: key } : item;
    }
    return { ...item, subject: key || item.subject, content: canonicalFactContent(item.content) };
  });
}

function planActiveConflicts(items = []) {
  const groups = new Map();
  for (const item of items) {
    if (!item || (item.status && item.status !== 'active')) continue;
    const key = factKey(item);
    if (!key) continue;
    const list = groups.get(key) || [];
    list.push(item);
    groups.set(key, list);
  }
  const conflicts = [];
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    const keep = group.reduce(newerItem);
    const keepId = keep.memoryId || keep.id;
    conflicts.push({
      factKey: key,
      keepId,
      supersedeIds: group.map(item => item.memoryId || item.id).filter(id => id !== keepId).sort(),
      keepUpdatedAt: keep.updatedAt || null
    });
  }
  return conflicts.sort((a, b) => a.factKey.localeCompare(b.factKey));
}

/**
 * Safe reconciliation for already-active conflicting facts.
 * dryRun (default) never mutates. apply requires explicit confirmApply=true.
 */
function reconcileActiveConflicts(memory, { dryRun = true, confirmApply = false, domain = 'personal', limit = 100 } = {}) {
  if (!memory || typeof memory.recent !== 'function') throw new Error('Personal memory service required');
  const items = memory.recent({ domain, limit, includeSensitive: false }).items;
  const conflicts = planActiveConflicts(items);
  if (dryRun || !confirmApply) {
    return { dryRun: true, applied: false, conflictCount: conflicts.length, conflicts };
  }
  if (typeof memory.supersedeActive !== 'function') throw new Error('Memory service lacks supersedeActive');
  const applied = [];
  for (const conflict of conflicts) {
    applied.push(memory.supersedeActive(conflict.supersedeIds, conflict.keepId));
  }
  return { dryRun: false, applied: true, conflictCount: conflicts.length, conflicts, results: applied };
}

module.exports = {
  stripCorrectionPreamble,
  subjectFor,
  factKey,
  canonicalFactContent,
  isCorrectionStatement,
  newerItem,
  currentItems,
  presentCurrentItems,
  planActiveConflicts,
  reconcileActiveConflicts
};
