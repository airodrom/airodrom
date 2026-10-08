'use strict';
// ADR 0016: per-Mission signed grants inside the canonical SQLite control plane.
const fs=require('node:fs'),path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const {object,fingerprint,transaction}=require('./control-plane-store');
const {privateDirectory}=require('./local-bootstrap');
const policy=require('./mission-web-policy');
const {ResearchNetwork,error}=require('./research-network');
const {unsafeEvidenceText}=require('./research-baseline');
const hash=v=>createHash('sha256').update(v).digest('hex');
class MissionWeb{
 constructor(service){
  this.service=service;this.bridge=service.bridge;this.store=service.store;this.db=service.db;this.active=new Map();this.uncertainBrowsers=new Map();this.invocations=new Map();
  this.options=this.bridge.options.missionWeb||{};
  if(Object.keys(this.options).length&&!(process.env.NODE_ENV==='test'&&this.options.synthetic===true))throw error('synthetic_web_adapter_denied');
  this.db.exec(`CREATE TABLE IF NOT EXISTS cp_mission_web_grants(id TEXT PRIMARY KEY,mission_id TEXT NOT NULL,policy TEXT NOT NULL,policy_hash TEXT NOT NULL,seal TEXT NOT NULL,state TEXT NOT NULL,actions INTEGER NOT NULL DEFAULT 0,pages INTEGER NOT NULL DEFAULT 0,bytes INTEGER NOT NULL DEFAULT 0,requests INTEGER NOT NULL DEFAULT 0,visited_origins TEXT NOT NULL DEFAULT '[]');
   CREATE TABLE IF NOT EXISTS cp_mission_web_evidence(id TEXT PRIMARY KEY,grant_id TEXT NOT NULL,mission_id TEXT NOT NULL,task_id TEXT NOT NULL,run_id TEXT NOT NULL,sha256 TEXT NOT NULL,invocation_id TEXT NOT NULL,created_at INTEGER NOT NULL);
   CREATE UNIQUE INDEX IF NOT EXISTS cp_current_web_grant ON cp_mission_web_grants(mission_id) WHERE state='active';`);
 }
 binding(m){return fingerprint({mission_id:m.id,envelope:m.envelope,grant_id:m.grant_id});}
 qualify(m){
  if(this.db.prepare("SELECT 1 FROM cp_runs WHERE mission_id=? AND state='termination_unverified' AND termination_verified=0").get(m.id))throw error('web_termination_unverified');
  if(m.owner!=='operator'||!['coding','browser_research'].includes(m.envelope.kind)||!m.envelope.authority)throw error('qualified_work_mission_required');
  this.service.assertAuthority(m,{network:['internet'],data:['read']});
  if(m.envelope.dispatch_policy?.privacy!=='local_only'||m.envelope.fallback_agents.length||!['host','opencode'].includes(m.envelope.preferred_agent))throw error('confined_local_worker_required');
  if(m.envelope.automatic_acceptance)throw error('web_evidence_requires_owner_acceptance');
  if(['completed','cancelled'].includes(m.state))throw error('mission_web_stopped');
  const task=this.bridge.tasks.get(m.task_id);if(!task||task.content_state==='erased'||task.cancelRequested||task.safetyStop?.latched||task.mission?.authorityRevoked)throw error('mission_web_stopped');
  if(m.envelope.manifest){const check=require('./mission-manifest').checkManifest(m.envelope.manifest,{toolName:'capability',input:{name:'mission_web',input:{}}},m.envelope.workspace);if(!check.allow)throw error('manifest_web_permission_denied');}
  return task;
 }
 configure(id,input,owner='operator'){
  if(owner!=='operator')throw error('operator_web_consent_required');object(input,['request_id','mode','entries','query','confirmed']);if(!policy.UUID.test(input.request_id||''))throw error('opaque_web_request_required');
  const m=this.store.requireMission(id);if(m.owner!=='operator')throw error('operator_mission_required');
  if(input.mode==='off')return this.store.request(owner,input.request_id,{op:'mission_web_off',id},()=>{this.db.prepare("UPDATE cp_mission_web_grants SET state='revoked' WHERE mission_id=? AND state='active'").run(id);this.cancel(id);this.store.event('mission.web.revoked',id,{actor:'operator'});return {kind:'mission_web',mission_id:id,mode:'off',message:'Web access stopped for this Mission.',authority:false};});
  const task=this.qualify(m),p=policy.normalize(inputPolicy(input),{expiresAt:Math.min(m.envelope.authority.expiresAt,m.envelope.manifest?.expires_at||Infinity)});
  if(m.envelope.manifest?.public_web){const sealed=m.envelope.manifest.public_web;if(p.mode!==sealed.mode||fingerprint(p.entries)!==fingerprint(sealed.entries)||p.query!==sealed.query)throw error('sealed_web_policy_required');}
  if(m.envelope.manifest?.permissions.network.origins&&!m.envelope.manifest.public_web&&p.origins.some(o=>!m.envelope.manifest.permissions.network.origins.includes(o)))throw error('manifest_origin_ceiling_denied');
  if(m.envelope.manifest?.permissions.network.origins&&!m.envelope.manifest.public_web&&p.mode==='all')throw error('manifest_origin_ceiling_denied');
  if(!this.bridge.missionAuthority.fixtureOnly)this.bridge.missionAuthority.initializeOperatorKey();
  return this.store.request(owner,input.request_id,{op:'mission_web_grant',id,...inputPolicy(input)},()=>{
   this.db.prepare("UPDATE cp_mission_web_grants SET state='revoked' WHERE mission_id=? AND state='active'").run(id);this.cancel(id);
   const grant={...p,id:randomUUID(),mission_binding:this.binding(m)},digest=fingerprint(grant),seal=this.bridge.missionAuthority.sealManifest({mission_id:id,manifest_hash:digest});if(!seal)throw error('signed_web_grant_required');
   this.db.prepare('INSERT INTO cp_mission_web_grants(id,mission_id,policy,policy_hash,seal,state) VALUES(?,?,?,?,?,?)').run(grant.id,id,JSON.stringify(grant),digest,JSON.stringify(seal),'active');
   this.store.event('mission.web.granted',id,{grant_id:grant.id,mode:p.mode,origins:p.origins,expires_at:p.expires_at,max_actions:p.max_actions,max_pages:p.max_pages,actor:'operator',public_only:true});
   return {kind:'mission_web',mission_id:id,mode:p.mode,grant_id:grant.id,message:'Public web access approved for this Mission for up to three minutes. Login, private data, mutations and private downloads remain separately authorized.',authority:false};
  });
 }
 grant(m,{active=true}={}){
  const row=this.db.prepare("SELECT * FROM cp_mission_web_grants WHERE mission_id=? AND state='active'").get(m.id);if(!row)throw error('mission_web_approval_required');
  const p=JSON.parse(row.policy);if(fingerprint(p)!==row.policy_hash||p.mission_binding!==this.binding(m)||!this.bridge.missionAuthority.verifyManifestSeal(JSON.parse(row.seal),{mission_id:m.id,manifest_hash:row.policy_hash}))throw error('web_grant_integrity_denied');
  if(active&&Date.now()>=p.expires_at)throw error('web_grant_expired');return {...row,policy:p};
 }
 status(id){const m=this.store.requireMission(id),request=policy.proposal(m.envelope.objective);let grant;try{grant=this.grant(m,{active:false});}catch{}
  return {needed:request.needed,mode:grant?Date.now()>=grant.policy.expires_at?'expired':grant.policy.mode:'off',origins:grant?.policy.origins||[],expires_at:grant?.policy.expires_at||null,actions:grant?.actions||0,pages:grant?.pages||0,public_only:true,search_source:this.source(),authority:false};
 }
 source(){return this.options.searchSource??JSON.parse(fs.readFileSync(path.join(__dirname,'../config/mission-web-v1.json'),'utf8')).search_source;}
 bindInvocation(task,request){this.invocations.set(task.id,this.bridge.orchestrator.requestIdFor(task,request.toolCallId));}
 isActiveTask(id){return [...this.active.keys()].some(key=>this.store.getMission(key)?.task_id===id)||!!this.db.prepare("SELECT 1 FROM cp_runs WHERE task_id=? AND state='termination_unverified' AND termination_verified=0").get(id);}
 uncertain(m,runId,browser){this.uncertainBrowsers.set(m.id,browser);this.store.updateRun(runId,{state:'termination_unverified',processState:'unknown',verified:false,resolution:'web_termination_unverified'});this.db.prepare("UPDATE cp_leases SET state='quarantined' WHERE run_id=? AND state='held'").run(runId);this.db.prepare("UPDATE cp_dispatches SET state='unknown' WHERE mission_id=? AND run_id=?").run(m.id,runId);this.store.event('mission.web.termination_unverified',m.id,{reconciliation_required:true},{runId});}
 async closeBrowser(m,runId,browser){try{const result=await browser.close();if(!result?.closed||!result.termination_verified||result.owned_process_termination!=='verified')throw error('web_termination_unverified');return result;}catch{this.uncertain(m,runId,browser);throw error('web_termination_unverified');}}
 assess(task,input,{budget=true}={}){
  const m=this.store.requireMission(input.mission_id),bound=this.qualify(m),g=this.grant(m);
  const dispatch=this.db.prepare("SELECT run_id FROM cp_dispatches WHERE mission_id=? AND task_id=? AND state='running'").get(m.id,task.id),run=dispatch?.run_id?this.store.run(dispatch.run_id):null;
  if(task.controlPlaneMissionId!==m.id||bound.id!==task.id||!run||run.state!=='running'||run.mission_id!==m.id||run.task_id!==task.id||dispatch?.run_id!==run.id||m.state!=='running')throw error('active_canonical_web_run_required');
  if(budget&&(g.actions>=g.policy.max_actions||g.pages>=g.policy.max_pages||g.bytes>=g.policy.max_bytes))throw error('mission_web_budget_exhausted');
  if(input.action.type==='search'&&!g.policy.query)throw error('sealed_public_query_required');
  if(input.action.type!=='search')this.destination(m,g,input.action);
  return {scope:{mission_id:m.id,grant_id:g.id,public_only:true},facts:{grant_id:g.id}};
 }
 directory(task){const session=path.resolve(this.bridge.dataDir,'tasks',task.id,'sessions');if(task.sessionDir!==session)throw error('web_evidence_scope_denied');privateDirectory(session);return privateDirectory(path.join(session,'web-evidence'),true);}
 read(row){const task=this.bridge.tasks.get(row.task_id);if(!task||task.content_state==='erased')throw error('web_evidence_erased');const file=path.join(this.directory(task),row.id+'.json'),fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.uid!==process.getuid?.()||stat.nlink!==1||stat.mode&0o077||stat.size>1048576)throw error('web_evidence_integrity_denied');const bytes=fs.readFileSync(fd);if(hash(bytes)!==row.sha256)throw error('web_evidence_integrity_denied');return JSON.parse(bytes);}finally{fs.closeSync(fd);}
 }
 rows(m,runId){return this.db.prepare('SELECT * FROM cp_mission_web_evidence WHERE mission_id=?'+(runId?' AND run_id=?':'')+' ORDER BY created_at').all(...(runId?[m.id,runId]:[m.id]));}
 candidates(m,g){return this.rows(m).filter(r=>r.grant_id===g.id).flatMap(r=>this.read(r).links||[]);}
 destination(m,g,a){let url=a.url;if(a.type==='click'){const link=this.candidates(m,g).find(l=>l.id===a.link_id);if(!link)throw error('verified_current_link_required');url=link.url;}
  const known=g.policy.entries.includes(url)||this.candidates(m,g).some(l=>l.url===url);if(!known)throw error('operator_source_or_verified_link_required');
  const network=this.network(g);try{url=network.validate(url);}catch(e){this.store.event('mission.web.permission_needed',m.id,{grant_id:g.id,reason:e.code,origin:new URL(url).origin,public_only:true});throw e;}
  return url;
 }
 transportUsage(g,{origin,bytes=0}={}){transaction(this.db,()=>{const m=this.store.requireMission(g.mission_id),current=this.grant(m);if(current.id!==g.id||m.state!=='running'||this.bridge.tasks.get(m.task_id).cancelRequested)throw error('mission_web_stopped');const visited=JSON.parse(current.visited_origins);if(origin&&!visited.includes(origin)){require('./research-network').safeOrigin(origin);if(visited.length>=g.policy.max_origins)throw error('mission_web_domain_budget');visited.push(origin);}if(origin&&current.requests>=g.policy.max_requests||current.bytes+bytes>g.policy.max_bytes)throw error('mission_web_transport_budget');this.db.prepare('UPDATE cp_mission_web_grants SET requests=requests+?,bytes=bytes+?,visited_origins=? WHERE id=?').run(origin?1:0,bytes,JSON.stringify(visited),g.id);});}
 network(g,signal){const origins=g.policy.origins.length?g.policy.origins:['https://example.com'];return new ResearchNetwork({scope:{origins,publicDiscovery:g.policy.mode==='all',maxOrigins:g.policy.max_origins},signal,testing:this.options.testing,...(signal?{onRequest:origin=>this.transportUsage(g,{origin}),onBytes:bytes=>this.transportUsage(g,{bytes})}:{})});}
 async perform(task,input,signal){
  this.assess(task,input);const m=this.store.requireMission(input.mission_id),g=this.grant(m),runId=this.runFor(m,task).id;if(this.active.has(m.id))throw error('mission_web_busy');
  const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();const timer=setTimeout(abort,Math.max(0,g.policy.expires_at-Date.now()));this.active.set(m.id,controller);
  let browser,result,termination={closed:true,termination_verified:true,owned_process_termination:'verified'};
  transaction(this.db,()=>{const current=this.grant(m);if(current.id!==g.id)throw error('web_grant_changed');this.db.prepare('UPDATE cp_mission_web_grants SET actions=actions+1,pages=pages+1 WHERE id=?').run(g.id);});
  try{
   if(input.action.type==='search'){
    const source=await (this.options.search||require('./mission-web-search').search)({query:g.policy.query,source:this.source(),signal:controller.signal,testing:this.options.testing,onRequest:origin=>this.transportUsage(g,{origin}),onBytes:bytes=>this.transportUsage(g,{bytes})});
    result={classification:'documented',title:'Public web search',text:source.results.map(r=>r.title+' — '+r.url).join('\n'),source,links:source.results.map(r=>({id:randomUUID(),text:r.title,url:r.url})),bytes:source.bytes};
   }else{
    const url=this.destination(m,g,input.action);
    if(input.action.type==='document')result=await require('./mission-web-document').read({url,network:this.network(g,controller.signal),signal:controller.signal});
    else{
     const scope={origins:g.policy.origins.length?g.policy.origins:[new URL(url).origin],publicDiscovery:g.policy.mode==='all',maxOrigins:g.policy.max_origins,maxActions:10,allowDownloads:false};
     browser=this.options.browserFactory?this.options.browserFactory({scope,signal:controller.signal,evidenceDir:this.directory(task)}):new (require('./research-browser').ResearchBrowser)({scope,network:this.network(g,controller.signal),onEvidenceBytes:bytes=>this.transportUsage(g,{bytes}),signal:controller.signal,evidenceDir:this.directory(task),onEvent:e=>this.store.event(e.type,m.id,{grant_id:g.id,reason:e.reason||null},{runId})});
     await browser.execute({type:'navigate',url});const row=await browser.execute({type:input.action.type==='screenshot'||input.action.type==='explore'?'screenshot':'snapshot'});
     if(!browser.verify(row))throw error('web_evidence_integrity_denied');
     result={classification:row.classification,title:row.title,text:row.text,url:row.url,links:row.links||[],browser_evidence:row,bytes:Buffer.byteLength(JSON.stringify(row))+[row.evidence_ref,row.screenshot_ref].filter(Boolean).reduce((sum,ref)=>sum+fs.statSync(ref.path).size,0),...(input.action.type==='test'?{functionality:{navigation:row.classification==='observed'?'observed':'inaccessible',forms:'untested',mutations:'denied'}}:{})};
    }
   }
   if(controller.signal.aborted)throw error('cancelled');
   if(browser){termination=await this.closeBrowser(m,runId,browser);browser=null;}if(!termination.termination_verified)throw error('web_termination_unverified');
   this.assess(task,input,{budget:false});if(this.grant(m).id!==g.id)throw error('web_grant_changed');
   if(unsafeEvidenceText(result.text)||unsafeEvidenceText(result.title)||result.classification==='inaccessible'&&result.text)throw error('private_web_evidence_denied');
   const current=this.grant(m);if(!Number.isSafeInteger(result.bytes)||result.bytes<0||current.bytes+result.bytes>g.policy.max_bytes)throw error('mission_web_byte_budget');
   const invocation=this.invocations.get(task.id);if(!invocation||this.store.invocation(invocation)?.state!=='running')throw error('canonical_web_invocation_required');
   const id=randomUUID(),record={id,mission_id:m.id,task_id:task.id,run_id:runId,grant_id:g.id,action:input.action.type,...result,termination,untrusted:true,authority:false,captured_at:Date.now()},bytes=Buffer.from(JSON.stringify(record)+'\n');if(bytes.length>1048576)throw error('web_evidence_bound');if(current.bytes+result.bytes+bytes.length>g.policy.max_bytes)throw error('mission_web_byte_budget');
   const file=path.join(this.directory(task),id+'.json');fs.writeFileSync(file,bytes,{mode:0o600,flag:'wx'});
   this.db.prepare('INSERT INTO cp_mission_web_evidence VALUES(?,?,?,?,?,?,?,?)').run(id,g.id,m.id,task.id,runId,hash(bytes),invocation,Date.now());this.db.prepare('UPDATE cp_mission_web_grants SET bytes=bytes+? WHERE id=?').run(result.bytes+bytes.length,g.id);
   this.store.event('mission.web.evidence',m.id,{evidence_id:id,grant_id:g.id,classification:record.classification,action:record.action,termination_verified:true},{runId});return this.project(record);
  }finally{
   clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();try{if(browser&&!this.uncertainBrowsers.has(m.id))await this.closeBrowser(m,runId,browser);}finally{if(!this.uncertainBrowsers.has(m.id))this.active.delete(m.id);}
  }
 }
 project(record){return {evidence_id:record.id,classification:record.classification,title:record.title,text:record.text,...(record.url?{url:record.url}:{}),links:record.links,source:record.source?{source_id:record.source.source_id,source_url:record.source.source_url,fetched_at:record.source.fetched_at}:undefined,functionality:record.functionality,untrusted:true,authority:false};}
 verify(m,run){
  const rows=this.rows(m,run.id);for(const row of rows){const e=this.read(row),invocation=this.store.invocation(row.invocation_id);if(invocation?.state!=='settled'||invocation.result?.status!=='completed'||invocation.result?.capability!=='mission_web'||invocation.task_id!==row.task_id)throw error('web_invocation_integrity_denied');if(e.mission_id!==m.id||e.task_id!==run.task_id||e.run_id!==run.id||e.grant_id!==row.grant_id||e.authority!==false||!e.untrusted||!e.termination.termination_verified||unsafeEvidenceText(e.text)||unsafeEvidenceText(e.title))throw error('web_evidence_integrity_denied');
   const historical=this.db.prepare('SELECT * FROM cp_mission_web_grants WHERE id=? AND mission_id=?').get(row.grant_id,m.id);if(!historical)throw error('web_grant_provenance_denied');const p=JSON.parse(historical.policy);if(fingerprint(p)!==historical.policy_hash||p.mission_binding!==this.binding(m)||!this.bridge.missionAuthority.verifyManifestSeal(JSON.parse(historical.seal),{mission_id:m.id,manifest_hash:historical.policy_hash}))throw error('web_grant_provenance_denied');
   if(e.browser_evidence){if(!require('./research-browser').verifyEvidence(e.browser_evidence,{evidenceDir:this.directory(this.bridge.tasks.get(run.task_id)),scope:{origins:p.origins.length?p.origins:[new URL(e.browser_evidence.url).origin],publicDiscovery:p.mode==='all',maxOrigins:p.max_origins}}))throw error('web_evidence_integrity_denied');}}
  return {evidence_count:rows.length,termination_verified:true,authority:false};
 }
 runFor(m,task){const dispatch=this.db.prepare("SELECT run_id FROM cp_dispatches WHERE mission_id=? AND task_id=? AND state='running'").get(m.id,task.id),run=dispatch?.run_id?this.store.run(dispatch.run_id):null;if(!run||run.task_id!==task.id||run.mission_id!==m.id||run.state!=='running')throw error('active_canonical_web_run_required');return run;}
 context(task){const m=this.store.requireMission(task.controlPlaneMissionId),run=this.runFor(m,task);if(!run||run.task_id!==task.id)throw error('web_context_run_required');this.verify(m,run);return this.rows(m,run.id).map(r=>this.project(this.read(r))).slice(0,8);}
 async preflight(m,task){
  const requested=policy.proposal(m.envelope.objective);let g;try{g=this.grant(m);}catch(e){if(requested.needed)throw e;return;}
  task.activeRunId=this.db.prepare("SELECT id FROM cp_runs WHERE task_id=? AND mission_id=? AND state='running' ORDER BY created_at DESC LIMIT 1").get(task.id,m.id)?.id;if(!task.activeRunId)throw error('active_canonical_web_run_required');
  const actions=g.policy.query?[{type:'search'}]:[];actions.push(...g.policy.entries.slice(0,3).map(url=>({type:/\.pdf$/i.test(new URL(url).pathname)?'document':'explore',url})));
  for(const action of actions){if(action.type==='search'&&!this.source())throw error('approved_search_provider_unavailable');await this.call(m,task,action);}
 }
 async call(m,task,action){const requestId=randomUUID();let response=await this.bridge.invokeCapability(task.id,{name:'mission_web',input:{mission_id:m.id,action},requestId});if(response.status==='pending'&&this.bridge.orchestrator.inflight.has(requestId))response=await this.bridge.orchestrator.inflight.get(requestId);if(this.uncertainBrowsers.has(m.id))throw error('web_termination_unverified');if(response.status!=='completed')throw error('mission_web_preflight_stopped');return response;}
 createResearch(input,owner='operator'){
  if(owner!=='operator')throw error('operator_web_consent_required');object(input,['request_id','objective','mode','entries','query','confirmed']);
  const p=policy.normalize(inputPolicy(input));
  return this.store.request(owner,'web-research:'+input.request_id,{op:'public_web_research',...input},()=>{
   const created=this.service.research.create({request_id:input.request_id,objective:input.objective,entry_url:p.entries[0]||'https://html.duckduckgo.com/html/',public_web:inputPolicy(input)});
   this.configure(created.mission_id,{...inputPolicy(input),request_id:randomUUID()});return created;
  });
 }
 async launchResearch(dispatch,m){
  const research=this.service.research,task=research.assertContract(m,{execution:true}),runId=randomUUID(),deadline=m.envelope.manifest.expires_at;
  let started=false;
  try{
   transaction(this.db,()=>{this.store.startRun({id:runId,taskId:task.id,missionId:m.id,agentId:'host'});this.store.acquireLease({resource:m.envelope.workspace,runId,missionId:m.id,mode:'read',baseline:m.envelope.baseline,ttlMs:Math.max(1,deadline-Date.now())});this.store.updateRun(runId,{state:'running',processState:'not_started'});this.db.prepare("UPDATE cp_dispatches SET state='running',run_id=? WHERE id=?").run(runId,dispatch.id);this.store.state(m.id,'running');task.activeRunId=runId;task.status='running';task.assignedAgent='host';task.mission.started=true;task.mission.status='active';require('./execution-evidence').begin(task,runId);this.bridge.tasks.save(task);started=true;});
   research.phase(m.id,'browser');await this.preflight(m,task);
   const grant=this.grant(m),records=this.rows(m,runId).map(r=>this.read(r));
   if(grant.policy.mode==='all'&&grant.policy.query){for(const link of records.flatMap(r=>r.links||[]).slice(0,2)){try{await this.call(m,task,{type:'explore',url:link.url});}catch{this.store.event('mission.web.source_inaccessible',m.id,{reason:'public_source_unavailable'});}}}
   this.verify(m,this.store.run(runId));const evidence=this.rows(m,runId).map(r=>this.read(r)),baseline=research.baseline(m.envelope.workspace),browserRows=evidence.filter(r=>r.browser_evidence).map(r=>r.browser_evidence),scope={origins:grant.policy.origins.length?grant.policy.origins:[new URL(m.envelope.manifest.entry_url).origin],publicDiscovery:grant.policy.mode==='all',maxOrigins:grant.policy.max_origins};
   const reporter=new (require('./research-report').ResearchReport)({baseline,evidenceStore:{verify:row=>require('./research-browser').verifyEvidence(row,{evidenceDir:this.directory(task),scope})}});
   const built=await reporter.build({competitor:m.envelope.manifest.entry_url,evidence:browserRows,baselineSnapshot:m.envelope.research_baseline});const report=JSON.parse(JSON.stringify(built));
   const sourceLines=evidence.filter(e=>e.source).flatMap(e=>e.links?.length?e.links.map(l=>'• Documented search result: '+l.text+' — '+l.url):['• Documented public source: '+e.url]);
   if(sourceLines.length)report.markdown+='\n\nPublic source provenance\n'+sourceLines.join('\n')+'\nSearch titles are source claims; website functionality has not been established by search.\n';
   report.digest=hash(report.markdown);if(report.markdown.length>12000)throw error('web_report_bound');
   const bytes=Buffer.from(JSON.stringify({mission_id:m.id,run_id:runId,baseline_digest:m.envelope.research_baseline.digest,report})+'\n');fs.writeFileSync(path.join(this.directory(task),runId+'.report.json'),bytes,{mode:0o600,flag:'wx'});
   this.db.prepare('INSERT INTO cp_artifacts VALUES(?,?,?,?,?,?,?)').run(runId,m.id,runId,'web_report',runId,JSON.stringify({sha256:hash(bytes)}),Date.now());
   this.store.updateRun(runId,{state:'completed',processState:'not_started',verified:true,result:{web_report:{sha256:hash(bytes)},native_execution_evidence:{...task.nativeExecutionEvidence}}});research.phase(m.id,'browser','completed');research.phase(m.id,'report','completed');
   this.service.captureResult(runId,{status:'completed',result:{text:JSON.stringify({summary:'Public web research evidence and current Arecibo comparison prepared for owner review.',changed_files:[],tests:[],artifacts:[],limitations:['Account-only areas remain inaccessible. Recommendations require separate authorization.']})}});
  }catch(e){
   const uncertain=e.code==='web_termination_unverified'||this.uncertainBrowsers.has(m.id);if(started){this.store.updateRun(runId,{state:uncertain?'termination_unverified':'failed',processState:uncertain?'unknown':'not_started',verified:!uncertain,resolution:/^[a-z_]+$/.test(e.code||'')?e.code:'public_web_stopped'});}
   this.db.prepare("UPDATE cp_dispatches SET state=? WHERE id=?").run(uncertain?'unknown':'blocked',dispatch.id);if(this.store.getMission(m.id).state!=='cancelled')this.store.state(m.id,'blocked',e.code==='approved_search_provider_unavailable'?'No approved search provider is configured. No search results were invented.':e.code||'Public research stopped safely.');
  }finally{delete task.activeRunId;this.bridge.tasks.save(task);this.bridge.emit('change');}
 }
 researchArtifact(m,run){
  this.service.research.assertContract(m);this.verify(m,run);if(run.state!=='completed'||!run.termination_verified)throw error('verified_web_report_required');
  const artifact=this.db.prepare("SELECT * FROM cp_artifacts WHERE id=? AND mission_id=? AND run_id=? AND kind='web_report'").get(run.id,m.id,run.id);if(!artifact||JSON.parse(artifact.metadata).sha256!==run.result.web_report?.sha256)throw error('web_report_integrity_denied');
  const fd=fs.openSync(path.join(this.directory(this.bridge.tasks.get(run.task_id)),run.id+'.report.json'),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.mode&0o077||stat.uid!==process.getuid?.()||stat.size>262144)throw error('web_report_integrity_denied');const bytes=fs.readFileSync(fd);if(hash(bytes)!==run.result.web_report.sha256)throw error('web_report_integrity_denied');const value=JSON.parse(bytes);if(value.mission_id!==m.id||value.run_id!==run.id||value.baseline_digest!==m.envelope.research_baseline.digest||value.report.digest!==hash(value.report.markdown))throw error('web_report_integrity_denied');return value;}finally{fs.closeSync(fd);}
 }
 verifyResearch(m,run){try{
  const result=this.researchArtifact(m,run),checks=[],add=(id,status,evidence)=>checks.push({id,status,evidence});
  add('web_evidence','passed',this.verify(m,run));add('browser_termination','passed',{termination_verified:true});add('artifact_integrity','passed',{immutable_artifacts_rehashed:true});
  add('native_execution',require('./execution-evidence').runSatisfied(run)?'passed':'failed',{completed_invocations:this.rows(m,run.id).length});
  const current=this.service.research.safeSnapshot(m);add('read_only_boundary',current.hash===m.envelope.baseline.hash?'passed':'failed',{approved_sources_unchanged:current.hash===m.envelope.baseline.hash});
  add('baseline_integrity','passed',{baseline_digest:result.baseline_digest});add('verification_workspace_stable',current.hash===m.envelope.baseline.hash?'passed':'failed',{scope:'approved_research_sources'});add('report','operator_review',{owner_review_required:true});
  return {status:checks.some(c=>c.status==='failed')?'failed':'operator_review',checks,workspace_hash:current.hash};
 }catch{return {status:'failed',checks:[{id:'web_evidence',status:'failed',evidence:{reason:'web_evidence_unavailable'}}],workspace_hash:'unavailable'};}}

 report(m){const run=this.db.prepare("SELECT id FROM cp_runs WHERE mission_id=? AND agent_id='host' AND state='completed' ORDER BY ended_at DESC").all(m.id).map(r=>this.store.run(r.id)).find(r=>r.result?.web_report);if(!run)throw error('web_report_unavailable');const value=this.researchArtifact(m,run),report=stripPaths(value.report);return {mission_id:m.id,markdown:report.markdown,report,screenshots:this.rows(m,run.id).map(r=>this.read(r).browser_evidence).filter(r=>r?.screenshot_ref).map(r=>({id:r.id,viewport:r.viewport,sha256:r.screenshot_ref.sha256})),accepted:m.state==='completed',authority:false};}
 evidence(m,id){if(!policy.UUID.test(id||''))throw error('web_evidence_scope_denied');this.report(m);const runRows=this.rows(m).map(r=>({row:r,value:this.read(r)})),found=runRows.find(r=>r.value.browser_evidence?.id===id&&r.value.browser_evidence?.screenshot_ref?.id===id);if(!found)throw error('web_screenshot_unavailable');this.researchArtifact(m,this.store.run(found.row.run_id));const ref=found.value.browser_evidence.screenshot_ref;if(ref.path!==path.join(this.directory(this.bridge.tasks.get(m.task_id)),id+'.png'))throw error('web_evidence_scope_denied');const fd=fs.openSync(ref.path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.mode&0o077||stat.uid!==process.getuid?.()||stat.size>4194304)throw error('web_evidence_integrity_denied');const buffer=fs.readFileSync(fd);if(hash(buffer)!==ref.sha256)throw error('web_evidence_integrity_denied');return {buffer,mime:'image/png'};}finally{fs.closeSync(fd);}}
 cancel(id){this.active.get(id)?.abort();}
 async close(){for(const [id,browser] of this.uncertainBrowsers){try{const result=await browser.close();if(result?.closed&&result.termination_verified&&result.owned_process_termination==='verified'){this.uncertainBrowsers.delete(id);this.active.delete(id);}}catch{}}for(const c of this.active.values())c.abort();const until=Date.now()+15000;while(this.active.size&&Date.now()<until)await new Promise(r=>setTimeout(r,20));if(this.active.size)throw error('web_termination_unverified');}
}
function stripPaths(value){if(Array.isArray(value))return value.map(stripPaths);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k,v])=>k!=='evidence_dir'&&!(k==='path'&&typeof v==='string'&&path.isAbsolute(v))).map(([k,v])=>[k,stripPaths(v)]));return value;}
function inputPolicy(input){return Object.fromEntries(['mode','entries','query','confirmed'].filter(k=>input[k]!==undefined).map(k=>[k,input[k]]));}
module.exports={MissionWeb};
