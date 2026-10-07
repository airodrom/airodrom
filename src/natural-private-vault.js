'use strict';
// Terminal-only host workflow. No HTTP, model, event, or history value path.
const path=require('node:path'),{parse}=require('./private-vault-intent');
async function guide({message,input,output,home,signal,vault}={}) {
 if(!input?.isTTY||!output?.isTTY||typeof input.setRawMode!=='function')throw Error('Private Vault requires an interactive operator terminal.');
 if(input.listenerCount('data')||input.listenerCount('readable'))throw Error('Close ordinary terminal input before Private Vault.');
 const intent=parse(message,{capture:true});message=null;if(!intent)throw Error('Use /secret for private identifiers. Credentials require /vault secure entry.');
 const local=require('./local-bootstrap');
 if(!vault){local.privateDirectory(home,true);vault=new(require('./secret-vault').SecretVault)(local.privateDirectory(path.join(home,'data'),true));}
 const choose=prompt=>require('./vault-cli').hidden(input,output,{prompt,maximum:64,signal});
 const cancel=()=>({state:'cancelled'});
 const confirm=async prompt=>{output.write(prompt+'\n');return /^(?:yes|y|1)$/i.test(await choose('Yes or no (hidden; Ctrl+C cancels): '))&&!signal?.aborted;};
 const entries=query=>{const rows=vault.search(query||'');if(!rows.length)output.write('No matching saved Vault labels.\n');else rows.forEach((r,i)=>output.write(`${i+1}. ${r.name} · ${r.kind==='private_identifier'?'Private identifier':'Credential; approved capability use only'}\n`));return rows;};
 try {
  if(intent.action==='classify'){
   output.write('Where should this belong?\n1. Personal Memory: ordinary preferences and facts\n2. Sensitive Memory: private facts, operator-only\n3. Vault: identifiers or credentials in Keychain\n');
   const choice=await choose('Choose 1–3 (hidden): ');
   output.write(choice==='1'?'Use /remember with an ordinary fact.\n':choice==='2'?'Use /remember-sensitive with a private fact.\n':'Use /secret for a private identifier, or /vault to enter a credential securely.\n');return {state:'clarification'};
  }
  if(intent.action==='clarify'||!intent.label&&!['list','search'].includes(intent.action)){
   output.write('Use /secret list, search <label>, reveal <label>, remove <label>, or rename <label> to <new label>. To save: Save my mailbox number, followed by its number.\n');return {state:'clarification'};
  }
  if(['list','search'].includes(intent.action)){entries(intent.label);return {state:'listed'};}
  if(intent.action==='save'){
   if(vault.search(intent.label).some(r=>require('./private-vault-intent').key(r.name)===require('./private-vault-intent').key(intent.label))){output.write('That label already exists. Rename or remove it first; I will not overwrite it.\n');return {state:'collision'};}
   if(!vault.status().configured){output.write('Keychain is unavailable. Run airodrom secret prepare in Terminal.\n');return {state:'unavailable'};}
   if(!await confirm(`Save ${intent.label} as a private identifier in your Keychain Vault?`))return cancel();
   const saved=vault.put(intent.value,'operator',{kind:'private_identifier',name:intent.label});output.write(`Saved as ${intent.label} in your private Vault.\n`);return {state:'saved',reference:saved.reference};
  }
  const exact=vault.search(intent.label).filter(r=>require('./private-vault-intent').key(r.name)===require('./private-vault-intent').key(intent.label));
  const rows=exact.length?exact:vault.search(intent.label);
  if(!rows.length){output.write('No matching saved Vault label.\n');return {state:'missing'};}
  let selected=rows[0];
  if(rows.length>1){rows.forEach((r,i)=>output.write(`${i+1}. ${r.name}\n`));const answer=await choose('Choose one number, or 0 to cancel (hidden): ');if(!/^[1-9]\d{0,3}$/.test(answer)||!rows[Number(answer)-1])return cancel();selected=rows[Number(answer)-1];}
  if(intent.action==='reveal'){
   if(selected.kind!=='private_identifier'){output.write('Credentials stay hidden. Use their reference through an approved capability.\n');return {state:'denied'};}
   if(!await confirm(`Reveal ${selected.name} to you in this operator terminal?`))return cancel();
   // Reveal to the terminal only. No value-bearing receipt is returned.
   let value=vault.revealPrivate(selected.reference,{confirmed:true});try{output.write(`Your ${selected.name.toLowerCase()} is ${value}.\n`);}finally{value='';}return {state:'revealed'};
  }
  if(intent.action==='remove'){
   if(!await confirm(`Remove ${selected.name} and permanently revoke its reference?`))return cancel();
   vault.forget(selected.reference);output.write('Removed. Its reference is revoked.\n');return {state:'removed'};
  }
  if(intent.action==='rename'){
   if(!await confirm(`Rename ${selected.name} to ${intent.new_label}?`))return cancel();
   vault.rename(selected.reference,intent.new_label);output.write('Vault label renamed.\n');return {state:'renamed'};
  }
  return {state:'clarification'};
 }catch(error){
  if(signal?.aborted||error.message==='Secure entry cancelled')return cancel();
  output.write('Private Vault operation unavailable. No value was sent to a model or retained in chat.\n');return {state:'unavailable'};
 }finally{if(intent)delete intent.value;}
}
module.exports={guide};
