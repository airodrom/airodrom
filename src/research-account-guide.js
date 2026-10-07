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
 const terminal=require('./vault-cli');
 const choose=prompt=>terminal.visible(input,output,{prompt,choices:['0',...rows.map((_,i)=>String(i+1))],signal});
 const select=async prompt=>{const v=await choose(prompt);if(!/^[1-9]\d{0,3}$/.test(v)||!rows[Number(v)-1])throw Error('Account authorization cancelled');return rows[Number(v)-1];};
 const user=await select('Username entry number · 0 or Ctrl+C cancels: '),password=await select('Password entry number · 0 or Ctrl+C cancels: ');
 if(user.reference===password.reference||!['password','credential'].includes(password.kind))throw Error('Choose two distinct account credentials');
 output.write(`Username: ${user.name}\nPassword: ${password.name}\n`);
 if(!await terminal.confirm(input,output,{prompt:'Authorize one existing-account login to '+u.origin+' for competitor product research?',signal}))return {kind:'clarify',message:'Account authorization cancelled.'};
 const current=vault.search('');
 if(![user,password].every(selected=>current.some(row=>row.reference===selected.reference&&row.name===selected.name&&row.kind===selected.kind)))throw Error('Account credential selection changed; list current Vault labels and retry.');
 return (request||local.request)(home,'/api/assistant/research/account',{entry_url:u.href,username_reference:user.reference,password_reference:password.reference,confirmed:true,request_id:randomUUID()});
}
module.exports={guide};
