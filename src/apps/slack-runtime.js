'use strict';
const {SlackGateway}=require('../slack-gateway');
const {fingerprint,redactValue,object,identifier}=require('../control-plane-store');
const {transaction}=require('../control-transaction');
const {randomUUID}=require('node:crypto');
const ROUTES={ 'agent.dispatch.waiting':'important', 'agent.dispatch.fallback_selected':'important','agent.dispatch.circuit_open':'important','agent.dispatch.circuit_closed':'important', 'codex.result.published':'important', 'mission.created':'info','run.started':'progress','verification.completed':'important','decision.requested':'decision_required','mission.completed':'important','mission.blocked':'important','mission.stop_requested':'important','decision.answered':'important','decision.expired':'important','decision.cancelled':'important','decision.superseded':'important' };
class SlackRuntime{
 constructor(bridge,options={}){
  this.bridge=bridge;this.store=bridge.controlStore;this.db=this.store.db;
  this.options=options;this.stopped=false;this.presence={app_token_present:false,bot_token_present:false};
  const env=options.env||process.env;
  const saved=this.db.prepare('SELECT config FROM cp_slack_config WHERE id=1').get();
  const config=options.config||(saved?JSON.parse(saved.config):null)||{enabled:env.SLACK_GATEWAY_ENABLED==='true',teamId:env.SLACK_TEAM_ID,operatorIds:(env.SLACK_OPERATOR_IDS||'').split(',').filter(Boolean),channelIds:(env.SLACK_CHANNEL_IDS||'').split(',').filter(Boolean),appTokenRef:'SLACK_APP_TOKEN',botTokenRef:'SLACK_BOT_TOKEN',outboundEnabled:env.SLACK_OUTBOUND_ENABLED==='true',decisionsEnabled:env.SLACK_DECISIONS_ENABLED==='true',connectorsEnabled:env.EXTERNAL_CONNECTORS_ENABLED!=='false'};
  this.createGateway(config);
  this.taskHealthNotifications=new(require('../task-health-slack').TaskHealthSlack)(this);
  this.ciFlow=new(require('../slack-ci-flow').SlackCIFlow)(this,options.ciFlow||{});
  this.db.prepare("INSERT OR IGNORE INTO cp_gateway_cursors VALUES('slack',0)").run();
  this.store.outbox.register('slack_event',row=>{transaction(this.db,()=>this.db.prepare('INSERT OR IGNORE INTO cp_slack_pending_events VALUES(?,?,?,?,?)').run(row.payload.event_id,row.correlation.mission_id,row.event_type,JSON.stringify({decision_id:row.payload.decision_id||null}),row.created_at));return{local_receipt:row.payload.event_id};},{idempotent:true});
  this.store.outbox.recover();
 }
 createGateway(config){
  const options=this.options,bridge=this.bridge;
  const resolver=options.resolveCredential||require('../slack-credentials').resolveSlackCredential;
  this.gateway=new SlackGateway({store:this.store,config,resolveCredential:async ref=>{const value=await resolver(ref);this.presence[ref==='SLACK_APP_TOKEN'?'app_token_present':'bot_token_present']=Boolean(value);return value;},...(options.transportFactory?{transportFactory:options.transportFactory}:{}),stopMission:(id,actor)=>bridge.missions.cancel(id,{request_id:`slack-stop:${id}`},'operator')});
  this.gateway.onCIAction=input=>this.ciFlow?.ui.interaction(input);
  this.gateway.details=id=>bridge.missions.decisionDetails(id);this.gateway.onAnswer=()=>bridge.missions.schedule();
 }
 status(){return{implemented:true,task_health_notifications:true,enabled:this.gateway.config.enabled===true,configured:Boolean(this.presence.app_token_present&&this.presence.bot_token_present&&this.gateway.config.teamId&&this.gateway.config.operatorIds?.length&&this.gateway.config.channelIds?.length),connected:this.gateway.state==='connected',state:this.gateway.state,...this.presence,workspace:this.gateway.config.teamId||null,operator_allowlist_valid:Boolean(this.gateway.config.operatorIds?.length),inbound_enabled:this.gateway.config.decisionsEnabled===true,outbound_enabled:this.gateway.config.outboundEnabled===true};}
 async start(){await this.gateway.start();}
 async credentialProbe(input){
  object(input,[]);
  if(this.bridge.closed)throw Error('Bridge is shutting down');
  const cycles=[];
  for(let i=0;i<3;i++){
   const app=await this.gateway.resolveCredential('SLACK_APP_TOKEN');
   const bot=await this.gateway.resolveCredential('SLACK_BOT_TOKEN');
   cycles.push({app_ref_readable:Boolean(app),bot_ref_readable:Boolean(bot),token_classes_valid:Boolean(app&&bot)});
  }
  return{execution_domain:'control_plane_internal',cycles,passed:cycles.every(c=>c.token_classes_valid)};
 }
 credentialAuthorize(input){
  object(input,['request_id','reference']);identifier(input.request_id);
  if(!Object.hasOwn(require('../slack-credentials').ACCOUNTS,input.reference))throw Error('Unknown Slack credential reference');
  if(this.bridge.closed||this.bridge.leases.size)throw Error('Credential authorization requires an idle control plane');
  if(this.credentialAuthorization){
   if(this.credentialAuthorization.request_id===input.request_id)return{...this.credentialAuthorization};
   if(this.credentialAuthorization.state==='pending')throw Error('Credential authorization already pending');
  }
  this.credentialAuthorization={request_id:input.request_id,reference:input.reference,state:'pending',execution_domain:'control_plane_internal'};
  require('../slack-credentials').authorizeSlackCredential(input.reference).then(result=>{
   this.credentialAuthorization={...this.credentialAuthorization,state:result.token_class_valid?'authorized':'denied',...result};
   this.store.event('slack.helper.authorization.settled',null,{state:this.credentialAuthorization.state,execution_domain:'control_plane_internal'});
  });
  return{...this.credentialAuthorization};
 }

