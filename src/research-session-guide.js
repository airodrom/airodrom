'use strict';
const {randomUUID}=require('node:crypto');
const local=require('./local-bootstrap'),terminal=require('./vault-cli');
function terminalRequired(input,output){if(!input?.isTTY||!output?.isTTY||!input.setRawMode||input.listenerCount('data')||input.listenerCount('readable'))throw Error('Session consent requires detached operator terminal input');}
async function guide({entry_url,input,output,home,signal,request=local.request}={}){
 terminalRequired(input,output);const u=new URL(entry_url);require('./research-network').safeOrigin(u.origin);require('./research-session').allowedURL(u.href,{origin:u.origin,phase:'login',navigation:true});
 const network=u.origin==='https://app.monarch.com'?require('./research-session-policy').MONARCH:undefined;
 const options=require('./browser-connections').availability();
 output.write('AIRODROM · BROWSER ACCESS\nWebsite: '+u.origin+'\nPurpose: Arecibo product research\n');
 for(const mode of options.modes)output.write(mode.id+'. '+mode.label+(mode.available?'':' · unavailable')+'\n   '+mode.reason+'\n');
 output.write('Strict: approved site GET/HEAD only. Authentication: human-controlled same-site login POST at fixed endpoints until hand-back or three-minute expiry. Extended: separate public-only grant, maximum fifteen minutes. Unknown identity domains/POST, financial changes, exports, payments, settings changes and credential capture remain denied.\n');
 const choice=await terminal.visible(input,output,{prompt:'Choose [1–7] · Enter or Ctrl+C cancels: ',choices:['1','2','3','4','5','6','7'],signal});
 if(!choice||choice==='7')return {kind:'clarify',message:'Browser session authorization cancelled.'};
 const selected=options.modes.find(m=>m.id===Number(choice));
 if(!selected?.available)return {kind:'clarify',message:selected?.reason||'Browser mode unavailable.'};
 if(choice==='4')return require('./browser-connections').openHuman(u.href);
 if(choice==='6')return require('./mission-web-guide').guide({offer:{objective:'Explore explicitly approved public product sources.',mode:'all',entries:[u.origin+'/'],duration_ms:180000,permission_mode:'extended'},input,output,home,signal,request});
 const mode=choice==='2'?'dedicated_cdp':'dedicated_manual';
 output.write('PERMISSION · this new Mission\n1. Strict read-only (reuse a dedicated login after human confirmation)\n2. Authentication (you sign in manually, including supported same-site MFA; dedicated passkeys are disabled)\n3. Cancel\n');
 const permission=choice==='5'?'2':await terminal.visible(input,output,{prompt:'Choose permission [1–3]: ',choices:['1','2','3'],signal});
 if(!permission||permission==='3')return {kind:'clarify',message:'Browser permission cancelled.'};
 if(network)output.write('Monarch scope additionally permits fixed static.monarch.com assets and monarch.com/www.monarch.com root GET redirects during human login. Google identity requests, GraphQL POST and unknown endpoints remain unqualified.\n');
 if(!await terminal.confirm(input,output,{prompt:'Approve this site, purpose, temporary permission and isolated profile reuse?',signal}))return {kind:'clarify',message:'Browser authorization cancelled.'};
 return request(home,'/api/assistant/research/session',{entry_url:u.href,mode,permission_mode:permission==='1'?'strict':'authentication',confirmed:true,...(network?{network_profile:network}:{}),request_id:randomUUID()});
}
async function ready({mission_id,input,output,home,signal,request=local.request}={}){
 terminalRequired(input,output);output.write('The dedicated browser is yours for login and MFA. Do not change account data.\n');
 if(!await terminal.confirm(input,output,{prompt:'Finished signing in? Authorize bounded read-only inspection now? [No cancels this Mission]',signal})){
  await request(home,'/api/assistant/mission',{action:'cancel',mission_id,request_id:randomUUID()});return false;
 }
 await request(home,'/api/assistant/research/session/ready',{mission_id,confirmed:true,request_id:randomUUID()});return true;
}
module.exports={guide,ready,terminalRequired};
