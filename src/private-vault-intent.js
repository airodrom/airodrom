'use strict';
// Operator ingress only. The default result contains no private value.
const PRIVATE_LABELS = ['mailbox number', 'locker number', 'parking space number'];
function normalizeLabel(value) {
 if(typeof value!=='string')throw Error('Choose a readable Vault label.');
 const label=value.trim().replace(/\s+/g,' ');
 if(!/^[\p{L}][\p{L} .'-]{0,63}$/u.test(label)||require('./personal-memory').containsSecret(label))throw Error('Choose a short label using words, without a value.');
 return label[0].toUpperCase()+label.slice(1);
}
function containsPrivate(value,depth=0){if(depth>20)return true;if(typeof value==='string')return /\b(?:mailbox|locker|parking\s+space)\s+number\b/i.test(value.normalize('NFKC'));if(Array.isArray(value))return value.some(v=>containsPrivate(v,depth+1));return !!value&&typeof value==='object'&&Object.values(value).some(v=>containsPrivate(v,depth+1));}
const key=value=>String(value).trim().replace(/\s+/g,' ').toLocaleLowerCase('en-US');
function parse(value,{capture=false,nickname}={}) {
 if(typeof value!=='string')return null;
 if(Buffer.byteLength(value)>4000||/[\r\n\0]/.test(value))return containsPrivate(value)?{kind:'private_vault',route:'VAULT',action:'clarify'}:null;
 const request=require('./personal-storage-intent').normalize(value,nickname).replace(/\s+/g,' ');
 const command=/^\/secret(?:\s+(list|search|reveal|remove|rename))?(?:\s+(.+))?$/i.exec(request);
 if(command){
  const action=(command[1]||'list').toLowerCase(),arg=command[2]||'';
  if(action==='list'&&arg)return {kind:'private_vault',route:'VAULT',action:'clarify'};
  if(action==='rename'){
   const parts=arg.split(/\s+to\s+/i);if(parts.length!==2)return {kind:'private_vault',route:'VAULT',action:'clarify'};
   try{return {kind:'private_vault',route:'VAULT',action,label:normalizeLabel(parts[0]),new_label:normalizeLabel(parts[1])};}catch{return {kind:'private_vault',route:'VAULT',action:'clarify'};}
  }
  try{return {kind:'private_vault',route:'VAULT',action,...(arg?{label:normalizeLabel(arg)}:{})};}catch{return {kind:'private_vault',route:'VAULT',action:'clarify'};}
 }
 // Never classify a password, PIN, token or recovery code as an identifier.
 if(require('./personal-memory').containsSecret(value)||/\b(?:password|passphrase|passcode|pin|api[ _-]?key|otp|token|recovery|seed phrase|private key|authentication code)\b/i.test(value))return null;
 const labels=PRIVATE_LABELS.join('|');
 const save=new RegExp('^(?:save|store|remember)\\s+(?:(?:secret of|the secret of)\\s+)?(?:my\\s+)?('+labels+')\\s*(?:is|:|=|-)?\\s*(\\d{1,12})$','i').exec(request);
 if(save)return {kind:'private_vault',route:'VAULT',action:'save',label:normalizeLabel(save[1]),classification:'private_identifier',...(capture?{value:save[2]}:{value_present:true})};
 const lookup=new RegExp("^(?:what(?:['’]s| is)|give me|show|reveal|tell me)\\s+(?:my\\s+)?("+labels+")\\s*-?$",'i').exec(request);
  if(lookup)return {kind:'private_vault',route:'VAULT',action:'reveal',label:normalizeLabel(lookup[1])};
 if(containsPrivate(request))return {kind:'private_vault',route:'VAULT',action:'clarify'};
 if(/^(?:save|store|remember)\s+(?:my\s+)?(?:mailbox|locker|parking space)\b/i.test(request))return {kind:'private_vault',route:'VAULT',action:'clarify'};
 if(/^(?:save|store)\s+my\s+\S+/i.test(request))return {kind:'private_vault',route:'VAULT',action:'classify'};
 return null;
}
module.exports={parse,normalizeLabel,key,PRIVATE_LABELS,containsPrivate};
