'use strict';
const { LOCAL_OLLAMA } = require('./local-ollama-broker');
const BASE = {chat:true,reasoning:true,coding:null,tool_calling:null,forced_tool_choice:null,json_output:null,strict_schema:null,streaming:null,vision:false,long_context:null,thinking:null,temperature:null,cancellation:true};
function model(id, capabilities = {}, extra = {}) { return {id,capabilities:{...BASE,...capabilities},max_context:null,max_output:8192,cost_class:'unknown',latency_class:'unknown',...extra}; }
const deepseek = id => ['disabled','enabled'].map(mode => model(id, {
  coding:true,tool_calling:true,forced_tool_choice:mode==='disabled',json_output:true,strict_schema:false,
  streaming:true,long_context:true,thinking:mode==='enabled',temperature:mode==='disabled',
  // Vendor vision exists for Flash; V1 text envelope deliberately does not enable it.
}, {profile_id:`${id}:${mode}`,thinking_mode:mode,max_context:1000000,max_output:393216,cost_class:id==='deepseek-flash'?'low':'medium',
  quirks:{thinking_field:true,reasoning_history_with_tools:true,json_prompt_required:true,strict_tools_beta:false,stream_usage:'last_content_chunk',documented_vision:id==='deepseek-flash'},docs_verified:'2026-10-02'}));
function initialProfiles() { return [
  {id:'ollama',protocol:'openai_compatible',locality:'local',privacy_class:'local',implemented:true,auth_required:false,models:[model(LOCAL_OLLAMA.model,{coding:true,streaming:true,temperature:true},{cost_class:'free/local',max_output:8192})]},
  {id:'anthropic_subscription',protocol:'anthropic_runtime',locality:'external',privacy_class:'approved_external_only',implemented:true,runtime_only:true,models:[model('claude-runtime',{chat:true,reasoning:true,coding:null,tool_calling:false,streaming:false,cancellation:true},{max_output:8192})]},
  {id:'codex_openai',protocol:'openai_runtime',locality:'external',privacy_class:'approved_external_only',implemented:true,runtime_only:true,models:[model('codex-runtime',{coding:true},{max_output:null})]},
  {id:'openai_compatible',protocol:'openai_compatible',locality:'external',privacy_class:'approved_external_only',implemented:true,auth_required:true,models:[]},
  {id:'deepseek',protocol:'openai_compatible',locality:'external',privacy_class:'approved_external_only',implemented:true,auth_required:true,models:[...deepseek('deepseek-flash'),...deepseek('deepseek-v4-pro')]}
]; }
module.exports = { initialProfiles, model };
