'use strict';
// Versioned installation compatibility. Mixed Git SHAs are allowed; incompatible
// contract majors and missing component evidence are not. Mutations fail closed;
// read-only diagnostics and recovery remain available.
const fs=require('node:fs'),path=require('node:path');
const CONFIG=require('../config/installation-compatibility-v1.json');
const contracts=require('./core-contracts');

function packageVersion(root){
 try{return require(path.join(root,'package.json')).version;}catch{return null;}
}

function semverParts(v){
 const m=String(v||'').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
 if(!m)return null;
 return {major:+m[1],minor:+m[2],patch:+m[3],pre:m[4]||''};
}

function compatiblePackage(installed,minimum){
 const a=semverParts(installed),b=semverParts(minimum);
 if(!a||!b)return 'missing_evidence';
 if(a.major!==b.major)return a.major>b.major?'compatible_outdated':'incompatible';
 if(a.minor>b.minor||(a.minor===b.minor&&a.patch>=b.patch))return 'compatible';
 return 'compatible_outdated';
}

function observeComponent(id,root,bridge){
 const spec=CONFIG.contracts[id];
 const pkg=packageVersion(root);
 const base={component:id,package_version:pkg,state:'missing_evidence',guidance:null,evidence:{}};
 if(id==='core_daemon'){
  const state=compatiblePackage(pkg,spec.min_package);
  const intact=contracts.intact();
  return {...base,state:intact?state:'incompatible',evidence:{core_contracts:intact,source_sha256:bridge?.runtimeFingerprint?.source_sha256||null},guidance:intact?null:'Restore config/core-contracts-v1.json and matching core-contracts module.'};
 }
 if(id==='global_cli'){
  const cli=fs.existsSync(path.join(root,'scripts/airodrom.cjs'))||fs.existsSync(path.join(root,'scripts/run.cjs'));
  return {...base,state:cli?compatiblePackage(pkg,spec.min_package):'missing_evidence',evidence:{cli_scripts:cli,protocol:spec.protocol},guidance:cli?null:'Install or repair the global Airodrom CLI from this package.'};
 }
 if(id==='control_center'){
  const hub=fs.existsSync(path.join(root,'public/control-hub.js'));
  return {...base,state:hub?compatiblePackage(pkg,spec.min_package):'missing_evidence',evidence:{hub},guidance:hub?null:'Control Center assets missing from this installation.'};
 }
 if(id==='macos_menu'){
  const menu=fs.existsSync(path.join(root,'macos/AirodromMenu.swift'));
  const control=fs.existsSync(path.join(root,'scripts/macos/product-control.cjs'));
  let actions_ok=false;
  try{actions_ok=fs.readFileSync(path.join(root,'scripts/macos/product-control.cjs'),'utf8').includes('open-conversation');}catch{actions_ok=false;}
  return {...base,state:menu&&control?(actions_ok?compatiblePackage(pkg,spec.min_package):'compatible_outdated'):'missing_evidence',evidence:{menu,control,open_conversation:actions_ok},guidance:menu&&control?(actions_ok?null:'Rebuild/reinstall the macOS menu for Conversation navigation.'):'macOS menu sources unavailable in this tree.'};
 }
 if(id==='mcp_contract'){
  let tools=[];
  try{
   const src=fs.readFileSync(path.join(root,'src/mcp-tools.js'),'utf8');
   tools=spec.tools_required.filter(name=>src.includes("'"+name+"'")||src.includes('"'+name+'"'));
  }catch{tools=[];}
  const complete=tools.length===spec.tools_required.length;
  return {...base,state:complete?compatiblePackage(pkg,spec.min_package):'incompatible',evidence:{tools_present:tools,tools_required:spec.tools_required},guidance:complete?null:'MCP tool surface is missing required Mission/task contracts.'};
 }
 if(id==='model_provider_contract'){
  const ok=contracts.definition('ModelRequest').version===spec.contract_version;
  return {...base,state:ok?compatiblePackage(pkg,spec.min_package):'incompatible',evidence:{contract:spec.contract,version:contracts.definition('ModelRequest').version},guidance:ok?null:'Model provider contract version mismatch.'};
 }
 if(id==='agent_runtime_contract'){
  const ok=contracts.definition('WorkerAssignment').version===spec.contract_version;
  return {...base,state:ok?compatiblePackage(pkg,spec.min_package):'incompatible',evidence:{contract:spec.contract,version:contracts.definition('WorkerAssignment').version},guidance:ok?null:'Agent runtime contract version mismatch.'};
 }
 return base;
}

function detectMixedSource(components){
 const shas=components.map(c=>c.evidence?.source_sha256).filter(Boolean);
 if(shas.length<=1)return false;
 return new Set(shas).size>1;
}

function evaluate(bridge,{root=path.resolve(__dirname,'..')}={}){
 const components=CONFIG.components.map(id=>observeComponent(id,root,bridge));
 // Attach daemon fingerprint onto each row that can share process evidence.
 const sha=bridge?.runtimeFingerprint?.source_sha256||null;
 for(const c of components)if(!c.evidence.source_sha256&&sha)c.evidence.source_sha256=sha;
 const mixed=detectMixedSource(components);
 if(mixed)for(const c of components)if(c.state==='compatible'||c.state==='compatible_outdated')c.state='mixed_source';
 const incompatible=components.some(c=>c.state==='incompatible');
 const missing=components.some(c=>c.state==='missing_evidence');
 const overall=incompatible?'incompatible':mixed?'mixed_source':missing?'missing_evidence':components.some(c=>c.state==='compatible_outdated')?'compatible_outdated':'compatible';
 return {
  schema_version:CONFIG.schema_version,
  family:CONFIG.family,
  overall,
  mutations_allowed:overall==='compatible'||overall==='compatible_outdated',
  readonly_diagnostics:true,
  recovery_access:true,
  policy:CONFIG.policy,
  package_version:packageVersion(root),
  components,
  upgrade_guidance:components.filter(c=>c.guidance).map(c=>({component:c.component,guidance:c.guidance,state:c.state})),
  observed_at:Date.now(),
  authority:false
 };
}

function assertMutable(bridge,root){
 const status=evaluate(bridge,{root});
 if(!status.mutations_allowed)throw Error('Installation incompatible with state-changing operations ('+status.overall+'). Diagnostics and recovery remain available.');
 return status;
}

module.exports={CONFIG,evaluate,assertMutable,compatiblePackage,observeComponent};
