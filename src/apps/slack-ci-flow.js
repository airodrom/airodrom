'use strict';
const fs=require('node:fs');
const {HostExecutor}=require('../host-exec');
const {transaction}=require('../control-transaction');
const {fingerprint,object,identifier}=require('../control-plane-store');
const {redactText}=require('../secret-observation');
const REPO=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA=/^[a-f0-9]{40}$/;
const safeName=value=>redactText(String(value||'Unknown')).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])).replace(/[\r\n]/g,' ').slice(0,180);
const state=item=>item.status==='completed'?(['success','failure','cancelled','skipped','neutral','timed_out','action_required','stale'].includes(item.conclusion)?item.conclusion:'unknown'):['queued','in_progress','waiting','pending','requested'].includes(item.status)?item.status:'unknown';
const pick=item=>({name:safeName(item.name),state:state(item)});
class GitHubCIReader{
 constructor({exec}={}){this.file=['/opt/homebrew/bin/gh','/usr/local/bin/gh'].find(f=>fs.existsSync(f));this.exec=exec||new HostExecutor({allowed:this.file?[this.file]:[]});}
 async call(args){if(!this.file)throw Error('github_unavailable');const r=await this.exec.run(this.file,args,{timeoutMs:15000,maxOutput:512*1024,env:{GH_PROMPT_DISABLED:'1',GH_NO_UPDATE_NOTIFIER:'1',GH_SPINNER_DISABLED:'1'}});if(r.exitCode||r.timedOut||r.truncated)throw Error('github_unavailable');try{return JSON.parse(r.stdout);}catch{throw Error('github_unavailable');}}
 async list(repo,numbers){
  const fields='number,headRefOid,isDraft,state,statusCheckRollup';
  const prs=numbers.length?await Promise.all(numbers.map(n=>this.call(['pr','view',String(n),'--repo',repo,'--json',fields]))):await this.call(['pr','list','--repo',repo,'--state','open','--limit','1000','--json',fields]);
  if(!Array.isArray(prs)||prs.length===1000)throw Error('too_many_pull_requests');
  return prs.map(pr=>({...pr,sourceSignature:fingerprint({sha:pr.headRefOid,draft:pr.isDraft,state:pr.state,checks:(pr.statusCheckRollup||[]).map(check=>({name:safeName(check.name||check.context),status:check.status||check.state,conclusion:check.conclusion||null,started:check.startedAt||null,ended:check.completedAt||null})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))})}));
 }
 async snapshot(repo,pr){
  if(!Number.isSafeInteger(pr.number)||pr.number<1||!SHA.test(pr.headRefOid))throw Error('invalid_github_response');
  const endpoint=`repos/${repo}`;
  const [checks,runs]=await Promise.all([this.call(['api',`${endpoint}/commits/${pr.headRefOid}/check-runs?per_page=100`]),this.call(['api',`${endpoint}/actions/runs?head_sha=${pr.headRefOid}&per_page=20`])]);
  if(checks.total_count>100||runs.total_count>20)throw Error('ci_detail_limit');
  const latest=new Map();for(const run of runs.workflow_runs||[]){if(run.head_sha!==pr.headRefOid)continue;const key=`${run.workflow_id}:${run.event}`;if(!latest.has(key)||run.run_number>latest.get(key).run_number)latest.set(key,run);}
  const workflows=await Promise.all([...latest.values()].map(async run=>{
   if(!Number.isSafeInteger(run.id))throw Error('invalid_github_response');
   const jobs=await this.call(['api',`${endpoint}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`]);if(jobs.total_count>100)throw Error('ci_detail_limit');
   return{...pick(run),id:run.id,attempt:run.run_attempt||1,jobs:(jobs.jobs||[]).map(j=>({...pick(j),steps:(j.steps||[]).map(pick)}))};
  }));
  return{number:pr.number,sha:pr.headRefOid,prState:['OPEN','CLOSED','MERGED'].includes(pr.state)?pr.state:'OPEN',draft:pr.isDraft===true,checks:[...(checks.check_runs||[]).map(pick),...(pr.statusCheckRollup||[]).filter(c=>c.__typename==='StatusContext').map(c=>({name:safeName(c.context),state:({SUCCESS:'success',FAILURE:'failure',ERROR:'failure',PENDING:'pending'})[c.state]||'unknown'}))],workflows};
 }
}
function classSummary(flow){
 const steps=flow.workflows.flatMap(w=>w.jobs.flatMap(j=>j.steps));
 const status=pattern=>{const found=steps.filter(s=>pattern.test(s.name));return found.length?[...new Set(found.map(s=>s.state))].join(', '):'Not observed';};
 return{A:status(/^Class A\b|^(?:Run )?npm run test:ci-lite$/i),B:status(/^Class B\b|^(?:Run )?npm run test:ci-heavy$/i),C:status(/^Class C\b|^(?:Run )?(?:npx playwright test|npm run test:e2e)$/i)};
}
function flowMessages(repo,flow){
 const classes=classSummary(flow),checks=flow.checks,settled=checks.filter(c=>!['queued','in_progress','waiting','pending','requested','unknown'].includes(c.state)).length;
 const failed=checks.filter(c=>['failure','timed_out','action_required'].includes(c.state)).length;
 const lines=[`Live CI · ${repo} PR #${flow.number} · ${flow.prState==='OPEN'?(flow.draft?'Draft':'Open'):flow.prState}`,`Commit: ${flow.sha.slice(0,12)} · ${settled}/${checks.length} checks concluded · ${failed} failed`,`https://github.com/${repo}/pull/${flow.number}`,`Class A (lite): ${classes.A}`,`Class B (financial): ${classes.B}`,`Class C (browser, manual/on-demand): ${classes.C}`,'','CI checks:',...(checks.length?checks.map(c=>`• ${c.name}: ${c.state}`):['• No checks observed for this commit']),'','Workflow steps:'];
 for(const workflow of flow.workflows){lines.push(`${workflow.name}: ${workflow.state} (attempt ${workflow.attempt})`, `https://github.com/${repo}/actions/runs/${workflow.id}`);for(const job of workflow.jobs){lines.push(`• ${job.name}: ${job.state}`);for(const step of job.steps)lines.push(`  ${step.state} · ${step.name}`);}}
 if(!flow.workflows.length)lines.push('No workflow runs observed for this commit.');
 lines.push('Skipped, not observed and reporter-only jobs do not prove a class passed.');
 const chunks=[];let chunk='';for(const line of lines){if(chunk.length+line.length+1>2700){chunks.push(chunk);chunk='CI checklist (continued)\n';}chunk+=line+'\n';}if(chunk)chunks.push(chunk);return chunks;
}
class SlackCIFlow{
 constructor(runtime,{reader,now=Date.now}={}){this.runtime=runtime;this.db=runtime.db;this.reader=reader||new GitHubCIReader();this.now=now;this.nextPoll=0;this.busy=false;this.error=null;this.db.exec(`CREATE TABLE IF NOT EXISTS cp_slack_ci_config(id INTEGER PRIMARY KEY CHECK(id=1),record TEXT NOT NULL);CREATE TABLE IF NOT EXISTS cp_slack_ci_errors(repo TEXT NOT NULL,pr INTEGER NOT NULL,sha TEXT NOT NULL,retry_at INTEGER NOT NULL,PRIMARY KEY(repo,pr));CREATE TABLE IF NOT EXISTS cp_slack_ci_health(id INTEGER PRIMARY KEY CHECK(id=1),state TEXT NOT NULL,revision INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS cp_slack_ci_flows(repo TEXT NOT NULL,pr INTEGER NOT NULL,sha TEXT NOT NULL,hash TEXT NOT NULL,revision INTEGER NOT NULL,record TEXT NOT NULL,observed_at INTEGER NOT NULL,PRIMARY KEY(repo,pr));`);this.ui=new(require('../slack-ci-ui').SlackCIUI)(this);}
 config(){const row=this.db.prepare('SELECT record FROM cp_slack_ci_config WHERE id=1').get();return row?JSON.parse(row.record):{enabled:false};}
 status(){return{...this.config(),poll_interval_seconds:30,source:'github_current_commit',presentation:this.ui.status(),last_error:this.error,last_checked_at:this.checkedAt||null,unavailable:this.db.prepare('SELECT repo,pr,sha,retry_at FROM cp_slack_ci_errors WHERE repo=?').all(this.config().repo||''),items:this.db.prepare('SELECT repo,pr,sha,revision,observed_at FROM cp_slack_ci_flows ORDER BY observed_at DESC LIMIT 1000').all()};}
 configure(input){object(input,['request_id','enabled','repo','pull_requests']);identifier(input.request_id);if(typeof input.enabled!=='boolean'||!REPO.test(input.repo)||input.repo.split('/').some(p=>['.','..'].includes(p))||input.repo.length>160||!Array.isArray(input.pull_requests)||input.pull_requests.length>20||input.pull_requests.some(n=>!Number.isSafeInteger(n)||n<1))throw Error('Invalid CI monitor configuration');
  const config={enabled:input.enabled,repo:input.repo,pull_requests:[...new Set(input.pull_requests)]};const result=this.runtime.store.request('operator',input.request_id,{action:'slack-ci-configure',...config},()=>{this.db.prepare('INSERT INTO cp_slack_ci_config VALUES(1,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record').run(JSON.stringify(config));return{configured:true,...config};});this.nextPoll=0;return result;
 }
 async poll(){const r=this.runtime,c=this.config(),slack=r.gateway.config;if(this.busy||r.stopped||!c.enabled||!slack.enabled||!slack.outboundEnabled||slack.connectorsEnabled===false||this.now()<this.nextPoll)return;
  this.busy=true;this.nextPoll=this.now()+30000;
  try{
   const prs=await this.reader.list(c.repo,c.pull_requests);const present=new Set(prs.map(p=>p.number));
   if(!c.pull_requests.length)for(const old of this.db.prepare('SELECT pr,record FROM cp_slack_ci_flows WHERE repo=?').all(c.repo)){if(present.has(old.pr)||JSON.parse(old.record).prState!=='OPEN')continue;const closed=(await this.reader.list(c.repo,[old.pr]))[0];if(closed)prs.push(closed);}
   const due=prs.filter(pr=>{const failure=this.db.prepare('SELECT retry_at FROM cp_slack_ci_errors WHERE repo=? AND pr=?').get(c.repo,pr.number);if(failure&&failure.retry_at>this.now())return false;const old=this.db.prepare('SELECT record,observed_at FROM cp_slack_ci_flows WHERE repo=? AND pr=?').get(c.repo,pr.number);if(!old)return true;const flow=JSON.parse(old.record);return flow.sourceSignature!==pr.sourceSignature||flow.prState!==pr.state||flow.sha!==pr.headRefOid||(flow.workflows.some(w=>['queued','in_progress','waiting','pending','requested'].includes(w.state))&&this.now()-old.observed_at>=30000);});
   if(due.length>20)this.nextPoll=this.now()+10000;
   const selected=due.slice(0,20);let failed=false;
   for(let offset=0;offset<selected.length;offset+=4){
    const results=await Promise.allSettled(selected.slice(offset,offset+4).map(async pr=>({...await this.reader.snapshot(c.repo,pr),sourceSignature:pr.sourceSignature})));
    if(r.stopped||fingerprint(c)!==fingerprint(this.config())||!r.gateway.config.enabled||!r.gateway.config.outboundEnabled||r.gateway.config.connectorsEnabled===false)break;
    for(let index=0;index<results.length;index++){const result=results[index],pr=selected[offset+index];if(result.status==='fulfilled'){this.publish(c.repo,result.value);this.db.prepare('DELETE FROM cp_slack_ci_errors WHERE repo=? AND pr=?').run(c.repo,pr.number);}else{failed=true;transaction(this.db,()=>{
     const old=this.db.prepare('SELECT sha FROM cp_slack_ci_errors WHERE repo=? AND pr=?').get(c.repo,pr.number);
     this.db.prepare('INSERT INTO cp_slack_ci_errors VALUES(?,?,?,?) ON CONFLICT(repo,pr) DO UPDATE SET sha=excluded.sha,retry_at=excluded.retry_at').run(c.repo,pr.number,pr.headRefOid,this.now()+60000);
    });}}
   }
   this.error=failed||this.db.prepare('SELECT 1 FROM cp_slack_ci_errors WHERE repo=?').get(c.repo)?'github_unavailable':null;this.checkedAt=this.now();this.observeAvailability(this.error);
  }catch(error){this.error=['too_many_pull_requests','ci_detail_limit','invalid_github_response'].includes(error.message)?error.message:'github_unavailable';this.observeAvailability(this.error);}finally{try{this.ui.refresh();}finally{this.busy=false;}}
 }
 observeAvailability(error){
  const state=error||'available',r=this.runtime;
  if(r.stopped||!r.gateway.config.enabled||!r.gateway.config.outboundEnabled||r.gateway.config.connectorsEnabled===false)return;
  transaction(this.db,()=>{
   const old=this.db.prepare('SELECT * FROM cp_slack_ci_health WHERE id=1').get();if(old?.state===state)return;
   const revision=(old?.revision||0)+1;
   this.db.prepare('INSERT INTO cp_slack_ci_health VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,revision=excluded.revision').run(state,revision);
  });
 }
 publish(repo,flow){transaction(this.db,()=>{
  const hash=fingerprint(flow),old=this.db.prepare('SELECT * FROM cp_slack_ci_flows WHERE repo=? AND pr=?').get(repo,flow.number);
  if(old?.hash===hash){this.db.prepare('UPDATE cp_slack_ci_flows SET observed_at=? WHERE repo=? AND pr=?').run(this.now(),repo,flow.number);return;}
  const revision=(old?.revision||0)+1;
  this.db.prepare('INSERT INTO cp_slack_ci_flows VALUES(?,?,?,?,?,?,?) ON CONFLICT(repo,pr) DO UPDATE SET sha=excluded.sha,hash=excluded.hash,revision=excluded.revision,record=excluded.record,observed_at=excluded.observed_at').run(repo,flow.number,flow.sha,hash,revision,JSON.stringify(flow),this.now());
 });}
}
module.exports={SlackCIFlow,GitHubCIReader,classSummary,flowMessages};
