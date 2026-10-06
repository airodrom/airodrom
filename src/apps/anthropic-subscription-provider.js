'use strict';
const {validateRequest}=require('../provider-envelope');
const {dataPolicy}=require('../provider-policy');
const {secretLike}=require('../provider-policy');
const {normalizeError}=require('../provider-reliability');
const {SubscriptionRuntime}=require('../anthropic-subscription-runtime');
// Pinned subscription transport; execution-capable Claude agent remains separate.
class AnthropicSubscriptionProvider {
  constructor({profile,enabled=false,runtime=null}={}) {this.profile=profile;this.providerId='anthropic_subscription';this.runtime=runtime||new SubscriptionRuntime();this.runtimeState=enabled?this.runtime.qualify():this.runtime.state;this.lastSuccessfulInference=null;this.lastSafeErrorClass=null;this.sessionState=this.runtimeState.configured?'authenticated':'unknown';}
  health() {return {...this.runtimeState,session_health:{state:this.sessionState,last_successful_inference:this.lastSuccessfulInference,last_safe_error_class:this.lastSafeErrorClass},transport:'claude_cli_print',sandbox_verified:this.runtimeState.configured===true,execution_authority:false};}
  models(){return this.profile.models;}
  capabilities(model){return this.models().find(m=>m.id===model)?.capabilities||{};}
  async execute(input,model,{signal}={}) {
    let error_class='runtime_unavailable';
    try {
      validateRequest(input);
      if(!dataPolicy(input,this.profile).allow)error_class='policy_reject';
      else if(!this.models().includes(model)||input.tools?.length||input.stream||input.structured_schema||input.reasoning_mode||input.temperature!=null||input.messages.some(m=>m.role==='tool'||m.tool_calls))error_class='invalid_request';
      else if(signal?.aborted)error_class='cancelled';
    }catch(error){error_class=['policy_reject','invalid_request'].includes(error.code)?error.code:'invalid_request';}
    if(error_class==='runtime_unavailable'&&this.runtimeState.configured) {
      try {
        const prompt=JSON.stringify({messages:input.messages});
        const r=await this.runtime.run(prompt,{signal,maxOutput:input.max_output||8192});
        if(secretLike(r.text))throw Object.assign(Error('Unsafe response'),{code:'invalid_response'});
        this.lastSuccessfulInference=Date.now();this.lastSafeErrorClass=null;this.sessionState='authenticated';
        return {request_id:input.request_id,run_id:input.run_id,provider_id:this.providerId,model:model.id,status:'completed',text:r.text,runtime_version:r.runtime_version,runtime_sha256:r.runtime_sha256,tool_requests:[],execution_authority:false,accepted:false,finish_reason:'stop'};
      }catch(e){const normalized=normalizeError(e);this.lastSafeErrorClass=normalized.error_class;if(normalized.error_class==='auth_required'){this.sessionState='expired_or_invalid';this.runtimeState={...this.runtimeState,configured:false,state:'auth_required',reason:'auth_required',auth_state:'auth_required'};}return {status:'failed',provider_id:this.providerId,...normalized,accepted:false,execution_authority:false,tool_requests:[]};}
    }
    return {status:'failed',provider:this.providerId,error_class,state:'unavailable',retryable:false,reason:this.health().reason,accepted:false,execution_authority:false,tool_requests:[]};
  }
}
module.exports={AnthropicSubscriptionProvider};
