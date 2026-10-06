'use strict';
const {randomUUID}=require('node:crypto');
const {fingerprint,object,identifier}=require('../control-plane-store');
const {transaction}=require('../control-transaction');
const {classSummary,flowMessages}=require('../slack-ci-flow');
const ACTIVE=new Set(['in_progress','queued','waiting','pending','requested']);
const FAILED=new Set(['failure','timed_out','action_required']);
const section=text=>({type:'section',text:{type:'mrkdwn',text}});
function classLabel(value){const states=value.split(', ');if(states.some(s=>FAILED.has(s)))return '❌ Failed';if(states.some(s=>ACTIVE.has(s)))return '⏳ Running';if(states.every(s=>s==='success'))return '✅ Passed';if(states.every(s=>s==='skipped'))return '— Skipped';return '· Not observed';}
function flowState(flow){if(flow.checks.some(c=>FAILED.has(c.state))||flow.workflows.some(w=>FAILED.has(w.state)))return 'attention';if(flow.checks.some(c=>ACTIVE.has(c.state))||flow.workflows.some(w=>ACTIVE.has(w.state)))return 'running';return 'settled';}
class SlackCIUI{
 constructor(flow){this.flow=flow;this.runtime=flow.runtime;this.db=flow.db;this.nextRefresh=0;this.db.exec('CREATE TABLE IF NOT EXISTS cp_slack_ci_views(view_key TEXT PRIMARY KEY,root_ref TEXT,hash TEXT,revision INTEGER NOT NULL,nonce TEXT NOT NULL)');}
 rows(){const repo=this.flow.config().repo;return this.db.prepare('SELECT pr,record,observed_at FROM cp_slack_ci_flows WHERE repo=? ORDER BY pr DESC').all(repo).map(r=>({...JSON.parse(r.record),observedAt:r.observed_at})).filter(f=>f.prState==='OPEN');}
 view(key){return this.db.prepare('SELECT * FROM cp_slack_ci_views WHERE view_key=?').get(key);}
 dashboard(){const key=this.flow.config().repo+':dashboard';let view=this.view(key);if(!view){this.db.prepare('INSERT INTO cp_slack_ci_views VALUES(?,NULL,NULL,0,?)').run(key,randomUUID());view=this.view(key);}return view;}
 button(label,value,id){return{type:'button',text:{type:'plain_text',text:label},action_id:`ci_ui_${id}`,value:JSON.stringify({repo:this.flow.config().repo,nonce:this.dashboard().nonce,...value})};}
 summary(flow){const classes=classSummary(flow),settled=flow.checks.filter(c=>!ACTIVE.has(c.state)&&c.state!=='unknown').length;return `A ${classLabel(classes.A)}  ·  B ${classLabel(classes.B)}  ·  C ${classLabel(classes.C)}\n${settled}/${flow.checks.length} checks concluded · ${flow.sha.slice(0,8)}${flow.draft?' · Draft':''}`;}
 overview(){const repo=this.flow.config().repo,rows=this.rows(),running=rows.filter(f=>flowState(f)==='running'),attention=rows.filter(f=>flowState(f)==='attention');
  const unavailable=this.db.prepare('SELECT count(*) n FROM cp_slack_ci_errors WHERE repo=?').get(repo).n;
  const classes=rows.map(classSummary);const classLine=id=>{const labels=classes.map(c=>classLabel(c[id]));const count=label=>labels.filter(v=>v===label).length;return `*Class ${id}*${id==='C'?' · manual/on-demand':''}\n${count('✅ Passed')} passed · ${count('⏳ Running')} running · ${count('❌ Failed')} failed · ${count('— Skipped')} skipped · ${count('· Not observed')} not observed`;};
  const blocks=[{type:'header',text:{type:'plain_text',text:'Arecibo · CI overview'}},section(`*${repo}* · ${rows.length} observed open PRs · ${rows.filter(f=>f.draft).length} drafts\n⏳ ${running.length} in progress   ·   ❌ ${attention.length} with failing checks`),{type:'section',fields:['A','B','C'].map(id=>({type:'mrkdwn',text:classLine(id)}))}];
  if(this.flow.error||unavailable)blocks.push(section('⚠️ GitHub observations are unavailable or incomplete. Last-observed details are retained.'));
  const spotlight=running.length?running:attention; if(spotlight.length)blocks.push(section(`*${running.length?'In progress':'Failing checks'}*\n`+spotlight.slice(0,3).map(f=>`<https://github.com/${repo}/pull/${f.number}|PR #${f.number}> · ${this.summary(f).split('\n')[0]}`).join('\n')));
  blocks.push({type:'actions',elements:[this.button('All PRs',{view:'list',filter:'all',page:0},'all'),this.button('In progress',{view:'list',filter:'running',page:0},'running'),this.button('Failing checks',{view:'list',filter:'attention',page:0},'attention')]},{type:'context',elements:[{type:'plain_text',text:`Updates in place · No routine mentions · Details open in a thread\nSkipped/reporter jobs do not prove tests passed. Last checked: ${this.flow.checkedAt?new Date(this.flow.checkedAt).toISOString():'Waiting for GitHub'}`} ]});
  return{text:`Arecibo CI overview · ${running.length} in progress · ${attention.length} with failing checks`,blocks};
 }
 refresh(){const r=this.runtime,c=this.flow.config();if(!c.enabled||r.stopped||!r.gateway.config.enabled||!r.gateway.config.outboundEnabled||r.gateway.config.connectorsEnabled===false||this.flow.now()<this.nextRefresh)return;this.nextRefresh=this.flow.now()+120000;this.render(c.repo+':dashboard',this.overview(),'ci_dashboard');}
 render(key,body,kind='ci_ui'){
  return transaction(this.db,()=>{
   let view=this.view(key);if(!view){this.db.prepare('INSERT INTO cp_slack_ci_views VALUES(?,NULL,NULL,0,?)').run(key,randomUUID());view=this.view(key);}
   const hash=fingerprint(body);if(view.hash===hash)return;
   const parent=view.root_ref?this.db.prepare('SELECT state,body FROM cp_slack_health_outbox WHERE id=?').get(view.root_ref):null;
   // One confirmed root per view. Unknown sends never create a replacement.
   if(parent&&parent.state!=='delivered')return;
   const channel=this.runtime.gateway.config.channelIds[0];if(parent&&JSON.parse(parent.body).channel!==channel)return;
   const revision=view.revision+1,messageKey=`ci-view:${fingerprint(key)}:${revision}`;
   const dashboard=this.dashboard();const payload={channel,...body,unfurl_links:false,unfurl_media:false,reply_broadcast:false};
   if(view.root_ref)payload.update_root_ref=view.root_ref;
   else if(kind!=='ci_dashboard'){if(!dashboard.root_ref)return;payload.thread_root_ref=dashboard.root_ref;}
   const intentId=this.runtime.enqueueHealth(null,kind,payload,messageKey);
   this.db.prepare('UPDATE cp_slack_ci_views SET root_ref=COALESCE(root_ref,?),hash=?,revision=? WHERE view_key=?').run(intentId,hash,revision,key);
  });
 }
 interaction({envelope_id,body}){
  const r=this.runtime,c=this.flow.config();if(!c.enabled||r.stopped||!r.gateway.config.enabled||!r.gateway.config.outboundEnabled)return;
  let input;try{input=JSON.parse(body.actions[0].value);object(input,['repo','nonce','view','filter','page','pr']);}catch{return;}
  const dashboard=this.dashboard();if(input.repo!==c.repo||input.nonce!==dashboard.nonce||!['list','detail'].includes(input.view)||!Number.isSafeInteger(input.page)||input.page<0||input.page>1000)return;
  const known=this.db.prepare('SELECT root_ref FROM cp_slack_ci_views WHERE root_ref IS NOT NULL').all().some(v=>{const row=this.db.prepare('SELECT state,remote_ts,body FROM cp_slack_health_outbox WHERE id=?').get(v.root_ref);return row?.state==='delivered'&&row.remote_ts===body.message?.ts&&JSON.parse(row.body).channel===body.channel?.id;});if(!known)return;
  const receipt=body.event_id||envelope_id;if(typeof receipt!=='string'||!receipt||receipt.length>200)return;
  let key;try{key=identifier(receipt);}catch{return;}
  return r.store.request('slack-ci-ui',key,input,()=>{
   if(input.view==='list'){
    if(!['all','running','attention'].includes(input.filter))return{ignored:true};const rows=this.rows().filter(f=>input.filter==='all'||flowState(f)===input.filter),pages=Math.max(1,Math.ceil(rows.length/10)),page=Math.min(input.page,pages-1);
    const blocks=[{type:'header',text:{type:'plain_text',text:`CI · ${input.filter==='all'?'All PRs':input.filter==='running'?'In progress':'Failing checks'}`}},section(`${rows.length} PRs · Page ${page+1}/${pages}`)];
    for(const f of rows.slice(page*10,page*10+10))blocks.push({...section(`<https://github.com/${c.repo}/pull/${f.number}|*PR #${f.number}*>\n${this.summary(f)}`),accessory:this.button('Details',{view:'detail',pr:f.number,page:0},`detail_${f.number}`)});
    if(!rows.length)blocks.push(section('No PRs in this group.'));
    const nav=[];if(page>0)nav.push(this.button('Previous',{...input,page:page-1},'previous'));if(page+1<pages)nav.push(this.button('Next',{...input,page:page+1},'next'));if(nav.length)blocks.push({type:'actions',elements:nav});
    this.render(c.repo+':list',{text:`CI PR list · ${input.filter} · Page ${page+1}/${pages}`,blocks});
   }else{
    if(!Number.isSafeInteger(input.pr)||input.pr<1)return{ignored:true};const row=this.db.prepare('SELECT record,observed_at FROM cp_slack_ci_flows WHERE repo=? AND pr=?').get(c.repo,input.pr);if(!row)return{ignored:true};const f=JSON.parse(row.record),chunks=flowMessages(c.repo,f),pages=Math.max(1,Math.ceil(chunks.length/6)),page=Math.min(input.page,pages-1),blocks=chunks.slice(page*6,page*6+6).map(text=>({type:'section',text:{type:'plain_text',text}}));
    blocks.push({type:'context',elements:[{type:'plain_text',text:`Last observed: ${new Date(row.observed_at).toISOString()} · Page ${page+1}/${pages}`} ]});const nav=[];if(page>0)nav.push(this.button('Previous',{view:'detail',pr:f.number,page:page-1},'previous'));if(page+1<pages)nav.push(this.button('Next',{view:'detail',pr:f.number,page:page+1},'next'));nav.push(this.button('Refresh details',{view:'detail',pr:f.number,page},'refresh'));blocks.push({type:'actions',elements:nav});this.render(`${c.repo}:detail:${f.number}`,{text:`CI details · PR #${f.number}`,blocks});
   }
   return{queued:true,read_only:true};
  });
 }
 status(){const v=this.view(this.flow.config().repo+':dashboard');const row=v?.root_ref?this.db.prepare('SELECT state,remote_ts FROM cp_slack_health_outbox WHERE id=?').get(v.root_ref):null;return{mode:'quiet_dashboard',refresh_interval_seconds:120,message_state:row?.state||'not_posted',message_ts:row?.remote_ts||null};}
}
module.exports={SlackCIUI,classLabel,flowState};
