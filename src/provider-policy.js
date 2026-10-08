'use strict';
const { containsSecret } = require('./personal-memory');
const { redactText, sensitiveKey } = require('./secret-observation');
const CLASSES = new Set(['public','internal','private','financial','sensitive','credentials']);
const CREDENTIAL_PATH=/(?:^|[\/._-])(?:auth|authorization|token|secret|credentials?|password|passwd|signature|session|cookie|oauth|bearer|jwt|api[-_]?key|private[-_]?key|access[-_]?token|refresh[-_]?token)(?:[\/._-]|$)/i;
function ordinaryWebsiteSyntax(candidate,{login=false}={}) {
  if(typeof candidate!=='string'||/[\\%\x00-\x20\x7f]/.test(candidate))return false;
  const raw=/^https:\/\/([^/?#]+)(\/[^?#]*)?$/i.exec(candidate);if(!raw||raw[1].includes('@'))return false;
  if(!/^[a-z0-9.-]+(?::443)?$/i.test(raw[1]))return false;
  const path=raw[2]||'/';
  const fixedLogin=login&&/^\/(?:api\/)?auth\/(?:login|signin|session)\/?$/i.test(path);
  return /^\/(?:[a-z0-9][a-z0-9_.-]{0,47}\/?)*$/i.test(path)&&(!CREDENTIAL_PATH.test(path)||fixedLogin)&&(!containsSecret(candidate)||fixedLogin&&!containsSecret(raw[1]));
}
// Operator syntax screening also permits a harmless unregistered origin to
// reach the domain-scope gate. It does not qualify a network or provider route.
function operatorInstructionText(value) {
  return String(value).normalize('NFKC')
    .replace(/\b(?:browser|authenticated|dedicated|isolated|visible)\s+session\b(?=\s+(?:for|to|at|on)\s|[.,;!?]|$)/gi,(phrase,offset,source)=>{
      const tail=source.slice(offset+phrase.length),next=/^\s+(?:for|to|at|on)\s+([^\s<>"'`]+)/i.exec(tail);
      if(/^\s+(?:for|to|at|on)\s/i.test(tail)&&!next)return phrase;
      if(next){const token=next[1].replace(/[.,;!]+$/,'');if(!operatorAddress(token,{login:true})&&!(/^(?:[a-z0-9-]+\.)+[a-z]{2,63}(?::443)?(?:\/.*)?$/i.test(token)&&operatorAddress('https://'+token,{login:true}))&&!/^(?:monarch|login|research)$/i.test(token))return phrase;}
      return phrase.replace(/session$/i,'workflow');
    })
    // A complete final clause describes human entry, with no supplied value.
    // Unknown trailing text keeps the original credential noun screened.
    .replace(/\b(?:i(?: will|['’]ll)|let me)\s+(?:enter|type)\s+(?:my|the)\s+(?:password|credentials)\s+(?:(?:manually|myself)\s+)?(?:in|into)\s+(?:the|a|that)\s+(?:(?:dedicated|visible|isolated|separate)\s+)?browser(?:\s+(?:manually|myself))?[.!]?$/gi,phrase=>phrase.replace(/\b(?:password|credentials)\b/i,'login'));
}
function operatorAddress(candidate,{login=false}={}) {
  const value=candidate.replace(/[.,;!]+$/,'');
  return ordinaryWebsiteSyntax(value,{login})?{value,suffix:candidate.slice(value.length)}:null;
}
function operatorSecretLike(value) {
  const normalized=String(value).normalize('NFKC');
  const loginAddresses=normalized.replace(/https:\/\/[^\s<>"'`]+/gi,candidate=>{
    const address=operatorAddress(candidate,{login:true});if(!address)return candidate;
    const safe=ordinaryWebsiteSyntax(address.value)?address.value:address.value.replace(/\/(?:api\/)?auth\/(?:login|signin|session)\/?$/i,'/');
    // Separate sentence punctuation only after the whole address validates.
    return safe+(address.suffix?' '+address.suffix:'');
  });
  // Screen actual credential shapes across the complete input first. Display
  // redaction intentionally treats "session <word>" as sensitive, but the
  // valueless noun "browser session for ..." describes a host workflow.
  // Only that noun in instruction syntax is normalized; assignments, unknown
  // session values and every other part of a mixed submission remain screened.
  if(containsSecret(loginAddresses))return true;
  // Bare domain syntax must not hide credential/query suffixes or userinfo.
  for(const token of normalized.match(/[^\s<>"'`]+/g)||[])if(!token.includes('://')&&/(?:[a-z0-9-]+\.)+[a-z]{2,63}\b/i.test(token)&&(/[?#%\\]/.test(token)||/[:/]/.test(token)&&containsSecret('https://'+token)))return true;
  const screened=operatorInstructionText(loginAddresses);
  const baseline=screened.replace(/https:\/\/[^\s<>"'`]+/gi,candidate=>{const address=operatorAddress(candidate);return address?require('./transport-outcome').safeTransportUrl(address.value)+address.suffix:candidate;});
  return containsSecret(screened)||redactText(screened)!==baseline;
}
// Display redaction canonicalizes origins and hides arbitrary paths. Those
// structural edits are not credential evidence. Only ordinary public HTTPS
// addresses may receive that equivalence; every other redaction still denies.
function publicURLBaseline(value) {
  return value.replace(/https:\/\/[^\s<>"'`]+/gi, candidate => {
    try {
      // URL parsing can erase dot segments and encoded/backslash syntax. The
      // raw address must pass before canonicalization can be equivalent.
      if(!ordinaryWebsiteSyntax(candidate))return candidate;
      const u=new URL(candidate),host=u.hostname.toLowerCase();
      if(u.username||u.password||u.search||u.hash||u.port||require('node:net').isIP(host)||!host.includes('.')||host.split('.').some(p=>! /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(p))||/(?:^|\.)(?:localhost|local|internal|invalid|test)$/.test(host)||host.endsWith('.home.arpa'))return candidate;
      if(!/^\/(?:[a-z0-9][a-z0-9_.-]{0,47}\/?)*$/i.test(u.pathname)||CREDENTIAL_PATH.test(u.pathname)||containsSecret(candidate))return candidate;
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
module.exports = { dataPolicy, secretLike, operatorSecretLike, operatorInstructionText, ordinaryWebsiteSyntax, CLASSES };
