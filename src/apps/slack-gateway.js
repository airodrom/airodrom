'use strict';
const { transaction, text, redactValue } = require('../control-plane-store');
const {randomUUID}=require('node:crypto');
const {afterCommit}=require('../control-transaction');
const QUIET_LOGGER = { debug(){}, info(){}, warn(){}, error(){}, setLevel(){}, getLevel(){return 'error';}, setName(){} };
const AUTH_ERRORS = new Set(['invalid_auth','not_authed','token_revoked','account_inactive','invalid_app_token','team_access_not_granted']);
function prepareSlackOutboxSchema(db,table){
  if(!['cp_slack_outbox','cp_slack_health_outbox'].includes(table))throw Error('Unknown Slack intent store');
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))return;
  if(!db.prepare(`PRAGMA table_info(${table})`).all().some(c=>c.name==='source_key'))db.exec(`ALTER TABLE ${table} ADD COLUMN source_key TEXT`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${table}_source_key ON ${table}(source_key) WHERE source_key IS NOT NULL`);
}

// SDKs are loaded only after explicit enablement. Secrets come from an injected
// credential resolver and are never placed in durable configuration or events.
function socketTransport({ appToken, botToken }) {
  const { SocketModeClient } = require('@slack/socket-mode');
  const { WebClient } = require('@slack/web-api');
  const options = { timeout: 10000, logger: QUIET_LOGGER, retryConfig: { retries: 0 }, rejectRateLimitedCalls: true };
  const socket = new SocketModeClient({ appToken, logger: QUIET_LOGGER, autoReconnectEnabled: false, clientOptions: options });
  const web = new WebClient(botToken, options);let closing=false;
  return {
    connect: async (receive, offline) => {
      socket.on('slack_event', receive); socket.on('disconnected', error=>{if(!closing)offline(error);}); socket.on('error', error=>{if(!closing)offline(error);});
      const identity = await web.auth.test(); await socket.start(); return identity;
    },
    send: body => web.chat.postMessage(body),
    update: body => web.chat.update(body),
    close: () => {closing=true;return socket.disconnect();}
  };
}
class SlackGateway {
  constructor({ store, config = {}, resolveCredential, transportFactory = socketTransport, schedule = setTimeout, cancel = clearTimeout, random = Math.random, stopMission = null }) {
    this.store=store;this.db=store.db;this.config=config;this.resolveCredential=resolveCredential;this.transportFactory=transportFactory;
    prepareSlackOutboxSchema(this.db,'cp_slack_outbox');prepareSlackOutboxSchema(this.db,'cp_slack_health_outbox');
    this.outbox=store.outbox;
    this.outbox.register('slack_message',async row=>{
      if(this.stopped||this.config.enabled!==true||this.state!=='connected'||this.config.outboundEnabled!==true)throw Object.assign(Error('Disabled'),{failureClass:'transient'});
      if(!this.config.channelIds?.includes(row.payload.channel))throw Object.assign(Error('Route denied'),{failureClass:'policy'});
      const payload={...row.payload};
      if(payload.thread_root_ref){
        const parent=this.db.prepare('SELECT state,remote_ts,body FROM cp_slack_health_outbox WHERE id=?').get(payload.thread_root_ref);
        if(!parent||parent.state!=='delivered'||JSON.parse(parent.body).channel!==payload.channel)throw Object.assign(Error('Thread root is not confirmed'),{failureClass:'transient'});
        payload.thread_ts=parent.remote_ts;delete payload.thread_root_ref;
      }
      let updating=false;
      if(payload.update_root_ref){
        const parent=this.db.prepare('SELECT state,remote_ts,body,kind FROM cp_slack_health_outbox WHERE id=?').get(payload.update_root_ref);
        if(!parent||!['ci_dashboard','ci_ui'].includes(parent.kind)||parent.state!=='delivered'||JSON.parse(parent.body).channel!==payload.channel)throw Object.assign(Error('Update target is not confirmed'),{failureClass:'policy'});
        if(typeof this.transport.update!=='function')throw Object.assign(Error('Updates unavailable'),{failureClass:'unsupported_destination'});
        payload.ts=parent.remote_ts;delete payload.update_root_ref;delete payload.thread_ts;delete payload.reply_broadcast;delete payload.unfurl_links;delete payload.unfurl_media;updating=true;
      }
      let result;try{result=updating?await this.transport.update(payload):await this.transport.send({...payload,client_msg_id:row.id});}catch(error){throw Object.assign(Error('Delivery failed'),{failureClass:AUTH_ERRORS.has(error.code)?'auth':error.code==='slack_webapi_rate_limited_error'?'transient':'delivery_unknown'});}
      if(!result||result.ok!==true||result.channel!==row.payload.channel||typeof result.ts!=='string'||!/^\d+\.\d+$/.test(result.ts))throw Object.assign(Error('No confirmed receipt'),{failureClass:AUTH_ERRORS.has(result?.error)?'auth':'delivery_unknown'});
      try{transaction(this.db,()=>{const healthTable=Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='cp_slack_health_outbox'").get());const legacyRow=this.db.prepare('SELECT * FROM cp_slack_outbox WHERE id=?').get(row.destination_ref);const table=legacyRow?'cp_slack_outbox':'cp_slack_health_outbox';const legacy=legacyRow||(healthTable?this.db.prepare('SELECT * FROM cp_slack_health_outbox WHERE id=?').get(row.destination_ref):null);if(!legacy)throw Error('Missing Slack intent');this.db.prepare(`UPDATE ${table} SET state='delivered',remote_ts=?,attempts=attempts+1 WHERE id=?`).run(result.ts,legacy.id);if(legacy.kind==='thread_root')this.bindThread(legacy.mission_id,row.payload.channel,result.ts);this.store.event('slack.message.sent',legacy.mission_id,{outbox_id:row.id,kind:legacy.kind,dispatch_path:'native_workflow'});if(legacy.kind==='decision')this.store.event('decision.presented',legacy.mission_id,{outbox_id:row.id});});}catch{throw Object.assign(Error('Receipt persistence unresolved'),{failureClass:'delivery_unknown'});}return{message_ref:result.ts};
    });
    this.schedule=schedule;this.cancel=cancel;this.random=random;this.stopMission=stopMission;this.state='disabled';this.attempt=0;this.stopped=false;this.transport=null;
  }
  observe(state) { this.state=state;transaction(this.db,()=>{this.store.observeAgent('slack','connector',{state,connected:state==='connected'});const event={type:state==='connected'?'slack.gateway.connected':'slack.gateway.disconnected',mission:null,metadata:{state}};try{this.store.event(event.type,null,event.metadata);}catch{this.db.prepare('INSERT INTO cp_pending_events VALUES(?,?,?)').run(require('node:crypto').randomUUID(),JSON.stringify(event),this.store.now());}}); }
  async start() {
    if(this.config.enabled!==true||this.config.connectorsEnabled===false){this.observe('disabled');return;}
    if(!/^T[A-Z0-9]+$/.test(this.config.teamId||'')||!Array.isArray(this.config.operatorIds)||this.config.operatorIds.length!==1||!this.config.operatorIds.every(id=>/^U[A-Z0-9]+$/.test(id))||!Array.isArray(this.config.channelIds)||this.config.channelIds.length!==1||!this.config.channelIds.every(id=>/^[CG][A-Z0-9]+$/.test(id))||!/^U[A-Z0-9]+$/.test(this.config.botUserId||'')||!this.config.appTokenRef||!this.config.botTokenRef) {this.observe('unconfigured');return;}
    if(this.connecting||this.stopped||this.state==='authentication_failed')return;
    this.connecting=true;this.observe('connecting');
    try {
      const appToken=await this.resolveCredential(this.config.appTokenRef),botToken=await this.resolveCredential(this.config.botTokenRef);
      if(!appToken||!botToken)throw Object.assign(new Error('Missing credential'),{code:'invalid_auth'});
      if(this.stopped)return;
      const transport=this.transportFactory({appToken,botToken});this.transport=transport;
      const identity=await transport.connect(event=>{this.receive(event).catch(()=>{if(!this.stopped)this.observe('degraded');});},error=>this.offline(error));
      if(identity.team_id!==this.config.teamId||!identity.user_id||(this.config.botUserId&&identity.user_id!==this.config.botUserId))throw Object.assign(new Error('Identity mismatch'),{code:'invalid_auth'});
      if(this.stopped){await transport.close();return;}this.attempt=0;if(this.timer)this.cancel(this.timer);this.timer=null;this.observe('connected');
    } catch(error) { await this.offline(error); } finally {this.connecting=false;}
  }
  async offline(error={}) {
    if(this.stopped||this.state==='authentication_failed')return;
    const code=error.data?.error||error.code;
    if(AUTH_ERRORS.has(code)){this.observe('authentication_failed');const old=this.transport;this.transport=null;await old?.close().catch(()=>{});return;}
    if(this.timer)return;this.observe('reconnecting');
    const delay=Math.min(60000,1000*2**Math.min(this.attempt++,6))*(0.5+this.random()*0.5);
    this.timer=this.schedule(async()=>{this.timer=null;const old=this.transport;this.transport=null;await old?.close().catch(()=>{});await this.start();},delay);
    this.timer?.unref?.();
  }
  async stop() {if(this.stopped)return;this.stopped=true;if(this.timer)this.cancel(this.timer);this.timer=null;await this.transport?.close();this.transport=null;this.observe('offline');}
  bindThread(missionId,channelId,threadTs) {
    this.store.requireMission(missionId);
    if(!this.config.channelIds?.includes(channelId)||!/^\d+\.\d+$/.test(threadTs))throw Error('Unconfigured Slack route');
    this.db.prepare('INSERT INTO cp_slack_threads VALUES(?,?,?,?) ON CONFLICT(mission_id) DO UPDATE SET team_id=excluded.team_id,channel_id=excluded.channel_id,thread_ts=excluded.thread_ts').run(missionId,this.config.teamId,channelId,threadTs);
  }
  async receive({envelope_id,body,ack}) {
    if(this.stopped||this.state!=='connected'||this.config.enabled!==true){await ack();return;}
    const event=body.event||{},team=body.team_id||body.team?.id,user=event.user||body.user?.id;
    const channel=event.channel||body.channel?.id,thread=event.thread_ts||body.message?.thread_ts||body.message?.ts;
    if(team!==this.config.teamId||!this.config.operatorIds.includes(user)||!this.config.channelIds.includes(channel)||event.bot_id||event.subtype||body.user?.is_bot){await ack();return;}
    if(body.actions?.[0]?.action_id?.startsWith('ci_ui_')){try{this.onCIAction?.({envelope_id,body});}finally{await ack();}return;}
    if(this.config.decisionsEnabled!==true){await ack();return;}
    const binding=this.db.prepare('SELECT * FROM cp_slack_threads WHERE team_id=? AND channel_id=? AND thread_ts=?').get(team,channel,thread);
    if(!binding){await ack();return;}
    let proposal;
    const action=body.actions?.[0];
    if(action) {
      try {proposal=JSON.parse(action.value);}catch{await ack();return;}
      if(!proposal||typeof proposal!=='object'){await ack();return;}
      const d=this.store.decision(proposal.decision_id);
      if(!d||d.mission_id!==binding.mission_id||d.nonce!==proposal.nonce||d.kind!=='question'){await ack();return;}
      proposal={decision_id:d.id,option_id:proposal.option_id??null,action:action.action_id?.startsWith('decision_answer:')?'decision_answer':action.action_id};
      if(!['decision_answer','show_details','stop_mission'].includes(proposal.action)){await ack();return;}
    } else {
      if(typeof event.text!=='string'||event.text.length>4200){await ack();return;}
      const match=/^decision:([A-Za-z0-9_.:-]+)\s+([\s\S]+)$/.exec(event.text);
      const pending=this.store.decisions(binding.mission_id).filter(d=>d.state==='waiting_for_operator'&&d.kind==='question');
      const d=match?pending.find(d=>d.id===match[1]):pending.length===1?pending[0]:null;
      if(!d){await ack();return;}proposal={decision_id:d.id,free_text:match?match[2]:event.text,action:'decision_answer'};
    }
    const receiptId=body.event_id||envelope_id;
    if(typeof receiptId!=='string'||!receiptId.length||receiptId.length>200){await ack();return;}
    const receipt={...proposal,mission_id:binding.mission_id,actor:user,team,channel,thread};
    // Validate sensitive free text before retaining it. Unknown/expired answers
    // cannot trigger execution; the shared service owns answer semantics.
    try {if(receipt.free_text)text(receipt.free_text,'Slack answer',4000);}catch{await ack();return;}
    transaction(this.db,()=>this.db.prepare("INSERT OR IGNORE INTO cp_slack_inbox VALUES(?,?,'received',?)").run(receiptId,JSON.stringify(receipt),this.store.now()));
    await ack();try{this.processReceipt(receiptId);}catch{this.db.prepare("UPDATE cp_slack_inbox SET state='rejected' WHERE id=?").run(receiptId);}
  }
  processReceipt(id) {
    if(this.stopped||this.config.enabled!==true||this.config.decisionsEnabled!==true)return;
    transaction(this.db,()=>{
      const row=this.db.prepare('SELECT * FROM cp_slack_inbox WHERE id=?').get(id);if(!row||row.state!=='received')return;
      const r=JSON.parse(row.receipt);
      if(r.team!==this.config.teamId||!this.config.operatorIds.includes(r.actor)||!this.config.channelIds.includes(r.channel)||!this.db.prepare('SELECT 1 FROM cp_slack_threads WHERE mission_id=? AND team_id=? AND channel_id=? AND thread_ts=?').get(r.mission_id,r.team,r.channel,r.thread)){this.db.prepare("UPDATE cp_slack_inbox SET state='denied' WHERE id=?").run(id);return;}
      if(r.action==='decision_answer'){
        const decision=this.store.answerDecision(r.decision_id,{option_id:r.option_id??null,free_text:r.free_text??null,actor:r.actor,surface:'slack'});
        const message={channel:r.channel,thread_ts:r.thread,text:`Decision ${decision.id}: ${decision.state}${decision.already_answered?' (already resolved; no new continuation)':''}.`,unfurl_links:false,unfurl_media:false};
        this.enqueueIntent('cp_slack_outbox',r.mission_id,'decision_status',message,`answer-status:${id}`);
        if(decision.state==='answered'&&!decision.already_answered)afterCommit(this.db,()=>this.onAnswer?.());
      }
      else if(r.action==='stop_mission') {
        // No transport-specific cancellation or hidden approval bypass.
        // Remains pending when a shared, transactional stop service is absent.
        if(!this.stopMission)return;
        this.stopMission(r.mission_id,{actor:r.actor,surface:'slack'});
      } else {
        const route=this.db.prepare('SELECT * FROM cp_slack_threads WHERE mission_id=?').get(r.mission_id);
        const details=this.details?.(r.decision_id)||{note:'Inspect the Control Hub for evidence.'};
    const body={channel:route.channel_id,thread_ts:route.thread_ts,text:JSON.stringify(redactValue(details)).slice(0,2800),unfurl_links:false,unfurl_media:false};
        this.enqueueIntent('cp_slack_outbox',r.mission_id,'details',body,`details:${id}`);
        this.store.event('decision.details_requested',r.mission_id,{decision_id:r.decision_id});
      }
      this.store.event('slack.interaction.received',r.mission_id,{decision_id:r.decision_id,action:r.action});
      this.db.prepare("UPDATE cp_slack_inbox SET state='processed' WHERE id=?").run(id);
    });
  }
  enqueueDecision(id) {
    const d=this.store.decision(id);if(!d||d.kind!=='question'||d.state!=='waiting_for_operator')throw Error('Ordinary pending decision required');
    const route=this.db.prepare('SELECT * FROM cp_slack_threads WHERE mission_id=?').get(d.mission_id);if(!route)throw Error('Mission has no Slack thread');
    const value=option=>JSON.stringify({decision_id:id,nonce:d.nonce,option_id:option});
    const buttons=d.options.map(o=>({type:'button',text:{type:'plain_text',text:o.label.slice(0,75)},action_id:'decision_answer',value:value(o.id)}));
    // Distinct action IDs are required within Slack action blocks.
    buttons.forEach((b,i)=>{b.action_id=`decision_answer:${i}`;});
    buttons.push({type:'button',text:{type:'plain_text',text:'Show details'},action_id:'show_details',value:value(null)},{type:'button',text:{type:'plain_text',text:'Stop mission'},action_id:'stop_mission',value:value(null)});
    const body={channel:route.channel_id,thread_ts:route.thread_ts,text:this.config.operatorIds.map(id=>`<@${id}>`).join(' ')+' '+d.question,unfurl_links:false,unfurl_media:false,blocks:[{type:'section',text:{type:'plain_text',text:(d.question+'\n\n'+d.options.map(o=>o.label+(o.recommended?' (Recommended)':'')+(o.description?' — '+o.description:'')).join('\n')).slice(0,3000)}},...(buttons.length?[{type:'actions',elements:buttons}]:[]),{type:'context',elements:[{type:'mrkdwn',text:this.config.operatorIds.map(id=>`<@${id}>`).join(' ')+' · Your decision is needed.'}]}]};
    return this.enqueueIntent('cp_slack_outbox',d.mission_id,'decision',body,`decision:${id}`);
  }
  enqueueIntent(table,missionId,kind,body,sourceKey){
    require('../memory-content-erasure').assertReadable(this.db);
    if(!['cp_slack_outbox','cp_slack_health_outbox'].includes(table)||typeof sourceKey!=='string'||!sourceKey.length||sourceKey.length>512)throw Error('Invalid Slack intent correlation');
    return transaction(this.db,()=>{const prior=this.db.prepare(`SELECT id FROM ${table} WHERE source_key=?`).get(sourceKey);if(prior)return prior.id;const id=randomUUID(),now=this.store.now();this.db.prepare(`INSERT INTO ${table}(id,mission_id,kind,body,state,attempts,next_at,created_at,remote_ts,source_key) VALUES(?,?,?,?,'queued',0,?,?,NULL,?)`).run(id,missionId,kind,JSON.stringify(body),now,now,sourceKey);return id;});
  }
  async flush() {
    if(this.stopped||this.config.enabled!==true||this.state!=='connected'||this.config.outboundEnabled!==true)return;
    const tables=['cp_slack_outbox'];if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='cp_slack_health_outbox'").get())tables.push('cp_slack_health_outbox');
    for(const table of tables)for(const row of this.db.prepare(`SELECT * FROM ${table} WHERE state='queued'`).all())this.outbox.enqueue({key:`slack:${row.id}`,destination:'slack_message',ref:row.id,eventType:'slack.notification',correlation:{mission_id:row.mission_id},payload:JSON.parse(row.body)});
    await this.outbox.dispatch();
    for(const table of tables)for(const row of this.db.prepare("SELECT destination_ref,status,attempts FROM cp_effect_outbox WHERE destination_type='slack_message' AND status IN ('delivery_unknown','dead_letter')").all())this.db.prepare(`UPDATE ${table} SET state=?,attempts=? WHERE id=? AND state='queued'`).run(row.status,row.attempts,row.destination_ref);
  }
}
module.exports={SlackGateway,socketTransport,prepareSlackOutboxSchema};
