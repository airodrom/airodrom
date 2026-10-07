'use strict';
// Operator ingress only. Retrieved/worker text must never call this parser.
const secret = value => require('./personal-memory').containsSecret(value) || /\b(?:password|passphrase|passcode|one.time (?:code|password)|otp|authentication code|api[ _-]?key|private key|seed phrase|recovery codes?|backup codes?|mfa codes?|pin|oauth token|access token|refresh token|banking login)\b/i.test(value);
const sensitive = value => /\b(?:health|diagnosis|diagnosed|disease|condition|asthma|bipolar|diabetes|cancer|allergy|allergies|medication|medical|bank|checking|savings|balance|debt|loan|account number|private|routing number|identifier|ssn|social security|salary|financial|passport)\b/i.test(value);
// Automatic durable classification is deliberately small. Unknown facts require
// an operator choice rather than treating the absence of a keyword as evidence.
const ordinary = value => /^(?:my name is|i am called) [\p{L} .'-]{1,100}\.?$/iu.test(value) || /^(?:i prefer|my preferred (?:language|theme) is) (?:typescript|javascript|python|rust|go|java|swift|dark mode|light mode|concise answers|detailed answers)\.?$/i.test(value);
function parse(value) {
 if(typeof value!=='string'||!value.trim()||Buffer.byteLength(value)>4000||value.includes('\0'))throw Error('Invalid assistant input');value=value.trim();
 if(secret(value))return {kind:'secret',message:'Secret content is refused. Use the operator Secret Vault secure input path; values are never displayed.'};
 // A pasted control command cannot be silently embedded in a model prompt.
 if(/[\r\n]\s*(?:\/\w+|--(?:help|version))\b/.test(value)||/\S\/(?:quit|exit)\b/i.test(value))return {kind:'clarify',message:'Submit pasted commands separately from your question.'};
 const remember=/^(?:please\s+)?remember\s+(?:that\s+)?([\s\S]+)$/i.exec(value);
 if(remember){const content=remember[1];return sensitive(content)?{kind:'sensitive',content}:ordinary(content)?{kind:'remember',content}:{kind:'clarify',message:'Choose the data class explicitly: /remember <ordinary fact> or /remember-sensitive <private fact>. Credentials require the secure Secret Vault input path.'};}
 const forget=/^(?:please\s+)?forget\s+(?:that\s+)?(?:my\s+)?([\s\S]+?)\.?$/i.exec(value);
 if(forget)return {kind:'forget',selection:forget[1]};
 const recall=/^(?:what do you remember(?: about)?|recall|show (?:my )?memories(?: about)?)\s*(.*?)\??$/i.exec(value);
 if(recall)return {kind:'recall',query:recall[1].replace(/^my\s+/i,'')};
 if(/^(?:summari[sz]e (?:my )?unread (?:email|mail)|anything important this morning\??)$/i.test(value))return {kind:'connector',connector:'gmail',action:'attention'};
 const draft=/^draft (?:a )?reply to (.{1,200})$/i.exec(value);if(draft)return {kind:'connector',connector:'gmail',action:'draft_reply',query:draft[1]};
 if(/^show whatsapp messages needing attention\.?$/i.test(value))return {kind:'connector',connector:'whatsapp',action:'attention'};
 if(/^(?:create|write|edit|delete|remove|install|run|execute|commit|push|send|archive|deploy|change|modify|fix|build)\b/i.test(value))return {kind:'work',message:'This needs a WORK Mission with registered workspace, capabilities and verification. Use /task <mission.json>.'};
 return {kind:'conversation',message:value};
}
module.exports={parse,secret,sensitive,ordinary};
