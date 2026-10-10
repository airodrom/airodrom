'use strict';
// ADR 0024: a conversation boundary, separate from worker qualification. No
// production inference entry point exists until credential and billing gates pass.
const path=require('node:path');
const POLICY='claude-conversation-public-v1';
function readiness(){return {state:'WAIT',reason:'subscription_conversation_not_qualified',model:null,actual_model:null,auth_state:'not_probed',policy:POLICY,external_processing:false,
 gates:{containment:'candidate_requires_native_qualification',account_isolation:'unqualified',actual_model:'unobserved',subscription_only_billing:'unverified',exact_message_consent:'not_implemented'},
 billing:{source:'not_observed',extra_usage:'unknown',api_billing:'denied',cost:null},
 owner_action:'Claude stays OFF. The isolated account adapter, actual-model reporting and subscription-only billing need independent qualification. Login alone does not exclude paid extra usage. A disposable public test also requires separate owner approval once these checks pass. Use /provider qwen for local conversation.'};}
function profile(root,executable){
 if(!path.isAbsolute(root)||!path.isAbsolute(executable)||root==='/'||!executable.startsWith(root+'/')||/[\0\r\n]/.test(root+executable))throw Error('Disposable executable snapshot required');
 // No HOME, Keychain, vendor config, process fork, or network. Native qualification
 // of this zero-network candidate cannot authenticate or perform inference.
 return require('./sandbox-policy').makeProfile({readRoots:[root,'/System','/usr/lib','/usr/share','/Library/Apple/System/Library','/dev'],writeRoots:[path.join(root,'state')],exactReadFiles:[executable],denyFork:true,execPaths:[executable]});
}
function environment(root){return {HOME:path.join(root,'state'),PATH:'/usr/bin:/bin',TMPDIR:path.join(root,'state'),CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',CLAUDE_CODE_SKIP_PROMPT_HISTORY:'1',DISABLE_AUTOUPDATER:'1',DISABLE_TELEMETRY:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'};}
function invocation(model){
 if(typeof model!=='string'||!/^claude-[a-z0-9]+(?:-[a-z0-9]+)+$/.test(model)||['claude-default','claude-latest'].includes(model))throw Error('Explicit effective model required');
 return ['--print','--output-format','stream-json','--verbose','--model',model,'--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--setting-sources','','--settings','{"disableAllHooks":true}','--no-session-persistence','--disable-slash-commands'];
}
function parse(stdout,expectedModel){
 invocation(expectedModel);if(typeof stdout!=='string'||Buffer.byteLength(stdout)>65536)throw Error('Claude response bound');
 let initialized=false,completed=false,text=null;let count=0;
 for(const line of stdout.split('\n').filter(x=>x.trim())){
  if(++count>300)throw Error('Claude event bound');let e;try{e=JSON.parse(line);}catch{throw Error('Claude response schema');}
  if(completed)throw Error('Claude trailing event');
  if(e.type==='system'&&e.subtype==='init'&&!initialized){
   if(e.model!==expectedModel||!Array.isArray(e.tools)||e.tools.length||!Array.isArray(e.mcp_servers)||e.mcp_servers.length)throw Error('Claude model or tool boundary');initialized=true;
  }else if(e.type==='assistant'&&initialized){
   if(e.message?.model!==expectedModel||!Array.isArray(e.message?.content)||e.message.content.some(p=>p.type!=='text'||typeof p.text!=='string'))throw Error('Claude model or content boundary');
  }else if(e.type==='result'&&initialized){
   if(e.is_error||e.subtype!=='success'||typeof e.result!=='string'||!e.result.trim()||e.result.length>12000||e.num_turns!==1)throw Error('Claude result boundary');
   const models=Object.keys(e.modelUsage||{});if(models.length!==1||models[0]!==expectedModel)throw Error('Claude actual model unavailable');
   text=e.result;completed=true;
  }else throw Error('Claude event boundary');
 }
 if(!completed||require('./assistant-intent').secret(text)||require('./provider-policy').secretLike(text))throw Error('Claude result unavailable');
 // Vendor token or dollar estimates are not authoritative subscription billing.
 return {text,actual_model:expectedModel,model_source:'vendor_reported',billing_verified:false,cost:null,authority:false};
}
module.exports={POLICY,readiness,profile,environment,invocation,parse};
