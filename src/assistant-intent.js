'use strict';
// Operator ingress only. Retrieved/worker text must never call this parser.
const secret = value => {
 value=String(value).normalize('NFKC');
 // Fixed credential-free login endpoints are addresses, never credential
 // values. This only narrows a text heuristic; it grants no account authority.
 const policy=require('./provider-policy');
 return policy.operatorSecretLike(value) || /\b(?:password|passphrase|passcode|one.time (?:code|password)|otp|authentication code|api[ _-]?key|private key|seed phrase|recovery codes?|backup codes?|mfa codes?|pin|oauth token|access token|refresh token|banking login)\b/i.test(policy.operatorInstructionText(value));
};
const sensitive = value => require('./private-vault-intent').containsPrivate(value) || /\b(?:mailbox number|locker number|parking space number|health|diagnosis|diagnosed|disease|condition|asthma|bipolar|diabetes|cancer|allergy|allergies|medication|medical|bank|checking|savings|balance|debt|loan|account number|private|routing number|identifier|ssn|social security|salary|financial|passport)\b/i.test(value);
// Automatic durable classification is deliberately small. Unknown facts require
// an operator choice rather than treating the absence of a keyword as evidence.
const ordinary = value => /^(?:my name is|i am called) [\p{L} .'-]{1,100}\.?$/iu.test(value) || /^(?:i prefer|my preferred (?:language|theme) is) (?:typescript|javascript|python|rust|go|java|swift|dark mode|light mode|concise answers|detailed answers)\.?$/i.test(value);
const route = (name, result) => ({route:name,...result});
// This classifies requested operations, never grants their capabilities. The
// host's registered immutable Mission template is the only execution scope.
function workCapabilities(value) {
 const classes=new Set();
 if(/\b(?:send|email|gmail|whatsapp|archive|mark.read)\b/i.test(value))classes.add('communications');
 if(/\b(?:website|web site|domain|browser|web search|public sources|online documentation|competitor|pdf)\b|search (?:the )?web|https?:\/\/\S+/i.test(value))classes.add('web_read');
 if(/\b(?:deploy|publish|release|production)\b/i.test(value))classes.add('deployment');
 if(/\b(?:repository|repo|feature|file|code|script)\b/i.test(value)||/^(?:fix|implement|edit|modify|build|create|write|delete|remove|install|run|execute|commit|push|change)\b/i.test(value)||!classes.size){classes.add('repo');classes.add('developer_environment');}
 return [...classes];
}
const WORK_TARGET=/\b(?:fixture(?:\.txt)?|repository|repo|feature|file|files|code|script|website|application|app|test(?:\s+file)?|[\w.-]+\.(?:txt|js|cjs|mjs|ts|tsx|json|md|py|go|rs|swift))\b/i;
const WORK_VERB='(?:change|edit|modify|fix|implement|update|replace|rewrite|write|delete|remove|create|build|install|run|execute|commit|push|deploy|send|archive|audit)';
// Ordinary discussion about files stays conversation. Classification never grants execution.
function isWorkRequest(request) {
 if(/^(?:implement|edit|delete|remove|install|run|execute|commit|push|send|archive|deploy|change|modify|fix|build|audit)\b/i.test(request))return true;
 if(/^(?:create|write)\b.*\b(?:repository|repo|feature|file|website|application|app|code|script)\b/i.test(request))return true;
 if(new RegExp('^(?:can you|could you|would you|please)\\s+'+WORK_VERB+'\\b','i').test(request)&&WORK_TARGET.test(request))return true;
 // Contextual preamble then imperative: "In the prepared workspace, change fixture.txt…"
 if(new RegExp('(?:^|[,;]\\s+|\\.\\s+)(?:please\\s+)?'+WORK_VERB+'\\b','i').test(request)&&WORK_TARGET.test(request)){
  // Pure how-to / explanatory questions remain conversation.
  if(/^(?:what|why|how|when|where|who|which|explain|discuss|describe|tell me about|is there|are there|do you (?:know|think)|can we talk|let'?s (?:talk|discuss|brainstorm))\b/i.test(request)
    &&!/(?:^|[,;]\s+|\.\s+)(?:please\s+)?(?:change|edit|modify|fix|implement|update|replace)\b/i.test(request))return false;
  return true;
 }
 return false;
}
function parse(value, {nickname:assistantNickname,pendingResearch,researchURL} = {}) {
 if(typeof value!=='string'||!value.trim()||Buffer.byteLength(value)>4000||value.includes('\0'))throw Error('Invalid assistant input');value=value.trim();
 // A pasted control command cannot be silently embedded in a model prompt.
 if(/[\r\n]\s*(?:\/\w+|--(?:help|version))\b/.test(value)||/\S\/(?:quit|exit)\b/i.test(value))return {kind:'clarify',message:'Submit pasted commands separately from your question.'};
 const storage=require('./personal-storage-intent');
 const request=storage.normalize(value,assistantNickname);
 const forgetId=/^forget\s+([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/i.exec(request);
 if(forgetId)return route('MEMORY',{kind:'forget',selection:forgetId[1]});
 const privateIntent=require('./private-vault-intent').parse(request);
 // Explicit named operations accept label metadata, never credential values.
 if(/^\/secret\b/i.test(request)&&privateIntent)return {...privateIntent,message:'Use the native /secret workflow.'};
 if(privateIntent?.action==='list')return {...privateIntent,message:'Airodrom lists saved Vault labels in the operator terminal. Values stay hidden.'};
 // Only a valueless request opens secure entry. Credentials supplied in chat
 // still hit the secret refusal below and never reach a model or memory.
 if(/^\/vault$/i.test(request)||/^(?:(?:let['’]s|let us|i want to)\s+)?(?:save|store|add)\s+(?:a|an|my)\s+(?:password|api[ _-]?key|secret)$/i.test(request)||/^(?:open|show)\s+(?:the\s+)?(?:secret\s+)?vault$/i.test(request)||/^(?:view|show|list)\s+(?:my\s+)?saved secret names$/i.test(request)||/^remove a secret$/i.test(request))return route('VAULT',{kind:'vault',action:'menu'});
 if(secret(value)||/\b(?:my|a) (?:secret|credential)\s+\S+/i.test(value))return route('VAULT',{kind:'secret',message:'Credentials typed in chat are not secure input. This submission was not sent or saved. Already echoed text may remain in terminal scrollback. Use /vault and enter the value only in the native hidden prompt. Screening cannot detect every secret.'});
 if(privateIntent?.action==='save'&&privateIntent.value_present===false)return {...privateIntent,message:'Enter the private identifier in the native hidden prompt.'};
 const privateRequest=storage.parse(request);if(privateRequest)return privateRequest;
 if(privateIntent)return {...privateIntent,message:'Use the operator terminal /secret workflow. Private values never enter conversation.'};
 // Host Memory/Vault/connector awareness before research or remember fall-through.
 const awareness=require('./memory-awareness').detect(value);if(awareness)return awareness;
 const missionCommand=/^\/mission(?:\s+(new|list|status|cancel))?(?:\s+(.+))?$/i.exec(request);
 if(missionCommand){const action=(missionCommand[1]||'list').toLowerCase(),argument=missionCommand[2];if(action==='list'&&argument)return route('EXPLICIT MISSION',{kind:'clarify',message:'Use /mission list, /mission status [id], /mission cancel [id] or /mission new <objective>.'});return route('EXPLICIT MISSION',{kind:'mission',action,...(action==='new'?{objective:argument||null}:{mission_id:argument||null})});}
 if(/^\/(?:mission)\b/i.test(request))return route('EXPLICIT MISSION',{kind:'clarify',message:'Use /mission new, /mission list, /mission status or /mission cancel.'});
 const explicit=/^(?:create|start|open|make|launch|i want|i need|give me)\s+(?:(?:a|an|new)\s+)?(?:(?:work)\s+)?mission(?:\s+(?:to|for|that will)\s+(.+)|\s*:\s*(.+))?$/i.exec(request);
 if(explicit)return route('EXPLICIT MISSION',{kind:'mission',action:'new',objective:explicit[1]||explicit[2]||null});
 if(/^(?:show|list)\s+(?:my\s+)?(?:active\s+)?missions$/i.test(request))return route('EXPLICIT MISSION',{kind:'mission',action:'list',active:/\bactive\b/i.test(request)});
 if(/^(?:show|check)\s+(?:the\s+)?(?:current\s+)?mission(?:\s+status)?$/i.test(request))return route('EXPLICIT MISSION',{kind:'mission',action:'status',mission_id:null});
 if(/^cancel\s+(?:the\s+)?(?:current\s+)?mission$/i.test(request))return route('EXPLICIT MISSION',{kind:'mission',action:'cancel',mission_id:null});
 const publicWeb=require('./mission-web-guide').parse(value);if(publicWeb)return publicWeb;
 const research=require('./browser-research').parse(value,{pendingResearch,researchURL});if(research)return research;
 const nickname=/^(?:your nickname is|i(?:['’]ll| will) call you)\s+([\p{L}\p{N}][\p{L}\p{N} .'-]{0,39})$/iu.exec(request);
 if(nickname)return route('CONVERSATION',{kind:'preference',nickname:nickname[1].trim()});
 if(/^(?:save|store|remember)$/i.test(request))return route('MEMORY',{kind:'clarify',message:'What would you like to save? Private facts require a storage choice; credentials require /vault.'});
 const correction=/^(?:correction|update)\s*:\s*([\s\S]+)$/i.exec(request);
 if(correction){const content=request;return route('MEMORY',sensitive(content)?{kind:'sensitive',content}:{kind:'remember',content});}
 const remember=/^(?:remember|save|store)\s+(?:that\s+)?([\s\S]+)$/i.exec(request);
 if(remember){const content=remember[1];return route('MEMORY',sensitive(content)?{kind:'sensitive',content}:ordinary(content)||require('./memory-correction').isCorrectionStatement(content)?{kind:'remember',content}:/^my preference\.?$/i.test(content)?{kind:'clarify',message:'What preference should I remember? For example: Remember I prefer concise answers.'}:{kind:'clarify',message:'Choose the data class explicitly: /remember <ordinary fact> or /remember-sensitive <private fact>. Credentials require /vault.'});}
 const forget=/^forget\s+(?:that\s+)?(?:my\s+)?([\s\S]+?)\.?$/i.exec(request);
 if(forget)return route('MEMORY',{kind:'forget',selection:forget[1]});
 const recall=/^(?:please\s+)?(?:what do you remember(?: about)?|recall|show (?:my )?(?:saved )?memories(?: about)?)\s*(.*?)\??$/i.exec(request);
 if(recall)return route('MEMORY',{kind:'recall',query:recall[1].replace(/^my\s+/i,'').replace(/^me$/i,'').replace(/^about\s+/i,'')});
 if(/^(?:check|read|show|open)\s+(?:my\s+)?gmail$/i.test(request))return route('CONNECTOR',{kind:'connector',connector:'gmail',action:'recent'});
 if(/^(?:summari[sz]e (?:my )?unread (?:email|mail)|anything important this morning)$/i.test(request))return route('CONNECTOR',{kind:'connector',connector:'gmail',action:'attention'});
 const draft=/^draft (?:a )?reply to (.{1,200})$/i.exec(request);if(draft)return route('CONNECTOR',{kind:'connector',connector:'gmail',action:'draft_reply',query:draft[1]});
 if(/^(?:show|check|read)\s+(?:my\s+)?whatsapp(?: messages(?: needing attention)?)?$/i.test(request))return route('CONNECTOR',{kind:'connector',connector:'whatsapp',action:'attention'});
 // Personal ops / job search — host capability plan before model denial.
 const personalOps=require('./personal-ops');
 if(personalOps.isPersonalOpsRequest(request))return route('PERSONAL_OPS',{kind:'personal_ops',message:request});
 if(/^(?:create|start|open)\s+(?:a\s+)?(?:local\s+)?(?:job[- ]search\s+)?tracker(?:\s+workbook)?$/i.test(request))return route('JOB_SEARCH',{kind:'job_search',action:'create_tracker'});
 if(/^(?:job[- ]search\s+)?(?:daily\s+)?digest$/i.test(request)||/^(?:show|give)\s+(?:me\s+)?(?:a\s+)?(?:job[- ]search\s+)?(?:daily\s+)?digest$/i.test(request))return route('JOB_SEARCH',{kind:'job_search',action:'digest'});
 if(/^(?:list|show)\s+(?:my\s+)?(?:job\s+)?applications$/i.test(request))return route('JOB_SEARCH',{kind:'job_search',action:'list'});
 if(/^(?:log|record|track)\s+(?:a\s+)?(?:job\s+)?application\b/i.test(request))return route('JOB_SEARCH',{kind:'job_search',action:'upsert',raw:request});
 if(/^(?:find|identify)\s+(?:recruiter|recruiters)\b/i.test(request)||/^categorize\s+(?:job\s+)?(?:mail|email|gmail)\b/i.test(request))return route('JOB_SEARCH',{kind:'job_search',action:'recruiters'});
 if(/^(?:enable|turn on|disable|turn off)\s+(?:global\s+)?autopilot\b/i.test(request)||/^(?:read|show|what(?:'s| is))\s+(?:my\s+)?(?:settings|autonomy(?: mode)?|service status|expanded autonomy)\b/i.test(request)||/^(?:select|set)\s+(?:autonomy|expanded autonomy)\s+mode\b/i.test(request))return route('OPERATOR',{kind:'operator_control',objective:request,capability_classes:[]});
 if(isWorkRequest(request))return route('WORK',{kind:'work',objective:request,capability_classes:workCapabilities(request)});
 if(/^(?:do|handle|take care of)\s+(?:it|this|that)$/i.test(request))return {kind:'clarify',message:'Do you want to talk it through or create a Work Mission?'};
 if(/^(?:check|read|show|open)\s+(?:my\s+)?(?:inbox|messages|email|emails|mail)$/i.test(request))return route('CONNECTOR',{kind:'clarify',message:'Should I check Gmail or the official WhatsApp connector?'});
 return route('CONVERSATION',{kind:'conversation',message:value});
}
module.exports={parse,secret,sensitive,ordinary,workCapabilities,isWorkRequest};
