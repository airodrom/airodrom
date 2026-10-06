'use strict';
const {transaction}=require('../control-transaction');
const ALERTS=new Set(['Possibly Stalled','Stalled']);
const STATUSES=new Set(['Healthy','Possibly Stalled','Stalled','Recovered']);
const STATES=new Set(['alive','dead','unknown','absent','not_started','exited']);
const LEASES=new Set(['held','released','none','not_required','quarantined','expired']);
function formatHealth(taskId,health){
 const seconds=n=>Number.isFinite(n)&&n>=0?`${Math.floor(n/1000)}s`:'unknown';
 const score=Number.isInteger(health.score)&&health.score>=0&&health.score<=100?`${health.score}%`:'unknown';
 return `Task Health: ${health.status} · Score: ${score}\nTask: ${taskId}\nProcess: ${STATES.has(health.processState)?health.processState:'unknown'} · Lease: ${LEASES.has(health.leaseState)?health.leaseState:'unknown'}\nHeartbeat age: ${seconds(health.heartbeatAgeMs)} · Event age: ${seconds(health.eventAgeMs)} · Output age: ${seconds(health.outputAgeMs)}\nElapsed: ${seconds(health.elapsedMs)} · Budget: ${seconds(health.budgetMs)}`;
}
class TaskHealthSlack {
 constructor(runtime){this.runtime=runtime;this.db=runtime.db;this.db.exec(`CREATE TABLE IF NOT EXISTS cp_task_health_slack(task_id TEXT PRIMARY KEY,run_id TEXT,status TEXT NOT NULL,revision INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS cp_slack_health_outbox(id TEXT PRIMARY KEY,mission_id TEXT,kind TEXT NOT NULL,body TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL,next_at INTEGER NOT NULL,created_at INTEGER NOT NULL,remote_ts TEXT);`);require('./slack-gateway').prepareSlackOutboxSchema(this.db,'cp_slack_health_outbox');}
 poll(){
 const r=this.runtime,c=r.gateway.config;
 if(r.stopped||!c.enabled||!c.outboundEnabled||c.connectorsEnabled===false||!c.channelIds?.length||!r.bridge.taskHealth)return;
 for(const task of r.bridge.tasks.list()){
  if(!/^[A-Za-z0-9_.:-]{1,160}$/.test(task.id))continue;
  const h=r.bridge.taskHealth(task);if(!STATUSES.has(h.status))continue;
  const runId=r.bridge.leases?.get(task.id)?.runId||this.db.prepare('SELECT id FROM cp_runs WHERE task_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(task.id)?.id||task.activeRunId||null;
  transaction(this.db,()=>{
   const previous=this.db.prepare('SELECT * FROM cp_task_health_slack WHERE task_id=?').get(task.id);
   const sameRun=previous&&previous.run_id===runId;
   // Do not page for historical inactive tasks or replay unchanged observations.
   if(!h.active&&!(sameRun&&h.status==='Recovered'&&ALERTS.has(previous.status)))return;
   if(sameRun&&previous.status===h.status)return;
   const notify=ALERTS.has(h.status)||(sameRun&&ALERTS.has(previous.status)&&['Healthy','Recovered'].includes(h.status));
   const revision=(previous?.revision||0)+1;
   if(notify){
    const mission=r.store.missionForTask(task.id);
    const route=mission?this.db.prepare('SELECT channel_id,thread_ts FROM cp_slack_threads WHERE mission_id=?').get(mission.id):null;
    const channel=route?.channel_id||c.channelIds[0];if(!c.channelIds.includes(channel))return;
    const mention=(c.operatorIds||[]).filter(id=>/^U[A-Z0-9]+$/.test(id)).map(id=>`<@${id}>`).join(' ');
    r.enqueueHealth(mission?.id||null,'task_health',{channel,...(route?{thread_ts:route.thread_ts}:{}),text:`${mention} ${formatHealth(task.id,h)}`,unfurl_links:false,unfurl_media:false},`task-health:${task.id}:${runId}:${revision}`);
   }
   this.db.prepare('INSERT INTO cp_task_health_slack VALUES(?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET run_id=excluded.run_id,status=excluded.status,revision=excluded.revision').run(task.id,runId,h.status,revision);
  });
 }
 }
}
module.exports={TaskHealthSlack,formatHealth};
