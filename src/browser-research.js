'use strict';
// ADR 0012: no unqualified browser port may run or synthesize evidence.
const MESSAGE='Governed browser research is unavailable in this version. Navigation, account access, screenshots and feature-gap reports have not been qualified. No website was visited or compared with Arecibo. Account access requires separate operator authorization and human MFA.';
function parse(message){
 if(typeof message!=='string')return null;
 const request=message.trim().replace(/^(?:(?:please|also|can you|could you|would you|i want you to|i would like you to|i want to|i need to|i would like to|help me)\s+)+/i,'').replace(/^(?:(?:create|start|open|make|launch)\s+(?:(?:a|an|new)\s+)?mission\s+(?:to|for)\s+|\/mission\s+new\s+)/i,'');
 return /^(?:research|browse|visit|navigate|investigate)\b/i.test(request)||/[\r\n]\s*(?:research|browse|visit|navigate|investigate)\b/i.test(request)||/^(?:open|inspect|explore|review|check|look at|take a look at)\b.*(?:https?:\/\/|\b(?:website|web site|browser|account)\b)/i.test(request)||/^(?:log|sign)\s+(?:in|into)\b/i.test(request)||/^(?:audit|compare)\b.*(?:website|web site|account|https?:)/i.test(request)||/\bfeatures\b.*\b(?:arecibo|adopt)\b/i.test(request)?{route:'WORK',kind:'research_unavailable',message:MESSAGE,available:false,evidence:[],comparison:'unverified'}:null;
}
function research(){return {state:'unavailable',message:MESSAGE,available:false,evidence:[],comparison:'unverified'};}
module.exports={parse,research,MESSAGE};
