'use strict';
const fs=require('node:fs'),path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const {workspaceSnapshot}=require('./control-context');
const {transaction,redactValue}=require('./control-plane-store');
const hash=s=>createHash('sha256').update(s).digest('hex');
const sleep=ms=>new Promise(resolve=>{const timer=setTimeout(resolve,Math.max(0,ms));timer.unref?.();});
function canonical(value){
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function capabilityRequestId(runId,name,input){
  const digest=createHash('sha256').update(canonical([name,input||{}])).digest('hex').slice(0,32);
  return `verify:${runId}:${name}:${digest}`;
}

function capabilityDeadline(mission,input,{now=Date.now(),defaultBudgetMs=60_000}={}){
  const taskMs=Number.isFinite(input?.timeoutSeconds)?Math.max(1_000,Math.floor(input.timeoutSeconds*1000)):defaultBudgetMs;
  // Recovery may outlast the registered task timeout by a short grace window while the
  // same request_id settles; authority and manifest expiry remain hard stops.
  const soft=now+taskMs+Math.min(15_000,Math.max(1_000,Math.floor(taskMs/4)));
  const authority=mission?.envelope?.authority?.expiresAt;
  const manifest=mission?.envelope?.manifest?.expires_at;
  return Math.min(soft,Number.isSafeInteger(authority)?authority:Infinity,Number.isSafeInteger(manifest)?manifest:Infinity,require('./specialist-gateway').enabled(mission)?require('./specialist-gateway').deadline(mission):Infinity);
}

class MissionVerifier {
  constructor(bridge,store,options={}){
    this.bridge=bridge;this.store=store;
    this.recoveryWaitMs=Number.isSafeInteger(options.recoveryWaitMs)&&options.recoveryWaitMs>0?options.recoveryWaitMs:250;
    this.defaultCapabilityBudgetMs=Number.isSafeInteger(options.defaultCapabilityBudgetMs)&&options.defaultCapabilityBudgetMs>0?options.defaultCapabilityBudgetMs:60_000;
  }
  async invokeVerificationCapability(task,mission,run,name,input){
    if(this.bridge.closed)throw Error('Bridge is shutting down');
    const specialist=require('./specialist-gateway'),bounded=specialist.enabled(mission);
    const deadline=capabilityDeadline(mission,input,{defaultBudgetMs:this.defaultCapabilityBudgetMs});
    if(bounded&&name==='vscode_run_task'){
      const seconds=Math.floor((deadline-Date.now())/1000);if(seconds<1)throw Error('gateway_program_runtime_exhausted');
      // Keep the invocation input and replay identity stable across recovery.
      // The existing job cancellation path enforces the shorter graph deadline.
    }
    const requestId=capabilityRequestId(run.id,name,input);
    const current=()=>{if(Date.now()>=deadline)throw Error('gateway_program_runtime_exhausted');if(bounded){const m=this.store.requireMission(mission.id);specialist.assertRoot(this.bridge,m);this.bridge.missions.assertAuthority(m);}};
    const invoke=()=>{if(bounded)current();return this.bridge.invokeCapability(task.id,{name,input,requestId});};
    const watch=bounded?setInterval(()=>{try{current();}catch{for(const job of this.bridge.capabilityHost.jobs.jobs.values())if(job.taskId===task.id)this.bridge.capabilityHost.jobs.cancel(job);}},100):null;
    watch?.unref?.();
    try {
    let response=await invoke();
    let recoveries=0;
    while(response?.status==='pending'){
      if(this.bridge.closed)throw Error('Bridge is shutting down');
      if(task.cancelRequested||task.safetyStop?.latched)throw Error(`Verification capability unavailable: cancelled (${requestId})`);
      const remaining=deadline-Date.now();
      if(!(remaining>0))throw Error(`Verification capability unavailable: pending deadline exceeded (${requestId})`);
      // Prefer the live in-flight promise when present so recovery does not wait another
      // sync budget merely to learn the same execution finished. Still bound the wait by
      // the verification deadline so a stuck capability cannot run forever.
      const live=this.bridge.orchestrator?.inflight?.get(requestId);
      if(live){
        let timedOut=false;
        response=await Promise.race([
          live,
          sleep(remaining).then(()=>{timedOut=true;return {status:'pending',request_id:requestId};})
        ]);
        if(timedOut||Date.now()>=deadline)throw Error(`Verification capability unavailable: pending deadline exceeded (${requestId})`);
        recoveries++;
        continue;
      }
      await sleep(Math.min(this.recoveryWaitMs,remaining));
      response=await invoke();
      recoveries++;
      if(recoveries>240)throw Error(`Verification capability unavailable: pending recovery bound exceeded (${requestId})`);
    }
    if(response?.status!=='completed'){
      const detail=response?.decision?.reason?`: ${response.decision.reason}`:'';
      throw Error(`Verification capability unavailable: ${response?.status||'unknown'}${detail} (${requestId})`);
    }
    if(bounded)current();
    return response.result;
    }finally{if(watch)clearInterval(watch);}
  }
  async verify(mission,run,assignmentCheck=null){
    if(assignmentCheck){
      const a=require('./specialist-gateway').active(this.bridge,mission,run.task_id);
      if(!require('./specialist-gateway').enabled(mission)||a.attempt.run_id!==run.id||canonical(a.assignment)!==canonical(assignmentCheck.assignment)||canonical(a.attempt.baseline)!==canonical(assignmentCheck.baseline))throw Error('gateway_verifier_assignment_binding');
    }
    if(mission.envelope.kind==='conversation')return require('./conversation-mission').verify(this.bridge.missions,mission,run);
    if(mission.envelope.kind==='browser_research')return this.bridge.missions.research.verify(mission,run);
    // Absent/wrong-run native evidence fails before provenance adapters run, so
    // empty fixtures report native_tool_required rather than a runtime-specific miss.
    if (!require('./execution-evidence').runSatisfied(run)) return { status: 'failed', checks: [{ id: 'native_execution', status: 'failed', evidence: { reason: 'native_tool_required' } }], workspace_hash: 'unavailable' };
    try{this.bridge.opencodeAdapter?.assertEvidence(run);this.bridge.workers?.assertEvidence(run);this.bridge.cursorWorker?.assertEvidence(run);this.bridge.missions._web?.verify(mission,run);}catch(error){return{status:'failed',checks:[{id:'runtime_provenance',status:'failed',evidence:{reason:/^cursor_/.test(error?.code||error?.message||'')?'cursor_provenance_unavailable':'opencode_provenance_unavailable'}}],workspace_hash:'unavailable'};}
    const envelope=assignmentCheck?{...mission.envelope,allowed_files:assignmentCheck.assignment.paths,baseline:assignmentCheck.baseline,criteria:[],verification:{diff_check:mission.envelope.verification.diff_check,tests:assignmentCheck.assignment.verification.filter(v=>v!==mission.envelope.verification.diff_check),syntax:[]}}:mission.envelope,checks=[],task=this.bridge.tasks.get(run.task_id);
    const add=(id,status,evidence)=>checks.push({id,status,evidence:redactValue(evidence)});
    const coverageIds=['contract_integrity','verifier_inputs_unchanged','protected_tests_unchanged','security:secret_scan','security:sensitive_area'];
    const noteCoverage=(reason)=>{if(!(envelope.coding_plan||envelope.contract))return;for(const id of coverageIds)if(!checks.some(c=>c.id===id))add(id,'unavailable',{reason,classification:'UNAVAILABLE'});};
    const call=(name,input)=>this.invokeVerificationCapability(task,mission,run,name,input);
    let snapshot=null;
    try {
      snapshot=workspaceSnapshot(envelope.workspace);
      if(envelope.coding_plan&&!envelope.contract){
        add('contract_integrity','failed',{reason:'host_coding_contract_required',classification:'LEGACY_CONTRACTLESS'});
        noteCoverage('host_coding_contract_required');
        return{status:'failed',checks,workspace_hash:snapshot.hash};
      }
      const lease=this.store.db.prepare("SELECT baseline FROM cp_leases WHERE run_id=? AND mode='write'").get(run.id);
      if(!lease)throw Error('Run baseline missing');const baseline=assignmentCheck?assignmentCheck.baseline:JSON.parse(lease.baseline);
      const repairScope=!!envelope.repair_of||!!assignmentCheck;
      const grantBinding={mission,autonomy:this.bridge.developerAutonomy};
      const receipt=baseline.version===2?require('./repository-verification').compare(baseline,snapshot,envelope.allowed_files,[],{creation:envelope.baseline,allowPreDirtyScope:repairScope,...grantBinding}):null;
      if(receipt)add('repository_v2',receipt.status,receipt);
      const changed=[...new Set([...Object.keys(baseline.files),...Object.keys(snapshot.files)])].filter(f=>baseline.files[f]!==snapshot.files[f]);
      const protectedChanged=changed.filter(f=>!envelope.allowed_files.includes(f)||(baseline.dirty.includes(f)&&!repairScope));
      const creation=envelope.baseline;
      if(creation.version===2)add('creation_repository_v2',require('./repository-verification').compare(creation,snapshot,envelope.allowed_files,[],{allowPreDirtyScope:repairScope,...grantBinding}).status,{baseline_hash:creation.hash,identity_and_original_scope_checked:true});
      for(const [file,digest]of Object.entries(creation.files))if(!envelope.allowed_files.includes(file)&&snapshot.files[file]!==digest&&!protectedChanged.includes(file))protectedChanged.push(file);
      add('workspace', 'passed',{exists:true});
      add('protected_files',protectedChanged.length||baseline.head!==snapshot.head?'failed':'passed',{changed:protectedChanged,head_unchanged:baseline.head===snapshot.head});
      const readonly=assignmentCheck?.assignment.operation==='read'||(envelope.cognitive?.envelope.version===3&&envelope.cognitive.proposal.tasks.every(t=>t.operation==='read'));
      const expectedBaseline=assignmentCheck?mission.envelope.baseline:creation;
      add('expected_changes',readonly?!changed.length?'passed':'failed':envelope.allowed_files.some(f=>expectedBaseline.files[f]!==snapshot.files[f])?'passed':'failed',{task_owned_changes:changed.filter(f=>envelope.allowed_files.includes(f)),baseline_hash:baseline.hash,read_only:readonly});
      // ADR 0051: contract integrity and trusted verifier-input baseline. Tampered tests or
      // verification policy fail before any registered task runs; evidence is preserved.
      if(envelope.contract){
        const contracts=require('./mission-contract');
        try{contracts.assertIntact(envelope.contract);add('contract_integrity','passed',{scope_fingerprint:envelope.contract.scope_fingerprint,schema_version:envelope.contract.schema_version});}
        catch(error){add('contract_integrity','failed',{reason:error.message});}
        const vb=require('./verifier-baseline');
        const auditResult=vb.audit(envelope.workspace,envelope.contract.audit?.verifier_baseline,snapshot,{contract:envelope.contract,allowedFiles:envelope.allowed_files});
        add('verifier_inputs_unchanged',auditResult.status,{changed:auditResult.changed.length,tampering:auditResult.tampering.map(t=>({file:t.file,kind:t.kind,classification:t.classification,removed_assertions:t.removed_assertions??null,weakened_negative_checks:t.weakened_negative_checks??null,skips_added:t.skips_added??null})),agent_authored:auditResult.agent_authored.map(a=>a.file),authorized:auditResult.authorized.map(a=>a.file),trusted_source:auditResult.trusted_source,reason:auditResult.reason||null});
        const protectedTests=auditResult.status==='unavailable'?'unavailable':auditResult.tampering.some(t=>/(^|\/)(tests?|__tests__)(\/|$)|\.(test|spec)\./.test(t.file))?'failed':'passed';
        add('protected_tests_unchanged',protectedTests,auditResult.status==='unavailable'?{classification:'UNAVAILABLE',reason:auditResult.reason||'trusted_baseline_unavailable',policy:'Protected-test inspection is not treated as passed when the trusted baseline cannot be read'}:{policy:'verifier-owned tests are immutable to workers; agent-authored tests are never proof'});
      }
      if(checks.some(c=>c.status==='failed')||checks.some(c=>c.id==='verifier_inputs_unchanged'&&c.status==='unavailable')){noteCoverage('verification_stopped');return{status:checks.some(c=>c.status==='failed')?'failed':'unavailable',checks,workspace_hash:snapshot.hash};}
      add('git_status','passed',await call('git_status',{repo:envelope.workspace}));
      add('task_owned_diff','passed',await call('git_diff',{repo:envelope.workspace,paths:envelope.allowed_files,stat:true}));
      for(const criterion of envelope.criteria){
        if(criterion.type==='exact_file'){
          const result=await call('file_hash',{path:path.join(envelope.workspace,criterion.path),algorithm:'sha256'});
          add(criterion.id,result.digest===hash(criterion.content)?'passed':'failed',{path:criterion.path,expected_sha256:hash(criterion.content),actual_sha256:result.digest});
        }else if(criterion.type!=='registered_checks'||envelope.cognitive?.envelope.version!==3)add(criterion.id,'operator_review',{description:criterion.description});
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
      if(envelope.cognitive?.envelope.version===3)for(const criterion of envelope.criteria.filter(c=>c.type==='registered_checks'))add(criterion.id,labels.every(label=>checks.some(c=>c.id==='task:'+label&&c.status==='passed'))?'passed':'failed',{registered_checks:labels});
      if(envelope.contract){
        // Proportional security verification over the files the worker actually changed.
        const changedAllowed=changed.filter(f=>envelope.allowed_files.includes(f));
        for(const check of require('./verifier-baseline').securityScan(envelope.workspace,changedAllowed,{contract:envelope.contract,baselineRecord:envelope.contract.audit?.verifier_baseline}))add(check.id,check.status,check.evidence);
      }
      const after=workspaceSnapshot(envelope.workspace);
      add('verification_workspace_stable',after.hash===snapshot.hash?'passed':'failed',{before:snapshot.hash,after:after.hash});snapshot=after;
    }catch(error){add('verification_available','unavailable',{reason:error.message});noteCoverage(error.message);}
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
module.exports={MissionVerifier,capabilityRequestId,capabilityDeadline};
