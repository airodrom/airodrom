'use strict';
// Terminal-only host workflow. No HTTP, model, event, or history value path.
const path=require('node:path'),{parse}=require('./private-vault-intent');
async function guide({message,input,output,home,signal,vault}={}) {
 if(!input?.isTTY||!output?.isTTY||typeof input.setRawMode!=='function')throw Error('Private Vault requires an interactive operator terminal.');
 if(input.listenerCount('data')||input.listenerCount('readable'))throw Error('Close ordinary terminal input before Private Vault.');
 const intent=parse(message,{capture:true});message=null;if(!intent)throw Error('Use /secret for private identifiers. Credentials require /vault secure entry.');
 const local=require('./local-bootstrap');
 if(!vault){local.privateDirectory(home,true);vault=new(require('./secret-vault').SecretVault)(local.privateDirectory(path.join(home,'data'),true));}
 const terminal=require('./vault-cli');
 const choose=(prompt,choices)=>terminal.visible(input,output,{prompt,choices,signal});
 const cancel=()=>{output.write('Cancelled. Nothing saved, revealed or changed.\n');return {state:'cancelled'};};
 const confirm=prompt=>terminal.confirm(input,output,{prompt,signal});
 const entries=query=>{const rows=vault.search(query||'');if(!rows.length)output.write(query?'No matching Vault label. Try /secret list to see saved names.\n':'Your Vault is empty. Save a mailbox number here, or use /vault for a password or API key.\n');else rows.forEach((r,i)=>output.write(`${i+1}. ${r.name} · ${r.kind==='private_identifier'?'Private identifier':'Credential · stays hidden'}\n`));return rows;};
 try {
  if(intent.action==='classify'){
   output.write('Where should this belong?\n1. Personal Memory: ordinary preferences and facts\n2. Sensitive Memory: private facts, operator-only\n3. Vault: identifiers or credentials in Keychain\n');
   const choice=await choose('Choose 1–3 · Enter or Ctrl+C cancels: ',['1','2','3']);
   if(!choice)return cancel();
   output.write(choice==='1'?'Use /remember with an ordinary fact.\n':choice==='2'?'Use /remember-sensitive with a private fact.\n':'Use /secret for a private identifier, or /vault to enter a credential securely.\n');return {state:'clarification'};
  }
  if(intent.action==='clarify'||!intent.label&&!['list','search'].includes(intent.action)){
   output.write('Use /secret list, search <label>, reveal <label>, remove <label>, or rename <label> to <new label>. To save: Save my mailbox number, followed by its number.\n');return {state:'clarification'};
  }
  if(['list','search'].includes(intent.action)){entries(intent.label);return {state:'listed'};}
  if(intent.action==='save'){
   if(vault.search(intent.label).some(r=>require('./private-vault-intent').key(r.name)===require('./private-vault-intent').key(intent.label))){output.write('That label already exists. Rename or remove it first; I will not overwrite it.\n');return {state:'collision'};}
   if(!vault.status().configured){output.write('Keychain is unavailable. Run airodrom secret prepare in Terminal.\n');return {state:'unavailable'};}
   if(intent.value===undefined){
    intent.value=await terminal.hidden(input,output,{prompt:`${intent.label} (digits; hidden until preview; Ctrl+C cancels): `,maximum:64,signal});
    if(!intent.value)return cancel();
    if(!/^\d{1,12}$/.test(intent.value)){output.write('Use 1–12 digits for a private identifier. Passwords, PINs and keys belong in /vault. Nothing saved.\n');return {state:'invalid'};}
   }
   output.write(`${intent.label}\n  Value: ${intent.value}\n  Private identifier · stored in Keychain\n`);
   if(!await confirm(`Save ${intent.label} as a private identifier in your Keychain Vault?`))return cancel();
   const saved=vault.put(intent.value,'operator',{kind:'private_identifier',name:intent.label});output.write(`Saved as ${intent.label} in your private Vault.\n`);return {state:'saved',reference:saved.reference};
  }
  const exact=vault.search(intent.label).filter(r=>require('./private-vault-intent').key(r.name)===require('./private-vault-intent').key(intent.label));
  const rows=exact.length?exact:vault.search(intent.label);
  if(!rows.length){output.write('No matching saved Vault label. Try /secret list or /secret search <label>.\n');return {state:'missing'};}
  let selected=rows[0];
  if(rows.length>1){output.write('Several labels match. Choose the one you mean.\n');rows.forEach((r,i)=>output.write(`${i+1}. ${r.name}\n`));const answer=await choose('Choose one number · 0, Enter or Ctrl+C cancels: ',['0',...rows.map((_,i)=>String(i+1))]);if(!/^[1-9]\d{0,3}$/.test(answer)||!rows[Number(answer)-1])return cancel();selected=rows[Number(answer)-1];}
  const current=()=>{if(!vault.search('').some(row=>row.reference===selected.reference&&row.name===selected.name&&row.kind===selected.kind))throw Error('Vault selection changed');};
  if(intent.action==='reveal'){
   if(selected.kind!=='private_identifier'){output.write('Credentials stay hidden. Use their reference through an approved capability.\n');return {state:'denied'};}
   output.write('This will be visible here and may remain in terminal scrollback.\n');
   if(!await confirm(`Reveal ${selected.name} to you in this operator terminal?`))return cancel();
   current();
   // Reveal to the terminal only. No value-bearing receipt is returned.
   let value=vault.revealPrivate(selected.reference,{confirmed:true});try{output.write(`Your ${selected.name.toLowerCase()} is ${value}.\n`);}finally{value='';}return {state:'revealed'};
  }
  if(intent.action==='remove'){
   if(!await confirm(`Remove ${selected.name} and permanently revoke its reference?`))return cancel();
   current();
   vault.forget(selected.reference);output.write('Removed. Its reference is revoked.\n');return {state:'removed'};
  }
  if(intent.action==='rename'){
   if(vault.search('').some(row=>row.reference!==selected.reference&&require('./private-vault-intent').key(row.name)===require('./private-vault-intent').key(intent.new_label))){output.write('That label already exists. Choose another name; both entries are unchanged.\n');return {state:'collision'};}
   if(!await confirm(`Rename ${selected.name} to ${intent.new_label}?`))return cancel();
   current();
   vault.rename(selected.reference,intent.new_label);output.write(`Renamed to ${intent.new_label}.\n`);return {state:'renamed'};
  }
  return {state:'clarification'};
 }catch(error){
  if(signal?.aborted||error.message==='Secure entry cancelled')return cancel();
  if(error.message==='Visible choice invalid'){output.write('Use one of the displayed choices.\n');return cancel();}
  output.write('Vault entry is unavailable or changed. Try /secret list and choose the current label; check airodrom secret status if needed.\n');return {state:'unavailable'};
 }finally{if(intent)delete intent.value;}
}
module.exports={guide};
