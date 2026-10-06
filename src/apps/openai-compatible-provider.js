'use strict';
const { validateRequest, validateSchema, normalizeTools, fail }=require('../provider-envelope');
const { dataPolicy, secretLike }=require('../provider-policy');
const { normalizeError }=require('../provider-reliability');
const { redactText }=require('../secret-observation');
const MAX_RESPONSE=1024*1024;
function endpoint(baseUrl,locality) {
  let u;try{u=new URL(baseUrl);}catch{fail('invalid_request');}
  if(u.username||u.password||u.search||u.hash||locality==='external'&&u.protocol!=='https:'||locality==='local'&&!(u.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname)))fail('invalid_request');
  if(!['local','external'].includes(locality))fail('invalid_request');
  return new URL(u.pathname.replace(/\/$/,'')+'/chat/completions',u.origin).href;
}
class OpenAICompatibleProvider {
  #url; #secret; #request;
  constructor({profile,baseUrl,secret=null,request=fetch,timeoutMs=30000}={}) {
    this.profile=profile;this.providerId=profile.id;this.#url=endpoint(baseUrl,profile.locality);this.#secret=secret;this.#request=request;this.timeoutMs=Math.min(120000,Math.max(1,timeoutMs));
  }
  health() {return {state:this.profile.auth_required&&!this.#secret?.available()?'auth_required':'unknown',configured:!this.profile.auth_required||this.#secret?.available()===true};}
  models(){return this.profile.models;}
  capabilities(model){return this.models().find(m=>(m.profile_id||m.id)===model)?.capabilities||{};}
  normalizeError(error){return normalizeError(error);}
  estimateCostClass(model){return this.models().find(m=>(m.profile_id||m.id)===model)?.cost_class||'unknown';}
  mapRequest(input,model) {
    validateRequest(input);if(!dataPolicy(input,this.profile).allow)fail('policy_reject');
    const c=model.capabilities,thinking=model.thinking_mode;
    if(input.reasoning_mode&&input.reasoning_mode!==thinking||input.tools?.length&&c.tool_calling!==true||input.stream&&c.streaming!==true||input.structured_schema&&c.json_output!==true||input.strict_schema&&c.strict_schema!==true||input.temperature!=null&&c.temperature!==true)fail('invalid_request');
    if((input.tool_choice==='required'||typeof input.tool_choice==='object')&&c.forced_tool_choice!==true)fail('invalid_request');
    const output=input.max_output||8192;
    // UTF-8 bytes upper-bound input tokens conservatively when no host estimate exists.
    const context=Math.max(input.context_tokens||0,Buffer.byteLength(JSON.stringify({messages:input.messages,tools:input.tools,structured_schema:input.structured_schema})));
    if(!model.max_context&&input.context_tokens||model.max_context&&context+output>model.max_context||model.max_output&&output>model.max_output)fail('invalid_request');
    const messages=input.messages.map(m=>({...m}));
    if(model.quirks?.reasoning_history_with_tools&&input.tools?.length&&thinking==='enabled'&&messages.some(m=>m.role==='assistant'&&typeof m.reasoning_content!=='string'))fail('invalid_request');
    if(input.structured_schema){if(!input.strict_schema&&input.structured_schema.type!=='object')fail('invalid_request');messages.unshift({role:'system',content:'Return only a JSON object matching this schema: '+JSON.stringify(input.structured_schema)});}
    const payload={model:model.id,messages,stream:input.stream===true,max_tokens:output};
    if(thinking){payload.thinking={type:thinking};if(thinking==='enabled')payload.reasoning_effort=input.reasoning_effort||'high';}
    if(input.temperature!=null)payload.temperature=input.temperature;
    if(input.tools?.length)payload.tools=input.tools.map(t=>({type:'function',function:{name:t.name,description:t.description||'',parameters:t.parameters}}));
    if(input.tool_choice)payload.tool_choice=typeof input.tool_choice==='object'?{type:'function',function:{name:input.tool_choice.name}}:input.tool_choice;
    if(input.structured_schema)payload.response_format=input.strict_schema?{type:'json_schema',json_schema:{name:'result',strict:true,schema:input.structured_schema}}:{type:'json_object'};
    if(input.stream)payload.stream_options={include_usage:true};
    return payload;
  }
  async execute(input,model,{signal}={}) {
    const started=Date.now();let credential='';
    try {
      if(!this.models().includes(model))fail('invalid_request');
      const payload=this.mapRequest(input,model);
      if(this.profile.auth_required) {if(!this.#secret)fail('auth_required');credential=await this.#secret.resolve();}
      if(credential&&JSON.stringify(payload).includes(credential))fail('policy_reject');
      const response=await this.#request(this.#url,{method:'POST',redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(this.timeoutMs)]):AbortSignal.timeout(this.timeoutMs),headers:{'Content-Type':'application/json',...(credential?{Authorization:'Bearer '+credential}:{})},body:JSON.stringify(payload)});
      if(!response.ok) {await response.body?.cancel();throw {status:response.status};}
      let text='',bytes=0;const reader=response.body.getReader();const decoder=new TextDecoder();
      try {while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>MAX_RESPONSE)fail('invalid_response');text+=decoder.decode(value,{stream:true});}text+=decoder.decode();}finally{await reader.cancel().catch(()=>{});}
      if(credential)text=text.split(credential).join('[redacted-secret]');
      let raw;try {raw=input.stream?parseStream(text):JSON.parse(text);}catch {fail('invalid_response');}
      if(!raw||!Array.isArray(raw.choices)||raw.choices.length!==1)fail('invalid_response');
      const choice=raw.choices[0],message=choice.message;
      if(!message||message.role&&message.role!=='assistant'||message.content!=null&&typeof message.content!=='string')fail('invalid_response');
      if(secretLike(message.content)||secretLike(message.reasoning_content))fail('invalid_response');
      if(choice.finish_reason==='content_filter')fail('policy_reject');
      if(!['stop','tool_calls'].includes(choice.finish_reason))fail('invalid_response');
      const tools=normalizeTools(message.tool_calls||[],input.tools||[]);
      if(tools.length&&choice.finish_reason!=='tool_calls'||choice.finish_reason==='tool_calls'&&!tools.length||input.tool_choice==='none'&&tools.length||input.tool_choice==='required'&&!tools.length||typeof input.tool_choice==='object'&&(!tools.length||tools.some(t=>t.toolName!==input.tool_choice.name)))fail('invalid_response');
      let structured=null;if(input.structured_schema&&!tools.length){try{structured=JSON.parse(message.content);}catch{fail('invalid_response');}if(!validateSchema(input.structured_schema,structured)||secretLike(structured))fail('invalid_response');}
      if(!tools.length&&!message.content?.trim())fail('invalid_response');
      const usage={};for(const key of ['prompt_tokens','completion_tokens','total_tokens','prompt_cache_hit_tokens','prompt_cache_miss_tokens'])if(Number.isSafeInteger(raw.usage?.[key])&&raw.usage[key]>=0)usage[key]=raw.usage[key];
      if(Number.isSafeInteger(raw.usage?.completion_tokens_details?.reasoning_tokens))usage.reasoning_tokens=raw.usage.completion_tokens_details.reasoning_tokens;
      return {request_id:input.request_id,run_id:input.run_id,provider_id:this.providerId,model:model.id,profile_id:model.profile_id||model.id,status:'completed',text:redactText(message.content||''),structured_output:structured,tool_requests:tools,usage,finish_reason:choice.finish_reason,reasoning_context:typeof message.reasoning_content==='string'?redactText(message.reasoning_content):null,latency_ms:Date.now()-started,completed_at:Date.now(),execution_authority:false,accepted:false};
    } catch(error) {
      let e=error;if(signal?.aborted)e={code:'cancelled'};else if(error?.name==='TimeoutError')e={code:'timeout'};else if(error instanceof TypeError)e={code:'network_error'};
      return {request_id:input?.request_id,run_id:input?.run_id,provider_id:this.providerId,model:model?.id,status:'failed',...normalizeError(e),latency_ms:Date.now()-started,execution_authority:false,accepted:false};
    }
  }
  stream(input,model,options){return this.execute({...input,stream:true},model,options);}
  cancel(controller){controller.abort();}
}
function parseStream(text) {
  const message={role:'assistant',content:'',reasoning_content:'',tool_calls:[]};let done=false,finish=null,usage;
  const calls=new Map();
  for(const line of text.split(/\r?\n/)) {
    if(!line.startsWith('data:'))continue;const data=line.slice(5).trim();if(data==='[DONE]'){done=true;continue;}if(done)fail('invalid_response');
    const chunk=JSON.parse(data);if(chunk.error)fail('invalid_response');if(chunk.usage)usage=chunk.usage;
    if(!Array.isArray(chunk.choices)||chunk.choices.length>1)fail('invalid_response');
    for(const choice of chunk.choices){const d=choice.delta||{};if(d.content!=null&&typeof d.content!=='string'||d.reasoning_content!=null&&typeof d.reasoning_content!=='string')fail('invalid_response');message.content+=d.content||'';message.reasoning_content+=d.reasoning_content||'';if(choice.finish_reason)finish=choice.finish_reason;
      for(const t of d.tool_calls||[]){if(!Number.isInteger(t.index)||t.index<0||t.index>31)fail('invalid_response');const c=calls.get(t.index)||{id:'',type:'function',function:{name:'',arguments:''}};if(t.id)c.id=t.id;if(t.type)c.type=t.type;if(t.function?.name)c.function.name+=t.function.name;if(t.function?.arguments)c.function.arguments+=t.function.arguments;calls.set(t.index,c);}
    }
  }
  if(!done||!finish)fail('invalid_response');message.tool_calls=[...calls.values()];return {choices:[{message,finish_reason:finish}],usage};
}
module.exports={OpenAICompatibleProvider,parseStream,endpoint};
