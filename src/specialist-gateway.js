'use strict';
// ADR 0059. Typed assignment handling inside the existing Mission Program scheduler.
// No new scheduler, authority store, transport, or autonomous model session.
const { randomUUID } = require('node:crypto');
const { canonicalHash: hash } = require('./authority-hash');
const { transaction } = require('./control-transaction');
const { workspaceSnapshot } = require('./control-context');
const C = require('./cognitive-contracts');
const fail = C.fail;
const KIND = 'cognitive_specialists_v1';
function enabled(m) { return m?.envelope?.cognitive?.envelope.version === 3; }
function deadline(m) {const c=m.envelope.contract;return Math.min(m.envelope.cognitive.envelope.expires_at,c.identity.expires_at,c.identity.created_at+c.budget.max_wall_clock_ms,m.created_at+c.budget.max_wall_clock_ms);}
function assignments(m) {
  const c = m.envelope.cognitive, ordered = [], seen = new Set();
  const visit = t => { if (seen.has(t.id)) return; t.depends_on.forEach(id => visit(c.proposal.tasks.find(x => x.id === id))); seen.add(t.id); ordered.push(t); };
  c.proposal.tasks.forEach(visit);
  return ordered.map(t => ({ version: 1, parent_mission_id: m.id, sealed_contract_hash: c.sealed.hash,
    id: t.id, worker: t.worker, role: t.role, operation: t.operation, paths: [...t.paths].sort(),
    description: t.description, depends_on: t.depends_on, verification: t.verification,
    workspace_id: c.envelope.workspace_id, repository_id: c.envelope.repository_id,
    runtime_ms: c.envelope.limits.execution_ms, max_invocations: 1, repair_ceiling: c.envelope.limits.repair_attempts,
    idempotency_key: 'assignment:' + m.id + ':' + t.id }));
}
function program(bridge, m) {
  const row = bridge.controlStore.db.prepare('SELECT * FROM cp_mission_programs WHERE id=?').get(m.id);
  if (!row) fail('gateway_graph_missing');
  const graph = JSON.parse(row.graph), expected = { kind: KIND, parent_mission_id: m.id, sealed_contract_hash: m.envelope.cognitive.sealed.hash, assignments: assignments(m) };
  if (hash(graph) !== hash(expected) || row.fingerprint !== hash(expected)) fail('gateway_graph_changed');
  return { ...row, graph };
}
function nodes(bridge, m) {
  const p = program(bridge, m), db = bridge.controlStore.db;
  return p.graph.assignments.map(a => {
    const row = db.prepare('SELECT * FROM cp_mission_program_nodes WHERE program_id=? AND node_id=?').get(m.id, a.id);
    if (!row) fail('gateway_assignment_missing');
    const record = JSON.parse(row.input);
    if (hash(record.assignment) !== hash(a) || !Array.isArray(record.attempts)) fail('gateway_assignment_changed');
    return { ...row, ...record };
  });
}
function save(bridge, m, node, state = node.state) {
  bridge.controlStore.db.prepare('UPDATE cp_mission_program_nodes SET input=?,state=? WHERE program_id=? AND node_id=?')
    .run(JSON.stringify({ assignment: node.assignment, attempts: node.attempts }), state, m.id, node.node_id);
}
function attempts(bridge, m) { return nodes(bridge, m).flatMap(n => n.attempts.map(a => ({ ...a, assignment_id: n.node_id }))).sort((a,b) => a.ordinal - b.ordinal); }
function repairCount(bridge, m) { return enabled(m) ? attempts(bridge,m).filter(a => a.repair).length : 0; }
function register(service, m) {
  if (!enabled(m)) return;
  const graph = { kind: KIND, parent_mission_id: m.id, sealed_contract_hash: m.envelope.cognitive.sealed.hash, assignments: assignments(m) };
  const now = service.store.now();
  service.db.prepare('INSERT INTO cp_mission_programs(id,owner,graph,fingerprint,state,started_at,expires_at,request_id) VALUES(?,?,?,?,?,?,?,?)')
    .run(m.id, m.owner, JSON.stringify(graph), hash(graph), 'prepared', now, m.envelope.cognitive.envelope.expires_at, 'specialists:' + m.id);
  for (const a of graph.assignments) service.db.prepare('INSERT INTO cp_mission_program_nodes(program_id,node_id,mission_id,input,state,record_id) VALUES(?,?,NULL,?,?,?)')
    .run(m.id, a.id, JSON.stringify({ assignment: a, attempts: [] }), 'pending', randomUUID());
  service.store.event('gateway.assignments.sealed', m.id, { assignments: graph.assignments.map(a => ({ id:a.id, worker:a.worker, role:a.role })), concurrency:1, authority:false });
}
function assertRoot(bridge, m) {
  if (!enabled(m)) fail('gateway_assignment_version_required');
  require('./cognitive-router').assertBound(bridge,m);
  const e = m.envelope, c = e.cognitive;
  const expectedWorkers = [...new Set(c.proposal.tasks.map(t => t.worker))].sort();
  if (hash([...e.contract.execution.worker_allowlist].sort()) !== hash(expectedWorkers) ||
      e.contract.budget.max_worker_invocations !== c.proposal.tasks.length + c.envelope.limits.repair_attempts ||
      c.proposal.tasks.some(t => !['cursor','opencode'].includes(t.worker))) fail('gateway_worker_authority_changed');
  if (['cancelled','completed','blocked','needs_rework'].includes(m.state)) fail('gateway_parent_stopped');
  const p=program(bridge,m);
  if (!['prepared','running','waiting_acceptance'].includes(p.state) || bridge.controlStore.now() >= Math.min(p.expires_at,deadline(m))) fail('gateway_program_stopped');
}
function active(bridge, m, taskId = m.task_id) {
  const matches = nodes(bridge,m).flatMap(n => n.attempts.filter(a => a.task_id === taskId).map(a => ({ node:n, attempt:a, assignment:n.assignment })));
  if (matches.length !== 1) fail('gateway_assignment_task_binding');
  return matches[0];
}
function adapterScope(bridge, task, worker) {
  const m = bridge.controlStore.requireMission(task.controlPlaneMissionId);
  if (!enabled(m)) return null;
  assertRoot(bridge,m);
  const { node, attempt, assignment } = active(bridge,m,task.id);
  const dispatch = bridge.controlStore.db.prepare('SELECT * FROM cp_dispatches WHERE id=?').get(attempt.dispatch_id);
  if (m.task_id !== task.id || assignment.worker !== worker || !['queued','running'].includes(node.state) ||
      !dispatch || dispatch.task_id !== task.id || dispatch.mission_id !== m.id || !['queued','dispatching','running'].includes(dispatch.state) ||
      hash(task.gateway_assignment || null) !== hash({ id:assignment.id, assignment_hash:hash(assignment), ordinal:attempt.ordinal })) fail('gateway_assignment_dispatch_binding');
  validateHistory(bridge,m,attempt.ordinal-1);
  return { assignment, attempt, files: assignment.paths, writable: assignment.operation === 'edit' ? assignment.paths : [],
    deadline: Math.min(deadline(m), attempt.created_at + assignment.runtime_ms) };
}
function baseline(bridge, m, taskId) { return enabled(m) ? active(bridge,m,taskId).attempt.baseline : m.envelope.baseline; }
function assertFresh(bridge,m,taskId) {
  if (!enabled(m)) return;
  assertRoot(bridge,m);
  const a = active(bridge,m,taskId).attempt;
  if (workspaceSnapshot(m.envelope.workspace).hash !== a.baseline.hash ||
      require('./cognitive-integrity').capture(m.envelope.workspace,m.envelope.allowed_files).integrity.hash !== a.integrity_hash) fail('gateway_assignment_workspace_changed');
}
function queue(service, m) {
  const b=service.bridge,db=service.db;
  assertRoot(b,m); service.assertAuthority(m);
  if (!['ready','running'].includes(m.state)) fail('gateway_assignment_state');
  if (db.prepare("SELECT 1 FROM cp_dispatches WHERE mission_id=? AND state IN ('queued','dispatching','running','unknown')").get(m.id)) fail('gateway_assignment_active_or_uncertain');
  if (db.prepare("SELECT 1 FROM cp_leases WHERE resource=? AND state IN ('held','quarantined')").get(m.envelope.workspace)) fail('gateway_assignment_lease');
  const all=nodes(b,m), history=attempts(b,m), next=all.find(n => n.state === 'pending' && n.assignment.depends_on.every(id => all.find(x=>x.node_id===id)?.state==='ready'));
  if (!next) fail('gateway_assignment_dependency');
  if (all.some(n=>['queued','running','evaluating','failed','unavailable'].includes(n.state))) fail('gateway_assignment_active_or_uncertain');
  const repair=next.attempts.length>0;
  if (history.length >= m.envelope.contract.budget.max_worker_invocations || (repair && repairCount(b,m)>=m.envelope.cognitive.envelope.limits.repair_attempts)) fail('gateway_assignment_budget_exhausted');
  const snap=workspaceSnapshot(m.envelope.workspace), last=history.at(-1);
  if (snap.hash !== (last?.verification?.workspace_hash || m.envelope.baseline.hash)) fail('gateway_assignment_workspace_changed');
  if (last) validateHistory(b,m);
  if (!last) require('./cognitive-integrity').assertCurrent(m.envelope.workspace,m.envelope.cognitive.envelope,m.envelope.cognitive.workspace_identity);
  const task=history.length ? service.newTask(m.id,m.project_id,{...m.envelope,preferred_agent:next.assignment.worker},m.owner,history.length+1) : b.tasks.get(m.task_id);
  task.gateway_assignment={id:next.node_id,assignment_hash:hash(next.assignment),ordinal:history.length+1}; b.tasks.save(task);
  if (history.length) db.prepare('INSERT INTO cp_mission_tasks VALUES(?,?,?,NULL,NULL,?)').run(task.id,m.id,history.length+1,service.store.now());
  const dispatchId=randomUUID();
  db.prepare("INSERT INTO cp_dispatches VALUES(?,?,?,'queued',NULL,NULL,NULL,?,?)").run(dispatchId,m.id,task.id,service.store.now(),service.store.now());
  db.prepare('UPDATE cp_mission_tasks SET dispatch_id=? WHERE task_id=?').run(dispatchId,task.id);
  db.prepare('UPDATE cp_missions SET task_id=? WHERE id=?').run(task.id,m.id);
  if (b.authorityRuntime?.active) db.prepare('UPDATE authority_missions SET task_id=? WHERE id=?').run(task.id,m.id);
  next.attempts.push({ordinal:history.length+1,task_id:task.id,dispatch_id:dispatchId,run_id:null,created_at:service.store.now(),repair,
    baseline:snap,integrity_hash:require('./cognitive-integrity').capture(m.envelope.workspace,m.envelope.allowed_files).integrity.hash,
    previous_evaluation:last?.evaluation_run_id||null});
  save(b,m,next,'queued'); db.prepare("UPDATE cp_mission_programs SET state='running' WHERE id=?").run(m.id);
  if (m.state==='ready') service.store.state(m.id,'dispatching');
  service.store.event('gateway.assignment.queued',m.id,{assignment_id:next.node_id,worker:next.assignment.worker,role:next.assignment.role,attempt:history.length+1,repair,authority:false});
  return {mission_id:m.id,task_id:task.id,dispatch_id:dispatchId,status:'queued'};
}
async function select(service,m,dispatch) {
  const scope=adapterScope(service.bridge,service.bridge.tasks.get(dispatch.task_id),active(service.bridge,m,dispatch.task_id).assignment.worker);
  const observations=await service.agents.refresh({boundedOnly:true}),worker=scope.assignment.worker,o=observations[worker];
  if (!o?.available || worker==='cursor'&&!o.governed_worker) fail('cognitive_worker_unqualified:'+worker);
  if(service.bridge.authorityRuntime?.routing){const route=await service.bridge.authorityRuntime.route(m,observations);if(route.selected!==worker)fail('gateway_assignment_governed_route_unavailable');return{...route,assignment_id:scope.assignment.id,assignment_hash:hash(scope.assignment)};}
  return {selected:worker,selected_agent:worker,transport:worker==='cursor'?'sandboxed_headless_cli':'confined_local_cli',reason:'sealed_specialist_assignment',assignment_id:scope.assignment.id,assignment_hash:hash(scope.assignment),authority:false};
}
function started(bridge,m,taskId,runId) {
  if (!enabled(m)) return;
  const a=active(bridge,m,taskId); a.attempt.run_id=runId; save(bridge,m,a.node,'running');
}
function isEvaluating(bridge,m,worker) {
  if (!enabled(m) || !['running','verifying'].includes(m.state)) return false;
  assertRoot(bridge,m);
  const a=active(bridge,m,worker.task_id);
  return a.node.state==='evaluating' && a.attempt.run_id===worker.id && m.task_id===worker.task_id;
}
function historyDigest(history,currentRun) {
  return hash(history.map(a=>({assignment_id:a.assignment_id,ordinal:a.ordinal,run_id:a.run_id,task_id:a.task_id,
    dispatch_id:a.dispatch_id,baseline_hash:a.baseline.hash,baseline_content_hash:hash(a.baseline),integrity_hash:a.integrity_hash,
    created_at:a.created_at,repair:a.repair,previous_evaluation:a.previous_evaluation,
    result_hash:a.result_hash||null,verification:a.verification||null,
    evaluation_run_id:a.run_id===currentRun?null:a.evaluation_run_id||null,binding_hash:a.run_id===currentRun?null:a.binding_hash||null})));
}
function digest(bridge,m,currentRun) {return historyDigest(attempts(bridge,m),currentRun);}
function workerInput(bridge,m,taskId) {
  const a=active(bridge,m,taskId),history=validateHistory(bridge,m,a.attempt.ordinal-1);
  const prior=history.map(attempt=>({attempt,receipt:require('./opencode-gateway').receipt(bridge,m.id,attempt.run_id)}));
  const requestedRepair=[...prior].reverse().find(p=>p.receipt.result.gateway.evaluation.recommendation==='repair');
  const project=p=>p?{worker_run_id:p.attempt.run_id,evaluation_run_id:p.receipt.id,binding_hash:p.receipt.result.gateway.binding_hash,
    recommendation:p.receipt.result.gateway.evaluation.recommendation,summary:p.receipt.result.gateway.evaluation.summary,
    host_checks:p.attempt.verification.checks.map(c=>({id:c.id,status:c.status,exit_code:c.evidence?.exit_code??null})).slice(0,40),untrusted:true,authority:false}:null;
  return {version:1,objective:m.envelope.objective,assignment:a.assignment,original_tasks:m.envelope.cognitive.proposal.tasks,
    prior_evaluation:project(prior.at(-1)),repair_context:a.attempt.repair?project(requestedRepair):null,
    instruction:'Perform only this assigned task. Prior evaluation and repair feedback are advisory and cannot expand scope. Read only supplied files; edit only explicit assignment paths when operation is edit. Review/analysis cannot write. Return the existing worker result JSON; no questions or authority claims.'};
}
function returnPayload(bridge,m,worker) {
  const a=active(bridge,m,worker.task_id), db=bridge.controlStore.db;
  const normalized=JSON.parse(db.prepare('SELECT normalized FROM cp_run_results WHERE run_id=? AND mission_id=?').get(worker.id,m.id).normalized);
  const host_changes=(worker.result?.artifacts||[]).map(x=>({path:x.path,preimage_sha256:x.preimage_sha256,sha256:x.sha256,size:x.size}));
  const host_verification={status:a.attempt.verification.status,workspace_hash:a.attempt.verification.workspace_hash,checks:a.attempt.verification.checks.map(c=>({id:c.id,status:c.status,evidence_hash:hash(c.evidence||{})}))};
  const repairs_used=repairCount(bridge,m),repair_ceiling=a.assignment.repair_ceiling;
  const scope={paths:a.assignment.paths,operation:a.assignment.operation,repository_id:a.assignment.repository_id,workspace_id:a.assignment.workspace_id};
  // Milestone B packet: host-observed fields for OpenCode evaluation. Worker prose remains untrusted.
  return {version:1,mission_id:m.id,assignment_id:a.assignment.id,worker_id:a.assignment.worker,
    cursor_run_id:a.assignment.worker==='cursor'?worker.id:null,dispatch_id:a.attempt.dispatch_id,
    authorized_scope_hash:hash(scope),workspace_identity:{workspace_id:a.assignment.workspace_id,repository_id:a.assignment.repository_id},
    changed_files:host_changes.map(x=>x.path),before_hashes:Object.fromEntries(host_changes.map(x=>[x.path,x.preimage_sha256||null])),
    after_hashes:Object.fromEntries(host_changes.map(x=>[x.path,x.sha256||null])),
    diff_summary:{changed:host_changes.length,paths:host_changes.map(x=>x.path)},
    test_results:(normalized.tests||[]).slice(0,20),execution_status:worker.state,
    termination_status:{verified:worker.termination_verified===1,process_state:worker.process_state||null},
    verification_results:host_verification,errors:(normalized.limitations||[]).slice(0,20),
    remaining_repair_budget:Math.max(0,repair_ceiling-repairs_used),
    assignment:a.assignment,attempt:a.attempt.ordinal,run_id:worker.id,state:worker.state,termination_verified:worker.termination_verified===1,
    host_changes,host_verification,
    worker_claims:{tests:(normalized.tests||[]).slice(0,20),limitations:(normalized.limitations||[]).slice(0,20),untrusted:true},
    accounting:{class:m.envelope.contract.budget.spend_observability,observed_cost:null,
      invocations:db.prepare('SELECT count(*) n FROM cp_subscription_invocations WHERE mission_id=?').get(m.id).n},
    references:['mission:'+m.id,'run:'+worker.id,'dispatch:'+a.attempt.dispatch_id],
    prior_results:attempts(bridge,m).filter(x=>x.run_id!==worker.id).map(x=>({assignment_id:x.assignment_id,run_id:x.run_id,result_hash:x.result_hash,evaluation_run_id:x.evaluation_run_id,binding_hash:x.binding_hash})),authority:false};
}
function lifecycleView(bridge,m) {
  const p=program(bridge,m),ns=nodes(bridge,m);
  const active=ns.find(n=>['queued','running','evaluating'].includes(n.state))||null;
  const planningDone=!!m.envelope?.cognitive?.proposal;
  const anyReturned=ns.some(n=>n.attempts.some(a=>a.evaluation_run_id));
  const evaluating=!!active&&active.state==='evaluating';
  const executing=!!active&&['queued','running'].includes(active.state);
  const settled=p.state==='settled'||m.state==='completed';
  const blocked=['blocked','needs_rework','cancelled'].includes(m.state)||['blocked','needs_rework','cancelled'].includes(p.state);
  const verifying=m.state==='verifying';
  const current=settled?'settled':blocked?(p.state==='needs_rework'||m.state==='needs_rework'?'needs_rework':p.state==='cancelled'||m.state==='cancelled'?'cancelled':'blocked'):verifying?'verifying':evaluating?'evaluating':executing?'executing':'planning';
  const worker=active?.assignment?.worker||ns.find(n=>n.assignment.worker==='cursor')?.assignment?.worker||'opencode';
  const workerLabel=worker==='cursor'?'Cursor':worker==='opencode'?'OpenCode':String(worker);
  const stageDone=(id)=>id==='planning'?planningDone:id==='executing'?anyReturned||evaluating||verifying||settled||(active&&['ready','failed'].includes(active.state)):id==='evaluating'?anyReturned&&!evaluating&&(verifying||settled||blocked||['ready','failed','unavailable'].includes(active?.state)):id==='verifying'?settled||['awaiting_acceptance','completed'].includes(m.state):settled;
  return {current,stages:[
    {id:'planning',label:'Planning — OpenCode',state:planningDone?(current==='planning'?'live':'done'):'pending'},
    {id:'executing',label:'Executing — '+workerLabel,state:current==='executing'?'live':(stageDone('executing')?'done':'pending')},
    {id:'evaluating',label:'Evaluating — OpenCode',state:current==='evaluating'?'live':(stageDone('evaluating')?'done':'pending')},
    {id:'verifying',label:'Verifying — Airodrom',state:current==='verifying'?'live':(stageDone('verifying')?'done':'pending')},
    {id:'settled',label:'Settled',state:settled?'done':(blocked?current:'pending')},
  ]};
}
function inspect(bridge,m) {
  const p=program(bridge,m);
  return {version:1,parent_mission_id:m.id,state:p.state,concurrency:1,repair_attempts:repairCount(bridge,m),
    assignments:nodes(bridge,m).map(n=>({id:n.node_id,worker:n.assignment.worker,role:n.assignment.role,paths:n.assignment.paths,operation:n.assignment.operation,depends_on:n.assignment.depends_on,state:n.state,
      attempts:n.attempts.map(a=>({ordinal:a.ordinal,task_id:a.task_id,dispatch_id:a.dispatch_id,run_id:a.run_id,repair:a.repair,result_hash:a.result_hash||null,evaluation_run_id:a.evaluation_run_id||null,binding_hash:a.binding_hash||null,verification:a.verification?{status:a.verification.status,workspace_hash:a.verification.workspace_hash}:null}))})),
    lifecycle:lifecycleView(bridge,m),authority:false};
}
function tick(service,p) {
  const m=service.store.getMission(p.id); if (!enabled(m)) fail('gateway_graph_parent_missing');
  if (['cancelled','completed','blocked','needs_rework'].includes(m.state)) { service.db.prepare('UPDATE cp_mission_programs SET state=? WHERE id=?').run(m.state==='completed'?'settled':m.state,p.id); return; }
  const ns=nodes(service.bridge,m);
  if (ns.some(n=>['queued','running','evaluating'].includes(n.state))) return;
  if (ns.every(n=>n.state==='ready')) return;
  try { queue(service,m); } catch(error) {
    service.db.prepare("UPDATE cp_mission_programs SET state='blocked' WHERE id=?").run(m.id);
    if (!['blocked','cancelled'].includes(service.store.getMission(m.id).state)) service.store.state(m.id,'blocked',String(error.code||error.message).slice(0,200));
  }
}
function validateHistory(bridge,m,through=Infinity) {
  const G=require('./opencode-gateway'),all=nodes(bridge,m),history=attempts(bridge,m).filter(a=>a.ordinal<=through),db=bridge.controlStore.db;
  const unique=new Set(),seen=new Set();let previous=null;
  if(history.length>m.envelope.contract.budget.max_worker_invocations||repairCount(bridge,m)>m.envelope.cognitive.envelope.limits.repair_attempts)fail('gateway_assignment_budget_exhausted');
  for(const [index,a] of history.entries()){
    const assignment=all.find(n=>n.node_id===a.assignment_id).assignment;
    const run=bridge.controlStore.run(a.run_id),row=db.prepare('SELECT normalized FROM cp_run_results WHERE run_id=? AND mission_id=?').get(a.run_id,m.id);
    const dispatch=db.prepare('SELECT * FROM cp_dispatches WHERE id=?').get(a.dispatch_id);
    const task=bridge.tasks.get(a.task_id),evaluation=G.receipt(bridge,m.id,a.run_id),g=evaluation?.result?.gateway;
    const ids=[a.run_id,a.task_id,a.dispatch_id];
    if(a.ordinal!==index+1||ids.some(id=>!id||unique.has(id))||a.repair!==seen.has(a.assignment_id)||
       a.previous_evaluation!==(previous?.evaluation_run_id||null)||
       a.baseline.hash!==(previous?.verification?.workspace_hash||m.envelope.baseline.hash)||
       (!previous&&hash(a.baseline)!==hash(m.envelope.baseline))||
       !dispatch||dispatch.mission_id!==m.id||dispatch.task_id!==a.task_id||dispatch.run_id!==a.run_id||dispatch.state!=='settled'||
       hash(task?.gateway_assignment||null)!==hash({id:a.assignment_id,assignment_hash:hash(assignment),ordinal:a.ordinal})||
       !run||run.mission_id!==m.id||run.task_id!==a.task_id||run.agent_id!==assignment.worker||run.state!=='completed'||!run.termination_verified||
       !row||hash(JSON.parse(row.normalized))!==a.result_hash||
       !g||evaluation.id!==a.evaluation_run_id||evaluation.state!=='completed'||!evaluation.termination_verified||g.binding_hash!==a.binding_hash||
       g.worker_run_id!==a.run_id||g.binding.mission_id!==m.id||g.binding.worker_run_id!==a.run_id||g.binding.contract_hash!==m.envelope.cognitive.sealed.hash||
       g.binding.assignment_hash!==hash(assignment)||g.binding.assignment_baseline!==a.baseline.hash||g.binding.result_hash!==a.result_hash||
       g.binding.verification_hash!==G.verificationDigest(a.verification)||g.binding.workspace_hash!==a.verification.workspace_hash||
       g.binding.assignments_hash!==historyDigest(history.slice(0,index+1),a.run_id)||
       hash(g.binding)!==a.binding_hash||hash(g.evaluation)!==g.evaluation_hash||g.evaluation.binding_hash!==g.binding_hash||
       !['ready','repair'].includes(g.evaluation.recommendation))fail('gateway_assignment_evidence_changed');
    ids.forEach(id=>unique.add(id));seen.add(a.assignment_id);previous=a;
    bridge.opencodeAdapter.assertEvidence(run);bridge.cursorWorker.assertEvidence(run);
  }
  return history;
}
function assertReceipts(bridge,m,finalRun) {
  assertRoot(bridge,m);
  const all=nodes(bridge,m),history=validateHistory(bridge,m);
  if(!all.every(n=>n.state==='ready'&&n.attempts.length&&require('./opencode-gateway').receipt(bridge,m.id,n.attempts.at(-1).run_id)?.result.gateway.evaluation.recommendation==='ready'))fail('gateway_assignments_incomplete');
  if(history.at(-1)?.run_id!==finalRun)fail('gateway_final_run_changed');
}
function finishResult(service,run) {
  service.db.prepare('UPDATE cp_run_results SET processed_at=? WHERE run_id=? AND processed_at=0').run(service.store.now(),run.id);
}
function planRepair(service,m,current,evaluation) {
  const b=service.bridge,all=nodes(b,m),requested=evaluation.evaluation.repair_assignment;
  // The evaluator can name only an existing sealed edit assignment. The host
  // computes the affected suffix and all repeated invocations consume repairs.
  const target=requested?all.find(n=>n.node_id===requested):all.find(n=>n.node_id===current.node_id&&n.assignment.operation==='edit');
  if(!target||target.assignment.operation!=='edit'||!target.attempts.length)return false;
  const index=all.findIndex(n=>n.node_id===target.node_id);
  const repeat=all.slice(index).filter(n=>n.attempts.length);
  const remaining=m.envelope.cognitive.envelope.limits.repair_attempts-repairCount(b,m);
  if(repeat.length>remaining||!repeat.length)return false;
  transaction(service.db,()=>{
    for(const n of repeat)save(b,m,n,'pending');
    const latest=service.store.requireMission(m.id);
    if(latest.state==='verifying'){
      service.store.state(m.id,'needs_rework','Bounded specialist repair under current policy');
      service.store.state(m.id,'ready','Bounded specialist repair');
    }
    service.db.prepare("UPDATE cp_mission_programs SET state='running' WHERE id=?").run(m.id);
    service.store.event('gateway.repair.queued',m.id,{assignment_id:target.node_id,repeated_assignments:repeat.map(n=>n.node_id),authority:false});
  });
  return true;
}
async function processResult(service,row) {
  const b=service.bridge,store=service.store,db=service.db,m=store.requireMission(row.mission_id),run=store.run(row.run_id),result=JSON.parse(row.normalized);
  if(!enabled(m))return false;
  const a=active(b,m,run?.task_id);
  if(a.attempt.run_id!==run?.id||!run.termination_verified)fail('gateway_result_assignment_mismatch');
  if(['cancelled','blocked','completed'].includes(m.state)){finishResult(service,run);return true;}
  if(a.attempt.evaluation_run_id&&['ready','pending'].includes(a.node.state)){
    finishResult(service,run);service.schedule();return true;
  }
  if(m.task_id!==run.task_id||!['running','evaluating'].includes(a.node.state))fail('gateway_result_assignment_mismatch');
  db.prepare("UPDATE cp_dispatches SET state='settled' WHERE id=? AND run_id=?").run(a.attempt.dispatch_id,run.id);
  if(result.status!=='completed'||result.questions?.length){save(b,m,a.node,'failed');store.state(m.id,'needs_rework','Specialist execution incomplete; uncertain execution is never replayed');finishResult(service,run);return true;}
  a.attempt.result_hash=hash(result);save(b,m,a.node,'evaluating');
  const verifyId=randomUUID();store.startRun({id:verifyId,taskId:run.task_id,missionId:m.id,agentId:'host',role:'verifier'});
  let final=false,verification=a.attempt.verification||null;
  try {
    store.acquireLease({resource:m.envelope.workspace,runId:verifyId,missionId:m.id,mode:'write'});
    assertRoot(b,store.requireMission(m.id));
    const latest=nodes(b,m);
    final=latest.every(n=>n.node_id===a.node.node_id||n.state==='ready');
    if(verification){
      if(workspaceSnapshot(m.envelope.workspace).hash!==verification.workspace_hash)fail('gateway_recovery_workspace_changed');
    }else{
      const stage=await service.verifier.verify(m,run,{assignment:a.assignment,baseline:a.attempt.baseline});
      if(final&&stage.status==='passed'){
        store.state(m.id,'verifying');verification=await service.verifier.verify(store.requireMission(m.id),run);
      }else verification=stage;
      a.attempt.verification=verification;save(b,m,a.node,'evaluating');
    }
    // Host already proved an edit assignment wrote nothing. Skip OpenCode evaluation:
    // worker claims remain untrusted, verification evidence stays on the attempt, and
    // settlement must not depend on evaluator JSON for an empty mutation.
    if(verification.status==='failed'&&a.assignment.operation==='edit'&&!(run.result?.artifacts||[]).length){
      save(b,m,a.node,'failed');
      if(['running','verifying'].includes(store.requireMission(m.id).state)){
        store.state(m.id,'needs_rework','Host verification failed: edit assignment produced no host-observed file changes');
      }
      finishResult(service,run);service.schedule();return true;
    }
    const gateway=require('./opencode-gateway');
    const evaluation=await gateway.evaluate(b,store.requireMission(m.id),run,verification);
    assertRoot(b,store.requireMission(m.id));
    const receipt=gateway.receipt(b,m.id,run.id);
    a.attempt.evaluation_run_id=receipt.id;a.attempt.binding_hash=receipt.result.gateway.binding_hash;
    // Persist evaluation before any successor becomes eligible. A restart can
    // consume this exact receipt; it must never replay the worker invocation.
    save(b,m,a.node,'evaluating');
    if(verification.status==='passed'&&evaluation.evaluation.recommendation==='ready'){
      transaction(db,()=>{
        save(b,m,a.node,'ready');
        if(final){
          assertReceipts(b,store.requireMission(m.id),run.id);
          service.verifier.persist(store.requireMission(m.id),run,verification);
          db.prepare("UPDATE cp_mission_programs SET state='waiting_acceptance' WHERE id=?").run(m.id);
        }
        finishResult(service,run);
      });
    }else if(evaluation.evaluation.recommendation==='repair'&&planRepair(service,store.requireMission(m.id),a.node,evaluation)){
      finishResult(service,run);
    }else{
      save(b,m,a.node,'failed');
      if(['running','verifying'].includes(store.requireMission(m.id).state))store.state(m.id,'needs_rework','Specialist evaluation or host verification did not pass within the authorized repair budget');
      finishResult(service,run);
    }
  }catch(error){
    const detail=String(error.code||error.message).slice(0,160);
    const current=store.requireMission(m.id);
    // Host verification already failed: keep that evidence as needs_rework.
    // Masking it as EVALUATION_UNAVAILABLE blocks durable settlement diagnostics
    // and erases the distinction between empty worker writes and evaluator JSON.
    if(verification&&verification.status==='failed'&&['running','verifying'].includes(current.state)){
      save(b,m,a.node,'failed');
      store.state(m.id,'needs_rework','Host verification failed; evaluation unavailable: '+detail);
    }else{
      save(b,m,a.node,'unavailable');
      if(['running','verifying','awaiting_acceptance'].includes(current.state))store.state(m.id,'blocked','EVALUATION_UNAVAILABLE: '+detail);
    }
    finishResult(service,run);
  }finally{store.updateRun(verifyId,{state:'completed',processState:'not_started',verified:true,deferAudit:true});}
  if(final&&store.requireMission(m.id).state==='awaiting_acceptance')autoAccept(b,m.id);
  service.schedule();return true;
}
function recover(service,m) {
  if(!enabled(m))return false;
  if(!['dispatching','running','verifying'].includes(m.state))return true;
  // Result inbox replay and queued launches are handled by the existing loop.
  if(service.db.prepare('SELECT 1 FROM cp_run_results WHERE mission_id=? AND processed_at=0').get(m.id)||
     service.db.prepare("SELECT 1 FROM cp_dispatches WHERE mission_id=? AND state='queued'").get(m.id))return true;
  const all=nodes(service.bridge,m),history=attempts(service.bridge,m);
  if(m.state==='running'&&all.every(n=>['ready','pending'].includes(n.state))&&history.length&&history.every(a=>a.evaluation_run_id&&a.result_hash)){
    // Evidence validation at queue() rejects changed or incomplete history.
    return true;
  }
  service.store.state(m.id,'blocked','Interrupted specialist execution requires termination reconciliation; no duplicate dispatch');
  return true;
}
function autoAccept(bridge,id) {
  const store=bridge.controlStore,m=store.requireMission(id),db=store.db;
  if (!enabled(m)||m.state!=='awaiting_acceptance')return {accepted:false};
  const gate=bridge.expandedAutonomy.mayAutoAccept(m);if(!gate.allow)return{accepted:false,reason:gate.reason};
  assertRoot(bridge,m);
  if(store.decisions(id).some(d=>d.state==='waiting_for_operator'))return{accepted:false,reason:'waiting_decision'};
  if(bridge.policy.list().some(a=>a.status==='pending'&&store.missionForTask(a.taskId)?.id===id))return{accepted:false,reason:'pending_protected_action'};
  bridge.missions.assertAuthority(m);
  if(db.prepare("SELECT 1 FROM cp_dispatches WHERE mission_id=? AND state IN ('queued','dispatching','running','unknown')").get(id)||db.prepare("SELECT 1 FROM cp_leases WHERE resource=? AND state IN ('held','quarantined')").get(m.envelope.workspace))return{accepted:false,reason:'execution_not_settled'};
  const v=db.prepare('SELECT * FROM cp_verifications WHERE mission_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(id);
  if(!v||v.result!=='passed'||v.revision!==m.revision||JSON.parse(v.evidence).some(c=>c.status!=='passed'))return{accepted:false,reason:'host_verification_required'};
  assertReceipts(bridge,m,v.run_id);
  bridge.missions.accept(id,{request_id:'specialist-auto-accept:'+v.id,verification_id:v.id,decision:'accept',rationale:'Current enrolled automatic policy; every specialist returned to OpenCode; independent host verification and termination passed'},'operator');
  db.prepare("UPDATE cp_mission_programs SET state='settled' WHERE id=?").run(id);
  return{accepted:true,verification_id:v.id};
}
module.exports={KIND,enabled,assignments,register,queue,select,started,active,adapterScope,baseline,assertFresh,assertRoot,isEvaluating,digest,returnPayload,inspect,tick,processResult,assertReceipts,autoAccept,repairCount,recover,deadline,workerInput};
