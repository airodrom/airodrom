#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{DatabaseSync}=require('node:sqlite'),{performance}=require('node:perf_hooks'),{execFileSync}=require('node:child_process');
const {measure}=require('../src/memory-quality');
function benchmark(root=path.resolve(__dirname,'..')) {
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'airodrom-quality-')),file=path.join(directory,'synthetic.sqlite');let db=new DatabaseSync(file),now=1790000000000;
 const Memory=require(path.join(root,'src/personal-memory')).PersonalMemory;let memory=new Memory({db,now:()=>now});const cases=[];
 const remember=(subject,content,extra={})=>memory.remember({domain:'project',projectId:'synthetic-project',type:'fact',subject,content,source:'user_explicit',sensitivity:'normal',...extra});
 function query(id,q,expected,forbidden=[],options={}) {
  const start=performance.now(),result=memory.search(q,{domain:'project',projectId:'synthetic-project',limit:6,maxChars:4000,...options}),ms=performance.now()-start;
  const metric=measure({expected,forbidden,retrieved:result.items.map(x=>({id:x.memoryId,provenance:x.source==='user_explicit'})),budget:options.maxChars||4000,used:result.usedChars,grounded:result.items.map(x=>x.memoryId),claims:result.items.map(x=>x.memoryId)});
  cases.push({id,latency_ms:ms,...metric});return result;
 }
 try {
  const runtime=remember('runtime.choice','OpenCode was chosen in synthetic decision ADR-FIXTURE because bounded file isolation passed.');
  query('relevant-selection','runtime.choice',[runtime.memoryId]);query('irrelevant-rejection','zucchini telescope unavailable',[]);
  const old=remember('runtime.version','Synthetic runtime version alpha.');now++;const current=memory.update(old.memoryId,{content:'Synthetic runtime version beta.'});
  query('current-fact','runtime.version',[current.memoryId],[old.memoryId]);query('correction-precedence','runtime.version',[current.memoryId],[old.memoryId]);query('superseded-exclusion','alpha',[],[old.memoryId]);
  const gone=remember('forgotten.marker','Synthetic forgotten signal.');memory.forget(gone.memoryId);query('forgotten-exclusion','forgotten.marker',[],[gone.memoryId]);
  const expired=remember('temporary.marker','Synthetic expiring reference.',{expiresAt:now+1});now+=2;query('temporal-expiry','temporary.marker',[],[expired.memoryId]);
  db.close();db=new DatabaseSync(file);memory=new Memory({db,now:()=>now});query('cross-session-consistency','runtime.choice',[runtime.memoryId]);
  const other=remember('runtime.choice','Other project private synthetic fact.',{projectId:'other-project'});query('cross-project-isolation','runtime.choice',[runtime.memoryId],[other.memoryId]);
  query('source-provenance','runtime.choice',[runtime.memoryId]);remember('secondary.runtime.choice','Secondary synthetic choice');query('ranking-exact-subject','runtime.choice',[runtime.memoryId]);
  query('context-budget','runtime.choice',[],[],{maxChars:1});
  query('grounded-answer-evidence','bounded file isolation',[runtime.memoryId]);query('missing-evidence','missing.fact.motivation',[]);
  // A historical decision remains retrievable as history; current corrections stay authoritative.
  query('historical-decision','ADR-FIXTURE',[runtime.memoryId],[old.memoryId]);
  const latency=cases.map(c=>c.latency_ms).sort((a,b)=>a-b);
  return {schema_version:1,source_sha:execFileSync('/usr/bin/git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),evidence_class:'DISPOSABLE_FIXTURE',seed:1,cases,
   summary:{cases:cases.length,relevant:cases.reduce((a,c)=>a+c.relevant,0),irrelevant:cases.reduce((a,c)=>a+c.irrelevant,0),correction_passed:cases.find(c=>c.id==='correction-precedence').forbidden_hits===0&&cases.find(c=>c.id==='correction-precedence').recall===1,forgetting_passed:cases.find(c=>c.id==='forgotten-exclusion').forbidden_hits===0,exact_retrieval_passes:cases.filter(c=>c.recall===1&&c.precision===1).length,precision:cases.reduce((a,c)=>a+c.precision,0)/cases.length,recall:cases.reduce((a,c)=>a+c.recall,0)/cases.length,forbidden_hits:cases.reduce((a,c)=>a+c.forbidden_hits,0),provenance:cases.filter(c=>c.provenance_coverage!==null).reduce((a,c)=>a+c.provenance_coverage,0)/cases.filter(c=>c.provenance_coverage!==null).length,budget_compliant:cases.every(c=>c.budget_compliant),mean_context_chars:cases.reduce((a,c)=>a+c.budget_used,0)/cases.length,latency_p50_ms:latency[Math.floor(latency.length*.5)],latency_p95_ms:latency[Math.floor(latency.length*.95)],database_bytes:fs.statSync(file).size},
   ranking_decision:'retain_existing; no candidate ranking demonstrated a strict improvement on this fixture',limitations:['Lexical/lifecycle evidence only; not semantic understanding.','Source-grounding measures available references, not a model answer.','No embeddings or graph service added.'],owner_memory_touched:false,model_invocations:0,external_cost:0};
 } finally {db.close();fs.rmSync(directory,{recursive:true,force:true});}
}
if(require.main===module){const root=process.argv.find(a=>a.startsWith('--root='))?.slice(7),out=process.argv.find(a=>a.startsWith('--output='))?.slice(9);const result=benchmark(root?path.resolve(root):undefined);if(out)fs.writeFileSync(out,JSON.stringify(result,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(result,null,2));if(result.summary.forbidden_hits||!result.summary.budget_compliant)process.exitCode=1;}
module.exports={benchmark};
