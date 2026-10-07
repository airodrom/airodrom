'use strict';
// ADRs 0012/0013: operator intent proposes a bounded host Mission; website text
// and models never call this parser or enlarge the approved origin.
const MESSAGE='Governed browser research is unavailable in this version. Navigation, account access, screenshots and feature-gap reports have not been qualified. No website was visited or compared with Arecibo. Account access requires separate operator authorization and human MFA.';
function parse(message){
 if(typeof message!=='string')return null;
 const request=message.trim().replace(/^(?:airo(?:drom)?)[,:]?\s+/i,'').replace(/^(?:(?:please|also|can you|could you|would you|i want you to|i would like you to|i want to|i need to|i would like to|help me)\s+)+/i,'').replace(/^(?:(?:create|start|open|make|launch)\s+(?:(?:a|an|new)\s+)?mission\s+(?:to|for)\s+|\/mission\s+new\s+)/i,'');
 const sessionIntent=/(?:\b(?:already|currently)\s+(?:logged|signed)\s+in\b|\b(?:inspect|explore|research|review)\b.*\bmy account\b)/i.test(request);
 if(sessionIntent){
  const urls=request.match(/https?:\/\/[^\s<>"'`]+/gi)||[];let target=urls.length===1?urls[0].replace(/[.,;!]+$/,''):urls.length===0&&/\bmonarch\b/i.test(request)?'https://app.monarch.com/':null;
  if(!target)return {route:'WORK',kind:'clarify',message:'Give one HTTPS account URL for the dedicated browser scope.'};
  try{const u=new URL(target);require('./research-session').allowedURL(u.href,{origin:u.origin,phase:'login',navigation:true});require('./research-network').safeOrigin(u.origin);return {route:'WORK',kind:'research_session',entry_url:u.href,message:'Your normal Chrome login is not inherited. External session attachment is unavailable in V1. Choose dedicated manual login or cancel.',authority:false};}catch{return {route:'WORK',kind:'clarify',message:'Use one HTTPS account URL without credentials, query parameters or private identifiers.'};}
 }
 const matched=/^(?:research|browse|visit|navigate|investigate)\b/i.test(request)||/[\r\n]\s*(?:research|browse|visit|navigate|investigate)\b/i.test(request)||/^(?:open|inspect|explore|review|check|look at|take a look at)\b.*(?:https?:\/\/|\b(?:website|web site|browser|account)\b)/i.test(request)||/^(?:log|sign)\s+(?:in|into)\b/i.test(request)||/^(?:audit|compare)\b.*(?:website|web site|account|https?:)/i.test(request)||/\bfeatures\b.*\b(?:arecibo|adopt)\b/i.test(request);
 if(!matched)return null;
 const urls=request.match(/https?:\/\/[^\s<>"'`]+/gi)||[];
 if(urls.length!==1)return {route:'WORK',kind:'clarify',message:'Which public website should I research? Give one URL to approve its domain scope.'};
 if(/\b(?:implement|deploy|publish|send|delete|purchase|subscribe|sign\s*up|create\s+(?:an?\s+)?account|(?:log|sign)\s+(?:in|into))\b/i.test(request))return {route:'WORK',kind:'clarify',message:'Public research and account or implementation actions need separate scopes. Start with “Research <public URL> and compare with Arecibo”.'};
 let u;try{u=new URL(urls[0].replace(/[.,;!]+$/,''));}catch{return {route:'WORK',kind:'clarify',message:'Give a valid public HTTPS website URL.'};}
 if(u.username||u.password||u.search||u.hash||u.protocol!=='https:')return {route:'WORK',kind:'clarify',message:'Give a public HTTPS URL without credentials, query parameters or a fragment.'};
 return {route:'WORK',kind:'research',objective:message,entry_url:u.href,capability_classes:['web_read']};
}
function research(){return {state:'unavailable',message:MESSAGE,available:false,evidence:[],comparison:'unverified'};}
module.exports={parse,research,MESSAGE};
