'use strict';
(() => {
 const $=id=>document.getElementById(id), node=(tag,text,cls)=>{const e=document.createElement(tag);if(text!=null)e.textContent=String(text);if(cls)e.className=cls;return e;};
 const hash=new URLSearchParams(location.hash.slice(1));let token=hash.get('token')||'';try{if(token)sessionStorage.setItem('airodromToken',token);else token=sessionStorage.getItem('airodromToken')||'';}catch{}if(hash.has('token'))history.replaceState(null,'',location.pathname+location.search);
 const colorScheme=matchMedia('(prefers-color-scheme: light)');let appearance='system';const applyAppearance=()=>{document.documentElement.dataset.theme=appearance==='system'?(colorScheme.matches?'light':'dark'):appearance;};$('theme').onchange=()=>{appearance=$('theme').value;applyAppearance();};colorScheme.addEventListener?.('change',applyAppearance);applyAppearance();
 const views=['Overview','Missions','Autonomous Goals','Development Sessions','Runtime & OpenCode','Approvals','Activity & Audit','System Health','Conversation','AI & Workers','Automation & Permissions','Models','Workers','WORK Templates','Google Connections','Connectors','WhatsApp Conversations','Sensitive & Vault','Memory','Projects','Reliability','MCP Diagnostics','Settings & About'];
 let selectedModel='auto',selectedWorker='auto',onceWorker;
 const preferenceDraft={};let preferenceNotice='',workRequestId=null;const workDraft={project:'',workspace:'',objective:''};
 const templateDraft={duration_minutes:'60'},templateFields=[['project','Project alias'],['workspace_alias','Workspace alias'],['project_id','Registered project ID'],['goal_id','Registered goal ID'],['workspace','Exact repository root'],['allowed_files','Existing files (one per line, maximum eight)'],['diff_check','Registered diff-check task'],['tests','Focused test task labels (one per line)'],['duration_minutes','Expires after minutes (1–1440)']];
 let conversationDraft='',conversationHistory=[],conversationNotice='',activeConversationId=null,conversationSessionId=null,previousConversationSessionId=null,pendingNewConversation=false,activeDirectTurn=null,includeMemoryConsent=true,conversationStreaming=null;
 try{
  const savedSession=sessionStorage.getItem('airodromConversationSession');if(/^[a-f0-9-]{36}$/i.test(savedSession||''))conversationSessionId=savedSession;
  const previousSession=sessionStorage.getItem('airodromPreviousConversationSession');if(/^[a-f0-9-]{36}$/i.test(previousSession||''))previousConversationSessionId=previousSession;
  const savedMemory=sessionStorage.getItem('airodromConversationMemory');if(savedMemory==='0')includeMemoryConsent=false;
  if(sessionStorage.getItem('airodromConversationPendingNew')==='1'){pendingNewConversation=true;conversationSessionId=null;}
 }catch{}
 const researchReports=new Map(),researchImages=new Map();
 let observatory=null,obsFollow=true,obsFilter='',obsQuery='',obsStream=null,obsCursor=0,diffCache=new Map(),expandedOutput=new Set();
 let lastOkAt=null,connectionView=null,secondaryNotice='';
 let missionPage=null,missionFilter='Active',missionOffset=0,missionLimit=15,missionWorker='',missionSort='newest',searchTimer=null,missionTab='Active',missionDetailTab='Outcome',contentScroll=0,missionListContext=null;
 const deepLinkViews=new Set(['Conversation','Missions','Development Sessions','System Health']);
 const nav=new Map(),feed=new Map();let view=(()=>{const value=new URLSearchParams(location.search).get('view');return deepLinkViews.has(value)?value:'Overview';})(),snapshot=null,missionId=(()=>{const value=new URLSearchParams(location.search).get('mission');return /^[a-f0-9-]{36}$/i.test(value||'')?value:null;})(),cursor=0,busy=false,paused=false,authorized=true,timer=null,failures=0,category='',generation=0,lastFocus=null,reviewMission=null,searchQuery='',inflight=null,currentOffset=0,memoryResults=[],memoryDraft='',memoryQuery='',selectedMemory=null,memoryEpoch=0,memoryController=null,eventMission='';
 if(missionId)view='Missions';
 async function api(route,body,signal){const response=await fetch(route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),cache:'no-store',redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000)});if(!response.ok){if(response.status===401){authorized=false;clearMemory();render();throw Error('Authorization expired. Reopen your private Control Center link.');}throw Error('Local request unavailable. Check System Health.');}return response.json();}
 function loseAuthorization(){authorized=false;generation++;inflight?.abort();clearTimeout(timer);timer=null;token='';try{sessionStorage.removeItem('airodromToken');}catch{}clearMemory();snapshot=null;missionPage=null;feed.clear();reviewMission=null;for(const id of ['new-dialog','review-dialog'])if($(id).open)$(id).close();render();}
 function authorizationView(){const panel=node('article',null,'glass');panel.setAttribute('role','alert');panel.append(node('h2','This browser session is not authorized'),node('p','Your missions and saved data have not disappeared. This tab needs its own private Control Center launch link.'),node('p','Open the Airodrom menu on your Mac and choose Open Control Center. Continue in the browser it opens. A plain address copied from another browser does not authorize this tab.'),node('p','The menu opens your default browser. Authorization cannot be transferred by copying the plain address. Do not share private links or copy session credentials between browsers.'));$('content').replaceChildren(panel);$('heading').textContent='Authorization required';$('connection').textContent='Authorization required';$('notice').textContent='Open Control Center from the local Airodrom menu to authorize a session.';$('new').disabled=true;$('pause').disabled=true;}
 function deriveConnection(input){
   // Mirrors src/connection-status.js — keep labels aligned.
   if(input.authorized===false)return {state:'AUTHORIZATION_REQUIRED',label:'Authorization required',detail:'Open Control Center from the local Airodrom menu.',chip:'unavailable'};
   if(input.maintenance)return {state:'MAINTENANCE',label:'Maintenance',detail:'Service intentionally unavailable for work.',chip:'waiting'};
   if(input.paused&&input.reachable)return {state:'CONNECTED',label:'Updates paused',detail:'Local service reachable; live updates paused.',chip:'waiting'};
   if(!input.reachable)return input.failures>0?{state:'RECONNECTING',label:'Reconnecting',detail:input.error||'Retrying local service…',chip:'degraded',attempt:input.failures}:{state:'DISCONNECTED',label:'Disconnected',detail:input.error||'Local service cannot be reached.',chip:'unavailable'};
   if(input.overviewStatus==='Degraded'||input.overviewStatus==='Unavailable')return {state:'DEGRADED',label:'Connected · degraded',detail:'Service reachable; a required dependency is unavailable.',chip:'degraded'};
   return {state:'CONNECTED',label:'Connected',detail:'Service reachable and authenticated.',chip:'ready'};
 }
 function applyConnection(view){
   connectionView=view;
   const el=$('connection'); if(!el)return;
   el.textContent=view.label+(view.attempt?' · attempt '+view.attempt:'');
   el.className='chip '+(view.chip||'');
   el.title=(view.detail||'')+(lastOkAt?' · Last ok '+stamp(lastOkAt):'')+(secondaryNotice?' · '+secondaryNotice:'');
   document.body.classList.toggle('offline', view.state==='DISCONNECTED'||view.state==='RECONNECTING'||view.state==='AUTHORIZATION_REQUIRED');
   document.body.dataset.connection=view.state;
 }


 const present=value=>value!=null&&value!==''&&!(typeof value==='number'&&!Number.isFinite(value));
 const readable=value=>{if(!present(value))return null;return String(value).replaceAll('_',' ');};
 const safeNum=(value,suffix='')=>{if(!Number.isFinite(value))return null;return Math.trunc(value)+suffix;};
 function chip(text,tone){
  const missionLabel=({draft:'Registered — execution not started',ready:'Ready to execute',dispatching:'Queued',running:'Running',verifying:'Independent verification',awaiting_acceptance:'Waiting for approval',waiting_for_operator:'Waiting for operator',needs_rework:'Needs rework',blocked:'Blocked',paused:'Paused',completed:'Completed',cancelled:'Cancelled',settled:'Settled',archived:'Archived',registered:'Registered — execution not started'})[text];
  const cls=tone||({Ready:'ready',Degraded:'degraded',Unavailable:'unavailable',Waiting:'waiting',passed:'ready',failed:'failed',operator_review:'waiting',completed:'ready',settled:'ready',blocked:'degraded',needs_rework:'degraded',awaiting_acceptance:'waiting',waiting_for_operator:'waiting',dispatching:'ready',running:'ready',verifying:'ready',draft:'waiting',ready:'waiting',archived:'muted',registered:'waiting'})[text]||'';
  const label=missionLabel||readable(text);if(!label)return document.createDocumentFragment();
  return node('span',label,'chip '+cls+(text==='awaiting_acceptance'||text==='waiting_for_operator'?' review':''));
 }
 function statusChip(m){const d=m.display||{};return chip(d.key||m.state,d.tone);}
 function button(text,fn,primary=false){const b=node('button',text,primary?'primary':'');b.type='button';b.dataset.focusKey=missionId?missionId+':'+text:text;b.onclick=fn;return b;}
 function glass(title,value,detail){const c=node('article',null,'glass');c.append(node('h3',title),node('div',present(value)?value:'—','metric'));if(detail)c.append(node('small',detail));return c;}
 function empty(text){return node('p',text,'empty');}
 const stamp=t=>{if(!Number.isFinite(t)||t<=0)return 'Not observed';return new Date(t).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});};
 const stampKnown=t=>{if(!Number.isFinite(t)||t<=0)return null;return new Date(t).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});};
 const stateText=s=>({draft:'Registered — execution not started',ready:'Ready to execute',dispatching:'Queued',running:'Running',verifying:'Independent verification',awaiting_acceptance:'Waiting for approval',waiting_for_operator:'Waiting for operator',needs_rework:'Needs rework',blocked:'Blocked',paused:'Paused',completed:'Completed',cancelled:'Cancelled'})[s]||null;
 function phase(m){const wrap=node('div',null,'phase'),track=node('div',null,'track '+(m.progress.mode==='indeterminate'?'active':'paused'));track.setAttribute('role','progressbar');track.setAttribute('aria-label',m.progress.label);if(m.progress.mode==='determinate'){track.setAttribute('aria-valuenow',m.progress.value);track.setAttribute('aria-valuemax',m.progress.maximum);track.setAttribute('aria-valuemin','0');track.classList.add('determinate');track.style.setProperty('--progress',(m.progress.maximum>0?Math.min(100,100*m.progress.value/m.progress.maximum):0)+'%');}const label=(m.display&&m.display.label)||stateText(m.state);if(label)wrap.append(track,node('span',label));else wrap.append(track);return wrap;}
 function lifecycle(m){
   const panel=node('article',null,'glass live-mission');panel.dataset.missionId=m.id;
   const advancing=['dispatching','running','verifying'].includes(m.state);
   panel.append(node('span',advancing?'DOING NOW':'CURRENT MISSION STATE','eyebrow'),node('h2',m.timeline.at(-1)?.label||stateText(m.state)));
   const labels=[['request','Request'],['context','Context'],['runtime','Runtime'],['execution','Execution'],['verification','Verification'],['acceptance','Acceptance'],['settlement','Settlement']];
   const latest=({dispatching:'execution',running:'execution',verifying:'verification',awaiting_acceptance:'acceptance',waiting_for_operator:'acceptance'})[m.state]||(m.settlement.status==='settled'?'settlement':m.timeline.filter(e=>e.stage).at(-1)?.stage),rail=node('ol',null,'lifecycle');
   for(const [key,label]of labels){const observed=m.timeline.filter(e=>e.stage===key),li=node('li',null,observed.length?'observed':'unobserved');li.dataset.stage=key;
     if(key===latest){li.classList.add(advancing?'live':'waiting');li.setAttribute('aria-current','step');}
     li.append(node('span',label),node('small',observed.length?stamp(observed.at(-1).timestamp_ms):'Not observed'));rail.append(li);
   }
   panel.append(rail,phase(m));if(m.progress.mode==='indeterminate')panel.append(node('small','Live activity · completion estimate unavailable'));
   const stats=node('div',null,'live-facts');for(const [label,value]of [['Elapsed',m.started_at&&Number.isFinite(snapshot?.observed_at)?(safeNum(Math.floor(((m.finished_at||snapshot.observed_at)-m.started_at)/1000),' s')||'Not observed'):'Not started'],['Model',m.model?.id||null],['Worker',m.worker_assigned?m.runtime:null],['Memory',present(m.memory?.selected_count)?`${m.memory.selected_count} selected · ${m.memory.delivery}`:null],['Actions',present(m.budget?.actions_used)&&present(m.budget?.actions_limit)?`${m.budget.actions_used} / ${m.budget.actions_limit}`:null],['Retries',present(m.budget?.retries_used)&&present(m.budget?.retries_limit)?`${m.budget.retries_used} / ${m.budget.retries_limit}`:null],['Runtime limit',Number.isFinite(m.budget?.runtime_limit_ms)?(m.budget.runtime_limit_ms/1000)+' s':null],['Approvals',String((snapshot?.approvals?.records||[]).filter(a=>a.task_id===m.task_id&&a.status==='pending').length)+' waiting']]){if(!present(value)&&value!=='Not started')continue;const fact=node('div');fact.append(node('small',label),node('span',value));stats.append(fact);}panel.append(stats,webPanel(m));return panel;
 }
 function routeControls(){const group=node('div',null,'route-controls');
   for(const [label,items,current]of [['Model',snapshot.assistant.models,selectedModel],['Worker',snapshot.assistant.workers,selectedWorker]]){const field=node('label',label+' routing'),select=node('select');select.setAttribute('aria-label',label+' routing');select.dataset.focusKey=label+'-routing';
     for(const id of ['auto',...(label==='Model'?['local']:[]),...items.map(i=>i.id)]){const item=items.find(i=>i.id===id),option=node('option',id==='auto'?'AUTO':id==='local'?'Local only':(item.name||id)+' · '+item.qualification);option.value=id;option.disabled=!!item&&(!item.available||item.qualification!=='qualified');select.append(option);}select.value=current;
     select.onchange=()=>{if(label==='Model')selectedModel=select.value;else selectedWorker=select.value;};field.append(select);group.append(field);
   }group.append(node('small','These model and worker choices apply to Work Missions. Conversation uses its separate provider setting.'));return group;
 }
 async function approvePublicWeb(offer,id){
   const summary=(offer.mode==='all'?'Discover public websites from verified links.':'Visit approved public sites:')+'\n'+(offer.entries||[]).join('\n')+(offer.query?'\nPublic query: '+offer.query:'')+'\nThree minutes; eight domains/pages; 100 requests; forty actions; eight MiB. Login, private data, mutations, payments and private downloads require separate approval.';
   if(!window.confirm(summary+'\nApprove this Mission web scope?'))return null;
   return api(id?'/api/assistant/mission/web':'/api/assistant/web/research',{request_id:crypto.randomUUID(),mode:offer.mode,entries:offer.entries||[],...(offer.query?{query:offer.query}:{}),confirmed:true,...(id?{mission_id:id}:{objective:offer.objective})});
 }
 function webPanel(m){
   if(!m.web)return document.createDocumentFragment();const box=node('section',null,'glass');box.append(node('h3','Mission web access'),node('p','Public web: '+readable(m.web.mode)+(m.web.expires_at?' · expires '+stamp(m.web.expires_at):'')));
   if(!['completed','cancelled'].includes(m.state))for(const [label,mode] of [['Approve public sites','on'],['Approve public discovery','all'],['Stop web access','off']])box.append(button(label,async()=>{try{if(mode==='off')await api('/api/assistant/mission/web',{mission_id:m.id,mode,request_id:crypto.randomUUID()});else{const raw=window.prompt('Public HTTPS starting URLs, separated by spaces');if(!raw)return;await approvePublicWeb({mode,entries:raw.trim().split(/\s+/)},m.id);}await refresh();}catch(e){$('notice').textContent=e.message;}}));
   if(['ready','blocked','needs_rework'].includes(m.state))box.append(button('Run approved Mission',async()=>{try{await api('/api/assistant/mission',{action:'run',mission_id:m.id,request_id:crypto.randomUUID()});await refresh();}catch(e){$('notice').textContent=e.message;}}));return box;
 }
 function researchPanel(m){
   if(!m.research)return document.createDocumentFragment();
   const box=node('section',null,'glass'),steps=node('ol',null,'timeline');box.append(node('h2','ARECIBO PRODUCT RESEARCH'));
   for(const step of m.research.steps||[])steps.append(node('li',({completed:'✓ ',active:'● ',pending:'○ ',attention:'! '}[step.state]||'○ ')+step.label));
   box.append(steps);if(m.research.session_mode){box.append(node('h3','Browser connection & consent'),node('p','Connection: '+readable(m.research.session_mode)+' · permission: '+readable(m.research.permissions?.mode||'strict')));if(m.research.permissions)box.append(node('p','Approved site: '+m.research.permissions.origin+' · methods '+m.research.permissions.methods.join('/')+' · expires '+stamp(m.research.permissions.expires_at)));box.append(button('View sanitized browser diagnostics',async()=>{try{const result=await api('/api/assistant/browser/diagnostics?mission_id='+encodeURIComponent(m.id));$('notice').textContent=result.diagnostics.length?result.diagnostics.map(d=>[d.method,d.origin,d.resource,d.reason||d.type].filter(Boolean).join(' · ')).join('\n'):'No retained browser denials.';}catch(e){$('notice').textContent=e.message;}}));if(m.research.handoff_required)box.append(button('Hand back for strict read-only inspection',async()=>{if(!window.confirm('Finished signing in manually? Stop login traffic and authorize only fixed read-only feature navigation?'))return;try{await api('/api/assistant/research/session/ready',{mission_id:m.id,confirmed:true,request_id:crypto.randomUUID()});await refresh();}catch(e){$('notice').textContent=e.message;}}));if(!['completed','cancelled'].includes(m.state))box.append(button('Revoke browser access and close',async()=>{try{await api('/api/assistant/browser/revoke',{mission_id:m.id,request_id:crypto.randomUUID()});await refresh();}catch(e){$('notice').textContent=e.message;}}));}if(m.state==='running'&&m.research.downloads_allowed===true)box.append(button('Request public evidence download',async()=>{const url=window.prompt('Public text, CSV or JSON URL in this Mission’s approved domain');if(!url)return;try{const result=await api('/api/assistant/research/download',{mission_id:m.id,url,request_id:crypto.randomUUID()});$('notice').textContent=result.message||'Download queued for exact approval.';}catch(e){$('notice').textContent=e.message;}}));const report=researchReports.get(m.id);if(report){const text=node('section',null,'research-report');for(const line of report.markdown.split('\n')){if(!line.trim()||/^\s*\|?[- :|]+\|?\s*$/.test(line))continue;const clean=line.replace(/^#{1,6}\s+/,'').replace(/\*\*([^*]+)\*\*/g,'$1').replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,'$1 — $2').replace(/^[-*]\s+/,'• ').replace(/^\|?|\|?$/g,'');text.append(node(/^#/.test(line)?'h3':'p',clean));}text.style.overflowWrap='anywhere';box.append(text);for(const ref of report.screenshots||report.report?.screenshot_refs||[]){if(!/^[a-f0-9-]{36}$/i.test(ref.id||''))continue;const image=researchImages.get(ref.id);if(image){const img=node('img');img.src=image;img.alt='Captured public page evidence';img.style.maxWidth='100%';box.append(img);}else box.append(button('View public screenshot',()=>loadResearchScreenshot(m.id,ref.id)));}}
   if(m.research.report_available)box.append(button('Read research report',async()=>{const version=generation;try{const report=await api('/api/assistant/research/report?mission_id='+encodeURIComponent(m.id));if(version===generation&&authorized&&!document.hidden&&missionId===m.id){researchReports.set(m.id,report);render();}}catch(e){$('notice').textContent=e.message;}}));
   return box;
 }
 async function loadResearchScreenshot(id,evidenceId){
   const version=generation;
   try{const response=await fetch('/api/assistant/research/evidence?mission_id='+encodeURIComponent(id)+'&evidence_id='+encodeURIComponent(evidenceId),{headers:{Authorization:'Bearer '+token},cache:'no-store',redirect:'error',signal:AbortSignal.timeout(10000)});if(!response.ok){if(response.status===401){loseAuthorization();}throw Error('Current screenshot evidence is unavailable.');}const blob=await response.blob();if(blob.type!=='image/png'||blob.size>4194304)throw Error('Screenshot integrity boundary refused.');if(version!==generation||!authorized||document.hidden||missionId!==id)return;researchImages.set(evidenceId,URL.createObjectURL(blob));render();}catch(e){$('notice').textContent=e.message;}
 }
 function missionCard(m){
  // Compact row used on Overview / Conversation; Missions page uses missionRow.
  const c=node('article',null,'mission-row');c.dataset.missionId=m.id;
  const main=node('div',null,'mission-row-main');
  main.append(node('h3',m.label||'Scoped Mission'));
  const meta=node('p',null,'mission-row-meta');
  const bits=[(m.display&&m.display.label)||stateText(m.state),m.worker_assigned&&m.runtime?m.runtime:null,stampKnown(m.started_at||m.created_at),m.latest_activity].filter(Boolean);
  meta.textContent=bits.join(' · ');
  main.append(meta);
  if(m.next_action)main.append(node('small',m.next_action,'mission-next'));
  const actions=node('div',null,'actions');
  actions.append(button('View Mission',()=>selectMission(m.id),true));
  if(m.actions?.accept){const review=button('Review',event=>openReview(m,event.currentTarget),true);review.dataset.focusKey='review:'+m.id;actions.append(review);}
  c.append(main,statusChip(m),actions);return c;
 }
 function missionRow(m){
  const c=node('article',null,'mission-row');c.dataset.missionId=m.id;
  const main=node('div',null,'mission-row-main');
  const title=node('button',m.label||'Scoped Mission','mission-title');title.type='button';title.dataset.focusKey='mission:'+m.id;title.onclick=()=>selectMission(m.id);
  main.append(title);
  const line=node('p',null,'mission-row-meta');
  const outcome=m.outcome||{};
  const parts=[];
  parts.push(outcome.headline||(m.display&&m.display.label)||stateText(m.state)||'Status not observed');
  if(m.worker_assigned&&m.runtime)parts.push(m.runtime);
  const when=stampKnown(m.started_at||m.created_at);if(when)parts.push(when);
  line.textContent=parts.join(' · ');
  main.append(line);
  if(outcome.detail)main.append(node('p',outcome.detail,'latest-activity'));
  else if(m.latest_activity&&!m.autonomous_managed)main.append(node('p',m.latest_activity,'latest-activity'));
  if(m.next_action)main.append(node('small',m.next_action,'mission-next'));
  const actions=node('div',null,'actions');
  actions.append(button('View Mission',()=>selectMission(m.id),true));
  if(m.actions?.accept){const review=button('Review Acceptance',event=>openReview(m,event.currentTarget),true);review.dataset.focusKey='review:'+m.id;review.disabled=paused;actions.append(review);}
  if(m.actions?.archive)actions.append(button('Archive',async()=>{if(!window.confirm('Archive this Mission from the primary list? Canonical records remain.'))return;try{await api('/api/product/archive-missions',{ids:[m.id],confirmed:true,request_id:crypto.randomUUID(),reason:'operator_archive'});missionPage=null;await refresh();}catch(e){$('notice').textContent=e.message;}}));
  if(m.actions?.restore)actions.append(button('Restore',async()=>{try{await api('/api/product/restore-mission',{id:m.id,confirmed:true,request_id:crypto.randomUUID()});missionPage=null;await refresh();}catch(e){$('notice').textContent=e.message;}}));
  c.append(main,statusChip(m),actions);return c;
 }
 function missionDashboard(){
  const result=node('div'),counts=missionPage?.counts||snapshot.mission_counts||{};
  const tabs=node('div',null,'mission-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','Mission views');
  for(const name of ['Active','Needs Attention','Recent','History','Archived']){
   const b=button(name+(counts[name]===undefined?'':' ('+counts[name]+')'),()=>{missionFilter=name;missionTab=name;missionOffset=0;missionPage=null;generation++;inflight?.abort();render();refresh();});
   b.setAttribute('role','tab');b.setAttribute('aria-selected',missionFilter===name?'true':'false');b.dataset.focusKey='mission-tab:'+name;
   if(missionFilter===name)b.classList.add('active-tab');tabs.append(b);
  }
  result.append(tabs);
  const attention=counts['Needs Attention']??counts['Awaiting Review'];
  if(Number.isFinite(attention)&&attention>0&&missionFilter!=='Needs Attention'){
   const banner=node('aside',null,'review-banner');
   banner.append(node('h3','Needs attention'),node('p',`${attention} Mission${attention===1?'':'s'} need an owner decision or rework.`),button('Open Needs Attention',()=>{missionFilter='Needs Attention';missionTab='Needs Attention';missionOffset=0;missionPage=null;generation++;render();refresh();}));
   result.append(banner);
  }
  const controls=node('div',null,'filters');
  const search=node('input');search.type='search';search.placeholder='Search Missions…';search.setAttribute('aria-label','Search Missions');search.dataset.focusKey='mission-search';search.value=searchQuery;search.maxLength=180;
  const status=node('select');status.setAttribute('aria-label','Status filter');status.dataset.focusKey='mission-filter';
  for(const name of ['Active','Needs Attention','Recent','History','Archived','All','Awaiting Review','Completed','Failed','Settled']){const o=node('option',name+(counts[name]===undefined?'':' ('+counts[name]+')'));o.value=name;status.append(o);}status.value=missionFilter;
  const worker=node('select');worker.setAttribute('aria-label','Worker filter');worker.dataset.focusKey='mission-worker';
  for(const [value,label]of [['','Any worker'],['opencode','OpenCode'],['host','Host'],['codex','Codex'],['claude_code','Claude Code'],['none','No worker assigned']]){const o=node('option',label);o.value=value;worker.append(o);}worker.value=missionWorker;
  const sort=node('select');sort.setAttribute('aria-label','Sort Missions');sort.dataset.focusKey='mission-sort';
  for(const [value,label]of [['newest','Newest first'],['oldest','Oldest first']]){const o=node('option',label);o.value=value;sort.append(o);}sort.value=missionSort;
  const size=node('select');size.setAttribute('aria-label','Page size');size.dataset.focusKey='mission-limit';
  for(const n of [10,15,25,50]){const o=node('option',n+' per page');o.value=String(n);size.append(o);}size.value=String(missionLimit);
  function changed(resetPage=true){generation++;inflight?.abort();if(resetPage)missionOffset=0;missionPage=null;clearTimeout(searchTimer);searchTimer=setTimeout(()=>{render();refresh();},250);}
  search.oninput=()=>{searchQuery=search.value;changed();};
  status.onchange=()=>{missionFilter=status.value;missionTab=status.value;changed();};
  worker.onchange=()=>{missionWorker=worker.value;changed();};
  sort.onchange=()=>{missionSort=sort.value;changed();};
  size.onchange=()=>{missionLimit=Number(size.value)||15;changed();};
  controls.append(search,status,worker,sort,size);
  const organize=button('Organize history…',async()=>{
   try{
    const preview=await api('/api/product/organize-missions-preview',{older_than_ms:0,limit:200,request_id:crypto.randomUUID()});
    if(!preview.items?.length||!preview.preview_id){$('notice').textContent=preview.note||'No settled or cancelled history ready to organize.';return;}
    const lines=preview.items.slice(0,40).map(i=>`• ${i.label} · ${i.state}${i.settled?' · settled':''} · ${i.id.slice(0,8)}`).join('\n');
    const more=preview.items.length>40?`\n…and ${preview.items.length-40} more`:'';
    if(!window.confirm(`Organize ${preview.items.length} historical Mission${preview.items.length===1?'':'s'} into Archive?\n\n${lines}${more}\n\nThis only changes list visibility for the exact Missions listed. Unresolved Acceptance and active execution are never included.`))return;
    await api('/api/product/organize-missions',{confirmed:true,request_id:crypto.randomUUID(),preview_id:preview.preview_id,digest:preview.digest,reason:'outcome_first_organize'});
    missionPage=null;await refresh();
   }catch(e){$('notice').textContent=e.message;}
  });
  organize.dataset.focusKey='mission-organize';
  controls.append(organize);
  result.append(controls,node('p','Outcome-first: live progress and owner decisions stay primary. Historical Missions can be organized into Archive without deleting evidence.','muted'));
  if(!snapshot.mission_counts){result.append(empty('The running service predates full Mission history.'));for(const m of snapshot.missions)result.append(missionRow(m));return result;}
  if(!missionPage){result.append(empty(failures?'Mission history unavailable. Retry when the local service reconnects.':'Loading Missions…'));return result;}
  const page=missionPage.page||Math.floor(missionOffset/missionLimit)+1;
  const pages=missionPage.pages||(missionPage.total?Math.ceil(missionPage.total/missionLimit):1);
  const summary=node('p',`${missionPage.total} matching · page ${page} of ${pages} · showing ${missionPage.total?missionOffset+1:0}–${missionOffset+missionPage.missions.length}`,'muted');
  summary.setAttribute('role','status');result.append(summary);
  if(!missionPage.missions.length)result.append(empty(searchQuery||missionFilter!=='All'?'No Missions match this search and filter.':'No Missions in this view.'));
  const list=node('div',null,'mission-list');for(const m of missionPage.missions)list.append(missionRow(m));result.append(list);
  const pagesBar=node('nav',null,'pagination');pagesBar.setAttribute('aria-label','Mission pagination');
  const prev=button('Previous',()=>{missionOffset=Math.max(0,missionOffset-missionLimit);generation++;missionPage=null;render();refresh();});prev.disabled=missionOffset<=0;
  const next=button('Next',()=>{missionOffset+=missionLimit;generation++;missionPage=null;render();refresh();});next.disabled=!missionPage.has_more;
  pagesBar.append(prev,node('span',`Page ${page} / ${pages}`,'page-indicator'),next);result.append(pagesBar);return result;
 }
 function health(){const c=node('article',null,'glass');c.append(node('h2','System Health'));const conn=snapshot.connectivity||connectionView;if(conn){const r=node('div',null,'table-row');const text=node('div','Service connectivity');text.append(node('small',(conn.detail||conn.label)+(lastOkAt?' · Last ok '+stamp(lastOkAt):'')));r.append(text,chip(conn.label||conn.state));c.append(r);}for(const [label,item]of [['Control Plane',snapshot.control],['OpenCode · Primary',snapshot.runtime],['Memory V2 · Local',snapshot.memory],['Local provider',snapshot.provider],['Audit / events',snapshot.audit],['External client / MCP',snapshot.connection],['Disk capacity',snapshot.disk]]){const r=node('div',null,'table-row');const text=node('div',label);text.append(node('small',item.reason|| (label.startsWith('OpenCode')?'Exact artifact readiness':label.startsWith('Memory')?snapshot.memory.backend+' store observed':label==='Audit / events'?'Canonical ledger health':label.includes('MCP')?'Does not imply service disconnect':'Host observation')));r.append(text,chip(item.state));c.append(r);}const install=snapshot.installation_compatibility;if(install){const r=node('div',null,'table-row');const text=node('div','Installation compatibility');text.append(node('small',(install.mutations_allowed?'Mutations allowed':'Mutations blocked')+' · '+(install.upgrade_guidance?.length?install.upgrade_guidance.map(g=>g.component+': '+g.guidance).join(' · '):'Components observed without private context')));r.append(text,chip(install.overall||'Unavailable'));c.append(r);}const security=snapshot.runtime_security;if(security?.items){for(const item of security.items.slice(0,4)){const r=node('div',null,'table-row');const text=node('div','Runtime security · '+item.adapter);const props=Object.entries(item.properties||{}).map(([k,v])=>readable(k)+' '+readable(v.state)).join(' · ');text.append(node('small',props||'Host evidence classification'));r.append(text,chip(item.kind==='model_provider'?'Ready':'Degraded'));c.append(r);}}c.append(node('small',`Observed ${stamp(snapshot.observed_at)} · ${snapshot.leases.held} held leases · ${snapshot.leases.quarantined} quarantined`));return c;}
 function activity(limit=500){const list=node('ol',null,'feed');for(const e of [...feed.values()].filter(e=>!category||e.category===category).slice(-limit).reverse()){const item=node('li'),at=node('time',stamp(e.timestamp_ms)),body=node('div',e.label);if(e.timestamp_ms)at.dateTime=new Date(e.timestamp_ms).toISOString();body.append(node('small',e.category+(e.outcome?' · '+e.outcome:'')));item.append(at,body);list.append(item);}return list.children.length?list:empty('No matching observed events. Unsupported stages are never inferred.');}
 function overview(){
   const f=document.createDocumentFragment(),hero=node('article',null,'hero'),image=node('img');image.src='/brand/airodrom-3d-model-blue.svg';image.alt='Dimensional Airodrom mark';
   const copy=node('div');copy.append(node('span','OUTCOME-FIRST CONTROL','eyebrow'),node('h2','Goals and verified results.'),node('p','Airodrom plans, executes, repairs and verifies within authorized bounds. You see progress, genuine decisions, and concise results — not routine Continue or Retry steps.'),chip(snapshot.status));hero.append(image,copy);f.append(hero);
   const board=snapshot.outcomes||{progress:[],decisions:[],results:[]};
   const reviewTotal=snapshot.mission_counts?.['Needs Attention']??snapshot.mission_counts?.['Awaiting Review']??snapshot.counts.review??0;
   const grid=node('div',null,'grid');
   grid.append(
     glass('In progress',board.progress?.length??snapshot.counts.active,'Authorized autonomous work'),
     glass('Needs your decision',board.decisions?.length??reviewTotal,reviewTotal?'Acceptance or operator Decision':'None waiting'),
     glass('Approvals',snapshot.approvals.waiting,'Protected operations only'),
     glass('Verified results',board.results?.filter(r=>r.success).length??0,'Independent verification required')
   );f.append(grid);

   const goals=snapshot.autonomous_goals?.items||[];
   const goalsPanel=node('section',null,'glass');
   goalsPanel.append(node('h3','Autonomous goals'),node('p','Primary surface for continuous work. Scheduling continues in the durable service once authorized.','muted'));
   if(goals.length){
     for(const g of goals.slice(0,4)){
       const life=g.autonomous?.lifecycle||g.state;
       const row=node('div',null,'table-row');
       const textEl=node('div',g.goal_id||g.id||'Goal');
       textEl.append(node('small',(g.execution_enabled?'Executing within budget':'Observe only')+' · '+(readable(life)||life)));
       row.append(textEl,chip(life));goalsPanel.append(row);
     }
     goalsPanel.append(button('Open Autonomous Goals',()=>nav.get('Autonomous Goals').click()));
   }else goalsPanel.append(empty('No authorized autonomous goals yet. Open Autonomous Goals to review proposals.'));
   f.append(goalsPanel);

   const cols=node('div',null,'columns'),left=node('div'),right=node('div');
   left.append(node('h2','Current progress'));
   if(board.progress?.length){for(const item of board.progress){const card=node('article',null,'mission-row');const main=node('div',null,'mission-row-main');main.append(node('h3',item.label),node('p',item.headline,'mission-row-meta'));if(item.detail)main.append(node('small',item.detail));card.append(main,button('View',()=>selectMission(item.id),true));left.append(card);}}
   else left.append(empty('No live autonomous progress right now.'));

   left.append(node('h2','Needs your decision'));
   if(board.decisions?.length){for(const item of board.decisions){const card=node('article',null,'mission-row');const main=node('div',null,'mission-row-main');main.append(node('h3',item.label),node('p',item.headline,'mission-row-meta mission-next'));if(item.detail)main.append(node('small',item.detail));const actions=node('div',null,'actions');actions.append(button('Review',()=>selectMission(item.id),true));card.append(main,actions);left.append(card);}}
   else left.append(empty('No owner decisions waiting.'));

   left.append(node('h2','Recent verified results'));
   const verified=board.results||[];
   if(verified.length){for(const item of verified.slice(0,5)){const card=node('article',null,'mission-row');const main=node('div',null,'mission-row-main');main.append(node('h3',item.label),node('p',item.headline+(item.success?'':' · not a verified success'),'mission-row-meta'));card.append(main,button('Open report',()=>selectMission(item.id)));left.append(card);}}
   else left.append(empty('No recent results on this page.'));

   right.append(health(),node('h2','Platform readiness'),node('p',`Control ${snapshot.control.state} · OpenCode ${snapshot.runtime.state} · Memory ${snapshot.memory.state}`,'muted'),node('p','Execution diagnostics stay under Missions → Audit. Success always requires independent verification; Acceptance is never skipped.','muted'));
   cols.append(left,right);f.append(cols);return f;
 }
 function stopObsStream(){try{obsStream?.abort();}catch{}obsStream=null;}
 function connectObsStream(id){
   stopObsStream(); if(!authorized||paused||document.hidden||!id||typeof ReadableStream==='undefined')return;
   const controller=new AbortController(); obsStream=controller;
   const params=new URLSearchParams({mission:id,after:String(obsCursor||0)});
   if(obsFilter)params.set('category',obsFilter);
   (async()=>{
     try{
       const response=await fetch('/api/product/live-stream?'+params,{headers:{Authorization:'Bearer '+token},cache:'no-store',redirect:'error',signal:controller.signal});
       if(!response.ok||!response.body){obsStream=null;return;}
       const reader=response.body.getReader(),decoder=new TextDecoder(); let buffer='';
       while(true){
         const {value,done}=await reader.read(); if(done)break;
         buffer+=decoder.decode(value,{stream:true});
         let sep; while((sep=buffer.indexOf('\n\n'))>=0){
           const chunk=buffer.slice(0,sep); buffer=buffer.slice(sep+2);
           const lines=chunk.split('\n'); let event='message', data='';
           for(const line of lines){if(line.startsWith('event:'))event=line.slice(6).trim(); if(line.startsWith('data:'))data+=line.slice(5).trim();}
           if(!data)continue;
           let payload; try{payload=JSON.parse(data);}catch{continue;}
           if(event==='event'&&payload.event_id){
             if(!observatory)observatory={mission:{id},events:[],files:[],commands:[],tests:[],worker:[],activity:{}};
             const list=observatory.events||[]; if(!list.some(e=>e.event_id===payload.event_id))list.push(payload);
             observatory.events=list.slice(-200); obsCursor=Math.max(obsCursor,payload.sequence||0);
             if(['File','Git'].includes(payload.category))observatory.files=[...(observatory.files||[]),payload].slice(-64);
             if(payload.category==='Command')observatory.commands=[...(observatory.commands||[]),payload].slice(-64);
             if(payload.category==='Test')observatory.tests=[...(observatory.tests||[]),payload].slice(-32);
             if(['Worker','Runtime','Capability'].includes(payload.category))observatory.worker=[...(observatory.worker||[]),payload].slice(-64);
             observatory.activity={...(observatory.activity||{}),current_label:payload.label,phase:payload.stage||observatory.activity?.phase,last_heartbeat_ms:payload.timestamp_ms,advancing:['dispatching','running','verifying'].includes(snapshot?.selected_mission?.state||'')};
             if(missionId===id&&!document.hidden)render();
           }
         }
       }
     }catch(e){if(e.name!=='AbortError')obsStream=null;}
   })();
 }
 async function loadDiff(id,file){
   try{const diff=await api('/api/product/observatory/diff?mission='+encodeURIComponent(id)+'&path='+encodeURIComponent(file));diffCache.set(id+':'+file,diff);render();}
   catch(e){$('notice').textContent=e.message;}
 }
 function observatoryFeed(list,limit=80){
   const ol=node('ol',null,'obs-feed');
   const items=[...(list||[])].filter(e=>!obsFilter||e.category===obsFilter).filter(e=>!obsQuery||(`${e.label} ${e.path||''} ${e.tool||''} ${e.job||''}`).toLowerCase().includes(obsQuery.toLowerCase())).slice(-limit).reverse();
   for(const e of items){
     const li=node('li',null,'obs-item entry'+(e.branch==='attention'?' attention':''));
     const head=node('div',null,'obs-item-head');
     head.append(node('time',stamp(e.timestamp_ms)),node('span',e.category,'obs-cat'),node('strong',e.label));
     li.append(head);
     if(e.path||e.tool||e.job||e.exit_code!=null){
       const meta=node('small',null,'muted');
       meta.textContent=[e.path,e.tool,e.job,e.exit_code!=null?'exit '+e.exit_code:'',e.lines_added!=null?'+'+e.lines_added:'',e.lines_removed!=null?'−'+e.lines_removed:''].filter(Boolean).join(' · ');
       li.append(meta);
     }
     if(e.output){
       const key=e.event_id,open=expandedOutput.has(key);
       const toggle=button(open?'Hide output':'Expand output',()=>{if(open)expandedOutput.delete(key);else expandedOutput.add(key);render();});
       li.append(toggle);
       if(open){const pre=node('pre',e.output,'obs-output');li.append(pre);}
     }
     if(e.path&&(e.category==='File'||e.category==='Git'))li.append(button('View diff',()=>loadDiff(missionId,e.path)));
     ol.append(li);
   }
   return ol.children.length?ol:empty('No observed events in this filter. Progress is never inferred.');
 }
 function missionDetail(m){
   const obs=observatory?.mission?.id===m.id?observatory:null;
   const activity=obs?.activity||{};
   const outcome=m.outcome||{headline:(m.display&&m.display.label)||stateText(m.state),detail:m.next_action,success:false};
   const root=node('div',null,'observatory mission-detail');
   const top=node('header',null,'obs-top');
   top.append(button('← Back to Missions',()=>{stopObsStream();missionId=null;observatory=null;diffCache.clear();missionDetailTab='Outcome';if(missionListContext){missionFilter=missionListContext.filter;missionTab=missionListContext.tab;missionOffset=missionListContext.offset;missionLimit=missionListContext.limit;missionWorker=missionListContext.worker;missionSort=missionListContext.sort;searchQuery=missionListContext.query;missionPage=null;}generation++;view='Missions';$('heading').textContent='Missions';render();refresh();}));
   const title=node('div');title.append(node('span','OUTCOME','eyebrow'),node('h2',m.label),statusChip(m));
   title.append(node('p',outcome.headline,'mission-next'));
   if(outcome.detail)title.append(node('p',outcome.detail,'muted'));
   top.append(title);
   const controls=node('div',null,'actions obs-controls');
   if(m.actions.accept)controls.append(button('Review Acceptance',event=>openReview(m,event.currentTarget),true));
   if(m.actions.dispatch&&!m.autonomous_managed)controls.append(button('Run Mission',async()=>{try{await api('/api/assistant/mission',{action:'run',mission_id:m.id,request_id:crypto.randomUUID()});await refresh();}catch(e){$('notice').textContent=e.message;}}));
   if(m.autonomous_managed&&!m.actions.accept)controls.append(node('small','Autonomous execution authorized — no Continue / Retry / Next Mission required.','muted'));
   if(m.actions.cancel&&!m.autonomous_managed)controls.append(button('Cancel Mission',()=>send('cancel-mission',{id:m.id})));
   if(m.actions.archive)controls.append(button('Archive',async()=>{if(!window.confirm('Archive this Mission from the primary list?'))return;try{await api('/api/product/archive-missions',{ids:[m.id],confirmed:true,request_id:crypto.randomUUID(),reason:'operator_archive'});stopObsStream();missionId=null;observatory=null;missionPage=null;await refresh();}catch(e){$('notice').textContent=e.message;}}));
   if(m.actions.restore)controls.append(button('Restore',async()=>{try{await api('/api/product/restore-mission',{id:m.id,confirmed:true,request_id:crypto.randomUUID()});await refresh();}catch(e){$('notice').textContent=e.message;}}));
   top.append(controls);root.append(top,researchPanel(m));

   const summary=node('div',null,'live-facts mission-summary');
   const elapsed=activity.elapsed_s!=null?safeNum(activity.elapsed_s,' s'):(m.started_at&&snapshot?.observed_at?safeNum(Math.floor(((m.finished_at||snapshot.observed_at)-m.started_at)/1000),' s'):null);
   for(const [label,value]of [['Outcome',outcome.headline],['Worker',m.worker_assigned?m.runtime:null],['Progress',ACTIVE_UI(m.state)?(activity.current_label||m.latest_activity):null],['Elapsed',elapsed],['Created',stampKnown(m.created_at)]]){
     if(!present(value))continue;const fact=node('div');fact.append(node('small',label),node('span',value));summary.append(fact);
   }
   root.append(summary);

   const tabs=node('div',null,'mission-tabs detail-tabs');tabs.setAttribute('role','tablist');
   const tabDefs=[['Outcome','Outcome'],['Activity','Activity'],['Worker','Worker'],['Files & Git','Files'],['Tests','Tests'],['Verification','Verification'],['Audit','Audit']];
   for(const [label] of tabDefs){
     const b=button(label,()=>{missionDetailTab=label;render();});b.setAttribute('role','tab');b.setAttribute('aria-selected',missionDetailTab===label?'true':'false');
     if(missionDetailTab===label)b.classList.add('active-tab');tabs.append(b);
   }
   root.append(tabs);
   const panel=node('section',null,'glass detail-panel');
   if(missionDetailTab==='Outcome'||missionDetailTab==='Overview'){
     panel.append(node('h3','Result report'));
     panel.append(node('p',outcome.headline));
     if(outcome.detail)panel.append(node('p',outcome.detail,'muted'));
     if(outcome.success===true)panel.append(node('p','Verified success requires independent verification and recorded Acceptance.','muted'));
     else if(m.state==='completed')panel.append(node('p','Worker or Mission completion alone is never reported as verified success.','muted'));
     const split=node('div',null,'split obs-summary');
     split.append(glass('Verification',readable(m.verification.status)||'Not observed',m.verification.current?'Current':'Not current'),glass('Acceptance',readable(m.acceptance.status)||'Not applicable',m.actions.accept?'Decision required':null),glass('Settlement',readable(m.settlement.status)||'Not observed',null));
     panel.append(split);
     if(m.next_action)panel.append(node('p','Required of you: '+m.next_action,'mission-next'));
     const diag=node('details');diag.append(node('summary','Execution stages (secondary)'),lifecycle(m));panel.append(diag);
   }else if(missionDetailTab==='Activity'){
     const events=obs?.events||m.timeline||[];
     if(!events.length)panel.append(empty('No activity observed yet.'));
     else panel.append(observatoryFeed(events,120));
   }else if(missionDetailTab==='Worker'){
     if(!m.worker_assigned&&!m.runtime)panel.append(empty('No worker assigned. Normal before execution starts.'));
     else{panel.append(node('p',(m.runtime||'Worker')+(m.model?.id?' · '+m.model.id:'')));panel.append((obs?.worker||[]).length?observatoryFeed(obs.worker,40):empty('No mid-run worker events observed yet.'));}
   }else if(missionDetailTab==='Files & Git'){
     const files=obs?.files||[];
     if(!files.length)panel.append(empty('No host-measured file or git changes observed.'));
     else{const ul=node('ul',null,'obs-files');for(const e of files.slice(-24).reverse()){const li=node('li');li.append(node('strong',e.path||e.label),node('small',e.category+' · '+(stamp(e.timestamp_ms)||'time not observed')));if(e.path)li.append(button('Diff',()=>loadDiff(m.id,e.path)));ul.append(li);}panel.append(ul);}
     const diffKey=[...diffCache.keys()].find(k=>k.startsWith(m.id+':'));
     if(diffKey){const d=diffCache.get(diffKey);panel.append(node('h3','Diff · '+d.path),node('pre',d.diff,'diff-view'));}
   }else if(missionDetailTab==='Tests'){
     panel.append((obs?.tests||[]).length?observatoryFeed(obs.tests,20):empty('No test observations recorded.'));
   }else if(missionDetailTab==='Verification'){
     panel.append(glass('Verification',readable(m.verification.status)||'Not observed',m.verification.current?'Current revision':'Not current'));
     if(m.verification.checks?.length){const ul=node('ul',null,'checks');for(const c of m.verification.checks)ul.append(node('li',c.label+' · '+(readable(c.status)||'not observed')));panel.append(ul);}
     else panel.append(empty('No independent verification checks observed yet.'));
     panel.append(glass('Acceptance',readable(m.acceptance.status)||'Not applicable',m.acceptance.mode?readable(m.acceptance.mode):null));
     panel.append(glass('Settlement',readable(m.settlement.status)||'Not observed',null));
   }else{
     const trace=snapshot.flight_recorder;
     if(trace){panel.append(node('p',trace.explanation),node('p',trace.next_safe_action));const list=node('ol');for(const e of trace.events||[])list.append(node('li',(stamp(e.timestamp)||'')+' · '+e.label+(e.policy_outcome?' · '+e.policy_outcome:'')));panel.append(list);}
     else if(m.timeline?.length)panel.append(observatoryFeed(m.timeline,80));
     else panel.append(empty('No audit timeline observed yet.'));
     const tech=node('details');tech.append(node('summary','Technical diagnostics'),node('pre',JSON.stringify({id:m.id,state:m.state,revision:m.revision,termination:m.termination,budget:m.budget,authority:m.authority,autonomous_managed:m.autonomous_managed},null,2)));panel.append(tech);
   }
   root.append(panel,node('p',(obs?.limitations||['Observatory shows sanitized host observations only.']).join(' '),'privacy'));
   return root;
 }
 function ACTIVE_UI(state){return ['dispatching','running','verifying'].includes(state);}
 function memoryLayerChip(state){const s=String(state||'Unavailable');if(s==='Disabled'||s==='Not installed')return node('span',s,'chip degraded');if(s==='Configured')return node('span',s,'chip waiting');return chip(s);}
 function memoryLayersPanel(layers,{compact=false}={}){
   const panel=node('section',null,'glass memory-layers'+(compact?' compact':''));
   panel.append(node('h3',compact?'Memory layers · live':'All memory layers · live'));
   const list=node('div',null,'memory-layer-list');
   const items=Array.isArray(layers)&&layers.length?layers:[
     {id:'personal',label:'Personal Memory V2',state:'Unavailable',percent:0,used:null,capacity:null,detail:'Waiting for observation'},
     {id:'project',label:'Project Memory V2',state:'Unavailable',percent:0,used:null,capacity:null,detail:'Waiting for observation'},
     {id:'architecture',label:'Architecture / canonical',state:'Unavailable',percent:0,used:null,capacity:null,detail:'Waiting for observation'},
     {id:'context_pack',label:'ContextPack (1h)',state:'Unavailable',percent:0,used:null,capacity:null,detail:'Waiting for observation'},
     {id:'developer',label:'Developer Memory V1',state:'Unavailable',percent:0,used:null,capacity:null,detail:'Waiting for observation'}
   ];
   for(const [index,layer] of items.entries()){
     const row=node('article',null,'memory-layer'+(layer.state==='Ready'?' live':''));
     row.style.setProperty('--layer-delay',(index*90)+'ms');
     row.dataset.layer=layer.id||'';
     const head=node('div',null,'memory-layer-head');
     const title=node('div',null,'memory-layer-title');
     title.append(node('strong',layer.label||layer.id||'Layer'),node('small',layer.detail||(layer.authority===false?'Reference only · no authority':'Live observation')));
     const pct=typeof layer.percent==='number'?Math.max(0,Math.min(100,layer.percent)):null;
     const meta=node('div',null,'memory-layer-meta');
     meta.append(memoryLayerChip(layer.state),node('span',pct==null?'—':pct+'%','memory-layer-pct'));
     head.append(title,meta);
     const track=node('div',null,'track memory-layer-track'+(layer.state==='Ready'&&pct!=null&&pct>0?' determinate active':layer.state==='Ready'?' active':''));
     if(pct!=null)track.style.setProperty('--progress',pct+'%');
     track.setAttribute('role','progressbar');
     track.setAttribute('aria-valuemin','0');
     track.setAttribute('aria-valuemax','100');
     if(pct!=null)track.setAttribute('aria-valuenow',String(pct));
     track.setAttribute('aria-label',(layer.label||'Memory layer')+' usage');
     const counts=node('p',null,'memory-layer-counts muted');
     const used=layer.used==null?'—':String(layer.used);
     const capacity=layer.capacity==null?'—':String(layer.capacity);
     counts.textContent=used+' / '+capacity+(compact?'':' · '+(layer.capacity_kind==='reference_soft'?'reference soft capacity':'capacity'));
     row.append(head,track,counts);
     list.append(row);
   }
   panel.append(list,node('p',compact?'Polled with Control Center overview · private contents never shown.':'Usage bars reflect host-retained counts against soft capacity. Private memory text is never rendered here. Developer Memory stays off unless operator-enabled.','muted'));
   return panel;
 }
 function memoryView(){const result=node('div');result.append(glass('Memory V2',snapshot.memory.state,snapshot.memory.backend+' · Local'),glass('Active personal records',snapshot.memory.active_records??'Unavailable','Normal sensitivity · current operator scope'));result.append(memoryLayersPanel(snapshot.memory?.layers||[]));const facts=node('div',null,'live-facts memory-live-facts');for(const [label,value]of[['Observed',stamp(snapshot.observed_at)],['Generation',snapshot.memory.generation?String(snapshot.memory.generation).slice(0,48)+'…':'Unavailable'],['Expired',snapshot.memory.expired_records??'Unavailable'],['Superseded',snapshot.memory.superseded_records??'Unavailable'],['Backend',snapshot.memory.backend||'Unavailable'],['Local only',snapshot.memory.local===false?'No':'Yes']]){const fact=node('div');fact.append(node('small',label),node('span',String(value)));facts.append(fact);}result.append(facts,node('p','Retrieve personal references explicitly. Corrections supersede the selected record; forgetting invalidates prior context. Private text is cleared on navigation, hiding, authorization loss or canonical changes.'));const form=node('form'),query=node('input');query.type='search';query.placeholder='Search current personal Memory';query.setAttribute('aria-label','Memory query');query.dataset.focusKey='memory-query';query.value=memoryQuery;query.oninput=()=>memoryQuery=query.value;form.append(query,button('Retrieve current Memory',()=>retrieveMemory(),true));form.onsubmit=e=>{e.preventDefault();retrieveMemory();};result.append(form);for(const m of memoryResults){const card=node('article',null,'glass');card.append(node('h3',m.subject),node('p',m.content),node('small',m.source));const correct=button('Correct selected record',()=>{selectedMemory=m.id;memoryDraft=m.content;render();});correct.dataset.focusKey='memory:'+m.id+':correct';const forget=button('Forget selected record',()=>mutateMemory('forget-memory',{id:m.id}));forget.dataset.focusKey='memory:'+m.id+':forget';card.append(correct,forget);result.append(card);}const edit=node('textarea');edit.rows=3;edit.maxLength=2000;edit.setAttribute('aria-label',selectedMemory?'Corrected Memory content':'Memory to remember');edit.dataset.focusKey='memory-draft';edit.value=memoryDraft;edit.oninput=()=>memoryDraft=edit.value;result.append(node('h2',selectedMemory?'Correct selected Memory':'Remember an explicit fact'),edit,button(selectedMemory?'Save correction':'Remember',()=>mutateMemory(selectedMemory?'correct-memory':'remember-memory',{...(selectedMemory?{id:selectedMemory}:{}),content:memoryDraft}),true));if(selectedMemory)result.append(button('Cancel correction',()=>{selectedMemory=null;memoryDraft='';render();}));return result;}
 function clearMemory(){for(const url of researchImages.values())URL.revokeObjectURL(url);researchImages.clear();researchReports.clear();const turn=activeDirectTurn;activeDirectTurn=null;if(turn&&authorized)api('/api/assistant/conversation/cancel',turn).catch(()=>{});conversationHistory=[];conversationNotice='';activeConversationId=null;conversationStreaming=null;memoryEpoch++;memoryController?.abort();memoryController=null;memoryResults=[];memoryDraft='';memoryQuery='';selectedMemory=null;}
 async function conversationSession({forceNew=false}={}){
  if(forceNew||pendingNewConversation||!conversationSessionId){
   const created=await api('/api/assistant/conversation/session',{channel:'browser',...((forceNew||pendingNewConversation)?{new:true}:{})});
   conversationSessionId=created.conversation_id;pendingNewConversation=false;
   try{sessionStorage.removeItem('airodromConversationPendingNew');if(conversationSessionId)sessionStorage.setItem('airodromConversationSession',conversationSessionId);}catch{}
  }
  if(!conversationSessionId)throw Error('Conversation unavailable.');
  return conversationSessionId;
 }
 async function showAssistantReceipt(receipt,version){
   if(version!==generation||!authorized||document.hidden||view!=='Conversation'){if(receipt.kind==='chat'&&authorized)await api('/api/assistant/conversation/cancel',{conversation_id:receipt.conversation_id,turn_id:receipt.turn_id}).catch(()=>{});return;}
   if(receipt.kind==='public_web_offer'){const next=await approvePublicWeb(receipt);if(next){await refresh();if(next.mission_id)selectMission(next.mission_id);}else{conversationNotice='Public web permission cancelled.';render();}return;}
   if(receipt.kind==='zero_setup'){
     const state=String(receipt.state||'').toUpperCase();
     conversationNotice=state==='WAIT'
       ?'Prepared bounded local work. Approve in Terminal with y/N, or use Autonomous Goals → Approve this task. Nothing has been written yet.'
       :state==='CLARIFY'
         ?(receipt.message||'One short clarification is required before preparation can continue.')
         :(receipt.message||receipt.presentation?.status||'Bounded work update.');
     if(version===generation&&authorized&&!document.hidden&&view==='Conversation')render();
     return;
   }
   let notice=receipt.display||receipt.message||(receipt.mission_id?'Mission registered.':'Request handled.');
   if(receipt.kind==='chat'){
     const turn={conversation_id:receipt.conversation_id,turn_id:receipt.turn_id};activeDirectTurn=turn;conversationNotice=(receipt.activity||'Thinking…')+(receipt.model?' · '+receipt.model+' · local-ollama':'');render();
     const deadline=Date.now()+130000;
     try{
       while(Date.now()<deadline&&version===generation&&authorized&&!document.hidden&&view==='Conversation'&&activeDirectTurn===turn){
         const result=await api('/api/assistant/conversation?conversation_id='+encodeURIComponent(turn.conversation_id)+'&turn_id='+encodeURIComponent(turn.turn_id));
         if(version!==generation||activeDirectTurn!==turn)return;
         if(result.state==='running'){conversationNotice=(result.activity||'Thinking…')+(result.model?' · '+result.model+' · '+(result.worker||'local-ollama'):'');render();}
         if(result.state==='completed'){activeDirectTurn=null;await refresh();if(version===generation&&authorized&&!document.hidden&&view==='Conversation'){conversationNotice=(receipt.draft_only?'Local reply preview — not saved in Gmail or sent. ':'')+(result.model?result.model+' · local-ollama · ':'')+(conversationHistory.some(item=>item.turn_id===turn.turn_id&&item.response)?'':result.summary||'');render();}return;}
         if(['failed','cancelled'].includes(result.state))throw Error(result.reason||'Conversation stopped.');
         await new Promise(resolve=>setTimeout(resolve,250));
       }
       if(activeDirectTurn===turn)throw Error('Conversation timed out.');
     }finally{if(activeDirectTurn===turn){activeDirectTurn=null;await api('/api/assistant/conversation/cancel',turn).catch(()=>{});}}
     return;
   }
   if(receipt.kind==='connect_required'&&receipt.can_start_oauth)notice+=' Use /connect '+receipt.connector+' in Terminal to authorize access in your browser.';
   if(receipt.kind==='google_form')notice='Open /'+receipt.operation.replace('.', ' ')+' in Terminal for the exact private review form and local confirmation.';
   if(receipt.kind==='vault')notice='Open /vault in the Airodrom terminal for secure entry.';
   if(receipt.kind==='memory'){
     // A busy polling refresh may return early. Read current canonical metadata
     // independently before displaying an explicitly requested memory reply.
     const current=await api('/api/product/overview');
     if(version!==generation||!authorized||document.hidden||view!=='Conversation')return;
     if(receipt.memory_generation!==current.memory.generation){clearMemory();render();return;}
     notice=receipt.items.length?receipt.items.map(m=>m.content).join('\n\n'):'No current memories found.';
   }
   if(version===generation&&authorized&&!document.hidden&&view==='Conversation'){activeConversationId=receipt.mission_id||null;conversationNotice=notice;render();}
 }
 async function retrieveMemory(){const version=generation,epoch=++memoryEpoch,known=snapshot?.memory?.generation;memoryController?.abort();memoryController=new AbortController();try{const result=await api('/api/product/memory?query='+encodeURIComponent(memoryQuery),undefined,memoryController.signal);if(authorized&&epoch===memoryEpoch&&version===generation&&view==='Memory'&&!document.hidden&&known===snapshot?.memory?.generation&&result.generation===known){memoryResults=result.items;render();}}catch(e){if(epoch!==memoryEpoch)return;clearMemory();render();$('notice').textContent=e.message;}}
 async function mutateMemory(action,body){generation++;inflight?.abort();clearMemory();render();try{await api('/api/product/'+action,body);await refresh();}catch(e){$('notice').textContent=e.message;}}
 function workspaceLink(text,task){const link=node('a',text);link.href='/workspace';link.onclick=()=>{if(task)try{sessionStorage.setItem('airodromTask',task);}catch{}};return link;}
 function workTemplatesView(){
   const result=node('section');result.append(node('h2','Local WORK templates'),node('p','Owner registration fixes exact files, focused tests and an expiry. OpenCode stays primary. Local-only inference; no external fallback, commits, push, deploy, secrets or automatic Acceptance. Existing protected approvals still apply.'));
   for(const item of snapshot.work_templates?.items||[]){const card=glass(item.project+' / '+item.workspace_alias,item.state,'Immutable registration');const detail=node('details');detail.append(node('summary','Inspect exact scope and capability ceiling'),node('p','Repository: '+(item.workspace||'Unavailable')),node('p','Project: '+(item.project_id||'Unavailable')+' · Goal: '+(item.goal_id||'Unavailable')),node('p','Files allowed to change:'),node('pre',(item.allowed_files||[]).join('\n')),node('p','Verification: '+[item.verification?.diff_check,...(item.verification?.tests||[])].filter(Boolean).join(', ')),node('p','Expires: '+(item.expires_at?stamp(item.expires_at):'Unavailable')),node('p','OpenCode · local_only · read and exact scoped writes · focused host tests · read-only canonical Memory · explicit Acceptance'),node('p','No external fallback, secrets, commits, push, merge, deploy or automatic Settlement.'));const record=node('details');record.append(node('summary','Registration record'),node('pre',JSON.stringify(item,null,2)));detail.append(record);card.append(detail);if(item.state!=='revoked')card.append(button('Revoke template',async()=>{if(!window.confirm('Revoke '+item.project+' / '+item.workspace_alias+'? New submissions and further authorized execution will be denied.'))return;try{await api('/api/assistant/work-templates/revoke',{project:item.project,workspace_alias:item.workspace_alias,template_hash:item.template_hash,confirmed:true});await refresh();}catch(e){$('notice').textContent=e.message;}}));result.append(card);}
   const form=node('form');for(const [key,label]of templateFields){const field=node('label',label),input=node(['allowed_files','tests'].includes(key)?'textarea':'input');input.name=key;input.required=true;input.value=templateDraft[key]||'';input.dataset.focusKey='template-'+key;input.setAttribute('aria-label',label);input.oninput=()=>templateDraft[key]=input.value;field.append(input);form.append(field);}
   const submit=node('button','Review and register');submit.type='submit';form.append(submit);form.onsubmit=async e=>{e.preventDefault();const body={...templateDraft,allowed_files:(templateDraft.allowed_files||'').split('\n').map(s=>s.trim()).filter(Boolean),tests:(templateDraft.tests||'').split('\n').map(s=>s.trim()).filter(Boolean),duration_minutes:Number(templateDraft.duration_minutes),confirmed:true};if(!window.confirm('Approve this exact local WORK template?\n'+JSON.stringify(body,null,2)+'\nScope cannot be edited or renewed. Use a new alias for a new registration. Explicit Acceptance remains required.'))return;submit.disabled=true;try{await api('/api/assistant/work-templates/register',body);for(const key of Object.keys(templateDraft))delete templateDraft[key];templateDraft.duration_minutes='60';await refresh();}catch(e){$('notice').textContent=e.message;}finally{submit.disabled=false;}};result.append(form);return result;
 }
 function googleView(){
   const result=node('section');result.append(node('h2','Google Connections'),node('p','Google consent, API enablement and account access are separate. Status checks do not change your account.'));
   result.append(node('p','Conversation: Search email → Find emails from Plaid → Read first message → Draft reply. Selections expire after five minutes and are bound to this session and Google account. Reply previews stay with local Qwen, even when Claude is selected. Saving a Gmail draft and sending are separate exact-review actions in Terminal.'));
   const data=snapshot.google;if(!data){result.append(empty('Connection status unavailable. Use /google status in Terminal.'));return result;}
   for(const [id,title,apiName,apiId]of [['gmail','Gmail','Gmail API','gmail.googleapis.com'],['calendar','Calendar','Google Calendar API','calendar-json.googleapis.com'],['drive','Drive','Google Drive API','drive.googleapis.com']]){
    const status=data.services?.[id],card=glass(title,data.permissions?.[id]?'OAuth permission granted':'OAuth permission missing',status?.state||'API availability not checked');
    if(status?.message)card.append(node('p',status.message));
    card.append(node('p','Read: '+data.reads.filter(x=>x.startsWith(id+'.')).map(x=>x.split('.')[1]).join(', ')),node('p','Write with exact owner confirmation: '+data.writes.filter(x=>x.startsWith(id+'.')).map(x=>x.split('.')[1]).join(', ')));
    if(id==='calendar')card.append(node('p','Calendar list permission: '+(data.permissions.calendar_list?'granted':'missing')));
    const details=node('details'),summary=node('summary','Owner steps: '+apiName);details.append(summary,node('p','In Google Cloud Console, select the project that owns your desktop OAuth client. Go to APIs & Services → Library, find '+apiName+' and enable it only if you authorize that change. Confirm the project before proceeding. Airodrom does not enable APIs, modify credentials or change billing.'),node('p','If OAuth scope is missing, run /connect google in Terminal and review consent. If access is denied with scopes granted and the API enabled, check the signed-in account and access to the selected calendar or file.'));
    const link=node('a','Open '+apiName+' in Cloud Console ↗');link.href='https://console.cloud.google.com/apis/library/'+apiId;link.target='_blank';link.rel='noopener noreferrer';details.append(link);card.append(details);result.append(card);
   }
   const scopes=node('details');scopes.append(node('summary','Granted OAuth scopes'),node('pre',(data.scopes||[]).join('\n')||'None observed'));result.append(scopes,node('h3','Review and activity'),node('p',data.approval),node('p','Use /gmail compose or /gmail send, /calendar create, or /drive upload in Terminal. The exact content appears before local confirmation. No approval is implied by connection or scope status. /google receipt <id> checks a prior action without repeating it.'),node('p','API observations are from this service session only; “not checked” is not a failure. Google write receipts persist in the existing activity store. Autonomous Google changes are off.'));for(const item of data.activity||[])result.append(node('p',stamp(item.created_at)+' · '+readable(item.state)+(item.error?' · '+readable(item.error):'')+' · Receipt '+item.id));return result;
 }
 let providerGeneration=-1;
 function preferencesView(){
   const result=node('section');result.append(node('h2','Choose your primary assistant'),node('p','ChatGPT is the default conversational client. Local uses this Control Center or the terminal. Selection grants no access and does not connect an account.'));
   result.append(glass('Current conversation provider',snapshot.provider?.state||'Unavailable',snapshot.provider?.message||'Use /provider in Terminal for current host routing.'));
   result.append(node('p','Conversation selection is separate from coding workers. External processing is OFF until the exact data policy and subscription conversation boundary are approved. No Google data, Memory, history, files or secrets are included.'));
   const provider=snapshot.provider,providerStale=failures>0||paused||document.hidden||providerGeneration!==generation;
   if(provider?.schema_version===1){
     const controls=node('section',null,'glass'),label=node('label','Conversation provider'),select=node('select');select.setAttribute('aria-label','Conversation provider');
     for(const [id,title]of [['qwen','Qwen · local only (default)'],['claude','Claude · unavailable · WAIT until qualified']]){const option=node('option',title);option.value=id;select.append(option);}select.value=provider.preferences.provider==='claude'?'qwen':provider.preferences.provider;label.append(select);controls.append(label);
     const save=button('Save conversation provider',async()=>{save.disabled=true;try{if(select.value==='claude'){preferenceNotice='Claude is unavailable until independently qualified. Qwen remains the selected working provider. No Claude activation, API key, or subscription workaround.';select.value='qwen';render();return;}await api('/api/assistant/provider',{revision:provider.preferences.revision,provider:'qwen',consent:null});preferenceNotice='Qwen selected · local only. No transmission authorized.';await refresh();}catch(e){preferenceNotice=e.message;render();}});
     save.disabled=providerStale;select.disabled=providerStale;controls.append(save);
     const consent=button('Review external data policy',async()=>{if(!window.confirm(provider.consent_text+'\n\nThis records only a data policy. Claude remains OFF until independently qualified. No inference or billing is approved. Record this policy?'))return;consent.disabled=true;try{await api('/api/assistant/provider',{revision:provider.preferences.revision,provider:'claude',consent:provider.consent_text});await refresh();}catch(e){preferenceNotice=e.message;render();}});
     consent.disabled=providerStale;controls.append(consent);
     const rollback=button('Use Qwen and revoke external consent',async()=>{rollback.disabled=true;try{await api('/api/assistant/provider',{revision:provider.preferences.revision,provider:'qwen',consent:null});await refresh();}catch(e){preferenceNotice=e.message;render();}});rollback.disabled=providerStale;controls.append(rollback,node('p','External data policy: '+(provider.preferences.consent?'public text, exact per-message review required':'OFF')),node('p',provider.qualification.owner_action));
     if(provider.qualification.gates)for(const [gate,state]of Object.entries(provider.qualification.gates))controls.append(node('p',readable(gate)+': '+readable(state)));
     controls.append(node('p','Actual Claude model: '+(provider.qualification.actual_model||'Not observed')+' · Subscription billing: '+(provider.qualification.billing?.source||'Not observed')+'. No automatic external fallback.'));
     if(providerStale)controls.append(node('p','Settings disabled while observations are stale or updates are paused. Reconnect and refresh first.'));result.append(controls);
   }else result.append(empty('Conversation switching requires a compatible backend. Settings are unavailable; no provider change was made.'));

   result.append(routeControls());
   const data=snapshot.orchestration;if(!data){result.append(empty('Settings require the updated backend. Existing Missions and permissions are unchanged.'));return result;}
   const saved=data.preferences;result.append(chip(saved.onboarded?'Configured':'First-time setup'),node('p','Result delivery: authenticated retrieval after reconnecting with the original client session. ChatGPT cannot receive unsolicited push. Other clients are not listed until supported.'));
   const form=node('form',null,'preference-form');
   const choice=(key,label,options,value)=>{const field=node('label',label),select=node('select');select.setAttribute('aria-label',label);select.dataset.focusKey='preferences-'+key;for(const [id,title]of options){const option=node('option',title);option.value=id;select.append(option);}select.value=preferenceDraft[key]??value;select.onchange=()=>{preferenceDraft[key]=select.value;};field.append(select);form.append(field);return select;};
   choice('primary_assistant','Primary assistant',[['chatgpt','ChatGPT · authenticated MCP'],['local','Local Control Center / terminal']],saved.primary_assistant);
   choice('worker','Preferred coding worker',[['auto','Automatic qualified route'],...(snapshot.assistant?.workers||[]).filter(w=>['opencode','codex','claude_code'].includes(w.id)).map(w=>[w.id,w.id+' · '+(w.available?w.qualification:('Unavailable · '+(w.reason||w.qualification)))])],saved.coding_worker);
   choice('scope','Apply preference',[['once','Once · next bounded WORK request'],['project','Project default'],['always','Always · local WORK default']],'once');
   const aliasLabel=node('label','Project alias'),alias=node('input');alias.setAttribute('aria-label','Project alias');alias.dataset.focusKey='preferences-project';alias.value=preferenceDraft.project||'';alias.oninput=()=>preferenceDraft.project=alias.value;aliasLabel.append(alias);form.append(aliasLabel);
   const save=node('button','Save selection');save.type='submit';form.append(save,node('p','Once is held for the next request in this tab. Project and Always persist only routing intent. Current qualification, privacy, signed template, expiry and revocation are checked on every execution.'));
   form.onsubmit=async e=>{e.preventDefault();const worker=preferenceDraft.worker??saved.coding_worker,scope=preferenceDraft.scope||'once';if(['claude_code','codex'].includes(worker)&&!window.confirm('Save an external coding worker preference? '+worker+' may use a vendor account or incur usage charges when you later approve eligible public Work. This saves a preference only; it does not start a worker, switch local conversation or authorize email/Memory disclosure.'))return;save.disabled=true;try{const next={...saved,projects:{...saved.projects},primary_assistant:preferenceDraft.primary_assistant??saved.primary_assistant,onboarded:true};if(scope==='always')next.coding_worker=worker;if(scope==='project'){if(!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(preferenceDraft.project||''))throw Error('Enter a registered project alias.');next.projects[preferenceDraft.project]=worker;}await api('/api/assistant/preferences',next);onceWorker=scope==='once'?worker:undefined;preferenceNotice='Saved '+scope+' preference. No execution authority granted.';await refresh();}catch(error){preferenceNotice=error.message;render();}finally{save.disabled=false;}};result.append(form);
   for(const [project,worker]of Object.entries(saved.projects)){const row=node('p',project+' → '+worker+' ');row.append(button('Remove '+project+' preference',async()=>{const projects={...saved.projects};delete projects[project];try{await api('/api/assistant/preferences',{...saved,projects});await refresh();}catch(e){preferenceNotice=e.message;render();}}));result.append(row);}
   result.append(node('h2','Start bounded WORK'),node('p','Uses an existing signed template. No scope is inferred from this request. The result stops for independent verification and operator Acceptance.'));
   const work=node('form',null,'preference-form');for(const [key,label]of [['project','WORK project alias'],['workspace','WORK template alias'],['objective','WORK objective']]){const field=node('label',label),input=node(key==='objective'?'textarea':'input');input.required=true;input.maxLength=key==='objective'?4000:64;input.value=workDraft[key];input.setAttribute('aria-label',label);input.dataset.focusKey='work-'+key;input.oninput=()=>{workDraft[key]=input.value;workRequestId=null;};field.append(input);work.append(field);}const run=node('button','Submit bounded WORK');run.type='submit';work.append(run);work.onsubmit=async e=>{e.preventDefault();run.disabled=true;workRequestId ||= crypto.randomUUID();try{const receipt=await api('/api/assistant/handoff',{version:2,request_id:workRequestId,...workDraft,mission_class:'WORK',data_class:'public',privacy:'local_only',...(onceWorker===undefined?{}:{worker:onceWorker}),model:'auto'});if(receipt.mission_id){onceWorker=undefined;workRequestId=null;selectMission(receipt.mission_id);}else{preferenceNotice='Waiting: '+readable(receipt.reason);render();}}catch(error){preferenceNotice=error.message;render();}finally{run.disabled=false;}};result.append(work,node('p',preferenceNotice,'notice'));return result;
 }
 function assistantView(){
   const result=node('div');
   if(view==='AI & Workers')return preferencesView();
   if(view==='Automation & Permissions'){result.append(node('h2','Automation within approved boundaries'),node('p','Read access requires an authorized scope. Local edits require a signed, unexpired WORK template. Sensitive actions require their existing exact approval; destructive actions have no blanket authorization. Revocation takes effect at execution and host application. Recovery never replays an uncertain external effect. Worker preferences cannot change these rules.'),node('p','Live activity and approvals are in Missions and Approvals. Enable native notifications from the Airodrom menu; macOS permission is separate. Completion is not Acceptance.'));result.append(workTemplatesView());return result;}
   if(view==='WORK Templates')return workTemplatesView();
   if(view==='Models'||view==='Workers'){
     for(const item of (view==='Models'?snapshot.assistant?.models:snapshot.assistant?.workers)||[]){result.append(glass(item.id,item.qualification,(item.provider||item.transport)+' · '+item.locality+' · '+(item.available?'Available':'Unavailable')),node('p',item.reason?item.reason.replaceAll('_',' '):item.support||'Context limit, token usage and cost: Unavailable'));
       if(view==='Workers'&&['codex','claude_code','cursor'].includes(item.id)){
         result.append(node('p','Installed: '+(item.installed?'Yes':'No')+' · Account: '+(item.auth_state||'Not probed')+' · Version: '+(item.version||'Not verified')+' · Qualification expiry: '+(item.expires_at?stamp(item.expires_at):'None')));
         if(item.id!=='cursor'&&item.installed&&!item.busy)result.append(button('Qualify '+item.id,async()=>{const model=window.prompt('Exact vendor model ID for a public synthetic edit check');if(!model||!window.confirm('Allow this vendor to receive one disposable public fixture? No personal Memory or repository files. Up to two minutes. This does not grant Mission execution.'))return;try{await api('/api/assistant/workers/qualify',{worker:item.id,model,confirmed:true,request_id:crypto.randomUUID()});await refresh();}catch(e){$('notice').textContent=e.message;}}));
         if(item.qualified||item.busy)result.append(button('Revoke '+item.id,async()=>{try{await api('/api/assistant/workers/revoke',{worker:item.id});await refresh();}catch(e){$('notice').textContent=e.message;}}));
       }
     }result.append(routeControls());result.append(node('p','Discovery does not qualify a route. Manual preference cannot bypass privacy, expiry or availability. Optional workers require fresh independent qualification.'));return result;
   }
   if(view==='Google Connections')return googleView();
   if(view==='Connectors'){for(const c of snapshot.connectors?.items||[])result.append(glass(c.id,c.state,c.protocol),node('p',c.setup),node('p',c.mutations));const wa=snapshot.whatsapp_inbound;if(wa){const live=wa.live_connection||{};const cred=wa.credentials||live.credentials||{};const meta=wa.meta||{};const cb=wa.callback||{};result.append(glass('WhatsApp inbound',wa.state,'Official Business webhook · auto Mission execution: off · retained '+(wa.retained||0)));result.append(node('p','Meta App '+(meta.meta_app_id||'—')+(meta.discovery?.app_name?' · '+meta.discovery.app_name:'')+' · Portfolio '+(meta.business_portfolio_id||'—')+' · WABA '+(meta.waba_id||'unavailable')+' · Phone Number ID '+(meta.phone_number_id||'unavailable')+' · publication '+(meta.app_publication_status||'unknown')+' · webhook '+(meta.webhook_subscription_status||'inactive'),'muted'));result.append(node('p','Credentials verify '+(cred.verify_token?.bound?'bound':'missing')+' · app secret '+(cred.app_secret?.bound?'bound':'missing')+' · access token '+(cred.access_token?.bound?'bound':'missing')+' · Graph '+(meta.discovery?.graph_access||'unavailable'),'muted'));result.append(node('p','Callback '+(cb.path||'/webhooks/whatsapp')+' · TLS required · prepared '+(cb.prepared_callback_url||'none')+' · public ingress '+(wa.public_ingress?'on':'off')+' · MCP tunnel unsuitable','muted'));if(live.subscription?.blockers?.length)result.append(node('p','Live blockers: '+live.subscription.blockers.join(', '),'muted'));result.append(node('p','Allowlist '+(wa.allowlist?.length||0)+' · lifecycle Received→Verified→Stored→Available · real test '+(live.real_message_test?.executed?'done':'deferred'),'muted'));for(const item of wa.recent||[]){const life=item.lifecycle;const lifeLabel=life?['received','verified','stored','available'].filter(k=>life[k]).join('→'):(item.status||'received');result.append(node('p',lifeLabel+' · '+(item.status||'received')+' · '+(item.from||'unknown')+' · '+(item.content||'').slice(0,120),'muted'));}}result.append(node('p','Selected email and message text is untrusted data. It cannot grant permissions. Local reply drafts never send. Inbound WhatsApp never auto-dispatches Missions. Public Meta HTTPS remains inactive until owner authorization.'));return result;}
   if(view==='Development Sessions'){
     const dsPanel=snapshot.development_sessions||{};
     if(window.AirodromDevelopmentSessions&&typeof window.AirodromDevelopmentSessions.render==='function'){
       const handled=window.AirodromDevelopmentSessions.render(result,dsPanel,{
         glass,node,button,api,stamp,
         setNotice:(msg)=>{conversationNotice=msg;render();}
       });
       if(handled===true)return result;
     }

     const ds=snapshot.development_sessions||{};
     const labels={LOCAL_ONLY:'LOCAL ONLY',READY_TO_PUSH:'READY TO PUSH',PR_OPEN:'PR OPEN',READY_TO_MERGE:'READY TO MERGE',MERGED:'MERGED'};
     const pending=Object.entries(ds.integration_counts||{}).filter(([k,n])=>n&&['READY_TO_PUSH','READY_TO_MERGE'].includes(k)).map(([k,n])=>labels[k]+' '+n);
     const daily=window.__dailyIntegration;
     result.append(glass('Local-first defaults',ds.merge_window_open?'Merge window open':'Merge window closed','auto push off · auto merge off · hosted CI auto-dispatch off'));
     result.append(node('p','Timezone '+(ds.merge_window?.timezone||'—')+' · '+(ds.merge_window?.local_start||'')+'-'+(ds.merge_window?.local_end||'')+' · open '+(ds.open_sessions||0),'muted'));
     result.append(node('p','Daily integration checkpoint requires operator authorization. Pending approvals: '+(pending.length?pending.join(' · '):'none')+'. CI cost estimate: Unavailable.','muted'));
     const prepare=button('Prepare Daily Integration',async()=>{
       try{
         window.__dailyIntegration=await api('/api/assistant/development-sessions/prepare-daily-integration',{confirmed:true,request_id:crypto.randomUUID()});
         conversationNotice='Daily integration prepared. No push, merge, or hosted CI dispatch.';
         render();
       }catch(error){conversationNotice=error.message;render();}
     });
     prepare.dataset.focusKey='prepare-daily-integration';
     result.append(prepare);
     if(daily){
       const card=glass('Daily integration checkpoint',daily.push||daily.merge||daily.hosted_ci_dispatched?'ERROR':'Prepared local-only',(daily.session_count||0)+' session(s) · push '+(daily.push?'yes':'no')+' · merge '+(daily.merge?'yes':'no')+' · hosted CI '+(daily.hosted_ci_dispatched?'yes':'no'));
       for(const s of daily.sessions||[]){
         card.append(node('p',(labels[s.integration_state]||s.integration_state)+' · '+(s.branch||'')+' · missions '+(s.related_missions?.length||0)+' · commits '+(s.local_commits?.length||0)+' · changed '+(s.changed_files?.length||0)+' · focused evidence '+(s.focused_test_evidence?.length||0)+(s.eligible_prs?.length?' · PR #'+s.eligible_prs[0].number:''),'muted'));
         if(s.readiness?.blockers?.length)card.append(node('p','Blockers: '+s.readiness.blockers.join(', '),'muted'));
       }
       result.append(card);
     }
     if(ds.active)result.append(glass('Active session',labels[ds.active.integration_state]||ds.active.integration_state,(ds.active.assigned_worker||'worker')+' · '+(ds.active.repository||'')+' · '+ds.active.branch));
     for(const s of ds.recent||[]){
       const card=glass(s.goal,labels[s.integration_state]||s.integration_state,(s.assigned_worker||'—')+' · '+s.branch+' · focused tests '+(s.evidence?.passed||0)+'/'+(s.evidence?.failed||0)+' · CI '+(s.github_ci_status||'not_dispatched')+' · runs '+(s.ci_runs||0));
       card.append(node('p',(s.repository||'')+' · worktree '+s.worktree,'muted'));
       card.append(node('p','Related Missions '+(s.mission_count||0)+' · local commits '+(s.local_commits?.length||0)+' · files changed '+(s.dirty_files?.length||0)+(s.pr_number?' · PR #'+s.pr_number+' '+(labels[s.integration_state]||''):' · no PR')+(s.head_sha?' · '+s.head_sha.slice(0,8):''),'muted'));
       result.append(card);
     }
     if(!(ds.recent||[]).length)result.append(empty('No Development Sessions. Related Missions share one local session; push/PR waits for the batch checkpoint.'));
     result.append(node('p','States: LOCAL ONLY · READY TO PUSH · PR OPEN · READY TO MERGE · MERGED. Acceptance stays Mission host verification (risk preference when installed). Sessions never grant Acceptance or auto-merge.'));
     return result;
   }
   if(view==='WhatsApp Conversations'){
     const wc=snapshot.whatsapp_conversations||{},wo=snapshot.whatsapp_outbound||{};
     result.append(glass('WhatsApp Conversations',wc.conversations_enabled?'Enabled':'Off','Allowlisted personal AI · Memory retrieval off · Outbound OFF'));
     result.append(node('p','Worker/model '+(wc.worker_model||'qwen')+' · Conversations '+(wc.conversations??0)+' · History '+(wc.include_history?'on':'off')+' · Personal Memory '+(wc.include_memory?'on':'off'),'muted'));
     result.append(node('p','Authorized senders: '+((wc.authorized_senders||[]).length?wc.authorized_senders.join(', '):'none'),'muted'));
     const counts=wc.turn_counts||{};
     result.append(node('p','Turn states: '+Object.keys(counts).map(k=>k+' '+counts[k]).join(' · ')||'none yet','muted'));
     result.append(glass('Outbound delivery',wo.activation||'off_until_operator_authorization','Sending unavailable until separately authorized. Drafts may queue for approval.'));
     const pending=wo.pending||wc.pending_outbound||[];
     if(pending.length){result.append(node('h3','Pending outbound approvals'));for(const p of pending){result.append(node('p',(p.state||'pending')+' · '+(p.recipient||'?')+' · '+(p.body||'').slice(0,160),'muted'));result.append(button('Authorize draft (does not send)',async()=>{try{await api('/api/assistant/whatsapp/outbound/authorize',{id:p.id,confirmed:true});await refresh();}catch(e){$('notice').textContent=e.message;}}),button('Cancel draft',async()=>{try{await api('/api/assistant/whatsapp/outbound/cancel',{id:p.id,confirmed:true});await refresh();}catch(e){$('notice').textContent=e.message;}}));}}
     else result.append(node('p','No pending outbound drafts.','muted'));
     result.append(node('h3','Recent turns'));
     for(const t of wc.recent||[]){result.append(node('p',(t.state||'?')+' · '+(t.intent||'')+' · '+(t.sender||'')+' · in: '+(t.inbound_body||'').slice(0,100)+(t.reply_body?' · reply: '+String(t.reply_body).slice(0,120):'')+(t.worker_identity?' · '+t.worker_identity:'')+(t.safe_error_class?' · '+t.safe_error_class:'')+(t.outbound_id?' · outbound '+t.outbound_id.slice(0,8):''),'muted'));}
     if(!(wc.recent||[]).length)result.append(node('p','No conversation turns yet. Allowlisted inbound messages create grounded replies here.','muted'));
     result.append(node('p','Inbound WhatsApp is untrusted. Conversations cannot run shell, change credentials, deploy, merge, dispatch Missions, or read unrestricted Memory. Phone-originated Meta delivery and outbound send remain separately gated.','muted'));
     return result;
   }
   if(view==='Sensitive & Vault'){result.append(glass('Sensitive Memory','Operator-only',snapshot.sensitive?.disclosure),node('p',snapshot.sensitive?.encryption),glass('Vault','macOS Keychain', 'Named private identifiers and credentials. Credential values stay hidden and are never sent to workers.'),node('p','In the Airodrom terminal, use /vault to save a password or API key securely. Use /secret list or /secret search <label> to find an entry. Private identifiers can be revealed only after fresh confirmation in that terminal and may remain in its scrollback. Credentials require approved capability use.'),node('p','Sensitive Memory is separate: use /remember-sensitive or /sensitive in the authenticated terminal.'));return result;}
   const layout=node('div',null,'assistant-layout'),chat=node('section',null,'glass conversation'),ops=node('aside',null,'operations');
   const provider=snapshot.provider;
   const providerId=provider?.preferences?.provider||'qwen';
   const providerTitle=provider?.state==='Ready'?'Qwen · local default':(providerId==='claude'?'Qwen · local default (Claude unavailable)':'Qwen · local default');
   chat.append(node('h2','Talk to Airodrom'));
   chat.append(glass('Conversation model',providerTitle,(provider?.state||'Unavailable')+' · '+(provider?.message||'Local conversation · qualified Qwen · no Mission authority')));
   const conn=connectionView||deriveConnection({authorized,reachable:failures===0,paused,failures,overviewStatus:snapshot.status});
   chat.append(node('p',conn.label+(conn.detail?' · '+conn.detail:'')+(lastOkAt?' · Last ok '+stamp(lastOkAt):''),'conversation-status'));
   if(failures>0)chat.append(node('p','Reconnecting to the local service. Conversation history may be stale until reconnect succeeds.','notice'));
   else if(paused)chat.append(node('p','Live updates paused. Resume updates to refresh model activity and history.','notice'));
   const providerStale=failures>0||paused||document.hidden||providerGeneration!==generation;
   if(provider?.schema_version===1){
     const modelBar=node('div',null,'conversation-model-bar'),label=node('label','Model'),select=node('select');
     select.setAttribute('aria-label','Conversation model');select.dataset.focusKey='conversation-model';
     for(const [id,title]of [['qwen','Qwen · local only (default)'],['claude','Claude · unavailable · WAIT until qualified']]){const option=node('option',title);option.value=id;select.append(option);}
     // Working everyday conversation stays on Qwen while Claude is unqualified.
     select.value='qwen';select.disabled=providerStale;label.append(select);modelBar.append(label);
     const save=button('Use selected model',async()=>{save.disabled=true;try{
      if(select.value==='claude'){
       select.value='qwen';
       if(provider.preferences.provider!=='qwen')await api('/api/assistant/provider',{revision:provider.preferences.revision,provider:'qwen',consent:null});
       // Set notice after refresh: refresh/clearMemory would otherwise wipe the unavailable explanation.
       await refresh();
       conversationNotice='Claude is unavailable for everyday conversation until independently qualified. Qwen remains the selected working provider. No Claude activation, API key, or subscription workaround.';
       render();return;
      }
      await api('/api/assistant/provider',{revision:provider.preferences.revision,provider:'qwen',consent:null});
      await refresh();
      conversationNotice='Qwen selected · local only. No external transmission.';
      render();
     }catch(e){conversationNotice=e.message;render();}finally{save.disabled=false;}});
     save.disabled=providerStale;modelBar.append(save);chat.append(modelBar);
     chat.append(node('p','Claude is listed for clarity only and stays unavailable until independently qualified. Everyday conversation uses local Qwen.','muted'));
     if(providerStale)chat.append(node('p','Model controls disabled while observations are stale, paused, or offline.','muted'));
   }else chat.append(node('p','Model picker requires a compatible backend. Default remains Qwen when available.','muted'));
   chat.append(node('p',pendingNewConversation?'New conversation ready · first send creates a fresh host session · previous history remains on the host':(conversationSessionId?('Continuing session '+conversationSessionId.slice(0,8)+' · '+conversationHistory.length+' retained turn(s)'):'New browser session starts on first send · ordinary conversation is separate from Work Missions'),'muted'));
   const sessionActions=node('div',null,'actions');
   const continuePrev=button('Continue previous conversation',()=>{
    const restore=conversationSessionId||previousConversationSessionId;
    if(!restore){conversationNotice='No previous browser session in this tab. Send a message to start one.';render();return;}
    pendingNewConversation=false;conversationSessionId=restore;
    try{sessionStorage.removeItem('airodromConversationPendingNew');sessionStorage.setItem('airodromConversationSession',restore);}catch{}
    conversationNotice='Continuing persistent browser session '+restore.slice(0,8)+'. Host-retained history is shown below.';
    generation++;inflight?.abort();render();refresh();
   });
   continuePrev.disabled=!(conversationSessionId||previousConversationSessionId);sessionActions.append(continuePrev);
   sessionActions.append(button('Start new conversation',()=>{
    if(conversationSessionId){previousConversationSessionId=conversationSessionId;try{sessionStorage.setItem('airodromPreviousConversationSession',conversationSessionId);}catch{}}
    conversationSessionId=null;pendingNewConversation=true;conversationHistory=[];activeConversationId=null;activeDirectTurn=null;conversationStreaming=null;
    try{sessionStorage.removeItem('airodromConversationSession');sessionStorage.setItem('airodromConversationPendingNew','1');}catch{}
    conversationNotice='New conversation. Previous browser session closed in this tab; host history for the old session is unchanged.';
    generation++;inflight?.abort();render();
   }));
   chat.append(sessionActions);
   if(conversationStreaming)chat.append(node('p','Model activity: '+conversationStreaming,'conversation-activity'));
   else if(activeDirectTurn)chat.append(node('p','Model activity: waiting for local reply…','conversation-activity'));
   else chat.append(node('p','Model activity: idle','muted'));
   const ordered=conversationHistory.every(item=>Number.isFinite(item.created_at))?conversationHistory.slice().sort((a,b)=>a.created_at-b.created_at):conversationHistory.slice().reverse();
   for(const item of ordered){
     if(item.prompt)chat.append(node('p',item.prompt,'operator-message'));
     if(item.response){chat.append(node('p',item.response,'assistant-message'));const meta=[item.model,item.worker||'local-ollama',item.memory_included?'Memory on':'Memory off'].filter(Boolean).join(' · ');if(meta)chat.append(node('small',meta,'muted'));}
   }
   const memoryStatus=node('p',includeMemoryConsent?'Memory consent: ON for the next reply · ordinary Memory V2 may be included as reference context only':'Memory consent: OFF for the next reply · no ordinary Memory included','memory-consent-status');
   memoryStatus.setAttribute('role','status');chat.append(memoryStatus);
   const memoryToggle=node('label','Include ordinary Memory V2 in this reply');memoryToggle.className='memory-consent';const memoryBox=node('input');memoryBox.type='checkbox';memoryBox.checked=includeMemoryConsent;memoryBox.setAttribute('aria-label','Include ordinary Memory V2');memoryBox.onchange=()=>{includeMemoryConsent=memoryBox.checked;try{sessionStorage.setItem('airodromConversationMemory',includeMemoryConsent?'1':'0');}catch{};render();};memoryToggle.prepend(memoryBox);chat.append(memoryToggle);
   for(const [label,prefix] of [['Search public web','search the web for '],['Explore public websites','explore ']])chat.append(button(label,()=>{const value=window.prompt(label==='Search public web'?'Public search query':'Public HTTPS websites separated by spaces');if(value){conversationDraft=prefix+value;render();}}));chat.append(button('Browser connections & human login',()=>{conversationNotice='In Terminal, use /browser open https://app.monarch.com/ for seven connection choices, or /browser options for availability. Review the exact domain permission, sign in manually in the dedicated visible browser, complete MFA and confirm hand-back. Normal Chrome login is not inherited.';render();}));const form=node('form'),compose=node('textarea');compose.value=conversationDraft;compose.placeholder='Ask a question or say Remember that…';compose.setAttribute('aria-label','Conversation message');compose.dataset.focusKey='conversation-composer';compose.maxLength=4000;compose.oninput=()=>conversationDraft=compose.value;
   const submit=node('button','Send');submit.type='submit';form.append(compose,submit);form.onsubmit=async e=>{e.preventDefault();generation++;const version=generation;inflight?.abort();const startNew=pendingNewConversation;const keepSession=startNew?null:conversationSessionId;clearMemory();conversationSessionId=keepSession;pendingNewConversation=startNew;submit.disabled=true;try{const receipt=await api('/api/assistant/input',{message:conversationDraft,conversation_id:await conversationSession({forceNew:startNew}),include_memory:includeMemoryConsent,request_id:crypto.randomUUID()});conversationDraft='';await refresh();await showAssistantReceipt(receipt,version);}catch(error){if(version===generation){conversationNotice=error.message||'Local conversation request failed. Check connection and retry.';render();}}finally{submit.disabled=false;}};
   if(activeConversationId&&conversationHistory.some(item=>item.mission_id===activeConversationId&&item.response))conversationNotice='Response ready.';
   chat.append(form,node('p',conversationNotice||'','notice'));
   ops.append(node('h2','Work Missions'),node('p','Sensitive execution stays here. Conversation never acquires Mission authority.','muted'));
   const work=snapshot.missions.filter(m=>m.label!=='Bounded local conversation'&&!['completed','cancelled'].includes(m.state)).slice(0,10);if(work.length){for(const m of work)ops.append(lifecycle(m),missionCard(m));}else ops.append(empty('No active Work Missions.'));ops.append(routeControls());
   layout.append(chat,ops);return layout;
 }
 function render(){if(!authorized){applyConnection(deriveConnection({authorized:false}));authorizationView();return;}if(!snapshot){$('content').replaceChildren(empty(failures?'Local service unavailable. Retrying automatically…':'Loading canonical Mission activity…'));return;}const focused=document.activeElement,key=focused?.dataset?.focusKey;const content=$('content');let result;if(missionId){const m=(snapshot.selected_mission?.id===missionId?snapshot.selected_mission:null)||snapshot.missions.find(x=>x.id===missionId);result=m?missionDetail(m):empty('Mission is outside the current snapshot. Reopen it from the task workspace.');}else if(['AI & Workers','Automation & Permissions','Conversation','Models','Workers','WORK Templates','Google Connections','Connectors','WhatsApp Conversations','Sensitive & Vault','Development Sessions'].includes(view))result=assistantView();else if(view==='Overview'){result=overview();if(snapshot.orchestration?.preferences?.onboarded===false){const setup=node('section',null,'glass');setup.append(node('h2','Choose your primary assistant'),node('p','ChatGPT is preferred. Choose a supported client and a qualified worker to finish setup.'),button('Set up AI & Workers',()=>nav.get('AI & Workers').click()));result.prepend(setup);}}else if(view==='Missions'){result=missionDashboard();}else if(view==='System Health')result=health();else if(view==='Activity & Audit'){result=node('div');const filter=node('select');filter.setAttribute('aria-label','Event category');filter.dataset.focusKey='event-category';for(const name of ['','Mission','Runtime','Memory','Capability','Verification','Approval','Settlement','System']){const o=node('option',name||'All categories');o.value=name;filter.append(o);}filter.value=category;filter.onchange=()=>{generation++;inflight?.abort();category=filter.value;cursor=0;feed.clear();refresh();render();};const missionFilter=node('select');missionFilter.setAttribute('aria-label','Activity Mission');missionFilter.dataset.focusKey='activity-mission';const all=node('option','All Missions');all.value='';missionFilter.append(all);for(const m of snapshot.missions){const o=node('option',m.label+' · '+m.id.slice(0,8));o.value=m.id;missionFilter.append(o);}missionFilter.value=eventMission;missionFilter.onchange=()=>{generation++;inflight?.abort();eventMission=missionFilter.value;cursor=0;feed.clear();refresh();render();};result.append(filter,missionFilter,node('p','Timestamped host observations · retained window: 500 safe events','muted'),activity());}else if(view==='Runtime & OpenCode'){result=node('div');result.append(glass('OpenCode · Primary',snapshot.runtime.state,snapshot.runtime.reason||'Qualified local execution'),node('p','Requalification never trusts a version string. It requires exact OpenCode and Seatbelt artifacts plus a fresh confined probe.'),node('p','Run airodrom requalify from Terminal. The owned service must be stopped; current work and quarantined leases prevent repair.'),node('pre','airodrom doctor\nairodrom requalify\nairodrom start'));}else if(view==='Approvals'){result=node('div');result.append(glass('Protected Approvals waiting',snapshot.approvals.waiting,'Decisions and Acceptance are distinct'),node('p','Review the exact governed operation in the authorized workspace.'),node('a','Review protected Approvals ↗'));result.lastChild.href='/workspace';for(const a of snapshot.approvals.records){const card=glass(a.label,a.status,'Created '+stamp(a.created_at)+' · expires '+stamp(a.expires_at));if(a.task_id)card.append(workspaceLink('Review exact operation in task workspace ↗',a.task_id));else card.append(node('small','Task-specific review unavailable'));result.append(card);}result.append(node('p',snapshot.approvals.scope,'muted'));}else if(view==='Reliability'){result=reliabilityView();}else if(view==='Autonomous Goals'){result=goalsView();}else if(view==='MCP Diagnostics'){result=mcpView();}else if(view==='Memory'){result=memoryView();}else if(view==='Projects'){result=node('div');result.append(node('p','Up to 50 registered projects, priority ordered · private names and repository paths withheld','muted'));for(const p of snapshot.projects){const card=glass(p.label,p.status,'Updated '+stamp(p.updated_at));card.append(node('small',p.id));if(p.status!=='archived'){const archive=button('Archive project',()=>send('archive-project',{id:p.id}));archive.dataset.focusKey='project:'+p.id+':archive';card.append(archive);}result.append(card);}if(!snapshot.projects.length)result.append(empty('No registered projects.'));const a=node('a','Open task workspace ↗');a.href='/workspace';result.append(a);}else{result=node('div');result.append(node('img'));result.firstChild.src='/brand/airodrom-logo-horizontal-dark.svg';result.firstChild.alt='Airodrom';result.firstChild.className='about-logo';result.append(node('h2','Airodrom '+snapshot.version),chip('PRE-RELEASE'),node('p','OpenCode executes bounded work. Airodrom owns Mission authority, Memory V2, Capability Broker, independent verification, Acceptance, Settlement, leases, audit and erasure.'),node('p','Native service and launch-at-login settings use the separately reviewed macOS lifecycle. Quitting the menu helper leaves the control plane running.'));const waits=snapshot.acceptance_config?.waits||{};const pref=snapshot.acceptance_config?.preference||{};result.append(glass('Automatic Acceptance',pref.enabled?'Enabled':'Off',(pref.privacy||'local_only')+' · '+(pref.data_class||'public')+' · OpenCode'),glass('Wait classes','Presentation only','Execution '+(waits.execution_timeout_ms||'—')+'ms · Heartbeat '+(waits.worker_heartbeat_timeout_ms||'—')+'ms · Review display '+(waits.acceptance_review_presentation_ms||'—')+'ms · Approval TTL not adjustable here ('+(waits.approval_expiry_ms||'SafetyPolicy')+')'),node('a','Documentation ↗'));result.lastChild.href='https://github.com/airodrom/airodrom#readme';}
  // Preserve focus and selection across an observed snapshot update.
 const selection=focused&&'selectionStart'in focused?[focused.selectionStart,focused.selectionEnd]:null;const renderKey=view+':'+(missionId||'')+':'+(view==='Missions'?missionFilter+':'+missionOffset+':'+missionDetailTab:'');const changed=content.dataset.renderKey!==renderKey;const prevScroll=changed?0:(contentScroll||content.scrollTop||0);content.dataset.renderKey=renderKey;content.replaceChildren(result);content.scrollTop=prevScroll;contentScroll=content.scrollTop;content.onscroll=()=>{contentScroll=content.scrollTop;};if(changed&&!matchMedia('(prefers-reduced-motion: reduce)').matches&&!document.hidden)content.animate([{opacity:0,transform:'translateY(6px)'},{opacity:1,transform:'translateY(0)'}],{duration:300,easing:'ease-out'});if(key){const target=[...content.querySelectorAll('[data-focus-key]')].find(e=>e.dataset.focusKey===key);target?.focus({preventScroll:true});if(target&&selection&&target.setSelectionRange)try{target.setSelectionRange(...selection);}catch{}}
 }
 function reliabilityView(){
   const root=node('div'),report=snapshot.reliability;
   root.append(glass('Reliability','Local fixtures','Execution remains disabled; aggregate evidence only'));
   if(!report?.items?.length)root.append(empty('No evaluation summaries imported. Run the local evaluation CLI and review its evidence.'));
   for(const r of report?.items||[]){const card=glass('Evaluation · '+r.evidence_class,r.failed||r.security_failures||r.memory.forbidden_hits>0?'HOLD':'Contracts pass','Operator-imported evidence · '+stamp(r.at));
    card.append(node('p',`Scenarios ${r.passed}/${r.scenarios} · security failures ${r.security_failures} · recovery ${r.recovery_passed} passed / ${r.recovery_failed} failed`));
    card.append(node('p','Task success '+(r.task_success_rate===null?'Not measured':Math.round(r.task_success_rate*100)+'%')+' · '+r.duration_ms+' ms'));
    card.append(node('h3','Memory Intelligence'));for(const key of ['precision','recall','provenance','budget_utilization'])card.append(node('p',readable(key)+': '+(r.memory[key]===null?'Not measured':Math.round(r.memory[key]*100)+'%')));
    card.append(node('p','Relevant results: '+(r.memory.relevant??'Not measured')+' · irrelevant results: '+(r.memory.irrelevant??'Not measured')));
    for(const key of ['correction_passed','forgetting_passed'])card.append(node('p',readable(key)+': '+(r.memory[key]==null?'Not measured':r.memory[key]?'Passed':'Failed')));
    card.append(node('p','Forbidden retrievals: '+(r.memory.forbidden_hits??'Not measured')));root.append(card);
   }
   if(report?.comparison)root.append(node('p',`Previous comparable summary: pass delta ${report.comparison.passed_delta}; security failure delta ${report.comparison.security_failure_delta}.`));return root;
 }
 function goalsView(){
  const root=node('div');
  root.append(node('h2','Ask Airodrom'),node('p','One instruction from ChatGPT prepares a bounded task. You approve protected access once. Airodrom then plans, runs OpenCode, verifies, and reports — without Continue loops or UUID setup.','muted'));
  const pending=snapshot.zero_setup?.items||[];
  for(const item of pending){
   const p=item.presentation||{};
   const card=node('article',null,'glass goal-card');
   card.append(node('span','AIRODROM','eyebrow'),node('h3',p.goal||'Prepared task'),statusChip({display:{key:'waiting',label:p.status||'Waiting for your approval',tone:'waiting'}}));
   const facts=node('div',null,'live-facts');
   for(const [label,value] of [
     ['Goal',p.goal],
     ['Project',item.project_name||p.project_name],
     ['File',(p.files||[]).join(', ')],
     ['Worker',p.worker||'Local OpenCode'],
     ['Verification',p.verification],
     ['Completion',p.completion_policy],
     ['Network',p.network||'No external access'],
     ['GitHub',p.github||'No commits or pushes'],
     ['Production',p.production||'No access'],
   ]){if(!present(value))continue;const fact=node('div');fact.append(node('small',label),node('span',value));facts.append(fact);}
   card.append(facts);
   const controls=node('div',null,'actions');
   const approve=button('Approve this task',async()=>{if(!window.confirm('Approve this bounded local task?\n\n'+ (p.goal||'') +'\nProject: '+(item.project_name||'')+'\nFiles: '+((p.files||[]).join(', ')||'none')+'\n\nThis registers the WORK scope, authorizes one Goal Plan, and allows local OpenCode to run. Acceptance remains a separate owner decision.'))return;try{await api('/api/assistant/zero-setup/approve',{request_id:item.request_id,confirmed:true});await refresh();}catch(e){$('notice').textContent=e.message;}},true);
   approve.dataset.focusKey='zero-setup:'+item.request_id+':approve';
   const cancel=button('Cancel',async()=>{if(!window.confirm('Cancel this prepared task? Nothing has been written yet.'))return;try{await api('/api/assistant/zero-setup/reject',{request_id:item.request_id,confirmed:true});await refresh();}catch(e){$('notice').textContent=e.message;}});
   cancel.dataset.focusKey='zero-setup:'+item.request_id+':cancel';
   const advanced=node('details');advanced.append(node('summary','View technical details'),node('pre',JSON.stringify({request_id:item.request_id,template_ready:item.template_ready},null,2)));
   controls.append(approve,cancel);card.append(controls,advanced);root.append(card);
  }
  root.append(node('h2','Continuous Autonomous Execution'),node('p','After approval, Airodrom schedules, monitors, repairs and verifies within bounds. You are asked only for genuine decisions and final Acceptance.','muted'));
  const items=snapshot.autonomous_goals?.items||snapshot.goal_plans?.items||[];
  for(const g of items){
   const life=g.autonomous?.lifecycle||g.state;
   const a=g.autonomous||{};
   const activeStage=(g.stages||[]).find(s=>['dispatched','running','verifying'].includes(s.state))||(g.stages||[]).find(s=>s.mission_id);
   const blocked=(g.blocked||[])[0]||(g.stages||[]).find(s=>s.state==='blocked');
   const verifiedCount=(g.stages||[]).filter(s=>s.state==='verified').length;
   const stageCount=(g.stages||[]).length||0;
   const outcomeLabel=verifiedCount&&verifiedCount===stageCount?'Completed and verified':['dispatched','running'].includes(activeStage?.state)?'Working':activeStage?.state==='verifying'?'Verification underway':g.execution_enabled?'Working':(a.pending_request||!g.execution_enabled)?'Waiting for your approval':readable(life);
   const title=g.presentation?.goal||g.goal_name||g.project_name||'Authorized goal';
   const card=node('article',null,'glass goal-card');
   card.append(node('span','AIRODROM','eyebrow'),node('h3',title),statusChip({display:{key:life,label:outcomeLabel,tone:g.execution_enabled?'ready':'waiting'}}));
   const facts=node('div',null,'live-facts');
   for(const [label,value] of [
     ['Status',outcomeLabel],
     ['Progress',stageCount?`${verifiedCount}/${stageCount} stages verified`:null],
     ['Worker',(a.workers||[]).join(', ')||'Local OpenCode'],
     ['Result',g.presentation?.result||null],
     ['Verification',g.presentation?.verification_label||(verifiedCount&&verifiedCount===stageCount?'Passed':null)],
     ['Current blocker',blocked?(readable(blocked.reason||blocked)||blocked):null],
     ['Next action',g.execution_enabled?(activeStage?.mission_id?'Open Mission for details':'Waiting for a ready stage'):(a.pending_request?'Confirm authorization below':'Authorize to schedule work')],
   ]){if(!present(value))continue;const fact=node('div');fact.append(node('small',label),node('span',value));facts.append(fact);}
   card.append(facts);
   if(activeStage?.mission_id)card.append(button('View result',()=>selectMission(activeStage.mission_id)));
   const advanced=node('details');advanced.append(node('summary','View technical details'),node('pre',JSON.stringify({plan_id:g.id,goal_id:g.goal_id,stages:g.stages,autonomous:a},null,2)));
   card.append(advanced);
   const controls=node('div',null,'actions');
   const goalSend=async(action,body)=>{try{await api('/api/control-v2/'+action,{...body,request_id:crypto.randomUUID()});await refresh();}catch(e){$('notice').textContent=e.message;}};
   if(!g.execution_enabled){
     const req=a.pending_request||{};
     const b=button('Approve this task',()=>goalSend('authorize-autonomous-goal',{id:g.id,workers:req.workers||['opencode'],max_concurrent_missions:req.max_concurrent_missions||1,max_dispatches:req.max_dispatches||3,max_repairs:req.max_repairs||1,confirmed:true}),true);
     b.dataset.focusKey='goal:'+g.id+':authorize';controls.append(b);
   }else{
     const p=button('Pause scheduling',()=>goalSend('pause-autonomous-goal',{id:g.id}));p.dataset.focusKey='goal:'+g.id+':pause';
     const r=button('Resume scheduling',()=>goalSend('resume-autonomous-goal',{id:g.id}));r.dataset.focusKey='goal:'+g.id+':resume';
     const s=button('Stop future scheduling',()=>{if(!window.confirm('Stop future scheduling for this goal? Active external execution is not terminated by this action.'))return;goalSend('stop-autonomous-goal',{id:g.id});});s.dataset.focusKey='goal:'+g.id+':stop';
     controls.append(p,r,s);
   }
   card.append(controls);root.append(card);
  }
  if(!pending.length&&!items.length)root.append(empty('No prepared tasks yet. Ask Airodrom from ChatGPT, then approve here.'));
  return root;
 }
 function mcpView(){const root=node('div'),d=snapshot.mcp_discovery;root.append(glass('MCP Diagnostics',d?.health||'Unavailable','Discovery does not grant authority'));
  for(const [key,label]of [['source','Source tools'],['installed','Installed server tools'],['advertised','Advertised MCP tools'],['client','Client-visible tools']])root.append(node('p',label+': '+(d?.observed?.[key]?.count??'Not observed')));
  root.append(node('p','Server package: '+(d?.server_version||'Not observed')),node('p','Source version: '+(d?.source_sha||'Not observed')),node('p','Installed version: '+(d?.installed_sha||'Not observed')),node('p','Catalog capability: listChanged='+String(d?.list_changed===true)+' · lifetime '+(d?.catalog_lifetime||'unknown')));
  root.append(node('p','If ChatGPT still shows an old tool list (missing ask_airodrom), start a new conversation after the connector points at this install. Conversation-scoped catalogs do not always refresh in place.'));
  for(const line of d?.limitations||[])root.append(node('p',line));return root;
 }
 function flightView(){const root=node('section',null,'glass'),trace=snapshot.flight_recorder;root.append(node('h2','Mission Flight Recorder'));if(!trace){root.append(empty('Trace unavailable.'));return root;}
  root.append(node('p',trace.explanation),node('p',trace.next_safe_action));const list=node('ol');for(const e of trace.events){const li=node('li',stamp(e.timestamp)+' · '+e.label+(e.policy_outcome?' · '+e.policy_outcome:'')+(e.error_class?' · '+e.error_class:''));list.append(li);}root.append(list);if(trace.has_more)root.append(node('p','First 100 canonical events shown; the API supports cursor pagination.'));return root;
 }
 function selectMission(id){missionListContext={filter:missionFilter,tab:missionTab,offset:missionOffset,limit:missionLimit,worker:missionWorker,sort:missionSort,query:searchQuery};clearMemory();stopObsStream();observatory=null;obsCursor=0;diffCache.clear();missionDetailTab='Outcome';generation++;missionId=id;view='Missions';$('heading').textContent='Mission';render();$('content').focus();refresh();}
 for(const name of views){const b=button(name,()=>{const keepSession=conversationSessionId;const keepPending=pendingNewConversation;const keepPrevious=previousConversationSessionId;clearMemory();conversationSessionId=keepSession;pendingNewConversation=keepPending;previousConversationSessionId=keepPrevious;view=name;missionId=null;generation++;for(const [n,item]of nav)item.setAttribute('aria-current',n===name?'page':'false');$('heading').textContent=name;render();refresh();});nav.set(name,b);$('nav').append(b);}nav.get(view)?.setAttribute('aria-current','page');$('heading').textContent=missionId?'Mission':view;
 async function send(action,body){generation++;inflight?.abort();try{await api('/api/product/'+action,{...body,request_id:crypto.randomUUID()});await refresh();}catch(e){$('notice').textContent=e.message;}}
 async function refresh(){clearTimeout(timer);timer=null;if(busy||paused||document.hidden||!authorized)return;busy=true;const version=generation,filter=category;inflight=new AbortController();try{let live=null;const current=await api('/api/product/overview?current_offset='+currentOffset,undefined,inflight.signal);let history=null,nextMissionPage=null;if(view==='Reliability')current.reliability=await api('/api/control-v2/reliability',undefined,inflight.signal);if(view==='Autonomous Goals'||view==='Overview'){current.goal_plans=await api('/api/control-v2/goal-plans',undefined,inflight.signal);current.autonomous_goals=await api('/api/control-v2/autonomous-goals',undefined,inflight.signal);try{current.zero_setup=await api('/api/assistant/zero-setup',undefined,inflight.signal);}catch(e){if(!authorized||inflight.signal.aborted)throw e;current.zero_setup={items:[]};}}if(view==='MCP Diagnostics')current.mcp_discovery=await api('/api/control-v2/mcp-discovery',undefined,inflight.signal);if(missionId)current.flight_recorder=await api('/api/control-v2/flight-recorder?id='+encodeURIComponent(missionId),undefined,inflight.signal);if(view==='Missions'&&!missionId&&current.mission_counts)nextMissionPage=await api('/api/product/missions?filter='+encodeURIComponent(missionFilter)+'&query='+encodeURIComponent(searchQuery)+'&offset='+missionOffset+'&limit='+missionLimit+'&sort='+encodeURIComponent(missionSort)+(missionWorker?'&worker='+encodeURIComponent(missionWorker):''),undefined,inflight.signal);if(view==='Google Connections')current.google=await api('/api/assistant/google',{action:'status'},inflight.signal);if(view==='AI & Workers'||view==='Conversation'){try{current.provider=await api('/api/assistant/provider',undefined,inflight.signal);}catch(e){if(!authorized||inflight.signal.aborted)throw e;current.provider=null;}}if(view==='AI & Workers'||view==='Overview'){try{current.orchestration=await api('/api/assistant/preferences',undefined,inflight.signal);}catch(e){if(!authorized||inflight.signal.aborted)throw e;current.orchestration=null;}}if(['WORK Templates','Automation & Permissions'].includes(view))current.work_templates=await api('/api/assistant/work-templates',undefined,inflight.signal);if(missionId)current.selected_mission=await api('/api/product/mission?id='+encodeURIComponent(missionId),undefined,inflight.signal);try{live=await api('/api/product/observatory?mission='+encodeURIComponent(missionId),undefined,inflight.signal);}catch(e){secondaryNotice='Observatory snapshot unavailable';live=null;}if(view==='Conversation'||missionId&&current.selected_mission?.label==='Bounded local conversation'){
       // Do not auto-restore the latest browser session while the operator asked for a new conversation.
       if(view==='Conversation'&&!conversationSessionId&&authorized&&!pendingNewConversation){try{await conversationSession();}catch{}}
       const historyQuery=missionId?'?mission_id='+encodeURIComponent(missionId):(conversationSessionId&&!pendingNewConversation?'?conversation_id='+encodeURIComponent(conversationSessionId):'');
       history=historyQuery?await api('/api/assistant/history'+historyQuery,undefined,inflight.signal):{items:[],streaming:null,generation:current.memory.generation};
     }let nextCursor=snapshot?.epoch!==current.epoch?0:cursor;const incoming=[];let pages=0,batch;do{batch=await api('/api/product/events?after='+nextCursor+(filter?'&category='+encodeURIComponent(filter):'')+(eventMission?'&mission='+encodeURIComponent(eventMission):''),undefined,inflight.signal);nextCursor=batch.cursor;incoming.push(...batch.events);pages++;}while(batch.has_more&&pages<4);if(version!==generation||paused||document.hidden)return;if(snapshot?.epoch!==current.epoch)feed.clear();if(snapshot?.memory?.generation!==current.memory.generation){const keepSession=conversationSessionId;const keepPending=pendingNewConversation;const keepPrevious=previousConversationSessionId;clearMemory();conversationSessionId=keepSession;pendingNewConversation=keepPending;previousConversationSessionId=keepPrevious;}snapshot=current;if(live&&missionId){observatory=live;obsCursor=Math.max(obsCursor,live.cursor||0);if(!obsStream)connectObsStream(missionId);}if(['AI & Workers','Conversation'].includes(view)&&current.provider?.schema_version===1)providerGeneration=version;if(nextMissionPage)missionPage=nextMissionPage;if(history&&(view==='Conversation'||missionId)&&history.generation===current.memory.generation){if(pendingNewConversation){conversationHistory=[];conversationStreaming=null;}else{conversationHistory=history.items;conversationStreaming=history.streaming||null;}}cursor=nextCursor;for(const e of incoming)if(e.event_id)feed.set(e.event_id,e);while(feed.size>500)feed.delete(feed.keys().next().value);failures=0;document.body.classList.remove('offline');lastOkAt=snapshot.observed_at;applyConnection(deriveConnection({authorized:true,reachable:true,paused:false,failures:0,overviewStatus:snapshot.status||'Ready'}));$('notice').textContent='Observed '+stamp(current.observed_at)+' · '+(view==='Missions'&&!missionId&&missionPage?missionPage.scope:current.counts.scope);render();if(batch.has_more)timer=setTimeout(()=>{timer=null;refresh();},250);}catch(e){if(version!==generation||paused||document.hidden)return;clearMemory();failures++;render();document.body.classList.add('offline');applyConnection(deriveConnection({authorized,reachable:false,paused:false,failures,error:e.message}));$('notice').textContent=e.message+(authorized?' Previous observations are stale.':'');}finally{busy=false;inflight=null;if(!timer&&!paused&&authorized&&!document.hidden)timer=setTimeout(()=>{timer=null;refresh();},version!==generation?250:Math.min(30000,2500*2**Math.min(failures,4)));}}
 $('pause').onclick=()=>{generation++;inflight?.abort();paused=!paused;$('pause').textContent=paused?'Resume updates':'Pause updates';applyConnection(deriveConnection({authorized,reachable:!!snapshot,paused,overviewStatus:snapshot?.status,failures}));if(paused){stopObsStream();clearTimeout(timer);}else{timer=null;refresh();}};
 document.addEventListener('visibilitychange',()=>{generation++;inflight?.abort();clearTimeout(timer);timer=null;if(document.hidden){const keepSession=conversationSessionId;const keepPending=pendingNewConversation;const keepPrevious=previousConversationSessionId;clearMemory();conversationSessionId=keepSession;pendingNewConversation=keepPending;previousConversationSessionId=keepPrevious;render();document.body.classList.add('offline');}else refresh();});
 function showDialog(d,trigger=document.activeElement){lastFocus=trigger;d.showModal();d.querySelector('textarea,button')?.focus();}for(const d of [$('new-dialog'),$('review-dialog')])d.addEventListener('close',()=>{const key=lastFocus?.dataset?.focusKey;const target=key?[...document.querySelectorAll('[data-focus-key]')].find(e=>e.dataset.focusKey===key):lastFocus;target?.focus();});
 $('new').onclick=()=>showDialog($('new-dialog'),$('new'));$('close-new').onclick=()=>$('new-dialog').close();$('close-review').onclick=()=>$('review-dialog').close();
 $('mission-form').onsubmit=async e=>{e.preventDefault();generation++;const version=generation;inflight?.abort();clearMemory();const b=e.submitter;b.disabled=true;$('submit-status').textContent='Registering bounded authority…';try{const m=await api('/api/assistant/mission',{action:'new',objective:$('request').value,model:selectedModel,worker:selectedWorker,request_id:crypto.randomUUID()});if(version!==generation||!authorized||document.hidden)return;$('request').value='';$('new-dialog').close();await refresh();if(version!==generation||!authorized||document.hidden)return;if(m.mission_id)selectMission(m.mission_id);else{view='Conversation';$('heading').textContent=view;await showAssistantReceipt(m,version);}}catch(error){if(version===generation)$('submit-status').textContent=error.message;}finally{b.disabled=false;}};
 function openReview(m,trigger){if(!authorized||paused||failures||!m.actions.accept)return;reviewMission=m;$('review-workspace').onclick=()=>{if(m.task_id)try{sessionStorage.setItem('airodromTask',m.task_id);}catch{}};$('review-status').textContent='';showDialog($('review-dialog'),trigger);}
 async function recordDecision(decision){if(!authorized||paused||failures){$('review-status').textContent='Reconnect and resume live observations before recording a decision.';return;}try{await api('/api/product/accept-mission',{id:reviewMission.id,verification_id:reviewMission.verification.id,request_id:crypto.randomUUID(),decision,rationale:$('rationale').value,evidence:$('evidence').value});$('rationale').value='';$('evidence').value='';$('review-dialog').close();await refresh();}catch(e){$('review-status').textContent=e.message;}}
 $('review-form').onsubmit=e=>{e.preventDefault();recordDecision('accept');};$('rework').onclick=()=>recordDecision('rework');
 refresh();
})();

// BEGIN generated atmosphere compatibility bundle; source: public/atmosphere.js
'use strict';
// Adapted directly from the owner's Somin WeatherAtmosphere.tsx canvas renderer.
// Source SHA-256: 818a9d3aae9fa8e219b11e12442efe1a48e138fe333588540187c49feb9b348e
// Drawing geometry, palettes, waves, palms, oaks, birds, rain and weather timing retained.
// Host adaptation: no React, no network, live reduced motion, hidden-page cancellation.
(() => {
    const canvas = document.getElementById('atmosphere'), group = document.getElementById('weather-switcher');
    if (!canvas || !group)
        return;
    const ctx = canvas.getContext('2d', { alpha: true, desynchronized: true });
    if (!ctx)
        return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)'), contrast = matchMedia('(prefers-contrast: more)');
    const modeRef = { current: 'auto' };
    const intensity = 1;
    const PHASE_MS = { rain: 48000, sunrise: 36000, sunset: 36000 }, NEXT = { rain: 'sunrise', sunrise: 'sunset', sunset: 'rain' };
    try {
        const saved = localStorage.getItem('airodrom.atmosphere.v1');
        if (['auto', 'rain', 'sunrise', 'sunset', 'off'].includes(saved))
            modeRef.current = saved;
    }
    catch { }
    let staticFrame = false, hiddenAt = 0;
    let w = 0;
    let h = 0;
    let raf = 0;
    let drops = [];
    let bolts = [];
    let birds = [];
    let palms = [];
    let oaks = [];
    let flash = 0;
    let nextBoltAt = performance.now() + 2000;
    let phase = 'rain';
    let phaseStarted = performance.now();
    let visible = !document.hidden;
    let lastFrame = 0;
    let waveT = 0;
    let lastForced = 'auto';
    let dprCap = window.innerWidth < 768 ? 1 : 1.5;
    let dpr = Math.min(window.devicePixelRatio || 1, dprCap);
    const spawnDrop = (anywhere) => ({
        x: Math.random() * w,
        y: anywhere ? Math.random() * h : -Math.random() * 60,
        len: 7 + Math.random() * 14,
        speed: 6 + Math.random() * 11 * intensity,
        width: 0.55 + Math.random(),
        alpha: 0.22 + Math.random() * 0.4,
    });
    const spawnBird = () => {
        const x = w * (0.15 + Math.random() * 0.7);
        const y = h * (0.28 + Math.random() * 0.28);
        return {
            x,
            y,
            vx: (Math.random() - 0.5) * 1.4,
            vy: (Math.random() - 0.5) * 0.8,
            wing: Math.random() * Math.PI * 2,
            scale: 0.7 + Math.random() * 0.55,
            hue: Math.random() > 0.5 ? 155 : 340,
            targetX: x + (Math.random() - 0.5) * 120,
            targetY: y + (Math.random() - 0.5) * 60,
        };
    };
    const layoutScene = () => {
        palms = [
            { x: w * 0.06, scale: 1.15, lean: -0.08 },
            { x: w * 0.14, scale: 0.92, lean: 0.06 },
            { x: w * 0.22, scale: 1.05, lean: -0.04 },
            { x: w * 0.08, scale: 0.72, lean: 0.1 },
        ];
        oaks = [
            { x: w * 0.78, scale: 1.05 },
            { x: w * 0.88, scale: 1.25 },
            { x: w * 0.94, scale: 0.85 },
            { x: w * 0.72, scale: 0.7 },
        ];
        birds = Array.from({ length: Math.min(5, Math.max(3, Math.floor(w / 420))) }, () => spawnBird());
    };
    const resize = () => {
        dprCap = window.innerWidth < 768 ? 1 : 1.5;
        dpr = Math.min(window.devicePixelRatio || 1, dprCap);
        w = window.innerWidth;
        h = window.innerHeight;
        canvas.width = Math.floor(w * dpr);
        canvas.height = Math.floor(h * dpr);
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const count = Math.min(90, Math.floor(((w * h) / 16000) * intensity));
        drops = Array.from({ length: Math.max(24, count) }, () => spawnDrop(true));
        layoutScene();
    };
    const makeBolt = () => {
        const startX = w * (0.15 + Math.random() * 0.7);
        const segments = [{ x: startX, y: 0 }];
        let x = startX;
        let y = 0;
        const targetY = h * (0.4 + Math.random() * 0.25);
        while (y < targetY) {
            x += (Math.random() - 0.5) * 44;
            y += 22 + Math.random() * 32;
            segments.push({ x, y: Math.min(y, targetY) });
        }
        const branches = [];
        const from = segments[Math.floor(segments.length * 0.4)];
        if (from) {
            const branch = [{ ...from }];
            let bx = from.x;
            let by = from.y;
            const dir = Math.random() > 0.5 ? 1 : -1;
            for (let i = 0; i < 4; i++) {
                bx += dir * (14 + Math.random() * 24);
                by += 16 + Math.random() * 22;
                branch.push({ x: bx, y: by });
            }
            branches.push(branch);
        }
        return {
            segments,
            branches,
            life: 1,
            maxLife: 0.32 + Math.random() * 0.2,
        };
    };
    const drawBoltPath = (points, alpha) => {
        if (points.length < 2)
            return;
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++)
            ctx.lineTo(points[i].x, points[i].y);
        ctx.strokeStyle = `rgba(200, 245, 255, ${alpha * 0.45})`;
        ctx.lineWidth = 5;
        ctx.stroke();
        ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
        ctx.lineWidth = 1.4;
        ctx.stroke();
    };
    const lerp = (a, b, t) => a + (b - a) * t;
    const skyColors = (p, t) => {
        if (p === 'rain') {
            return [
                'rgba(4, 14, 28, 0.72)',
                'rgba(8, 36, 52, 0.55)',
                'rgba(12, 40, 48, 0.35)',
            ];
        }
        if (p === 'sunrise') {
            const warm = 0.35 + t * 0.4;
            return [
                `rgba(${lerp(40, 255, warm)}, ${lerp(70, 170, warm)}, ${lerp(120, 100, warm)}, 0.75)`,
                `rgba(${lerp(255, 255, t)}, ${lerp(140, 200, t)}, ${lerp(90, 140, t)}, 0.65)`,
                `rgba(255, 220, 160, ${0.45 + t * 0.15})`,
            ];
        }
        return [
            `rgba(${lerp(255, 30, t)}, ${lerp(100, 25, t)}, ${lerp(70, 80, t)}, 0.72)`,
            `rgba(${lerp(255, 60, t)}, ${lerp(130, 40, t)}, ${lerp(90, 100, t)}, 0.6)`,
            `rgba(25, 15, 45, ${0.4 + t * 0.2})`,
        ];
    };
    const drawSky = (p, elapsed) => {
        const dur = PHASE_MS[p];
        const t = Math.min(1, elapsed / dur);
        const [c0, c1, c2] = skyColors(p, t);
        const g = ctx.createLinearGradient(0, 0, 0, h * 0.62);
        g.addColorStop(0, c0);
        g.addColorStop(0.5, c1);
        g.addColorStop(1, c2);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h * 0.62);
        if (p === 'sunrise' || p === 'sunset') {
            const sunX = p === 'sunrise' ? w * (0.2 + t * 0.25) : w * (0.7 - t * 0.22);
            const sunY = p === 'sunrise' ? h * (0.55 - t * 0.28) : h * (0.28 + t * 0.3);
            const r = Math.min(w, h) * 0.085;
            const glow = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, r * 5);
            if (p === 'sunrise') {
                glow.addColorStop(0, 'rgba(255, 245, 200, 0.7)');
                glow.addColorStop(0.3, 'rgba(255, 170, 90, 0.28)');
                glow.addColorStop(1, 'rgba(255, 100, 40, 0)');
            }
            else {
                glow.addColorStop(0, 'rgba(255, 210, 140, 0.65)');
                glow.addColorStop(0.28, 'rgba(255, 80, 110, 0.25)');
                glow.addColorStop(1, 'rgba(60, 20, 100, 0)');
            }
            ctx.fillStyle = glow;
            ctx.beginPath();
            ctx.arc(sunX, sunY, r * 5, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle =
                p === 'sunrise' ? 'rgba(255, 248, 220, 0.95)' : 'rgba(255, 190, 130, 0.92)';
            ctx.beginPath();
            ctx.arc(sunX, sunY, r, 0, Math.PI * 2);
            ctx.fill();
        }
    };
    const mountainTone = (p, depth) => {
        if (p === 'rain') {
            return `rgba(${20 + depth * 10}, ${35 + depth * 12}, ${48 + depth * 14}, ${0.55 + depth * 0.12})`;
        }
        if (p === 'sunrise') {
            return `rgba(${55 + depth * 30}, ${45 + depth * 25}, ${70 + depth * 20}, ${0.5 + depth * 0.15})`;
        }
        return `rgba(${40 + depth * 20}, ${25 + depth * 15}, ${55 + depth * 25}, ${0.55 + depth * 0.14})`;
    };
    const drawMountains = (p) => {
        const baseY = h * 0.52;
        const layers = [
            {
                depth: 0,
                peaks: [0, 0.12, 0.22, 0.35, 0.48, 0.6, 0.72, 0.85, 1],
                heights: [0.08, 0.22, 0.14, 0.28, 0.12, 0.24, 0.16, 0.2, 0.1],
            },
            {
                depth: 1,
                peaks: [0, 0.1, 0.25, 0.4, 0.55, 0.7, 0.88, 1],
                heights: [0.05, 0.16, 0.26, 0.14, 0.22, 0.12, 0.18, 0.08],
            },
            {
                depth: 2,
                peaks: [0, 0.15, 0.32, 0.5, 0.68, 0.82, 1],
                heights: [0.04, 0.14, 0.1, 0.2, 0.12, 0.16, 0.06],
            },
        ];
        for (const layer of layers) {
            ctx.beginPath();
            ctx.moveTo(0, h);
            ctx.lineTo(0, baseY);
            for (let i = 0; i < layer.peaks.length; i++) {
                const x = layer.peaks[i] * w;
                const y = baseY - layer.heights[i] * h;
                if (i === 0)
                    ctx.lineTo(x, y);
                else {
                    const px = layer.peaks[i - 1] * w;
                    const mid = (px + x) / 2;
                    ctx.quadraticCurveTo(mid, y - h * 0.02, x, y);
                }
            }
            ctx.lineTo(w, h);
            ctx.closePath();
            ctx.fillStyle = mountainTone(p, layer.depth);
            ctx.fill();
            // snow caps on taller peaks
            if (layer.depth < 2) {
                ctx.fillStyle =
                    p === 'rain'
                        ? 'rgba(200, 220, 235, 0.35)'
                        : 'rgba(255, 250, 245, 0.55)';
                for (let i = 1; i < layer.peaks.length - 1; i++) {
                    if (layer.heights[i] < 0.18)
                        continue;
                    const x = layer.peaks[i] * w;
                    const y = baseY - layer.heights[i] * h;
                    ctx.beginPath();
                    ctx.moveTo(x - 18, y + 22);
                    ctx.lineTo(x, y);
                    ctx.lineTo(x + 16, y + 20);
                    ctx.closePath();
                    ctx.fill();
                }
            }
        }
    };
    const drawOcean = (p, t) => {
        const top = h * 0.5;
        const ocean = ctx.createLinearGradient(0, top, 0, h);
        if (p === 'rain') {
            ocean.addColorStop(0, 'rgba(20, 60, 80, 0.75)');
            ocean.addColorStop(0.45, 'rgba(10, 40, 58, 0.85)');
            ocean.addColorStop(1, 'rgba(4, 20, 32, 0.92)');
        }
        else if (p === 'sunrise') {
            ocean.addColorStop(0, 'rgba(80, 160, 190, 0.7)');
            ocean.addColorStop(0.4, 'rgba(40, 110, 150, 0.82)');
            ocean.addColorStop(1, 'rgba(20, 50, 80, 0.9)');
        }
        else {
            ocean.addColorStop(0, 'rgba(90, 50, 120, 0.65)');
            ocean.addColorStop(0.4, 'rgba(30, 40, 90, 0.8)');
            ocean.addColorStop(1, 'rgba(10, 15, 40, 0.92)');
        }
        ctx.fillStyle = ocean;
        ctx.fillRect(0, top, w, h - top);
        // sun path reflection
        if (p === 'sunrise' || p === 'sunset') {
            const sunX = p === 'sunrise' ? w * (0.2 + t * 0.25) : w * (0.7 - t * 0.22);
            const refl = ctx.createLinearGradient(sunX, top, sunX, h * 0.85);
            refl.addColorStop(0, p === 'sunrise'
                ? 'rgba(255, 200, 120, 0.35)'
                : 'rgba(255, 120, 90, 0.28)');
            refl.addColorStop(1, 'rgba(255, 150, 80, 0)');
            ctx.fillStyle = refl;
            ctx.fillRect(sunX - 40, top, 80, h * 0.35);
        }
        // waves
        const waveAlpha = p === 'rain' ? 0.22 : 0.35;
        for (let row = 0; row < 5; row++) {
            const y0 = top + 18 + row * 22;
            ctx.beginPath();
            ctx.moveTo(0, y0);
            for (let x = 0; x <= w; x += 18) {
                const y = y0 +
                    Math.sin(x * 0.018 + waveT * (1.2 + row * 0.15) + row) * (3.5 + row * 0.8) +
                    Math.sin(x * 0.04 - waveT * 0.8) * 1.5;
                ctx.lineTo(x, y);
            }
            ctx.strokeStyle =
                p === 'rain'
                    ? `rgba(120, 200, 220, ${waveAlpha})`
                    : p === 'sunrise'
                        ? `rgba(255, 230, 190, ${waveAlpha})`
                        : `rgba(255, 180, 200, ${waveAlpha * 0.85})`;
            ctx.lineWidth = 1.2;
            ctx.stroke();
        }
        // foam near shore (left coast)
        ctx.fillStyle =
            p === 'rain' ? 'rgba(180, 220, 230, 0.15)' : 'rgba(255, 250, 240, 0.22)';
        ctx.beginPath();
        ctx.moveTo(0, h * 0.72);
        for (let x = 0; x < w * 0.38; x += 12) {
            ctx.lineTo(x, h * 0.7 + Math.sin(x * 0.05 + waveT * 2) * 4 + Math.sin(waveT + x * 0.02) * 3);
        }
        ctx.lineTo(w * 0.35, h);
        ctx.lineTo(0, h);
        ctx.closePath();
        ctx.fill();
    };
    const drawPalm = (palm, p) => {
        const ground = h * 0.78;
        const s = palm.scale * Math.min(w, h) * 0.0011;
        const trunkH = 160 * s;
        ctx.save();
        ctx.translate(palm.x, ground);
        ctx.rotate(palm.lean);
        // trunk
        ctx.strokeStyle =
            p === 'rain' ? 'rgba(60, 45, 30, 0.85)' : 'rgba(90, 60, 35, 0.9)';
        ctx.lineWidth = 7 * s;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(12 * s, -trunkH * 0.5, 4 * s, -trunkH);
        ctx.stroke();
        // fronds
        const crownY = -trunkH;
        const frondColor = p === 'rain'
            ? 'rgba(30, 90, 55, 0.8)'
            : p === 'sunrise'
                ? 'rgba(40, 130, 70, 0.88)'
                : 'rgba(25, 80, 50, 0.85)';
        for (let i = 0; i < 7; i++) {
            const ang = -Math.PI * 0.85 + (i / 6) * Math.PI * 0.95;
            const len = (70 + (i % 2) * 18) * s;
            ctx.strokeStyle = frondColor;
            ctx.lineWidth = 3 * s;
            ctx.beginPath();
            ctx.moveTo(4 * s, crownY);
            ctx.quadraticCurveTo(4 * s + Math.cos(ang) * len * 0.55, crownY + Math.sin(ang) * len * 0.4 + 10 * s, 4 * s + Math.cos(ang) * len, crownY + Math.sin(ang) * len * 0.75);
            ctx.stroke();
            // leaflet hints
            ctx.strokeStyle =
                p === 'rain' ? 'rgba(50, 120, 70, 0.45)' : 'rgba(70, 160, 90, 0.5)';
            ctx.lineWidth = 1.2 * s;
            for (let j = 1; j <= 3; j++) {
                const t = j / 3.5;
                const bx = 4 * s + Math.cos(ang) * len * t;
                const by = crownY + Math.sin(ang) * len * 0.75 * t;
                ctx.beginPath();
                ctx.moveTo(bx, by);
                ctx.lineTo(bx + Math.cos(ang + 0.9) * 12 * s, by + 8 * s);
                ctx.stroke();
            }
        }
        ctx.restore();
    };
    const drawOak = (oak, p) => {
        const ground = h * 0.76;
        const s = oak.scale * Math.min(w, h) * 0.00115;
        ctx.save();
        ctx.translate(oak.x, ground);
        // trunk
        ctx.fillStyle =
            p === 'rain' ? 'rgba(45, 32, 22, 0.88)' : 'rgba(70, 48, 30, 0.92)';
        ctx.beginPath();
        ctx.moveTo(-10 * s, 0);
        ctx.quadraticCurveTo(-6 * s, -90 * s, -4 * s, -130 * s);
        ctx.lineTo(6 * s, -128 * s);
        ctx.quadraticCurveTo(8 * s, -90 * s, 12 * s, 0);
        ctx.closePath();
        ctx.fill();
        // canopy lobes
        const canopy = p === 'rain'
            ? 'rgba(25, 70, 40, 0.82)'
            : p === 'sunrise'
                ? 'rgba(45, 110, 55, 0.88)'
                : 'rgba(30, 75, 45, 0.85)';
        const lobes = [
            { x: -35, y: -145, r: 42 },
            { x: 10, y: -160, r: 48 },
            { x: 40, y: -140, r: 38 },
            { x: -5, y: -120, r: 36 },
            { x: 25, y: -115, r: 32 },
        ];
        ctx.fillStyle = canopy;
        for (const lobe of lobes) {
            ctx.beginPath();
            ctx.ellipse(lobe.x * s, lobe.y * s, lobe.r * s, lobe.r * 0.85 * s, 0, 0, Math.PI * 2);
            ctx.fill();
        }
        // highlight
        ctx.fillStyle =
            p === 'sunrise' ? 'rgba(120, 180, 90, 0.2)' : 'rgba(80, 140, 90, 0.12)';
        ctx.beginPath();
        ctx.ellipse(5 * s, -155 * s, 28 * s, 22 * s, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    };
    const drawColibri = (b, now) => {
        b.wing += 0.55;
        const dx = b.targetX - b.x;
        const dy = b.targetY - b.y;
        b.vx += dx * 0.0025;
        b.vy += dy * 0.0025;
        b.vx *= 0.96;
        b.vy *= 0.96;
        b.x += b.vx;
        b.y += b.vy + Math.sin(now * 0.006 + b.hue) * 0.35;
        if (Math.hypot(dx, dy) < 18 || Math.random() < 0.008) {
            b.targetX = Math.max(40, Math.min(w - 40, b.x + (Math.random() - 0.5) * 160));
            b.targetY = Math.max(h * 0.22, Math.min(h * 0.55, b.y + (Math.random() - 0.5) * 80));
        }
        const facing = b.vx >= 0 ? 1 : -1;
        const s = b.scale * 1.15;
        const flap = Math.sin(b.wing) * 0.85;
        ctx.save();
        ctx.translate(b.x, b.y);
        ctx.scale(facing * s, s);
        // wings (blurred flutter)
        ctx.fillStyle = `hsla(${b.hue}, 70%, 55%, 0.45)`;
        ctx.beginPath();
        ctx.ellipse(-2, -2, 10, 3.5, -0.6 + flap, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(-2, 2, 9, 3, 0.55 - flap, 0, Math.PI * 2);
        ctx.fill();
        // body
        const body = ctx.createLinearGradient(-6, 0, 10, 0);
        body.addColorStop(0, `hsla(${b.hue}, 75%, 42%, 0.95)`);
        body.addColorStop(1, `hsla(${(b.hue + 40) % 360}, 80%, 55%, 0.95)`);
        ctx.fillStyle = body;
        ctx.beginPath();
        ctx.ellipse(2, 0, 7, 3.2, 0, 0, Math.PI * 2);
        ctx.fill();
        // head
        ctx.fillStyle = `hsla(${(b.hue + 20) % 360}, 85%, 50%, 0.95)`;
        ctx.beginPath();
        ctx.arc(8, -1, 2.6, 0, Math.PI * 2);
        ctx.fill();
        // long beak
        ctx.strokeStyle = 'rgba(40, 30, 20, 0.9)';
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.moveTo(10, -1);
        ctx.lineTo(18, 0.5);
        ctx.stroke();
        // tail
        ctx.fillStyle = `hsla(${b.hue}, 65%, 40%, 0.85)`;
        ctx.beginPath();
        ctx.moveTo(-5, 0);
        ctx.lineTo(-14, -4);
        ctx.lineTo(-12, 0);
        ctx.lineTo(-14, 4);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    };
    const rainStrength = (p, elapsed) => {
        const dur = PHASE_MS[p];
        const edge = 4500;
        if (p === 'rain') {
            if (elapsed < edge)
                return elapsed / edge;
            if (elapsed > dur - edge)
                return (dur - elapsed) / edge;
            return 1;
        }
        if (elapsed < 3500)
            return 1 - elapsed / 3500;
        return 0;
    };
    const frame = (now) => {
        raf = 0;
        if (!visible || modeRef.current === 'off' || contrast.matches)
            return;
        if (!staticFrame && now - lastFrame < 28) {
            if (!staticFrame)
                raf = requestAnimationFrame(frame);
            return;
        }
        lastFrame = now;
        waveT += 0.045;
        const forced = staticFrame && modeRef.current === 'auto' ? phase : modeRef.current;
        if (forced !== 'auto') {
            if (forced !== lastForced || phase !== forced) {
                phase = forced;
                phaseStarted = now;
                bolts = [];
                flash = 0;
                if (phase === 'rain')
                    nextBoltAt = now + 400;
            }
            lastForced = forced;
        }
        else if (lastForced !== 'auto') {
            // Re-enter cycle clearly from rain when AUTO is selected
            phase = 'rain';
            phaseStarted = now;
            bolts = [];
            flash = 0;
            nextBoltAt = now + 800;
            lastForced = 'auto';
        }
        else {
            const elapsedAuto = now - phaseStarted;
            if (elapsedAuto >= PHASE_MS[phase]) {
                phase = NEXT[phase];
                phaseStarted = now;
                bolts = [];
                flash = 0;
                if (phase === 'rain')
                    nextBoltAt = now + 1500;
            }
        }
        let elapsed = now - phaseStarted;
        // Manual lock: hold peak look (full rain / mid sun) — no fade-in dead zone
        if (forced !== 'auto') {
            const dur = PHASE_MS[phase];
            elapsed = phase === 'rain' ? dur * 0.5 : dur * 0.42;
        }
        const t = Math.min(1, elapsed / PHASE_MS[phase]);
        ctx.clearRect(0, 0, w, h);
        drawSky(phase, elapsed);
        drawMountains(phase);
        drawOcean(phase, t);
        // shore / grass strip under trees
        const shore = ctx.createLinearGradient(0, h * 0.7, 0, h);
        shore.addColorStop(0, phase === 'rain' ? 'rgba(35, 55, 40, 0.55)' : 'rgba(50, 90, 45, 0.5)');
        shore.addColorStop(1, 'rgba(15, 25, 20, 0.35)');
        ctx.fillStyle = shore;
        ctx.fillRect(0, h * 0.7, w, h * 0.3);
        for (const oak of oaks)
            drawOak(oak, phase);
        for (const palm of palms)
            drawPalm(palm, phase);
        // colibrí more active in clear weather
        const birdAlpha = phase === 'rain' ? 0.55 : 1;
        ctx.globalAlpha = birdAlpha;
        for (const bird of birds)
            drawColibri(bird, now);
        ctx.globalAlpha = 1;
        const rainAmt = rainStrength(phase, elapsed);
        if (rainAmt > 0.02) {
            const active = Math.floor(drops.length * Math.min(1, rainAmt * 1.1));
            for (let i = 0; i < active; i++) {
                const d = drops[i];
                d.y += d.speed;
                d.x += 0.3 + d.speed * 0.035;
                if (d.y > h + 20 || d.x > w + 20) {
                    drops[i] = spawnDrop(false);
                    continue;
                }
                ctx.globalAlpha = d.alpha * rainAmt;
                ctx.strokeStyle = 'rgba(160, 220, 230, 0.9)';
                ctx.lineWidth = d.width;
                ctx.beginPath();
                ctx.moveTo(d.x, d.y);
                ctx.lineTo(d.x - 1.4, d.y + d.len);
                ctx.stroke();
            }
            ctx.globalAlpha = 1;
            if (!staticFrame && phase === 'rain' && rainAmt > 0.55 && now >= nextBoltAt) {
                bolts.push(makeBolt());
                if (Math.random() > 0.55)
                    bolts.push(makeBolt());
                flash = 0.5 + Math.random() * 0.3;
                nextBoltAt = now + 2800 + Math.random() * 5000;
            }
        }
        bolts = bolts.filter((b) => {
            b.life -= 0.02 / b.maxLife;
            if (b.life <= 0)
                return false;
            const a = Math.max(0, Math.min(1, b.life));
            drawBoltPath(b.segments, a);
            for (const br of b.branches)
                drawBoltPath(br, a * 0.7);
            return true;
        });
        if (flash > 0.01) {
            ctx.fillStyle = `rgba(160, 220, 255, ${flash * 0.18})`;
            ctx.fillRect(0, 0, w, h);
            flash *= 0.86;
        }
        if (!staticFrame)
            raf = requestAnimationFrame(frame);
    };
    function sync() {
        cancelAnimationFrame(raf);
        raf = 0;
        visible = !document.hidden;
        canvas.hidden = modeRef.current === 'off' || contrast.matches;
        for (const b of group.querySelectorAll('[data-weather]'))
            b.setAttribute('aria-pressed', String(b.dataset.weather === modeRef.current));
        const note = group.querySelector('small');
        if (note)
            note.textContent = reduced.matches ? 'Visual presets · Static: Reduce Motion is enabled' : 'Visual presets · Auto cycles scenes · No live weather';
        if (!visible || canvas.hidden)
            return;
        staticFrame = reduced.matches;
        lastFrame = -Infinity;
        if (staticFrame) {
            bolts = [];
            flash = 0;
            frame(performance.now());
        }
        else
            raf = requestAnimationFrame(frame);
    }
    for (const b of group.querySelectorAll('[data-weather]'))
        b.addEventListener('click', () => {
            modeRef.current = b.dataset.weather;
            try {
                localStorage.setItem('airodrom.atmosphere.v1', modeRef.current);
            }
            catch { }
            sync();
        });
    document.addEventListener('visibilitychange', () => { const now = performance.now(); if (document.hidden)
        hiddenAt = now;
    else if (hiddenAt) {
        phaseStarted += now - hiddenAt;
        hiddenAt = 0;
    } sync(); });
    reduced.addEventListener('change', sync);
    contrast.addEventListener('change', sync);
    window.addEventListener('resize', () => { resize(); sync(); });
    window.addEventListener('pagehide', () => cancelAnimationFrame(raf));
    resize();
    sync();
})();

// END generated atmosphere compatibility bundle
