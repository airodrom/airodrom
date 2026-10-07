'use strict';
// ADR 0013. This adapter is a host port, never a worker browser escape hatch.
const {keys, text, integer, CapabilityInputError, looksSecret}=require('./capability-util');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ACTIONS={handoff:['authorization_id'],navigate:['url'],click:['link_id'],scroll:['dy'],snapshot:[],screenshot:[],viewport:['width','height'],form:['form_id','fields','approval_id'],download:['url','approval_id'],authenticate:['form_id','username_reference','password_reference','approval_id']};
function validate(input){
 keys(input,['mission_id','action']);if(!UUID.test(input.mission_id))throw new CapabilityInputError('Opaque research Mission identity required');
 const a=input.action;if(!a||!Object.hasOwn(ACTIONS,a.type))throw new CapabilityInputError('Unknown browser action');
 keys(a,['type',...ACTIONS[a.type]]);
 if(a.url!==undefined){text(a.url,'public URL',{max:2048,multiline:false});let u;try{u=new URL(a.url);}catch{throw new CapabilityInputError('Invalid public URL');}if(u.username||u.password||u.search||u.hash||!['https:','http:'].includes(u.protocol))throw new CapabilityInputError('Use a public URL without credentials, query or fragment');}
 for(const k of ['authorization_id','link_id','form_id','approval_id','username_reference','password_reference'])if(a[k]!==undefined){text(a[k],k,{max:100,multiline:false});if(!UUID.test(a[k]))throw new CapabilityInputError('Opaque browser reference required');}
 if(a.dy!==undefined)integer(a.dy,'scroll distance',{min:-1600,max:1600});
 if(a.width!==undefined)integer(a.width,'viewport width',{min:320,max:1920});if(a.height!==undefined)integer(a.height,'viewport height',{min:320,max:1200});
 if(a.fields!==undefined){if(!a.fields||typeof a.fields!=='object'||Array.isArray(a.fields)||Object.keys(a.fields).length>8)throw new CapabilityInputError('Bounded public form fields required');for(const [id,value]of Object.entries(a.fields)){if(!UUID.test(id))throw new CapabilityInputError('Opaque public field required');text(value,'public form value',{max:200,multiline:false});if(looksSecret(value)||require('./private-vault-intent').containsPrivate(value))throw new CapabilityInputError('Private values require secure entry');}}
 return structuredClone(input);
}
function researchCapabilities(){return {browser_research:{validate,pureAssess:true,
 assess:async(ctx,input)=>{if(!ctx.researchAssess)return {dynamic:{decision:'deny',reason:'Governed browser service unavailable'}};return ctx.researchAssess(ctx.task,input);},
 perform:(ctx,input)=>{if(!ctx.researchExecute)throw Error('Governed browser service unavailable');return ctx.researchExecute(ctx.task,input,ctx.signal);}
}};}
module.exports={researchCapabilities,validate,ACTIONS};
