'use strict';
// ADR 0010: operator-only entry; no model, request, readline or secret reveal.
const path=require('node:path');
const {hidden}=require('./vault-cli');
const MENU='SECRET VAULT\n\nWhat would you like to do?\n\n1. Save password/API key\n2. View saved secret names\n3. Remove a secret\n4. Cancel\n';

async function guide({input,output,home,signal,vault}={}){
 // The CLI closes and detaches its ordinary reader before invoking this guide,
 // then reconstructs it afterward. Refuse even a paused competing reader.
 if(!input?.isTTY||typeof input.setRawMode!=='function')throw Error('Secret Vault requires an interactive operator terminal.');
 if(input.listenerCount('data')||input.listenerCount('readable'))throw Error('Close ordinary terminal input before opening Secret Vault.');
 const local=require('./local-bootstrap');
 if(!vault){local.privateDirectory(home,true);vault=new(require('./secret-vault').SecretVault)(local.privateDirectory(path.join(home,'data'),true));}
 const choose=prompt=>hidden(input,output,{prompt,maximum:16,signal});
 const cancelled=()=>{output.write('Secret Vault cancelled.\n');return {state:'cancelled'};};
 const entries=()=>{
  const rows=vault.names();
  if(!rows.length)output.write('No saved secret names.\n');
  else for(let i=0;i<rows.length;i++)output.write(`${i+1}. ${rows[i].name}\n`);
  return rows;
 };
 try{
  output.write(MENU);
  const selection=await choose('Choose 1–4 (hidden; Ctrl+C cancels): ');
  if(selection==='4'||signal?.aborted)return cancelled();
  if(selection==='2'){entries();return {state:'listed'};}
  if(selection==='1'){
   if(!vault.status().configured){output.write('The secure Keychain helper is unavailable. Run airodrom secret prepare in Terminal, then try again.\n');return {state:'unavailable'};}
   output.write('Save as:\n1. Password\n2. API key\n3. Cancel\n');
   const type=await choose('Choose 1–3 (hidden): ');
   if(type==='3'||signal?.aborted)return cancelled();
   if(!['1','2'].includes(type)){output.write('Choose a listed option to save a secret.\n');return {state:'invalid'};}
   let value=await hidden(input,output,{signal});
   try{
    if(signal?.aborted)return cancelled();
    const receipt=vault.put(value,'operator',{kind:type==='1'?'password':'api_key'});
    const row=vault.names().find(entry=>entry.reference===receipt.reference);
    output.write('Secret saved'+(row?' as '+row.name:'')+'. Values stay hidden.\n');
    return {state:'saved',reference:receipt.reference};
   }finally{value='';}
  }
  if(selection==='3'){
   const rows=entries();if(!rows.length)return {state:'empty'};
   const selected=await choose('Secret number to remove, or 0 to cancel (hidden): ');
   if(selected==='0'||signal?.aborted)return cancelled();
   const index=/^[1-9]\d{0,5}$/.test(selected)?Number(selected)-1:-1;
   if(!rows[index]){output.write('Choose a listed secret number.\n');return {state:'invalid'};}
   output.write(`Remove ${rows[index].name}?\n1. Remove\n2. Cancel\n`);
   const confirmed=await choose('Choose 1–2 (hidden): ');
   if(confirmed!=='1'||signal?.aborted)return cancelled();
   // Recheck current operator names so the menu cannot revoke a connector token
   // or act on a stale/revoked entry from an earlier prompt.
   if(!vault.names().some(row=>row.reference===rows[index].reference))throw Error('Secret selection unavailable');
   vault.forget(rows[index].reference);output.write('Secret removed. Its reference is revoked.\n');return {state:'removed'};
  }
  output.write('Choose a listed Secret Vault option.\n');return {state:'invalid'};
 }catch(error){
  if(signal?.aborted||error.message==='Secure entry cancelled')return cancelled();
  // Host/provider diagnostics might contain credentials. No raw error crosses
  // this operator-facing workflow or reaches conversation/audit metadata.
  output.write('Secure Vault operation unavailable. Values stay hidden; check airodrom secret status.\n');
  return {state:'unavailable'};
 }
}
module.exports={guide,MENU};