 async tick(){if(this.busy||this.stopped||!this.gateway.config.enabled)return;this.busy=true;try{
   this.ciFlow.poll().catch(()=>{});
   this.taskHealthNotifications.poll();
   // Unprocessed durable inbound receipts survive a process restart.
   if(this.gateway.state==='connected'&&this.gateway.config.decisionsEnabled===true)for(const r of this.db.prepare("SELECT id FROM cp_slack_inbox WHERE state='received' LIMIT 50").all())this.gateway.processReceipt(r.id);
   await this.store.outbox.dispatch();
   await this.gateway.flush();
   let cursor=this.db.prepare("SELECT sequence FROM cp_gateway_cursors WHERE name='slack'").get().sequence;
   for(const event of this.bridge.ledger.list({afterSequence:cursor,limit:100}).events){
    const m=event.mission_id?this.store.getMission(event.mission_id):null;
    transaction(this.db,()=>{
      if(m?.envelope.control_version===2&&ROUTES[event.event_type])this.db.prepare('INSERT OR IGNORE INTO cp_slack_pending_events VALUES(?,?,?,?,?)').run(event.event_id,m.id,event.event_type,JSON.stringify({decision_id:event.metadata?.decision_id||null}),Date.now());
      this.db.prepare("UPDATE cp_gateway_cursors SET sequence=? WHERE name='slack'").run(event.sequence);
    });
   }
   for(const row of this.db.prepare("SELECT DISTINCT p.mission_id FROM cp_slack_pending_events p WHERE NOT EXISTS(SELECT 1 FROM cp_slack_threads t WHERE t.mission_id=p.mission_id) AND NOT EXISTS(SELECT 1 FROM cp_slack_outbox o WHERE o.mission_id=p.mission_id AND o.kind='thread_root') LIMIT 20").all()){
     const m=this.store.getMission(row.mission_id);this.enqueue(m.id,'thread_root',{channel:this.gateway.config.channelIds[0],text:`Mission: ${m.envelope.objective.slice(0,500)}`,unfurl_links:false,unfurl_media:false},`root:${m.id}`);
   }
   await this.store.outbox.dispatch();
   await this.gateway.flush();
   for(const event of this.db.prepare('SELECT p.*,t.channel_id,t.thread_ts FROM cp_slack_pending_events p JOIN cp_slack_threads t ON t.mission_id=p.mission_id ORDER BY p.created_at LIMIT 100').all())transaction(this.db,()=>{
     if(event.type==='decision.requested'){const d=this.store.decision(JSON.parse(event.metadata).decision_id);if(d?.state==='waiting_for_operator')this.gateway.enqueueDecision(d.id);}
     else {const progress=ROUTES[event.type]==='progress'||event.type==='mission.blocked';const key=progress?`progress:${event.type}:${event.mission_id}:${Math.floor(event.created_at/30000)}`:event.type==='mission.completed'?`completion:${event.mission_id}`:`event:${event.id}`;this.enqueue(event.mission_id,ROUTES[event.type],{channel:event.channel_id,thread_ts:event.thread_ts,text:`${event.type} · ${event.mission_id}`,unfurl_links:false,unfurl_media:false},key);}
     this.db.prepare('DELETE FROM cp_slack_pending_events WHERE id=?').run(event.id);
   });
   await this.store.outbox.dispatch();
   await this.gateway.flush();
  }finally{this.busy=false;}}
 healthTest(input){
  object(input,['request_id']);identifier(input.request_id);
  const identity=require('../memory-identity');require('../memory-content-erasure').assertReadable(this.db);
  if(identity.hasLegacyIdentifiers(input))throw Error('Legacy request identity requires migration');
  const c=this.gateway.config;
  if(this.stopped||!c.enabled||!c.outboundEnabled||c.connectorsEnabled===false||!c.channelIds?.length)throw Error('Slack outbound notifications are disabled');
  return this.store.request('operator',input.request_id,{action:'slack-health-test'},()=>{
   const key=randomUUID();
   const outboxId=this.enqueueHealth(null,'task_health_test',{channel:c.channelIds[0],text:(c.operatorIds||[]).filter(id=>/^U[A-Z0-9]+$/.test(id)).map(id=>`<@${id}>`).join(' ')+' Task Health notifications are enabled. You will receive alerts for Possibly Stalled and Stalled tasks, followed by recovery or healthy-again updates. Unchanged readings stay quiet.',unfurl_links:false,unfurl_media:false},key);
   return{queued:true,outbox_id:outboxId};
  });
 }
 enqueueHealth(missionId,kind,body,key){return this.gateway.enqueueIntent('cp_slack_health_outbox',missionId,kind,body,key);}
 enqueue(missionId,kind,body,key){return this.gateway.enqueueIntent('cp_slack_outbox',missionId,kind,body,key);}
 configure(input){
  const pending=(this.configurationQueue||Promise.resolve()).then(()=>this.configureOnce(input));
  this.configurationQueue=pending.catch(()=>{});return pending;
 }
 async configureOnce(input){
  if(this.bridge.closed)throw Error('Bridge is shutting down');
  object(input,['request_id','enabled','outboundEnabled','decisionsEnabled','teamId','operatorIds','channelIds','botUserId']);identifier(input.request_id);
  for(const k of ['enabled','outboundEnabled','decisionsEnabled'])if(typeof input[k]!=='boolean')throw Error('Explicit Slack flags required');
  if(!/^T[A-Z0-9]+$/.test(input.teamId)||!Array.isArray(input.operatorIds)||input.operatorIds.length!==1||!input.operatorIds.every(v=>/^U[A-Z0-9]+$/.test(v))||!Array.isArray(input.channelIds)||input.channelIds.length!==1||!input.channelIds.every(v=>/^[CG][A-Z0-9]+$/.test(v)))throw Error('One explicit operator and test channel required');
  if(!/^U[A-Z0-9]+$/.test(input.botUserId||''))throw Error('Invalid expected bot identity');
  const config={...input,appTokenRef:'SLACK_APP_TOKEN',botTokenRef:'SLACK_BOT_TOKEN',connectorsEnabled:this.gateway.config.connectorsEnabled!==false};delete config.request_id;
  if(this.gateway.config.teamId&&(this.gateway.config.teamId!==config.teamId||JSON.stringify(this.gateway.config.channelIds)!==JSON.stringify(config.channelIds)||JSON.stringify(this.gateway.config.operatorIds)!==JSON.stringify(config.operatorIds))&&this.db.prepare('SELECT 1 FROM cp_slack_threads LIMIT 1').get())throw Error('Existing thread identities require explicit migration');
  const result=this.store.request('operator',input.request_id,{op:'slack-configure',...input},()=>{this.db.prepare('INSERT INTO cp_slack_config VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config,updated_at=excluded.updated_at').run(JSON.stringify(config),Date.now());this.store.event('slack.configuration.updated',null,{enabled:config.enabled});return{configured:true};});
  const current=JSON.parse(this.db.prepare('SELECT config FROM cp_slack_config WHERE id=1').get().config);
  if(JSON.stringify(this.gateway.config)!==JSON.stringify(current)){await this.stop();if(this.bridge.closed)return this.status();this.stopped=false;this.createGateway(current);await this.start();}
  return{...result,...this.status()};
 }
 async stop(){this.stopped=true;this.gateway.config.enabled=false;this.gateway.config.decisionsEnabled=false;this.gateway.config.outboundEnabled=false;while(this.busy)await new Promise(resolve=>setTimeout(resolve,20));await this.gateway.stop();}
}
module.exports={SlackRuntime,ROUTES};
