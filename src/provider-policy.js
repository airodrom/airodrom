'use strict';
const { containsSecret } = require('./personal-memory');
const { redactText, sensitiveKey } = require('./secret-observation');
const CLASSES = new Set(['public','internal','private','financial','sensitive','credentials']);
function secretLike(value, depth = 0) {
  if (depth > 20) return true;
  if (typeof value === 'string') {const normalized=value.normalize('NFKC');return containsSecret(normalized) || redactText(normalized) !== normalized;}
  if (Array.isArray(value)) return value.some(v => secretLike(v, depth + 1));
  return !!value && typeof value === 'object' && Object.entries(value).some(([k,v]) => sensitiveKey(k) || secretLike(v, depth + 1));
}
// Host-owned classification and project policy. Never derived from model output.
function dataPolicy(input, provider) {
  const classification = input.data_class;
  if (!CLASSES.has(classification)) return {allow:false,reason:'unknown_data_class'};
  if (classification === 'credentials' || secretLike(input.messages) || secretLike(input.tools) || secretLike(input.structured_schema)) return {allow:false,reason:'secrets_prohibited'};
  const p = input.project_policy || {};
  if (provider.locality !== 'local' && provider.locality !== 'external') return {allow:false,reason:'unknown_locality'};
  if (provider.locality === 'external') {
    if (input.privacy === 'local_only' || p.local_only === true) return {allow:false,reason:'local_only'};
    const approved = p.approved_external?.[classification];
    if (!Array.isArray(approved) || !approved.includes(provider.id)) return {allow:false,reason:'external_not_approved'};
  }
  if (input.attachment_refs?.length && p.allow_attachments !== true) return {allow:false,reason:'attachments_not_approved'};
  if (input.context_refs?.length && p.allow_project_context !== true) return {allow:false,reason:'project_context_not_approved'};
  if (input.memory_refs?.length && p.allow_memory !== true) return {allow:false,reason:'memory_not_approved'};
  // V1 only transmits explicitly supplied text; references are never dereferenced.
  if (input.attachment_refs?.length || input.context_refs?.length || input.memory_refs?.length) return {allow:false,reason:'reference_transport_unsupported'};
  return {allow:true,classification,minimum_context:true,redaction_required:true,execution_authority:false};
}
module.exports = { dataPolicy, secretLike, CLASSES };
