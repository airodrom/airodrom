'use strict';
function validateCheckpoint(value, { model = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || JSON.stringify(value).length > 6000) throw new Error('Checkpoint must be a compact object (6000 characters maximum)');
  const fields = ['objective','verifiedFacts','hypotheses','decisions','completedGates','failedApproaches','gitReferences','nextStep'];
  if (Object.keys(value).some(k => !fields.includes(k))) throw new Error('Unknown checkpoint field');
  for (const key of ['objective','nextStep']) if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 1000) throw new Error(`Invalid checkpoint ${key}`);
  for (const key of fields.filter(k => !['objective','nextStep'].includes(k))) {
    if (!Array.isArray(value[key]) || value[key].length > 20) throw new Error(`Invalid checkpoint ${key}`);
    for (const item of value[key]) {
      if (key === 'verifiedFacts') {
        if (!item || Object.keys(item).sort().join(',') !== 'evidence,fact' || typeof item.fact !== 'string' || typeof item.evidence !== 'string' || !item.fact.trim() || !item.evidence.trim()) throw new Error('Verified facts require explicit evidence');
      } else if (typeof item !== 'string' || !item.trim()) throw new Error(`Invalid checkpoint ${key} item`);
    }
  }
  if (model && (value.verifiedFacts.length || value.completedGates.length)) throw new Error('Model checkpoints cannot certify facts or completed gates; save claims as hypotheses');
  return JSON.parse(JSON.stringify(value));
}
function pressure(context) {
  if (!context || !Number.isFinite(context.tokens) || !Number.isFinite(context.contextWindow) || context.contextWindow <= 0) return null;
  const percent = context.tokens / context.contextWindow * 100;
  return { percent, warning: percent >= 65, continuation: percent >= 75 };
}
module.exports = { validateCheckpoint, pressure };
