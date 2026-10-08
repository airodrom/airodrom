'use strict';
// ADR 0016. Proposals select capabilities; only operator grants authorize them.
const {safeOrigin,ResearchNetwork,error}=require('./research-network');
const {unsafeEvidenceText}=require('./research-baseline');
const {keys,text,CapabilityInputError}=require('./capability-util');
const ACTIONS=Object.freeze(['search','explore','inspect','click','screenshot','document','test']);
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function proposal(objective){
 const needed=/\b(?:search (?:the )?(?:web|internet)|web search|browse|website|web site|browser|online documentation|public sources|competitor|pdf)\b|https:\/\//i.test(objective||'');
 const entries=[...new Set((String(objective||'').match(/https:\/\/[^\s<>"'`]+/gi)||[]).map(v=>v.replace(/[.,;!]+$/,'')))].filter(v=>{try{new ResearchNetwork({scope:{origins:[new URL(v).origin]}}).validate(v);return true;}catch{return false;}}).slice(0,8);
 return {needed,mode:entries.length?'on':'all',entries,search:needed&&!entries.length,authority:false};
}
function normalize(input,{now=Date.now(),expiresAt}={}){
 keys(input,['mode'],['entries','query','confirmed']);
 if(!['on','all'].includes(input.mode)||input.confirmed!==true)throw error('operator_web_consent_required');
 const entries=input.entries||[];if(!Array.isArray(entries)||entries.length>8||entries.some(v=>typeof v!=='string'))throw error('web_entries_bound');
 const origins=[...new Set(entries.map(v=>safeOrigin(new URL(v).origin)))];
 const checker=new ResearchNetwork({scope:{origins:origins.length?origins:['https://example.com']}});
 const urls=[...new Set(entries.map(v=>checker.validate(v)))];
 let query=null;if(input.query!==undefined){text(input.query,'public search query',{max:500,multiline:false});if(unsafeEvidenceText(input.query)||require('./assistant-intent').secret(input.query)||require('./private-vault-intent').containsPrivate(input.query))throw error('private_search_query_denied');query=input.query;}
 if(!urls.length&&!query)throw error('public_sources_or_query_required');
 if(input.mode==='on'&&!origins.length&&query===null)throw error('approved_sites_required');
 const deadline=Math.min(now+180000,expiresAt||now+180000);if(deadline<=now)throw error('web_grant_expired');
 return {version:1,mode:input.mode,entries:urls,origins,query,expires_at:deadline,max_origins:8,max_actions:40,max_pages:8,max_requests:100,max_bytes:8388608,private_accounts:false,downloads:false,provenance:'authenticated_operator'};
}
function validate(input){
 keys(input,['mission_id','action']);if(!UUID.test(input.mission_id||''))throw new CapabilityInputError('Canonical Mission UUID required');
 const a=input.action;if(!a||!ACTIONS.includes(a.type))throw new CapabilityInputError('Typed read-only web action required');
 keys(a,['type'],a.type==='search'?[]:a.type==='click'?['link_id']:['url']);
 if(a.type==='click'&&!UUID.test(a.link_id||''))throw new CapabilityInputError('Current evidence link required');
 if(a.type!=='search'&&a.type!=='click'){text(a.url,'public URL',{max:2048,multiline:false});let u;try{u=new URL(a.url);new ResearchNetwork({scope:{origins:[safeOrigin(u.origin)]}}).validate(a.url);}catch{throw new CapabilityInputError('Public HTTPS URL without private or mutation data required');}}
 return structuredClone(input);
}
function capabilities(){return {mission_web:{validate,pureAssess:true,assess:(ctx,input)=>ctx.missionWeb?ctx.missionWeb.assess(ctx.task,input):{dynamic:{decision:'deny',reason:'Mission web service unavailable'}},perform:(ctx,input)=>ctx.missionWeb.perform(ctx.task,input,ctx.signal)}};}
module.exports={proposal,normalize,validate,capabilities,ACTIONS,UUID};
