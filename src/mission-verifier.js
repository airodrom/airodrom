'use strict';
const fs=require('node:fs'),path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const {workspaceSnapshot}=require('./control-context');
const {transaction,redactValue}=require('./control-plane-store');
const hash=s=>createHash('sha256').update(s).digest('hex');
class MissionVerifier {
  constructor(bridge,store){this.bridge=bridge;this.store=store;}
  async verify(mission,run){
    if(mission.envelope.kind==='conversation')return require('./conversation-mission').verify(this.bridge.missions,mission,run);
    if(mission.envelope.kind==='browser_research')return this.bridge.missions.research.verify(mission,run);
    try{this.bridge.opencodeAdapter?.assertEvidence(run);this.bridge.missions._web?.verify(mission,run);}catch{return{status:'failed',checks:[{id:'runtime_provenance',status:'failed',evidence:{reason:'opencode_provenance_unavailable'}}],workspace_hash:'unavailable'};}
    const envelope=mission.envelope,checks=[],task=this.bridge.tasks.get(run.task_id);
    const add=(id,status,evidence)=>checks.push({id,status,evidence:redactValue(evidence)});
    const call=async(name,input)=>{
      if(this.bridge.closed)throw Error('Bridge is shutting down');
      const response=await this.bridge.invokeCapability(task.id,{name,input,requestId:`verify:${run.id}:${name}:${randomUUID()}`});
      if(response.status!=='completed')throw Error(`Verification capability unavailable: ${response.status}`);
      return response.result;
    };
    if (!require('./execution-evidence').runSatisfied(run)) return { status: 'failed', checks: [{ id: 'native_execution', status: 'failed', evidence: { reason: 'native_tool_required' } }], workspace_hash: 'unavailable' };
    let snapshot=null;
    try {
      snapshot=workspaceSnapshot(envelope.workspace);
      const lease=this.store.db.prepare("SELECT baseline FROM cp_leases WHERE run_id=? AND mode='write'").get(run.id);
      if(!lease)throw Error('Run baseline missing');const baseline=JSON.parse(lease.baseline);
      const receipt=baseline.version===2?require('./repository-verification').compare(baseline,snapshot,envelope.allowed_files,[],{creation:envelope.baseline}):null;
      if(receipt)add('repository_v2',receipt.status,receipt);
      const changed=[...new Set([...Object.keys(baseline.files),...Object.keys(snapshot.files)])].filter(f=>baseline.files[f]!==snapshot.files[f]);
      const protectedChanged=changed.filter(f=>!envelope.allowed_files.includes(f)||baseline.dirty.includes(f));
      const creation=envelope.baseline;
      if(creation.version===2)add('creation_repository_v2',require('./repository-verification').compare(creation,snapshot,envelope.allowed_files).status,{baseline_hash:creation.hash,identity_and_original_scope_checked:true});
      for(const [file,digest]of Object.entries(creation.files))if(!envelope.allowed_files.includes(file)&&snapshot.files[file]!==digest&&!protectedChanged.includes(file))protectedChanged.push(file);
      add('workspace', 'passed',{exists:true});
      add('protected_files',protectedChanged.length||baseline.head!==snapshot.head?'failed':'passed',{changed:protectedChanged,head_unchanged:baseline.head===snapshot.head});
      add('expected_changes',envelope.allowed_files.some(f=>creation.files[f]!==snapshot.files[f])?'passed':'failed',{task_owned_changes:changed.filter(f=>envelope.allowed_files.includes(f)),baseline_hash:baseline.hash});
      if(checks.some(c=>c.status==='failed'))return{status:'failed',checks,workspace_hash:snapshot.hash};
      add('git_status','passed',await call('git_status',{repo:envelope.workspace}));
      add('task_owned_diff','passed',await call('git_diff',{repo:envelope.workspace,paths:envelope.allowed_files,stat:true}));
      for(const criterion of envelope.criteria){
        if(criterion.type==='exact_file'){
          const result=await call('file_hash',{path:path.join(envelope.workspace,criterion.path),algorithm:'sha256'});
          add(criterion.id,result.digest===hash(criterion.content)?'passed':'failed',{path:criterion.path,expected_sha256:hash(criterion.content),actual_sha256:result.digest});
        }else add(criterion.id,'operator_review',{description:criterion.description});
      }
      // Registered repository tasks are selected by the operator. Their file is
      // held immutable from Mission creation, and the existing broker classifies
      // the command and enforces any required exact approval.
      const tasksFile='.vscode/tasks.json';
      if(snapshot.files[tasksFile]!==creation.files[tasksFile]||!creation.files[tasksFile])throw Error('Registered verifier task definitions unavailable or modified');
      const config=JSON.parse(fs.readFileSync(path.join(envelope.workspace,tasksFile),'utf8'));
      const labels=[envelope.verification.diff_check,...envelope.verification.tests,...envelope.verification.syntax,...(envelope.verification.typecheck||[]),...(envelope.verification.lint||[]),...(envelope.verification.benchmark||[])];
      for(const label of labels){
        if(!label)throw Error('Registered diff-check task is required');
        const registered=config.tasks?.find(t=>t.label===label);
        if(!registered)throw Error('Registered verifier task missing');
        if(label===envelope.verification.diff_check&&(registered.command!=='git'||JSON.stringify(registered.args)!==JSON.stringify(['diff','--check'])))throw Error('Diff check must be exactly git diff --check');
        const result=await call('vscode_run_task',{repo:envelope.workspace,label,timeoutSeconds:60});
        add(`task:${label}`,result.exit_code===0&&!result.timed_out?'passed':'failed',{exit_code:result.exit_code,output:result.output});
      }
      const after=workspaceSnapshot(envelope.workspace);
      add('verification_workspace_stable',after.hash===snapshot.hash?'passed':'failed',{before:snapshot.hash,after:after.hash});snapshot=after;
    }catch(error){add('verification_available','unavailable',{reason:error.message});}
    return{status:checks.some(c=>c.status==='failed')?'failed':checks.some(c=>c.status==='unavailable')?'unavailable':checks.some(c=>c.status==='operator_review')?'operator_review':'passed',checks,workspace_hash:snapshot?.hash||'unavailable'};
  }
  persist(mission,run,result){return transaction(this.store.db,()=>{
    const id=randomUUID();this.store.state(mission.id,['passed','operator_review'].includes(result.status)?'awaiting_acceptance':'needs_rework',`Verification ${result.status}`);
    const current=this.store.getMission(mission.id);
    this.store.db.prepare('INSERT INTO cp_verifications VALUES(?,?,?,?,?,?,?,?,?)').run(id,mission.id,run.id,current.revision,result.workspace_hash,result.status,JSON.stringify(result.checks),'airodrom:host-verifier',Date.now());
    if(this.bridge.authorityRuntime?.active)this.bridge.authorityRuntime.recordVerification(id,current,run,result);
    this.store.event(result.status==='failed'?'verification.failed':'verification.completed',mission.id,{verification_id:id,status:result.status,verifier:'host'},{runId:run.id});
    this.store.event('acceptance.started',mission.id,{verification_id:id});
    this.store.event(result.status==='passed'?'acceptance.passed':result.status==='operator_review'?'acceptance.operator_review':'acceptance.failed',mission.id,{verification_id:id,evaluation_only:true,requires_acceptance:true});
    this.bridge.missions?.program.review(current,run,result,id);
    return id;
  });}
}
module.exports={MissionVerifier};
