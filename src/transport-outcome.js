'use strict';
// Product-specific payloads end here. Raw URLs/reasons are never persisted.
function safeTransportUrl(value){
 if(typeof value!=='string'||value.length>8000)return null;
 try{
  const u=new URL(value);if(!['https:','http:','ws:','wss:','codex:'].includes(u.protocol))return '[unsupported-url]';
  u.username='';u.password='';u.search='';u.hash='';
  // Only structural paths with a UUID are useful transport identifiers. Other
  // paths may themselves be credentials, so retain only the origin.
  const uuid='[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
  if(!new RegExp(`^/(?:c|threads|work)/${uuid}/?$`).test(u.pathname)&&u.pathname!=='/')u.pathname='/[redacted-path]';
  return u.toString();
 }catch{return '[invalid-url]';}
}
function redactUrls(value){return String(value)
 // Decode only URL candidates, never execution arguments or runtime values.
 .replace(/(?:https?|wss?|codex)%(?:25){0,3}3a(?:%(?:25){0,3}2f){2}[^\s<>"']+/gi,s=>{try{for(let n=0;n<4&&/%[0-9a-f]{2}/i.test(s);n++)s=decodeURIComponent(s);return safeTransportUrl(s)||'[redacted-url]';}catch{return '[redacted-url]';}})
 .replace(/(?:https?|wss?|codex):\/\/[^\s<>"']+/gi,s=>safeTransportUrl(s)||'[redacted-url]')
 // Relative links have no trustworthy origin or path allowlist. Fail closed.
 .replace(/(?<![\w:])(?:\/|\.\.?\/)[^\s<>"']*[?#][^\s<>"']*/g,'[redacted-relative-url]')
 .replace(/(?<![\w:])(?:\/|\.\.?\/)(?:[^\s<>"']*\/)?(?:auth|token|secret|session|credential|api[-_]?key)\/[^\s<>"']+/gi,'[redacted-relative-url]')
 .replace(/(?<![\w:])\/[^\s<>"']*\/[a-f0-9]{48,}[^\s<>"']*/gi,'[redacted-relative-url]')
 .replace(/(?:\/|%2f|%252f)[^\s<>"']*(?:%3f|%23|%253f|%2523)[^\s<>"']*/gi,'[redacted-relative-url]');}
function receipt(value){
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const out={};for(const k of ['thread_id','work_ref'])if(typeof value[k]==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value[k]))out[k]=value[k];
 if(typeof value.url==='string')out.url=safeTransportUrl(value.url);
 return Object.keys(out).length?out:null;
}
const CODES=new Set(['rejected_by_transport','busy','already_active','auth_required','quota_limited','temporarily_unavailable','invalid_request','policy_denied','unknown_outcome']);
function classifyCodexDispatchOutcome(raw){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))raw={};
 let classification='unknown_outcome',reasonKnown=false,noEffects=false;
 if(raw.accepted===true&&(!raw.code||raw.code==='accepted')){classification='accepted';reasonKnown=true;}
 else if(raw.accepted===false){classification=CODES.has(raw.code)?raw.code:'rejected_by_transport';reasonKnown=CODES.has(raw.code);noEffects=!['already_active','unknown_outcome'].includes(classification);}
 const retryable=noEffects&&['rejected_by_transport','busy','temporarily_unavailable'].includes(classification);
 return{classification,reason_known:reasonKnown,no_side_effects:noEffects,retryable,receipt:receipt(raw.receipt),safe_failure_reason:classification};
}
module.exports={safeTransportUrl,redactUrls,receipt,classifyCodexDispatchOutcome};
