'use strict';
// ADR 0047: pure scoring over authorized synthetic retrieval evidence.
// No retrieval, embeddings, database or authority surface is introduced here.
function measure({ expected, forbidden = [], retrieved, budget, used, grounded = [], claims = [] }) {
 if (![expected, forbidden, retrieved, grounded, claims].every(Array.isArray) || !Number.isSafeInteger(budget) || budget < 1 || !Number.isSafeInteger(used) || used < 0) throw Error('Invalid memory quality evidence');
 const wanted = new Set(expected), denied = new Set(forbidden), ids = retrieved.map(r => r.id), selected = new Set(ids);
 const relevant = [...selected].filter(id => wanted.has(id)).length, irrelevant = ids.length - relevant;
 const ranked = new Set();
 const dcg = ids.reduce((sum, id, i) => { const useful = wanted.has(id) && !ranked.has(id); ranked.add(id); return sum + (useful ? 1 / Math.log2(i + 2) : 0); }, 0);
 const ideal = Array.from({ length: Math.min(wanted.size, ids.length) }, (_, i) => 1 / Math.log2(i + 2)).reduce((a, b) => a + b, 0);
 const validEvidence = new Set(grounded);
 return { relevant, irrelevant, expected: wanted.size, retrieved: ids.length,
  precision: ids.length ? relevant / ids.length : wanted.size ? 0 : 1,
  recall: wanted.size ? [...wanted].filter(id => selected.has(id)).length / wanted.size : selected.size ? 0 : 1,
  ranking_ndcg: ideal ? dcg / ideal : wanted.size ? 0 : 1,
  forbidden_hits: ids.filter(id => denied.has(id)).length, duplicates: ids.length - selected.size,
  provenance_coverage: ids.length ? retrieved.filter(r => r.provenance === true).length / ids.length : null,
  unsupported_claims: claims.filter(c => !validEvidence.has(c)).length,
  missing_evidence: wanted.size === 0, budget_used: used, budget_limit: budget, budget_compliant: used <= budget,
  context_efficiency: ids.length ? relevant / ids.length : null, authority: false };
}
function compare(before, after) {
 const privacy = after.forbidden_hits === 0 && after.unsupported_claims === 0 && after.budget_compliant;
 return { retain_candidate: privacy && after.recall >= before.recall && after.precision >= before.precision && (after.recall > before.recall || after.precision > before.precision || after.ranking_ndcg > before.ranking_ndcg), privacy_preserved: privacy, recall_delta: after.recall - before.recall, precision_delta: after.precision - before.precision };
}
module.exports = { measure, compare };
