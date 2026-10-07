'use strict';
// Values cross only this host-only Keychain/browser port. ADR 0013.
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
class ResearchCredentials{
 #bridge;#vault;#used=new Set();
 constructor(bridge,{vault,synthetic=false}={}){
  if(vault&&!(process.env.NODE_ENV==='test'&&synthetic))throw Error('Synthetic credential port denied');
  this.#bridge=bridge;this.#vault=vault||new(require('./secret-vault').SecretVault)(bridge.dataDir);
 }
 validateReferences(usernameReference,passwordReference){
  if(!UUID.test(usernameReference||'')||!UUID.test(passwordReference||'')||usernameReference===passwordReference)throw Error('Two distinct stored credential references required');
  const rows=this.#vault.search('');
  const user=rows.find(r=>r.reference===usernameReference),password=rows.find(r=>r.reference===passwordReference);
  if(!user||!password||user.kind==='private_identifier'||!['password','credential'].includes(password.kind))throw Error('Current operator credential references required; connector and private identifier values are unavailable');
  return true;
 }
 authorized(m,action){
  const a=m.envelope.manifest?.account_authorization;
  if(m.owner!=='operator'||m.envelope.kind!=='browser_research'||!a||a.purpose!=='competitor_product_research'||!UUID.test(a.id)||action.type!=='authenticate'||action.username_reference!==a.username_reference||action.password_reference!==a.password_reference||m.envelope.authority?.permissions?.secrets?.includes('use')!==true)throw Error('Purpose-bound account authorization required');
  this.validateReferences(a.username_reference,a.password_reference);
  return a;
 }
 consumedApproval(m,action){
  this.authorized(m,action);
  return [...this.#bridge.policy.approvals.values()].find(p=>p.status==='consumed'&&p.taskId===m.task_id&&p.toolName==='capability'&&p.input?.name==='browser_research'&&p.input.input?.mission_id===m.id&&p.input.input.action?.type==='authenticate'&&p.input.input.action?.form_id===action.form_id&&p.input.input.action?.username_reference===action.username_reference&&p.input.input.action?.password_reference===action.password_reference&&p.input.input.action?.approval_id===action.approval_id)||null;
 }
 resolve(reference,grant){
  if(!grant||!UUID.test(grant.mission_id||''))throw Error('Current account purpose grant required');
  const m=this.#bridge.controlStore.requireMission(grant.mission_id),a=m.envelope.manifest?.account_authorization;
  this.#bridge.missions.research.assertContract(m,{execution:true});
  if(!a||a.id!==grant.id||a.origin!==grant.origin||grant.purpose!=='account_login'||!['running'].includes(m.state)||Date.now()>=m.envelope.manifest.expires_at||![a.username_reference,a.password_reference].includes(reference)||grant.username_reference!==a.username_reference||grant.password_reference!==a.password_reference||new URL(grant.submission_url).origin!==a.origin)throw Error('Account credential purpose or origin changed');
  const action={type:'authenticate',form_id:grant.form_id,username_reference:a.username_reference,password_reference:a.password_reference,approval_id:grant.approval_id};
  const approval=this.consumedApproval(m,action),key=(approval?.id||'')+':'+reference;
  if(!approval||this.#used.has(key))throw Error('Exact one-shot login approval required');
  this.#used.add(key);return this.#vault.resolve(reference,'operator');
 }
}
module.exports={ResearchCredentials};
