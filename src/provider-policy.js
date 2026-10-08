'use strict';
const { containsSecret } = require('./personal-memory');
const { redactText, sensitiveKey } = require('./secret-observation');
const CLASSES = new Set(['public','internal','private','financial','sensitive','credentials']);
// Display redaction canonicalizes origins and hides arbitrary paths. Those
// structural edits are not credential evidence. Only ordinary public HTTPS
// addresses may receive that equivalence; every other redaction still denies.
function publicURLBaseline(value) {
  return value.replace(/https:\/\/[^\s<>"'`]+/gi, candidate => {
    try {
      // URL parsing can erase dot segments and encoded/backslash syntax. The
      // raw address must pass before canonicalization can be equivalent.
      const raw=/^https:\/\/[^/]+(\/.*)?$/i.exec(candidate);if(!raw)return candidate;
      const rawPath=raw[1]||'/';
      if(/[\\%\x00-\x20\x7f]/.test(candidate)||!/^\/(?:[a-z][a-z0-9_-]{0,47}\/?)*$/i.test(rawPath)||/\b(?:auth|token|secret|credential|password|signature|session|api[-_]?key)\b/i.test(rawPath))return candidate;
      const u=new URL(candidate),host=u.hostname.toLowerCase();
      if(u.username||u.password||u.search||u.hash||u.port||require('node:net').isIP(host)||!host.includes('.')||host.split('.').some(p=>! /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(p))||/(?:^|\.)(?:localhost|local|internal|invalid|test)$/.test(host)||host.endsWith('.home.arpa'))return candidate;
      if(!/^\/(?:[a-z][a-z0-9_-]{0,47}\/?)*$/i.test(u.pathname)||/\b(?:auth|token|secret|credential|password|signature|session|api[-_]?key)\b/i.test(u.pathname)||containsSecret(candidate))return candidate;
      return require('./transport-outcome').safeTransportUrl(candidate);
    } catch { return candidate; }
  });
}
function secretLike(value, depth = 0) {
  if (depth > 20) return true;
  if (typeof value === 'string') {const normalized=value.normalize('NFKC');return containsSecret(normalized) || redactText(normalized) !== publicURLBaseline(normalized);}
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
