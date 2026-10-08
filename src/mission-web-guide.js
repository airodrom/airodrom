'use strict';
const {randomUUID}=require('node:crypto'),terminal=require('./vault-cli'),local=require('./local-bootstrap');
async function guide({offer,mission_id,input,output,home,signal,request=local.request}){
 require('./research-session-guide').terminalRequired?.(input,output);
 if(!input?.isTTY||!output?.isTTY||!input.setRawMode||input.listenerCount('data')||input.listenerCount('readable'))throw Error('Public web consent requires detached operator terminal input');
 output.write('PUBLIC WEB PERMISSION\n'+(mission_id?'Mission '+mission_id+'\n':'New research Mission\n')+(offer.mode==='all'?'Discover public websites from verified source links.':'Visit these approved public websites:')+'\n'+(offer.entries||[]).join('\n')+'\n'+(offer.query?'Public search query: '+offer.query+'\n':'')+'Up to three minutes, eight pages, eight domains, one hundred requests and forty actions. Airodrom performs the work. Login, private data, mutations, payments and private downloads require separate authorization.\n');
 if(!await terminal.confirm(input,output,{prompt:'Approve this public web scope?',signal}))return {kind:'clarify',message:'Public web authorization cancelled.'};
 const body={mode:offer.mode,entries:offer.entries||[],...(offer.query?{query:offer.query}:{}),confirmed:true,request_id:randomUUID()};
 return request(home,mission_id?'/api/assistant/mission/web':'/api/assistant/web/research',{...body,...(mission_id?{mission_id}:{objective:offer.objective})});
}
function parse(message){
 if(typeof message!=='string')return null;const request=message.normalize('NFKC').trim().replace(/^airo(?:drom)?[,:]?\s+/i,'').replace(/^(?:(?:please|can you|could you|help me)\s+)+/i,'');
 const match=/^(?:search (?:the )?(?:web|internet)(?: for)?|web search(?: for)?|research (?:public sources|competitors)(?: for)?)\s+(.+)$/i.exec(request);
 const explore=/^(?:explore|browse|visit|inspect)\s+(?:these (?:public )?(?:websites|sites)\s*:?\s*)?(.+)$/i.exec(request);
 if(!match&&!explore)return null;if(/\b(?:my account|authenticated|log in|sign in|password|credentials|mfa|bypass|ignore|override|deploy|publish|send|delete|purchase|signup|sign-up)\b/i.test(request))return null;
 if(match){const query=match[1];if(require('./research-baseline').unsafeEvidenceText(query))return null;return {kind:'public_web_offer',route:'WORK',objective:message,mode:'all',entries:[],query,authority:false};}
 const tokens=explore[1].split(/\s*(?:,| and |\s)\s*/).filter(Boolean),urls=tokens.map(token=>/^https:\/\//i.test(token)?token:'https://'+token);
 try{if(!urls.length||urls.length>8)return null;for(const url of urls){const u=new URL(url);new (require('./research-network').ResearchNetwork)({scope:{origins:[u.origin]}}).validate(url);}return {kind:'public_web_offer',route:'WORK',objective:message,mode:'on',entries:urls,authority:false};}catch{return null;}
}
module.exports={guide,parse};
