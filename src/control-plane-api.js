'use strict';
const { object, identifier } = require('./control-plane-store');

// Invoked only after ControlServer has authenticated its operator credential.
function controlPlaneRead(bridge, url) {
  const store = bridge.controlStore;
  if (!store) throw new Error('Durable control plane is unavailable');
  require('./memory-content-erasure').assertReadable(store.db);
  const section = url.pathname.slice('/api/control-v2/'.length);
  if(bridge.authorityRuntime&&(section.startsWith('authority-')||section==='memory-provenance')){
    const result=bridge.authorityRuntime.read(section,url);if(result!==null)return result;
  }
  const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('Invalid page size');
  const before = url.searchParams.get('before');
  if (before && (!Number.isSafeInteger(Number(before)) || Number(before) < 0)) throw new Error('Invalid cursor');
  if (section === 'health') return {
    bridge: {healthy:!bridge.closed,pid:process.pid,mcp_ready:!bridge.closed,runtime_fingerprint:bridge.runtimeFingerprint||null},
    outbox: store.outbox.health(),
    pending_approvals: bridge.policy.list().filter(a=>a.status==='pending').length,
    agents:store.agents(),
    ollama:{kind:'provider',state:'not_checked',reason:'No provider probe performed by this health request'},
    schema_version: store.db.prepare('SELECT version FROM control_plane_meta').get().version, ledger: bridge.ledger.health(),
    runs: store.db.prepare('SELECT state,count(*) count FROM cp_runs GROUP BY state').all(),
    pending_decisions: store.db.prepare("SELECT count(*) count FROM cp_decisions WHERE state='waiting_for_operator'").get().count,
    quarantined_leases: store.db.prepare("SELECT count(*) count FROM cp_leases WHERE state='quarantined'").get().count,
    autonomy:{execution_enabled:bridge.boundedNextActions?.enabled===true,default_mode:'observe',acceptance_required:true,fixture_auto_acceptance:!!bridge.fixtureAcceptance},
    slack: bridge.slackRuntime?.status() || { implemented:true, enabled:false, connected:false, state:'disabled' }, next_action_execution: bridge.boundedNextActions?.enabled===true, cursor_agent_execution: false,
    execution: { default_runtime: bridge.defaultRuntime, opencode: 'bounded_local_adapter', pi: 'compatibility_rollback', claude_code: 'existing_capability_runner', cursor_agent: 'acp_status_only_execution_unqualified', codex_agent: bridge.codexAdapter?.health()||'unimplemented' },
    limitations: ['Ordinary projects default to observe; explicit bounded development chains can execute. Cursor Agent execution is unavailable.']
  };
  if(section==='architecture-memory'){
    const arch=require('./architecture-memory'),projectId=url.searchParams.get('project_id'),history=url.searchParams.get('history')==='true';
    const ids=projectId?[projectId]:store.db.prepare('SELECT project_id FROM projects LIMIT 200').all().map(p=>p.project_id);
    return {items:ids.flatMap(id=>arch.list(store.db,id,{history,limit})).slice(0,limit),bootstrap:arch.exists(store.db)?store.db.prepare('SELECT * FROM architecture_memory_bootstraps LIMIT ?').all(limit):[],authority:false};
  }
  if(section==='context-inspector')return bridge.controlContext.inspect(identifier(url.searchParams.get('id')));
  if(section==='agent-dispatches')return{items:bridge.agentDispatch.views({mission_id:url.searchParams.get('mission_id'),run_id:url.searchParams.get('run_id')}),availability:bridge.agentDispatch.availability()};
  if(section==='outbox')return {health:store.outbox.health(),items:store.db.prepare('SELECT id,event_key,destination_type,destination_ref,event_type,correlation,status,attempts,next_at,created_at,updated_at,sent_at,error_class,receipt FROM cp_effect_outbox ORDER BY created_at DESC LIMIT ?').all(limit)};
  if(section==='git-files')return {items:store.db.prepare("SELECT resource,run_id,state,baseline FROM cp_leases ORDER BY acquired_at DESC LIMIT ?").all(limit).map(x=>({...x,baseline:JSON.parse(x.baseline)}))};
  if(section==='fixture-policy')return {items:store.db.prepare('SELECT project_id,workspace,policy FROM cp_fixture_projects LIMIT ?').all(limit)};
  if(section==='reasoning-admissions')return {items:bridge.hostReasoningAdmission?.views(limit)||[]};
  if(section==='provider-health')return {items:bridge.providerGateway?.views().items||[],execution_authority:false};
  if(section==='providers')return bridge.providerGateway?.views() || {items:require('./provider-profiles').initialProfiles().map(p=>({id:p.id,kind:'provider',protocol:p.protocol,implemented:p.implemented,state:'not_checked',execution_authority:false}))};
  if(section==='provider-routes')return {items:bridge.providerGateway?.routes({run_id:url.searchParams.get('run_id'),limit})||[]};
  if(section==='next-action'){if(!bridge.boundedNextActions)return{execution_enabled:false,items:[]};const ids=store.db.prepare('SELECT id FROM cp_autonomy_chains ORDER BY started_at DESC LIMIT ?').all(limit);return{execution_enabled:bridge.boundedNextActions.enabled,fixture_auto_acceptance:!!bridge.fixtureAcceptance,items:ids.map(r=>bridge.boundedNextActions.inspect(r.id))};}
  if (section === 'events') {
    const filters = { limit, order: url.searchParams.get('order') === 'desc' ? 'desc' : 'asc' };
    for (const name of ['taskId','runId','missionId','agent','eventType','status']) if (url.searchParams.has(name)) filters[name] = url.searchParams.get(name);
    for (const name of ['afterSequence','beforeSequence','fromMs','toMs']) if (url.searchParams.has(name)) filters[name] = Number(url.searchParams.get(name));
    return bridge.ledger.list(filters);
  }
  if (section === 'run') {const run=store.run(identifier(url.searchParams.get('id')));if(!run)throw Error('Run not found');return run;}
  if (section === 'task') {const id=identifier(url.searchParams.get('id')),task=bridge.tasks.get(id);return {id:task.id,mission_id:store.missionForTask(id)?.id,status:task.status,health:bridge.taskHealth(task),authority:require('./mission-permissions').snapshot(task.mission?.authority,Date.now(),task.mission?.authorityRevoked===true),assigned_agent:task.assignedAgent||null,context_pack_id:task.contextPackId||null};}
  if (section === 'slack-credential-authorization') return bridge.slackRuntime.credentialAuthorization || {state:'not_started'};
  if (section === 'slack-ci') return bridge.slackRuntime.ciFlow.status();
  if (section === 'slack') return bridge.slackRuntime.status();
  if (section === 'approvals') return {items:bridge.policy.list().filter(a=>a.status==='pending').slice(0,limit).map(a=>({id:a.id,task_id:a.taskId,state:a.status,created_at:a.createdAt,expires_at:a.expiresAt,tool:a.toolName,reason:'Protected approval: inspect the original Control Center before approving'}))};
  if (section === 'result-inbox') return {items:bridge.resultInbox.list({limit,agent:url.searchParams.get('agent'),state:url.searchParams.get('state'),mission:url.searchParams.get('mission_id'),task:url.searchParams.get('task_id'),run:url.searchParams.get('run_id'),project:url.searchParams.get('project_id')})};
  if (section === 'codex') return url.searchParams.get('run_id')?bridge.codexAdapter.getTask(identifier(url.searchParams.get('run_id'))):bridge.codexAdapter.health();
  if (section === 'agents') return {items:store.agents()};
  if(section==='mission-program')return bridge.missions.program.inspect(url.searchParams.get('id'));
  if (section === 'mission') return bridge.missions.detail(url.searchParams.get('id'));
  if (section === 'decision') return bridge.missions.decisionDetails(url.searchParams.get('id'));
  if (section === 'tasks') return {items:bridge.tasks.list().filter(t=>t.controlPlaneMissionId).slice(0,limit).map(t=>({id:t.id,mission_id:t.controlPlaneMissionId,status:t.status,health:bridge.taskHealth(t),authority:require('./mission-permissions').snapshot(t.mission?.authority,Date.now(),t.mission?.authorityRevoked===true),assigned_agent:t.assignedAgent||null,context_pack_id:t.contextPackId||null}))};
  if (section === 'missions') return { items: store.listMissions({ limit, after: Number(before || 0) }) };
  if (section === 'decisions') store.expireDecisions();
  if (section === 'decisions') return { items: store.decisions(url.searchParams.get('missionId') || null) };
  const tables = { runs:'cp_runs',leases:'cp_leases',candidates:'cp_candidates',context:'cp_context_packs',verifications:'cp_verifications',acceptance:'cp_acceptances' };
  const table = tables[section]; if (!table) throw new Error('Unknown control collection');
  const rows = store.db.prepare(`SELECT rowid AS cursor,* FROM ${table} WHERE rowid < ? ORDER BY rowid DESC LIMIT ?`).all(before ? Number(before) : Number.MAX_SAFE_INTEGER, limit + 1);
  const more = rows.length > limit; if (more) rows.pop();
  const items = rows.map(row => {
    for (const key of ['record','result','refs','selection','baseline','evidence']) if (typeof row[key] === 'string') { try { row[key] = JSON.parse(row[key]); } catch {} }
    return row;
  });
  return { items, next_cursor: more ? rows.at(-1).cursor : null };
}
function controlPlaneWrite(bridge, action, input) {
  if (action === 'project-memory-retention') {
    object(input, ['mission_id', 'expires_at']);
    identifier(input.mission_id);
    if (!bridge.projectMemoryV2?.memory) throw new Error('Memory V2 is unavailable');
    return bridge.projectMemoryV2.memory.setRetention(input.mission_id, { expiresAt: input.expires_at });
  }
  if (action === 'project-memory-forget') {
    object(input, ['mission_id']);
    identifier(input.mission_id);
    if (!bridge.projectMemoryV2?.memory) throw new Error('Memory V2 is unavailable');
    return bridge.projectMemoryV2.memory.forgetMission(input.mission_id);
  }
  if(['restricted-memory-save','restricted-memory-read','restricted-memory-snapshot','restricted-memory-forget'].includes(action)){
    const op=action.slice('restricted-memory-'.length);
    object(input,op==='save'?['id','content']:['id']);
    const vault=new(require('./restricted-memory-vault').RestrictedMemoryVault)(bridge.dataDir);
    return vault[op](input);
  }
  if(bridge.authorityRuntime&&['authority-prepare','authority-prove-memory','authority-prepare-router','authority-prove-router','authority-enable-router','authority-disable-router'].includes(action))return bridge.authorityRuntime.write(action,input);
  if(bridge.authorityRuntime&&['memory-propose','memory-observe','memory-promote','memory-forget','memory-reject','memory-context','memory-context-diff'].includes(action))return bridge.authorityRuntime.write(action,input);
  if(action==='provider-observe'){
    object(input,['id','state','request_id']);identifier(input.id);identifier(input.request_id);
    if(!bridge.providerGateway)throw Error('Provider gateway is unavailable');
    return bridge.controlStore.request('operator',input.request_id,{action,...input},()=>{bridge.providerGateway.registry.observe(input.id,input.state);return {observed:true,execution_authority:false};});
  }
  if(action==='provider-circuit-reset'){
    object(input,['id','profile','request_id']);identifier(input.id);identifier(input.profile);identifier(input.request_id);
    const g=bridge.providerGateway,p=g?.registry.get(input.id)?.profile;
    if(!p?.models.some(m=>(m.profile_id||m.id)===input.profile))throw Error('Unknown provider model');
    if(g.db?.prepare("SELECT 1 FROM cp_provider_requests WHERE state='consumed'").get())throw Error('Provider request requires settlement or reconciliation');
    return bridge.controlStore.request('operator',input.request_id,{action,...input},()=>({circuit:g.reliability.reset(input.id+':'+input.profile),execution_authority:false}));
  }
  if(action==='provider-diagnostic'){object(input,[]);return require('./provider-diagnostic').providerDiagnostic();}
  if(action==='reasoning-create'){
    object(input,['description','message','policy','request_id','probe']);identifier(input.request_id);
    if(typeof input.description!=='string'||!input.description.trim()||input.description.length>500||typeof input.message!=='string'||!input.message.trim()||Buffer.byteLength(input.message)>59000||require('./provider-policy').secretLike(input.message))throw Error('Invalid bounded context');
    const policy=require('./host-reasoning-admission').policy(input.policy);
    if(input.probe!=null&&(input.probe!=='ollama_unavailable'||policy.data_class!=='public'||policy.purpose!=='synthetic_probe'))throw Error('Invalid synthetic reasoning probe');
    const receipt=bridge.controlStore.request('operator',input.request_id,{action,...input},()=>{const t=bridge.createTask(input.description,{reasoningOnly:true,reasoningGatewayPolicy:policy,reasoningProbe:input.probe});return {task_id:t.id,execution_authority:false};});
    if(!receipt.duplicate){const task=bridge.tasks.get(receipt.task_id);task.latestMcpRequestId=input.request_id;bridge.tasks.save(task);return bridge.prompt(task.id,input.message).then(result=>({...receipt,result}));}
    return {...receipt,status:'inspect_existing_task'};
  }
  if(action==='fixture-project-policy')return bridge.fixtureAcceptance.register(input);
  if(action==='next-action-register')return bridge.boundedNextActions.register(input);
  if(action==='next-action-observe'){object(input,['id']);return bridge.boundedNextActions.tick(input.id);}
  if(action==='next-action-resume'){object(input,['id']);return bridge.boundedNextActions.resume(input.id);}
  if(action==='next-action-pause'){object(input,['id']);return bridge.boundedNextActions.pause(input.id);}
  if(action==='result-review'){object(input,['run_id','state','request_id']);return bridge.resultInbox.review(input.run_id,input.state);}
  if(action==='observe-agent-availability')return bridge.agentDispatch.observeAvailability(input,'operator');
  if(action==='claim-agent-dispatch')return bridge.agentDispatch.claim(input,'operator');
  if(action==='report-agent-dispatch')return bridge.agentDispatch.report(input,'operator');
  if(action==='codex-handoff'){object(input,['mission_id','request_id']);return bridge.codexAdapter.startTask(input.mission_id,input.request_id);}
  if(action==='codex-cancel'){object(input,['run_id']);return bridge.codexAdapter.cancelTask(input.run_id);}
  if(action==='codex-reconcile'){const result=bridge.codexAdapter.reconcile(input);bridge.missions.schedule();return result;}

  if(action==='supersede-decision'){object(input,['id','request_id','question','options','allow_free_text','expires_at']);identifier(input.id);identifier(input.request_id);const {id,request_id,...question}=input;return bridge.controlStore.request('operator',request_id,{action,...input},()=>bridge.controlStore.supersedeDecision(id,question,'operator'));}
  if(action==='slack-credential-probe')return bridge.slackRuntime.credentialProbe(input);
  if(action==='slack-credential-authorize')return bridge.slackRuntime.credentialAuthorize(input);
  if(action==='slack-ci-configure')return bridge.slackRuntime.ciFlow.configure(input);
  if(action==='slack-health-test')return bridge.slackRuntime.healthTest(input);
  if(action==='slack-configure')return bridge.slackRuntime.configure(input);
  if(action==='create-mission-program')return bridge.missions.program.create(input);
  if(action==='cancel-mission-program'){object(input,['id','request_id']);return bridge.missions.program.cancel(input.id,input.request_id);}
  if(action==='resume-mission-program'){object(input,['id']);return bridge.missions.program.resume(input.id);}
  if(action==='create-mission')return bridge.missions.create(input);
  if(action==='dispatch-mission')return bridge.missions.dispatch(input.id,input);
  if(action==='reverify-mission')return bridge.missions.reverify(input.id,input);
  if(action==='accept-mission')return bridge.missions.accept(input.id,input);
  if(action==='cancel-mission')return bridge.missions.cancel(input.id,input);
  if(action==='refresh-agents')return bridge.missions.agents.refresh();
  if (action === 'answer') {
    object(input, ['id','request_id','option_id','free_text']); identifier(input.id); identifier(input.request_id);
    if(bridge.missions)return bridge.missions.answer(input.id,input);
    return bridge.controlStore.request('operator', input.request_id, { action, ...input }, () => bridge.controlStore.answerDecision(input.id, { option_id: input.option_id ?? null, free_text: input.free_text ?? null, actor: 'operator', surface: 'operator' }));
  }
  if (action === 'review-candidate') {
    object(input, ['id','request_id','decision','content']); identifier(input.id); identifier(input.request_id);
    return bridge.controlStore.request('operator', input.request_id, { action, ...input }, () => bridge.controlContext.review(input.id, { decision: input.decision, content: input.content, reviewer: 'operator' }));
  }
  throw new Error('Control operation is not enabled');
}
module.exports = { controlPlaneRead, controlPlaneWrite };
