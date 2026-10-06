'use strict';
const {randomUUID,createHash}=require('node:crypto');
const {secretLike,CLASSES}=require('./provider-policy');
const {safeValue}=require('./secret-observation');
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
// Operator-owned, immutable inference policy. No context reference is dereferenced.
function policy(value) {
  if(!value||Object.keys(value).some(k=>!['providers','data_class','privacy','purpose','max_output'].includes(k))||
    !Array.isArray(value.providers)||!value.providers.length||value.providers.length>8||
    value.providers.some(p=>!['ollama','anthropic_subscription','codex_openai','deepseek','openai_compatible'].includes(p))||
    !CLASSES.has(value.data_class)||value.data_class==='credentials'||
    !['local_only','approved_external'].includes(value.privacy)||
    !['planning','summary','synthetic_probe'].includes(value.purpose)||
    !Number.isInteger(value.max_output)||value.max_output<1||value.max_output>8192)throw Error('Invalid host reasoning policy');
  if(!['public','internal'].includes(value.data_class)&&value.privacy!=='local_only')throw Error('Sensitive context requires local-only policy');
  return structuredClone(value);
}
class HostReasoningAdmission {
  constructor(bridge,{now=Date.now}={}) {
    this.bridge=bridge;this.db=bridge.memory.db;this.now=now;this.active=new Map();
    this.db.exec(`CREATE TABLE IF NOT EXISTS host_reasoning_admissions(
      id TEXT PRIMARY KEY,task_id TEXT NOT NULL,mission_id TEXT NOT NULL,run_id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL,request_id TEXT NOT NULL,request_hash TEXT NOT NULL,record TEXT NOT NULL,
      expires_at INTEGER NOT NULL,state TEXT NOT NULL,UNIQUE(task_id,request_id));`);
    this.db.prepare("UPDATE host_reasoning_admissions SET state='interrupted' WHERE state IN ('granted','consumed')").run();
  }
  views(limit=100){require('./memory-content-erasure').assertReadable(this.db);return this.db.prepare('SELECT id,task_id,mission_id,run_id,session_id,request_id,record,expires_at,state FROM host_reasoning_admissions ORDER BY rowid DESC LIMIT ?').all(limit).map(r=>({...r,record:JSON.parse(r.record),execution_authority:false,accepted:false}));}
  event(task,kind,metadata){this.bridge._ledgerRecord({...this.bridge._ledgerContext(task),eventType:'reasoning.host.'+kind,agent:'bridge',direction:'internal',status:kind,metadata:safeValue({...metadata,execution_authority:false,accepted:false})},{critical:true});}
  authorize(input) {
    const a=this.active.get(input.run_id),b=this.bridge;if(!a)return false;
    const {task,lease,id}=a,r=this.db.prepare('SELECT * FROM host_reasoning_admissions WHERE id=?').get(id);
    if(!r||r.state!=='granted'||r.expires_at<=this.now()||r.request_hash!==hash(input)||
      r.task_id!==task.id||r.mission_id!==task.mission.id||r.session_id!==task.sessionId||r.request_id!==input.request_id||
      r.run_id!==input.run_id||b.tasks.get(task.id)!==task||b.leases.get(task.id)!==lease||lease.aborted||
      task.activeRunId!==input.run_id||task.reasoningMode!=='reasoning_only'||task.capabilityScopes.length||
      task.mission.requireGrant||task.cancelRequested||task.safetyStop?.latched||hash(task.reasoningGatewayPolicy)!==a.policyHash)return false;
    return this.db.prepare("UPDATE host_reasoning_admissions SET state='consumed' WHERE id=? AND state='granted'").run(id).changes===1;
  }
  async run(task,message,{recovery=false,timeoutMs=120000}={}) {
    const b=this.bridge,p=policy(task.reasoningGatewayPolicy);
    if(b.closed||b.leases.size||recovery||task.cancelRequested||task.safetyStop?.latched||task.continuationRequired||
      ['cancelled','paused'].includes(task.status)||['cancelled','paused'].includes(task.mission.status)||
      task.reasoningMode!=='reasoning_only'||task.capabilityScopes.length||task.mission.requireGrant||task.includeSharedMemory||
      typeof message!=='string'||!message.trim()||Buffer.byteLength(message)>59000||secretLike(message))throw Error('Host reasoning admission denied');
    const remaining=task.mission.budget.maxRuntimeMs-task.mission.used.runtimeMs;
    if(remaining<=0)throw Error('Host reasoning runtime budget exhausted');
    const lease=b.leases.acquire(task.id,{agentId:'reasoning_provider'}),started=this.now();let timer,id;
    task.activeRunId=lease.runId;task.status='running';task.startedAt=started;task.mission.status='active';task.mission.started=true;
    try {
      if(!task.latestMcpRequestId&&task.reasoningContext?.hash===hash([{role:'user',content:message}]))throw Error('Reasoning request replay denied');
      const requestId=task.latestMcpRequestId||randomUUID(),expires=this.now()+Math.min(timeoutMs,remaining,120000);
      const input={run_id:lease.runId,request_id:requestId,messages:[{role:'user',content:message}],selected_agent:'reasoning_provider',
        allowed_providers:p.providers,data_class:p.data_class,privacy:p.privacy==='local_only'?'local_only':'project_policy',
        project_policy:{approved_external:{[p.data_class]:p.privacy==='approved_external'?p.providers:[]}},requirements:['chat'],max_output:p.max_output,cost_preference:'low'};
      id=randomUUID();const context={refs:[{id:randomUUID(),reason:'explicit_task_request'}],hash:hash(input.messages),bytes:Buffer.byteLength(message),memory_included:false,project_included:false,secret_scan:'passed'};
      const record={mode:'reasoning_only',purpose:p.purpose,policy:p,context_pack:context,verification:'unverified',acceptance:'not_accepted'};
      this.db.prepare('INSERT INTO host_reasoning_admissions VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,task.id,task.mission.id,lease.runId,task.sessionId,requestId,hash(input),JSON.stringify(record),expires,'granted');
      this.active.set(lease.runId,{task,lease,id,policyHash:hash(p)});task.reasoningAdmissionId=id;task.reasoningContext=context;
      this.event(task,'granted',{admission_id:id,...record});b.tasks.save(task);b.leases.setPhase(lease,'running');
      timer=setTimeout(()=>lease.controller.abort(),Math.max(1,expires-this.now()));
      const probe=task.reasoningProbe==='ollama_unavailable'&&p.data_class==='public'&&p.purpose==='synthetic_probe'?'ollama_unavailable':null;
      const outcome=await b.providerGateway.execute(input,{signal:lease.controller.signal,probe});
      if(lease.aborted||task.cancelRequested)throw Error('Reasoning cancelled');
      // Unsolicited tools are rejected by the adapter. Canonical requests must also pass the broker.
      for(const request of outcome.tool_requests||[]){const decision=await b.capabilityBroker.execute(task.id,request);if(decision.allow)throw Error('Reasoning tool boundary violated');}
      task.reasoningResult={status:outcome.status,error_class:outcome.error_class||null,tool_state:outcome.tool_requests?.length?'tool_not_authorized':'none',verification:'unverified',accepted:false};
      task.providerRouting=b.providerGateway.routes({run_id:lease.runId,limit:1})[0]||null;
      if(outcome.status==='completed'){task.lastResult=outcome.text;task.status='idle';task.failureKind=null;task.error=null;}
      else {task.status=outcome.status==='waiting'?'waiting_for_provider':'failed';task.failureKind=outcome.error_class||outcome.wait_reason;task.providerWait=outcome.status==='waiting'?{reason:outcome.wait_reason}:null;}
      this.event(task,'settled',{admission_id:id,result:task.reasoningResult,route:task.providerRouting});
      return safeValue(outcome);
    }catch(error){task.status='failed';task.failureKind='reasoning_admission_denied';task.error='Host reasoning admission failed';throw Error(task.error);}
    finally{clearTimeout(timer);this.active.delete(lease.runId);if(id)this.db.prepare("UPDATE host_reasoning_admissions SET state='settled' WHERE id=? AND state IN ('granted','consumed')").run(id);b.leases.releaseIfOwner(lease,{verified:true});delete task.activeRunId;task.mission.used.runtimeMs+=Math.max(0,this.now()-started);b.tasks.save(task);b.emit('change');}
  }
}
module.exports={HostReasoningAdmission,policy};
