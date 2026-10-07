'use strict';
const {randomUUID}=require('node:crypto');
const local=require('./local-bootstrap'),terminal=require('./vault-cli');
function terminalRequired(input,output){if(!input?.isTTY||!output?.isTTY||!input.setRawMode||input.listenerCount('data')||input.listenerCount('readable'))throw Error('Session consent requires detached operator terminal input');}
async function guide({entry_url,input,output,home,signal,request=local.request}={}){
 terminalRequired(input,output);const u=new URL(entry_url);require('./research-network').safeOrigin(u.origin);require('./research-session').allowedURL(u.href,{origin:u.origin,phase:'login',navigation:true});
 output.write('AUTHENTICATED PRODUCT RESEARCH\n'+u.origin+'\nYour normal Chrome login is not inherited. Supported CDP attachment exists for separately enabled debugging profiles, but external attachment is unavailable in this V1.\n1. Authorize dedicated browser login and local profile reuse for this domain\n2. Cancel\nSign in manually and complete MFA in the visible browser. Read-only investigation begins only after your hand-back. Private screenshots, financial text, exports, settings changes and payments are disabled. Only fixed feature labels are retained; no model receives account contents. Unsupported cross-domain, query and POST data flows stay inaccessible. The Mission expires after three minutes.\n');
 const choice=await terminal.visible(input,output,{prompt:'Choose [1/2] · Enter or Ctrl+C cancels: ',choices:['1','2'],signal});
 if(choice!=='1')return {kind:'clarify',message:'Browser session authorization cancelled.'};
 return request(home,'/api/assistant/research/session',{entry_url:u.href,mode:'dedicated_manual',confirmed:true,request_id:randomUUID()});
}
async function ready({mission_id,input,output,home,signal,request=local.request}={}){
 terminalRequired(input,output);output.write('The dedicated browser is yours for login and MFA. Do not change account data.\n');
 if(!await terminal.confirm(input,output,{prompt:'Finished signing in? Authorize bounded read-only inspection now? [No cancels this Mission]',signal})){
  await request(home,'/api/assistant/mission',{action:'cancel',mission_id,request_id:randomUUID()});return false;
 }
 await request(home,'/api/assistant/research/session/ready',{mission_id,confirmed:true,request_id:randomUUID()});return true;
}
module.exports={guide,ready};
