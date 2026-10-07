'use strict';
const path=require('node:path'),{randomUUID}=require('node:crypto');
async function guide({entry_url,input,output,home,signal,vault,request}={}){
 if(!input?.isTTY||!output?.isTTY||!input.setRawMode||input.listenerCount('data')||input.listenerCount('readable'))throw Error('Account authorization requires detached secure operator terminal input');
 let u;try{u=new URL(entry_url);}catch{throw Error('Use /research account <public HTTPS login URL>');}
 if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash)throw Error('Use a public HTTPS login URL without credentials or query parameters');
 const local=require('./local-bootstrap');vault||=new(require('./secret-vault').SecretVault)(local.privateDirectory(path.join(home,'data'),true));
 const rows=vault.search('').filter(r=>r.kind!=='private_identifier');
 if(rows.length<2){output.write('Save your account username and password as separate credentials with /vault secure entry, then label them with /secret rename. Values stay in Keychain.\n');return {kind:'clarify',message:'Two stored account credentials are required.'};}
 output.write('ACCOUNT RESEARCH AUTHORIZATION\n'+u.origin+'\nOnly the selected account credentials may be used for this research Mission. Screenshots of account pages are disabled. MFA or CAPTCHA stops this Mission for manual inspection. Live handoff and bypass are unavailable.\n');
 rows.forEach((r,i)=>output.write(`${i+1}. ${r.name}\n`));
 const choose=prompt=>require('./vault-cli').hidden(input,output,{prompt,maximum:64,signal});
 const select=async prompt=>{const v=await choose(prompt);if(!/^[1-9]\d{0,3}$/.test(v)||!rows[Number(v)-1])throw Error('Account authorization cancelled');return rows[Number(v)-1];};
 const user=await select('Choose stored username (hidden number): '),password=await select('Choose stored password (hidden number): ');
 if(user.reference===password.reference||!['password','credential'].includes(password.kind))throw Error('Choose two distinct account credentials');
 output.write('Authorize a single existing-account login to '+u.origin+' for competitor product research using these two references?\n');
 if(!/^(?:yes|y)$/i.test(await choose('Yes or no (hidden): '))||signal?.aborted)return {kind:'clarify',message:'Account authorization cancelled.'};
 return (request||local.request)(home,'/api/assistant/research/account',{entry_url:u.href,username_reference:user.reference,password_reference:password.reference,confirmed:true,request_id:randomUUID()});
}
module.exports={guide};
