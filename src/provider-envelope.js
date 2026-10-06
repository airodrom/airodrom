'use strict';
const { secretLike } = require('./provider-policy');
const fail = code => {throw Object.assign(Error('Provider request or response rejected'),{code});};
const ID=/^[A-Za-z0-9_.:-]{1,160}$/;
const SCHEMA_KEYS=new Set(['type','properties','required','additionalProperties','items','enum','anyOf','minimum','maximum','minLength','maxLength','minItems','maxItems','description','title']);
function validateSchema(schema,value,depth=0) {
  if(depth>16||!schema||typeof schema!=='object'||Array.isArray(schema)||Object.keys(schema).some(k=>!SCHEMA_KEYS.has(k)))return false;
  if(schema.anyOf&&!schema.anyOf.some(s=>validateSchema(s,value,depth+1)))return false;
  if(schema.enum&&!schema.enum.some(v=>JSON.stringify(v)===JSON.stringify(value)))return false;
  const types=Array.isArray(schema.type)?schema.type:[schema.type];
  if(schema.type&&!types.some(t=>t==='null'?value===null:t==='object'?value!==null&&typeof value==='object'&&!Array.isArray(value):t==='array'?Array.isArray(value):t==='integer'?Number.isSafeInteger(value):t==='number'?typeof value==='number'&&Number.isFinite(value):['string','boolean'].includes(t)&&typeof value===t))return false;
  if(value!==null&&typeof value==='object'&&!Array.isArray(value)) {
    if(schema.required&&(!Array.isArray(schema.required)||schema.required.some(k=>!Object.hasOwn(value,k))))return false;
    for(const [k,v]of Object.entries(value)) {if(Object.hasOwn(schema.properties||{},k)){if(!validateSchema(schema.properties[k],v,depth+1))return false;}else if(schema.additionalProperties===false)return false;else if(schema.additionalProperties&&typeof schema.additionalProperties==='object'&&!validateSchema(schema.additionalProperties,v,depth+1))return false;}
  }
  if(Array.isArray(value)) {if(schema.minItems!=null&&value.length<schema.minItems||schema.maxItems!=null&&value.length>schema.maxItems)return false;if(schema.items&&!value.every(v=>validateSchema(schema.items,v,depth+1)))return false;}
  if(typeof value==='number'&&(schema.minimum!=null&&value<schema.minimum||schema.maximum!=null&&value>schema.maximum))return false;
  if(typeof value==='string'&&(schema.minLength!=null&&value.length<schema.minLength||schema.maxLength!=null&&value.length>schema.maxLength))return false;
  return true;
}
function schemaSupported(schema,depth=0) {
  if(depth>16||!schema||typeof schema!=='object'||Array.isArray(schema)||Object.keys(schema).some(k=>!SCHEMA_KEYS.has(k)))return false;
  if(schema.type&&!([schema.type].flat().every(t=>['object','array','string','number','integer','boolean','null'].includes(t))))return false;
  if(schema.properties&&(!schema.properties||typeof schema.properties!=='object'||Array.isArray(schema.properties))||schema.required&&(!Array.isArray(schema.required)||schema.required.some(k=>typeof k!=='string'))||schema.enum&&(!Array.isArray(schema.enum)||schema.enum.length>128))return false;
  for(const k of ['minimum','maximum','minLength','maxLength','minItems','maxItems'])if(schema[k]!=null&&(typeof schema[k]!=='number'||!Number.isFinite(schema[k])||['minLength','maxLength','minItems','maxItems'].includes(k)&&(!Number.isSafeInteger(schema[k])||schema[k]<0)))return false;
  if(schema.additionalProperties!=null&&typeof schema.additionalProperties!=='boolean'&&typeof schema.additionalProperties!=='object')return false;
  return Object.values(schema.properties||{}).every(s=>schemaSupported(s,depth+1))&&(!schema.items||schemaSupported(schema.items,depth+1))&&(!schema.anyOf||Array.isArray(schema.anyOf)&&schema.anyOf.every(s=>schemaSupported(s,depth+1)))&&(!(schema.additionalProperties&&typeof schema.additionalProperties==='object')||schemaSupported(schema.additionalProperties,depth+1));
}
const REQUEST_FIELDS=new Set(['allowed_providers','request_id','run_id','messages','tools','tool_choice','structured_schema','strict_schema','reasoning_mode','reasoning_effort','stream','max_output','context_tokens','temperature','data_class','privacy','project_policy','attachment_refs','memory_refs','context_refs','redaction','requirements','selected_agent','required_provider','required_model','cost_preference','latency_preference','unknown_side_effects','failed_providers','deterministic','execution_started']);
function validateRequest(input) {
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!REQUEST_FIELDS.has(k))||!ID.test(input.request_id||'')||!ID.test(input.run_id||''))fail('invalid_request');
  if(Buffer.byteLength(JSON.stringify(input))>128*1024||secretLike(input.messages)||secretLike(input.tools)||secretLike(input.structured_schema))fail('policy_reject');
  if(!Array.isArray(input.messages)||!input.messages.length||input.messages.length>100)fail('invalid_request');
  for(const m of input.messages) {
    if(!m||!['system','user','assistant','tool'].includes(m.role)||Object.keys(m).some(k=>!['role','content','tool_calls','tool_call_id','reasoning_content'].includes(k))||!(typeof m.content==='string'||m.role==='assistant'&&m.content===null))fail('invalid_request');
    if(m.reasoning_content!=null&&typeof m.reasoning_content!=='string'||m.role==='tool'&&!ID.test(m.tool_call_id||''))fail('invalid_request');
  }
  if(input.max_output!=null&&(!Number.isSafeInteger(input.max_output)||input.max_output<1||input.max_output>8192)||input.context_tokens!=null&&(!Number.isSafeInteger(input.context_tokens)||input.context_tokens<0))fail('invalid_request');
  if(input.reasoning_mode!=null&&!['enabled','disabled'].includes(input.reasoning_mode)||input.reasoning_effort!=null&&!['low','high','max'].includes(input.reasoning_effort))fail('invalid_request');
  if(input.temperature!=null&&(typeof input.temperature!=='number'||!Number.isFinite(input.temperature)||input.temperature<0||input.temperature>2))fail('invalid_request');
  for(const k of ['stream','strict_schema','deterministic','unknown_side_effects','execution_started'])if(input[k]!=null&&typeof input[k]!=='boolean')fail('invalid_request');
  for(const k of ['selected_agent','required_provider','required_model'])if(input[k]!=null&&(!ID.test(input[k])||secretLike(input[k])))fail('invalid_request');
  if(input.allowed_providers!=null&&(!Array.isArray(input.allowed_providers)||!input.allowed_providers.length||input.allowed_providers.length>8||input.allowed_providers.some(k=>typeof k!=='string'||!ID.test(k))))fail('invalid_request');
  if(input.requirements!=null&&(!Array.isArray(input.requirements)||input.requirements.length>32||input.requirements.some(k=>typeof k!=='string'||!ID.test(k))))fail('invalid_request');
  for(const k of ['attachment_refs','memory_refs','context_refs','failed_providers'])if(input[k]!=null&&(!Array.isArray(input[k])||input[k].length>100||input[k].some(v=>typeof v!=='string'||v.length>500||secretLike(v))))fail('invalid_request');
  if(input.structured_schema&&!schemaSupported(input.structured_schema))fail('invalid_request');
  if(input.tools!=null&&(!Array.isArray(input.tools)||input.tools.length>32))fail('invalid_request');
  const names=new Set();
  for(const t of input.tools||[]) {if(!t||Object.keys(t).some(k=>!['name','description','parameters'].includes(k))||!/^[A-Za-z0-9_-]{1,128}$/.test(t.name||'')||names.has(t.name)||!schemaSupported(t.parameters))fail('invalid_request');names.add(t.name);}
  if(input.tool_choice!=null&&!['auto','none','required'].includes(input.tool_choice)&&!(typeof input.tool_choice==='object'&&Object.keys(input.tool_choice).join()==='name'&&names.has(input.tool_choice.name)))fail('invalid_request');
  if((input.tool_choice==='required'||typeof input.tool_choice==='object')&&!names.size)fail('invalid_request');
  return input;
}
function normalizeTools(calls,tools) {
  if(!Array.isArray(calls)||calls.length>32)fail('invalid_response');
  const ids=new Set();return calls.map(c=>{
    const schema=tools.find(t=>t.name===c.function?.name);if(!schema||c.type!=='function'||!ID.test(c.id||'')||ids.has(c.id)||typeof c.function.arguments!=='string')fail('invalid_response');ids.add(c.id);
    let input;try {input=JSON.parse(c.function.arguments);}catch {fail('invalid_response');}
    if(!validateSchema(schema.parameters,input)||secretLike(input))fail('invalid_response');
    return {toolCallId:c.id,toolName:c.function.name,input,execution_authority:false,requires_capability_broker:true};
  });
}
module.exports={validateRequest,validateSchema,schemaSupported,normalizeTools,fail};
