'use strict';
(() => {
 const $=id=>document.getElementById(id), node=(tag,text,cls)=>{const e=document.createElement(tag);if(text!=null)e.textContent=String(text);if(cls)e.className=cls;return e;};
 const hash=new URLSearchParams(location.hash.slice(1));let token=hash.get('token')||'';try{if(token)sessionStorage.setItem('airodromToken',token);else token=sessionStorage.getItem('airodromToken')||'';}catch{}if(hash.has('token'))history.replaceState(null,'',location.pathname+location.search);
 const views=['Conversation','Models','Workers','Connectors','Sensitive & Vault','Development Sessions','Overview','Missions','Memory','Projects','Runtime & OpenCode','Approvals','Activity & Audit','System Health','Settings & About'];
 let selectedModel='auto',selectedWorker='auto';
 let conversationDraft='',conversationHistory=[],conversationNotice='',activeConversationId=null,conversationSessionId=null,activeDirectTurn=null;
 const researchReports=new Map(),researchImages=new Map();
 const nav=new Map(),feed=new Map();let view='Overview',snapshot=null,missionId=(()=>{const value=new URLSearchParams(location.search).get('mission');return /^[a-f0-9-]{36}$/i.test(value||'')?value:null;})(),cursor=0,busy=false,paused=false,authorized=true,timer=null,failures=0,category='',generation=0,lastFocus=null,reviewMission=null,searchQuery='',inflight=null,currentOffset=0,memoryResults=[],memoryDraft='',memoryQuery='',selectedMemory=null,memoryEpoch=0,memoryController=null,eventMission='';
 let observatory=null,obsFollow=true,obsFilter='',obsQuery='',obsStream=null,obsCursor=0,diffCache=new Map(),expandedOutput=new Set();
 let lastOkAt=null,connectionView=null,secondaryNotice='';
 async function api(route,body,signal){const response=await fetch(route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),cache:'no-store',redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000)});if(!response.ok){if(response.status===401){authorized=false;clearMemory();render();throw Error('Authorization expired. Reopen your private Control Center link.');}throw Error('Local request unavailable. Check System Health.');}return response.json();}
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

 const readable=value=>String(value??'Unavailable').replaceAll('_',' ');
 function chip(text){return node('span',readable(text),'chip '+({Ready:'ready',Degraded:'degraded',Unavailable:'unavailable',Waiting:'waiting',passed:'ready',failed:'failed',operator_review:'waiting',completed:'ready',blocked:'degraded',needs_rework:'degraded'}[text]||''));}
 function button(text,fn,primary=false){const b=node('button',text,primary?'primary':'');b.type='button';b.dataset.focusKey=missionId?missionId+':'+text:text;b.onclick=fn;return b;}
 function glass(title,value,detail){const c=node('article',null,'glass');c.append(node('h3',title),node('div',value,'metric'));if(detail)c.append(node('small',detail));return c;}
 function empty(text){return node('p',text,'empty');}
 const stamp=t=>t?new Date(t).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'}):'Unavailable';
 const stateText=s=>({ready:'Registered',dispatching:'Queued / dispatching',running:'Executing',verifying:'Independent verification',awaiting_acceptance:'Acceptance pending',waiting_for_operator:'Operator Decision',needs_rework:'Rework required',blocked:'Blocked',paused:'Paused',completed:'Completed',cancelled:'Cancelled'})[s]||'Unavailable';
 function phase(m){const wrap=node('div',null,'phase'),track=node('div',null,'track '+(m.progress.mode==='indeterminate'?'active':'paused'));track.setAttribute('role','progressbar');track.setAttribute('aria-label',m.progress.label);if(m.progress.mode==='determinate'){track.setAttribute('aria-valuenow',m.progress.value);track.setAttribute('aria-valuemax',m.progress.maximum);track.setAttribute('aria-valuemin','0');track.classList.add('determinate');track.style.setProperty('--progress',(m.progress.maximum>0?Math.min(100,100*m.progress.value/m.progress.maximum):0)+'%');}wrap.append(track,node('span',stateText(m.state)));return wrap;}
 function lifecycle(m){
   const panel=node('article',null,'glass live-mission');panel.dataset.missionId=m.id;
   const advancing=['dispatching','running','verifying'].includes(m.state);
   panel.append(node('span',advancing?'DOING NOW':'CURRENT MISSION STATE','eyebrow'),node('h2',m.timeline.at(-1)?.label||stateText(m.state)));
   const labels=[['request','Request'],['context','Context'],['runtime','Runtime'],['execution','Execution'],['verification','Verification'],['acceptance','Acceptance'],['settlement','Settlement']];
   const latest=m.timeline.filter(e=>e.stage).at(-1)?.stage,rail=node('ol',null,'lifecycle');
   for(const [key,label]of labels){const observed=m.timeline.filter(e=>e.stage===key),li=node('li',null,observed.length?'observed':'unobserved');li.dataset.stage=key;
     if(key===latest){li.classList.add(advancing?'live':'waiting');li.setAttribute('aria-current','step');}
     li.append(node('span',label),node('small',observed.length?stamp(observed.at(-1).timestamp_ms):'Not observed'));rail.append(li);
   }
   panel.append(rail,phase(m));if(m.progress.mode==='indeterminate')panel.append(node('small','Live activity · completion estimate unavailable'));
   const stats=node('div',null,'live-facts');for(const [label,value]of [['Elapsed',m.started_at?Math.floor(((m.finished_at||snapshot.observed_at)-m.started_at)/1000)+' s · observed':'Not started'],['Model',m.model?.id||'Unavailable'],['Worker',m.runtime],['Memory',`${m.memory.selected_count??'Unavailable'} selected · ${m.memory.delivery}`],['Actions',`${m.budget.actions_used??'Unavailable'} / ${m.budget.actions_limit??'Unavailable'} · budget`],['Retries',`${m.budget.retries_used??'Unavailable'} / ${m.budget.retries_limit??'Unavailable'}`],['Runtime limit',m.budget.runtime_limit_ms===null?'Unavailable':m.budget.runtime_limit_ms/1000+' s'],['Approvals',snapshot.approvals.records.filter(a=>a.task_id===m.task_id&&a.status==='pending').length+' waiting (retained page)']]){const fact=node('div');fact.append(node('small',label),node('span',value));stats.append(fact);}panel.append(stats,webPanel(m));return panel;
 }
 function routeControls(){const group=node('div',null,'route-controls');
   for(const [label,items,current]of [['Model',snapshot.assistant.models,selectedModel],['Worker',snapshot.assistant.workers,selectedWorker]]){const field=node('label',label+' routing'),select=node('select');select.setAttribute('aria-label',label+' routing');select.dataset.focusKey=label+'-routing';
     for(const id of ['auto',...(label==='Model'?['local']:[]),...items.map(i=>i.id)]){const item=items.find(i=>i.id===id),option=node('option',id==='auto'?'AUTO':id==='local'?'Local only':(item.name||id)+' · '+item.qualification);option.value=id;option.disabled=!!item&&(!item.available||item.qualification!=='qualified');select.append(option);}select.value=current;
     select.onchange=()=>{if(label==='Model')selectedModel=select.value;else selectedWorker=select.value;};field.append(select);group.append(field);
   }group.append(node('small','Vendor choices apply to explicitly public Work Missions. Conversation remains local.'));return group;
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
   try{const response=await fetch('/api/assistant/research/evidence?mission_id='+encodeURIComponent(id)+'&evidence_id='+encodeURIComponent(evidenceId),{headers:{Authorization:'Bearer '+token},cache:'no-store',redirect:'error',signal:AbortSignal.timeout(10000)});if(!response.ok){if(response.status===401){authorized=false;clearMemory();render();}throw Error('Current screenshot evidence is unavailable.');}const blob=await response.blob();if(blob.type!=='image/png'||blob.size>4194304)throw Error('Screenshot integrity boundary refused.');if(version!==generation||!authorized||document.hidden||missionId!==id)return;researchImages.set(evidenceId,URL.createObjectURL(blob));render();}catch(e){$('notice').textContent=e.message;}
 }
 function missionCard(m){
   const c=node('article',null,'mission-card'),head=node('div',null,'mission-head');
   const open=button(m.label,()=>selectMission(m.id));open.dataset.focusKey='mission:'+m.id;head.append(open,chip(m.state));
   const last=m.timeline?.at?.(-1);const elapsed=m.started_at?Math.floor(((m.finished_at||snapshot.observed_at)-m.started_at)/1000)+' s':'Not started';
   c.append(head,
     node('small',`${m.runtime||'Unavailable'} · ${m.model?.id||'Model unavailable'} · Attempt ${m.attempts||'not started'}`),
     node('small',`Status: ${stateText(m.state)} · Elapsed ${elapsed} · Last: ${last?last.label+' · '+stamp(last.timestamp_ms):'No activity yet'}`),
     phase(m),researchPanel(m),
     node('small',`Verification: ${readable(m.verification.status)}${m.verification.current?'':' (historical / not current)'} · Acceptance: ${readable(m.acceptance.status)} · Settlement: ${readable(m.settlement.status)}`));
   return c;
 }
 function health(){const c=node('article',null,'glass');c.append(node('h2','System Health'));const conn=snapshot.connectivity||connectionView;if(conn){const r=node('div',null,'table-row');const text=node('div','Service connectivity');text.append(node('small',(conn.detail||conn.label)+(lastOkAt?' · Last ok '+stamp(lastOkAt):'')));r.append(text,chip(conn.label||conn.state));c.append(r);}for(const [label,item]of [['Control Plane',snapshot.control],['OpenCode · Primary',snapshot.runtime],['Memory V2 · Local',snapshot.memory],['Local provider',snapshot.provider],['Audit / events',snapshot.audit],['External client / MCP',snapshot.connection],['Disk capacity',snapshot.disk]]){const r=node('div',null,'table-row');const text=node('div',label);text.append(node('small',item.reason|| (label.startsWith('OpenCode')?'Exact artifact readiness':label.startsWith('Memory')?snapshot.memory.backend+' store observed':label==='Audit / events'?'Canonical ledger health':label.includes('MCP')?'Does not imply service disconnect':'Host observation')));r.append(text,chip(item.state));c.append(r);}c.append(node('small',`Observed ${stamp(snapshot.observed_at)} · ${snapshot.leases.held} held leases · ${snapshot.leases.quarantined} quarantined`));return c;}
 function activity(limit=500){const list=node('ol',null,'feed');for(const e of [...feed.values()].filter(e=>!category||e.category===category).slice(-limit).reverse()){const item=node('li'),at=node('time',stamp(e.timestamp_ms)),body=node('div',e.label);if(e.timestamp_ms)at.dateTime=new Date(e.timestamp_ms).toISOString();body.append(node('small',e.category+(e.outcome?' · '+e.outcome:'')));item.append(at,body);list.append(item);}return list.children.length?list:empty('No matching observed events. Unsupported stages are never inferred.');}
 function overview(){const f=document.createDocumentFragment(),hero=node('article',null,'hero'),image=node('img');image.src='/brand/airodrom-3d-model-blue.svg';image.alt='Dimensional Airodrom mark';const copy=node('div');copy.append(node('span','MANY AGENTS. ONE CONTROL PLANE.','eyebrow'),node('h2','Work you can see. Outcomes you can trust.'),node('p','Airodrom governs bounded work from request to independent verification, Acceptance and local Settlement.'),chip(snapshot.status));hero.append(image,copy);f.append(hero);
   const active=snapshot.missions.filter(m=>snapshot.current_mission_ids.includes(m.id));
   const working=active.filter(m=>['dispatching','running','verifying'].includes(m.state));
   const failures=snapshot.missions.filter(m=>['blocked','needs_rework','failed'].includes(m.state)||m.verification?.status==='failed').slice(0,5);
   const agents=[...new Set(working.map(m=> (m.runtime||'Unavailable')+' · '+(m.model?.id||'model unavailable')))];
   const grid=node('div',null,'grid');
   grid.append(
     glass('Active Missions',snapshot.counts.active,snapshot.counts.scope),
     glass('Working agents',working.length,agents.length?agents.slice(0,3).join(' · '):'No workers executing'),
     glass('Approvals waiting',snapshot.approvals.waiting,'Protected Approvals remain separate'),
     glass('Recent failures',failures.length,failures.length?failures.map(m=>stateText(m.state)).slice(0,3).join(' · '):'None on this page')
   );f.append(grid);
   const ready=node('div',null,'grid');
   ready.append(
     glass('OpenCode',snapshot.runtime.state,'Primary · '+(snapshot.runtime.version||'Version unavailable')),
     glass('Memory V2',snapshot.memory.state,'Local · authorized reference context'),
     glass('Control plane',snapshot.control.state,snapshot.control.reason||'Admission and leases'),
     glass('Provider',snapshot.provider.state,snapshot.provider.reason||'Local inference readiness')
   );f.append(ready);
   const cols=node('div',null,'columns'),left=node('div'),right=node('div');
   left.append(node('h2','Live Missions'));for(const m of active)left.append(lifecycle(m),missionCard(m));
   if(!active.length)left.append(empty(snapshot.counts.current?'No current work on this page.':'Ready for your next Mission. Each request registers fresh bounded authority.'));
   const paging=node('div',null,'actions');
   if(currentOffset>0)paging.append(button('Previous current Missions',()=>{currentOffset=Math.max(0,currentOffset-50);generation++;refresh();}));
   if(snapshot.counts.current_has_more)paging.append(button('More current Missions',()=>{currentOffset+=50;generation++;refresh();}));
   left.append(node('small',`${snapshot.counts.current} current Missions · page ${Math.floor(currentOffset/50)+1}`),paging);
   if(failures.length){left.append(node('h2','Recent failures'));for(const m of failures)left.append(missionCard(m));}
   left.append(node('h2','Recent outcomes'));for(const m of snapshot.missions.filter(m=>['completed','cancelled','blocked','needs_rework'].includes(m.state)).slice(0,5))left.append(missionCard(m));
   right.append(health(),node('h2','Current operations'),activity(8),node('h2','System readiness'),node('p',`Control ${snapshot.control.state} · OpenCode ${snapshot.runtime.state} · Memory ${snapshot.memory.state} · Provider ${snapshot.provider.state}`,'muted'));
   cols.append(left,right);f.append(cols);return f;}
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
   const root=node('div',null,'observatory');
   const top=node('header',null,'obs-top');
   top.append(button('← All Missions',()=>{stopObsStream();missionId=null;observatory=null;diffCache.clear();render();}));
   const title=node('div');title.append(node('span','LIVE MISSION OBSERVATORY','eyebrow'),node('h2',m.label),chip(m.state));
   top.append(title);
   const controls=node('div',null,'actions obs-controls');
   controls.append(button(obsFollow?'Pause scrolling':'Follow live',()=>{obsFollow=!obsFollow;render();}));
   const filter=node('select');filter.setAttribute('aria-label','Observatory filter');filter.dataset.focusKey='obs-filter';
   for(const name of ['','Mission','Runtime','Worker','Capability','File','Git','Command','Test','Verification','Approval','Settlement','System']){const o=node('option',name||'All events');o.value=name;filter.append(o);}
   filter.value=obsFilter;filter.onchange=()=>{obsFilter=filter.value;render();};
   const search=node('input');search.type='search';search.placeholder='Search events';search.setAttribute('aria-label','Search observatory events');search.dataset.focusKey='obs-search';search.value=obsQuery;search.oninput=()=>{obsQuery=search.value;render();};
   controls.append(filter,search);
   if(m.actions.accept)controls.append(button('Review Acceptance',event=>openReview(m,event.currentTarget),true));
   if(m.actions.cancel)controls.append(button('Cancel Mission',()=>send('cancel-mission',{id:m.id})));
   top.append(controls);root.append(top,researchPanel(m));

   const grid=node('div',null,'obs-grid');
   const left=node('section',null,'glass obs-col obs-left');
   left.append(node('h3','Timeline & stages'),lifecycle(m));
   const rail=node('ol',null,'timeline');
   for(const [index,e]of (obs?.events||m.timeline).entries()){
     const latest=index===(obs?.events||m.timeline).length-1;
     const li=node('li',null,(e.branch==='attention'||e.outcome==='failed'?'failed ':'stable ')+(latest?(activity.advancing?'active-current':'current-'+m.state):''));
     if(latest)li.setAttribute('aria-current','step');
     li.append(node('span',e.label),node('time',stamp(e.timestamp_ms)));rail.append(li);
   }
   left.append(rail.children.length?rail:empty('No lifecycle observations yet.'));

   const center=node('section',null,'glass obs-col obs-center');
   const pulse=node('div',null,'obs-pulse'+(activity.advancing?' live':''));
   pulse.append(node('span',activity.advancing?'EXECUTING NOW':'CURRENT ACTIVITY','eyebrow'),node('h2',activity.current_label||m.timeline.at(-1)?.label||stateText(m.state)));
   const facts=node('div',null,'live-facts');
   for(const [label,value]of [['Worker',activity.worker||m.runtime||'Unavailable'],['Model',activity.model||m.model?.id||'Unavailable'],['Phase',activity.phase||'Unavailable'],['Elapsed',activity.elapsed_s!=null?activity.elapsed_s+' s':'Not started'],['Heartbeat',stamp(activity.last_heartbeat_ms)],['Error',activity.error||'None observed']]){const fact=node('div');fact.append(node('small',label),node('span',value));facts.append(fact);}
   pulse.append(facts,phase(m));if(obs?.observation_boundary){const b=obs.observation_boundary;pulse.append(node('small','Tools: mid-run NDJSON · Files: '+(b.continuous_filesystem_watch?'live watch':'after-turn host measure')+' · Diff: authorized paths only','muted'));}center.append(pulse,node('h3','Live command & worker stream'),(obs?.events||[]).length?observatoryFeed(obs.events,120):empty('Detailed activity unavailable.'));
   if(obsFollow){requestAnimationFrame(()=>{const feedEl=center.querySelector('.obs-feed');if(feedEl)feedEl.scrollTop=0;});}

   const right=node('aside',null,'glass obs-col obs-right');
   right.append(node('h3','Files & Git'),node('small','Host-measured after worker turn — not continuous filesystem watch.','muted'));
   const files=node('ul',null,'obs-files');
   for(const e of (obs?.files||[]).slice(-24).reverse()){
     const li=node('li');li.append(node('strong',e.path||e.label),node('small',e.category+' · '+stamp(e.timestamp_ms)+(e.lines_added!=null?' · +'+e.lines_added:'')+(e.lines_removed!=null?'/−'+e.lines_removed:'')));
     if(e.path)li.append(button('Diff',()=>loadDiff(m.id,e.path)));
     files.append(li);
   }
   right.append(files.children.length?files:empty('No host-measured file changes yet. Continuous FS monitoring is unavailable.'));
   const diffKey=[...diffCache.keys()].find(k=>k.startsWith(m.id+':'));
   if(diffKey){const d=diffCache.get(diffKey);const panel=node('div',null,'obs-diff');panel.append(node('h3','Diff · '+d.path),node('small','+'+d.lines_added+' / −'+d.lines_removed+(d.truncated?' · truncated':'')),node('pre',d.diff,'diff-view'));right.append(panel);}
   right.append(node('h3','Worker'));
   right.append(observatoryFeed(obs?.worker||[],40));
   right.append(node('h3','Tests'));
   right.append(observatoryFeed(obs?.tests||[],20));
   const summary=node('div',null,'split obs-summary');
   summary.append(glass('Verification',readable(m.verification.status)+(m.verification.current?'':' · historical'),'Host checks'),glass('Acceptance',readable(m.acceptance.status),m.acceptance.at?stamp(m.acceptance.at):'Decision required'),glass('Settlement',readable(m.settlement.status),m.settlement.at?stamp(m.settlement.at):'Separate outcome'));
   right.append(summary);
   if(m.label==='Bounded local conversation'){
     const chat=node('section',null,'conversation');chat.append(node('h3','Conversation'));
     const item=conversationHistory.find(h=>h.mission_id===m.id);if(item?.prompt)chat.append(node('p',item.prompt,'operator-message'));if(item?.response)chat.append(node('p',item.response,'assistant-message'));
     if(!item?.response)chat.append(empty('Visible response pending.'));right.append(chat);
   }
   grid.append(left,center,right);root.append(grid);
   const foot=node('p',(obs?.limitations||['Observatory shows sanitized host observations only.']).join(' '),'privacy');root.append(foot);
   return root;
 }
 function memoryView(){const result=node('div');result.append(glass('Memory V2',snapshot.memory.state,snapshot.memory.backend+' · Local'),glass('Active personal records',snapshot.memory.active_records??'Unavailable','Normal sensitivity · current operator scope'),node('p','Retrieve personal references explicitly. Corrections supersede the selected record; forgetting invalidates prior context. Private text is cleared on navigation, hiding, authorization loss or canonical changes.'));const form=node('form'),query=node('input');query.type='search';query.placeholder='Search current personal Memory';query.setAttribute('aria-label','Memory query');query.dataset.focusKey='memory-query';query.value=memoryQuery;query.oninput=()=>memoryQuery=query.value;form.append(query,button('Retrieve current Memory',()=>retrieveMemory(),true));form.onsubmit=e=>{e.preventDefault();retrieveMemory();};result.append(form);for(const m of memoryResults){const card=node('article',null,'glass');card.append(node('h3',m.subject),node('p',m.content),node('small',m.source));const correct=button('Correct selected record',()=>{selectedMemory=m.id;memoryDraft=m.content;render();});correct.dataset.focusKey='memory:'+m.id+':correct';const forget=button('Forget selected record',()=>mutateMemory('forget-memory',{id:m.id}));forget.dataset.focusKey='memory:'+m.id+':forget';card.append(correct,forget);result.append(card);}const edit=node('textarea');edit.rows=3;edit.maxLength=2000;edit.setAttribute('aria-label',selectedMemory?'Corrected Memory content':'Memory to remember');edit.dataset.focusKey='memory-draft';edit.value=memoryDraft;edit.oninput=()=>memoryDraft=edit.value;result.append(node('h2',selectedMemory?'Correct selected Memory':'Remember an explicit fact'),edit,button(selectedMemory?'Save correction':'Remember',()=>mutateMemory(selectedMemory?'correct-memory':'remember-memory',{...(selectedMemory?{id:selectedMemory}:{}),content:memoryDraft}),true));if(selectedMemory)result.append(button('Cancel correction',()=>{selectedMemory=null;memoryDraft='';render();}));return result;}
 function clearMemory(){for(const url of researchImages.values())URL.revokeObjectURL(url);researchImages.clear();researchReports.clear();const turn=activeDirectTurn;activeDirectTurn=null;if(turn&&authorized)api('/api/assistant/conversation/cancel',turn).catch(()=>{});conversationHistory=[];conversationNotice='';activeConversationId=null;memoryEpoch++;memoryController?.abort();memoryController=null;memoryResults=[];memoryDraft='';memoryQuery='';selectedMemory=null;}
 async function conversationSession(){if(!conversationSessionId)conversationSessionId=(await api('/api/assistant/conversation/session',{channel:'browser'})).conversation_id;if(!conversationSessionId)throw Error('Conversation unavailable.');return conversationSessionId;}
 async function showAssistantReceipt(receipt,version){
   if(version!==generation||!authorized||document.hidden||view!=='Conversation'){if(receipt.kind==='chat'&&authorized)await api('/api/assistant/conversation/cancel',{conversation_id:receipt.conversation_id,turn_id:receipt.turn_id}).catch(()=>{});return;}
   if(receipt.kind==='public_web_offer'){const next=await approvePublicWeb(receipt);if(next){await refresh();if(next.mission_id)selectMission(next.mission_id);}else{conversationNotice='Public web permission cancelled.';render();}return;}
   let notice=receipt.message||(receipt.mission_id?'Mission registered.':'Request handled.');
   if(receipt.kind==='chat'){
     const turn={conversation_id:receipt.conversation_id,turn_id:receipt.turn_id};activeDirectTurn=turn;conversationNotice='Thinking…';render();
     const deadline=Date.now()+130000;
     try{
       while(Date.now()<deadline&&version===generation&&authorized&&!document.hidden&&view==='Conversation'&&activeDirectTurn===turn){
         const result=await api('/api/assistant/conversation?conversation_id='+encodeURIComponent(turn.conversation_id)+'&turn_id='+encodeURIComponent(turn.turn_id));
         if(version!==generation||activeDirectTurn!==turn)return;
         if(result.state==='completed'){activeDirectTurn=null;await refresh();if(version===generation&&authorized&&!document.hidden&&view==='Conversation'){conversationNotice=conversationHistory.some(item=>item.turn_id===turn.turn_id&&item.response)?'':result.summary||'';render();}return;}
         if(['failed','cancelled'].includes(result.state))throw Error(result.reason||'Conversation stopped.');
         await new Promise(resolve=>setTimeout(resolve,250));
       }
       if(activeDirectTurn===turn)throw Error('Conversation timed out.');
     }finally{if(activeDirectTurn===turn){activeDirectTurn=null;await api('/api/assistant/conversation/cancel',turn).catch(()=>{});}}
     return;
   }
   if(receipt.kind==='connect_required'&&receipt.can_start_oauth)notice+=' Use /connect '+receipt.connector+' in Terminal to authorize access in your browser.';
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
 function assistantView(){
   const result=node('div');
   if(view==='Models'||view==='Workers'){
     for(const item of (view==='Models'?snapshot.assistant?.models:snapshot.assistant?.workers)||[]){result.append(glass(item.id,item.qualification,(item.provider||item.transport)+' · '+item.locality+' · '+(item.available?'Available':'Unavailable')),node('p',item.reason?item.reason.replaceAll('_',' '):item.support||'Context limit, token usage and cost: Unavailable'));
       if(view==='Workers'&&['codex','claude_code','cursor'].includes(item.id)){
         result.append(node('p','Installed: '+(item.installed?'Yes':'No')+' · Account: '+(item.auth_state||'Not probed')+' · Version: '+(item.version||'Not verified')+' · Qualification expiry: '+(item.expires_at?stamp(item.expires_at):'None')));
         if(item.id!=='cursor'&&item.installed&&!item.busy)result.append(button('Qualify '+item.id,async()=>{const model=window.prompt('Exact vendor model ID for a public synthetic edit check');if(!model||!window.confirm('Allow this vendor to receive one disposable public fixture? No personal Memory or repository files. Up to two minutes. This does not grant Mission execution.'))return;try{await api('/api/assistant/workers/qualify',{worker:item.id,model,confirmed:true,request_id:crypto.randomUUID()});await refresh();}catch(e){$('notice').textContent=e.message;}}));
         if(item.qualified||item.busy)result.append(button('Revoke '+item.id,async()=>{try{await api('/api/assistant/workers/revoke',{worker:item.id});await refresh();}catch(e){$('notice').textContent=e.message;}}));
       }
     }result.append(routeControls());result.append(node('p','Discovery does not qualify a route. Manual preference cannot bypass privacy, expiry or availability. Optional workers require fresh independent qualification.'));return result;
   }
   if(view==='Connectors'){for(const c of snapshot.connectors?.items||[])result.append(glass(c.id,c.state,c.protocol),node('p',c.setup),node('p',c.mutations));result.append(node('p','Selected email and message text is untrusted data. It cannot grant permissions. Local reply drafts never send.'));return result;}
   if(view==='Development Sessions'){
     const ds=snapshot.development_sessions||{};
     result.append(glass('Local-first defaults',ds.merge_window_open?'Merge window open':'Merge window closed','auto push off · auto merge off · hosted CI auto-dispatch off'));
     result.append(node('p','Timezone '+(ds.merge_window?.timezone||'—')+' · '+(ds.merge_window?.local_start||'')+'-'+(ds.merge_window?.local_end||'')+' · open sessions '+(ds.open_sessions||0)+' · local-only '+(ds.local_only_sessions||0),'muted'));
     result.append(node('p','CI cost estimate: Unavailable. No fabricated percentages.','muted'));
     for(const s of ds.recent||[]){
       const card=glass(s.goal,s.local_only?'Local only':'Published to GitHub',s.branch+' · '+s.state+' · tests '+(s.evidence?.passed||0)+' passed / '+(s.evidence?.failed||0)+' failed · CI '+(s.github_ci_status||'not_dispatched'));
       card.append(node('p','Worktree '+s.worktree,'muted'));
       card.append(node('p','Missions '+(s.mission_count||0)+(s.pr_number?' · PR #'+s.pr_number:'')+(s.head_sha?' · '+s.head_sha.slice(0,8):''),'muted'));
       result.append(card);
     }
     if(!(ds.recent||[]).length)result.append(empty('No Development Sessions. Related Missions share one local session; push/PR waits for the batch checkpoint.'));
     result.append(node('p','Window alone never merges. Explicit operator authorization is required at the integration checkpoint.'));
     return result;
   }
   if(view==='Sensitive & Vault'){result.append(glass('Sensitive Memory','Operator-only',snapshot.sensitive?.disclosure),node('p',snapshot.sensitive?.encryption),glass('Vault','macOS Keychain', 'Named private identifiers and credentials. Credential values stay hidden and are never sent to workers.'),node('p','In the Airodrom terminal, use /vault to save a password or API key securely. Use /secret list or /secret search <label> to find an entry. Private identifiers can be revealed only after fresh confirmation in that terminal and may remain in its scrollback. Credentials require approved capability use.'),node('p','Sensitive Memory is separate: use /remember-sensitive or /sensitive in the authenticated terminal.'));return result;}
   const layout=node('div',null,'assistant-layout'),chat=node('section',null,'glass conversation'),ops=node('aside',null,'operations');
   chat.append(node('h2','Talk to Airodrom'),node('p','Local conversation · canonical Memory V2','muted'));
   const ordered=conversationHistory.every(item=>Number.isFinite(item.created_at))?conversationHistory.slice().sort((a,b)=>a.created_at-b.created_at):conversationHistory.slice().reverse();for(const item of ordered){if(item.prompt)chat.append(node('p',item.prompt,'operator-message'));if(item.response)chat.append(node('p',item.response,'assistant-message'));}
   chat.append(routeControls());for(const [label,prefix] of [['Search public web','search the web for '],['Explore public websites','explore ']])chat.append(button(label,()=>{const value=window.prompt(label==='Search public web'?'Public search query':'Public HTTPS websites separated by spaces');if(value){conversationDraft=prefix+value;render();}}));chat.append(button('Browser connections & human login',()=>{conversationNotice='In Terminal, use /browser open https://app.monarch.com/ for seven connection choices, or /browser options for availability. Review the exact domain permission, sign in manually in the dedicated visible browser, complete MFA and confirm hand-back. Normal Chrome login is not inherited.';render();}));const form=node('form'),compose=node('textarea');compose.value=conversationDraft;compose.placeholder='Ask a question or say Remember that…';compose.setAttribute('aria-label','Conversation message');compose.dataset.focusKey='conversation-composer';compose.maxLength=4000;compose.oninput=()=>conversationDraft=compose.value;
   const submit=node('button','Send');submit.type='submit';form.append(compose,submit);form.onsubmit=async e=>{e.preventDefault();generation++;const version=generation;inflight?.abort();clearMemory();submit.disabled=true;try{const receipt=await api('/api/assistant/input',{message:conversationDraft,conversation_id:await conversationSession(),include_memory:true,model:selectedModel,worker:selectedWorker,request_id:crypto.randomUUID()});conversationDraft='';await refresh();await showAssistantReceipt(receipt,version);}catch(error){if(version===generation){conversationNotice=error.message;render();}}finally{submit.disabled=false;}};
   if(activeConversationId&&conversationHistory.some(item=>item.mission_id===activeConversationId&&item.response))conversationNotice='Response ready.';
   chat.append(form,node('p',conversationNotice));
   const work=snapshot.missions.filter(m=>m.label!=='Bounded local conversation'&&!['completed','cancelled'].includes(m.state)).slice(0,10);if(work.length){ops.append(node('h2','Work Missions'));for(const m of work)ops.append(lifecycle(m),missionCard(m));}
   layout.append(chat,ops);return layout;
 }
 function render(){if(!authorized){applyConnection(deriveConnection({authorized:false}));$('content').replaceChildren(empty('This browser session is not authorized. Open Control Center from the local Airodrom menu.'));$('heading').textContent='Authorization required';return;}if(!snapshot){$('content').replaceChildren(empty(failures?'Local service unavailable. Retrying automatically…':'Loading canonical Mission activity…'));return;}const focused=document.activeElement,key=focused?.dataset?.focusKey;const content=$('content');let result;if(missionId){const m=(snapshot.selected_mission?.id===missionId?snapshot.selected_mission:null)||snapshot.missions.find(x=>x.id===missionId);result=m?missionDetail(m):empty('Mission is outside the current snapshot. Reopen it from the task workspace.');}else if(['Conversation','Models','Workers','Connectors','Sensitive & Vault','Development Sessions'].includes(view))result=assistantView();else if(view==='Overview')result=overview();else if(view==='Missions'){result=node('div');const search=node('input');search.type='search';search.placeholder='Filter by state or runtime';search.setAttribute('aria-label','Filter Missions');search.dataset.focusKey='mission-search';search.value=searchQuery;const list=node('div');const update=()=>{list.replaceChildren(...snapshot.missions.filter(m=>(m.label+' '+m.state+' '+m.runtime).toLowerCase().includes(search.value.toLowerCase())).map(missionCard));};search.oninput=()=>{searchQuery=search.value;update();};update();result.append(search,node('p',snapshot.counts.scope,'muted'),list);}else if(view==='System Health')result=health();else if(view==='Activity & Audit'){result=node('div');const filter=node('select');filter.setAttribute('aria-label','Event category');filter.dataset.focusKey='event-category';for(const name of ['','Mission','Runtime','Worker','Memory','Capability','File','Git','Command','Test','Verification','Approval','Settlement','System']){const o=node('option',name||'All categories');o.value=name;filter.append(o);}filter.value=category;filter.onchange=()=>{generation++;inflight?.abort();category=filter.value;cursor=0;feed.clear();refresh();render();};const missionFilter=node('select');missionFilter.setAttribute('aria-label','Activity Mission');missionFilter.dataset.focusKey='activity-mission';const all=node('option','All Missions');all.value='';missionFilter.append(all);for(const m of snapshot.missions){const o=node('option',m.label+' · '+m.id.slice(0,8));o.value=m.id;missionFilter.append(o);}missionFilter.value=eventMission;missionFilter.onchange=()=>{generation++;inflight?.abort();eventMission=missionFilter.value;cursor=0;feed.clear();refresh();render();};result.append(filter,missionFilter,node('p','Timestamped host observations · retained window: 500 safe events','muted'),activity());}else if(view==='Runtime & OpenCode'){result=node('div');result.append(glass('OpenCode · Primary',snapshot.runtime.state,snapshot.runtime.reason||'Qualified local execution'),node('p','Requalification never trusts a version string. It requires exact OpenCode and Seatbelt artifacts plus a fresh confined probe.'),node('p','Run airodrom requalify from Terminal. The owned service must be stopped; current work and quarantined leases prevent repair.'),node('pre','airodrom doctor\nairodrom requalify\nairodrom start'));}else if(view==='Approvals'){result=node('div');result.append(glass('Protected Approvals waiting',snapshot.approvals.waiting,'Decisions and Acceptance are distinct'),node('p','Review the exact governed operation in the authorized workspace.'),node('a','Review protected Approvals ↗'));result.lastChild.href='/workspace';for(const a of snapshot.approvals.records){const card=glass(a.label,a.status,'Created '+stamp(a.created_at)+' · expires '+stamp(a.expires_at));if(a.task_id)card.append(workspaceLink('Review exact operation in task workspace ↗',a.task_id));else card.append(node('small','Task-specific review unavailable'));result.append(card);}result.append(node('p',snapshot.approvals.scope,'muted'));}else if(view==='Memory'){result=memoryView();}else if(view==='Projects'){result=node('div');result.append(node('p','Up to 50 registered projects, priority ordered · private names and repository paths withheld','muted'));for(const p of snapshot.projects){const card=glass(p.label,p.status,'Updated '+stamp(p.updated_at));card.append(node('small',p.id));if(p.status!=='archived'){const archive=button('Archive project',()=>send('archive-project',{id:p.id}));archive.dataset.focusKey='project:'+p.id+':archive';card.append(archive);}result.append(card);}if(!snapshot.projects.length)result.append(empty('No registered projects.'));const a=node('a','Open task workspace ↗');a.href='/workspace';result.append(a);}else{result=node('div');result.append(node('img'));result.firstChild.src='/brand/airodrom-logo-horizontal-dark.svg';result.firstChild.alt='Airodrom';result.firstChild.className='about-logo';result.append(node('h2','Airodrom '+snapshot.version),chip('PRE-RELEASE'),node('p','OpenCode executes bounded work. Airodrom owns Mission authority, Memory V2, Capability Broker, independent verification, Acceptance, Settlement, leases, audit and erasure.'),node('p','Native service and launch-at-login settings use the separately reviewed macOS lifecycle. Quitting the menu helper leaves the control plane running.'),node('a','Documentation ↗'));result.lastChild.href='https://github.com/airodrom/airodrom#readme';}
 // Preserve focus and selection across an observed snapshot update.
 const selection=focused&&'selectionStart'in focused?[focused.selectionStart,focused.selectionEnd]:null;const renderKey=view+':'+(missionId||'');const changed=content.dataset.renderKey!==renderKey;content.dataset.renderKey=renderKey;content.replaceChildren(result);if(changed&&!matchMedia('(prefers-reduced-motion: reduce)').matches&&!document.hidden)content.animate([{opacity:0,transform:'translateY(6px)'},{opacity:1,transform:'translateY(0)'}],{duration:300,easing:'ease-out'});if(key){const target=[...content.querySelectorAll('[data-focus-key]')].find(e=>e.dataset.focusKey===key);target?.focus({preventScroll:true});if(target&&selection&&target.setSelectionRange)try{target.setSelectionRange(...selection);}catch{}}
 }
 function selectMission(id){clearMemory();stopObsStream();observatory=null;obsCursor=0;diffCache.clear();generation++;missionId=id;view='Missions';$('heading').textContent='Live Mission Observatory';render();$('content').focus();refresh();}
 for(const name of views){const b=button(name,()=>{clearMemory();view=name;missionId=null;generation++;for(const [n,item]of nav)item.setAttribute('aria-current',n===name?'page':'false');$('heading').textContent=name;render();refresh();});nav.set(name,b);$('nav').append(b);}nav.get('Overview').setAttribute('aria-current','page');
 async function send(action,body){generation++;inflight?.abort();try{await api('/api/product/'+action,{...body,request_id:crypto.randomUUID()});await refresh();}catch(e){$('notice').textContent=e.message;}}
 async function refresh(){clearTimeout(timer);timer=null;if(busy||paused||document.hidden||!authorized){if(!authorized)applyConnection(deriveConnection({authorized:false}));return;}busy=true;const version=generation,filter=category;inflight=new AbortController();secondaryNotice='';try{
   if(!token){authorized=false;applyConnection(deriveConnection({authorized:false}));busy=false;inflight=null;render();return;}
   const current=await api('/api/product/overview?current_offset='+currentOffset,undefined,inflight.signal);
   let history=null,live=null;
   try{if(missionId){current.selected_mission=await api('/api/product/mission?id='+encodeURIComponent(missionId),undefined,inflight.signal);try{live=await api('/api/product/observatory?mission='+encodeURIComponent(missionId),undefined,inflight.signal);}catch(e){secondaryNotice='Observatory snapshot unavailable';live=null;}}}catch(e){secondaryNotice='Mission detail unavailable';}
   try{if(view==='Conversation'||missionId&&current.selected_mission?.label==='Bounded local conversation')history=await api('/api/assistant/history'+(missionId?'?mission_id='+encodeURIComponent(missionId):''),undefined,inflight.signal);}catch(e){secondaryNotice='History unavailable';}
   let nextCursor=snapshot?.epoch!==current.epoch?0:cursor;const incoming=[];let pages=0,batch={events:[],cursor:nextCursor,has_more:false};
   try{do{batch=await api('/api/product/events?after='+nextCursor+(filter?'&category='+encodeURIComponent(filter):'')+(eventMission?'&mission='+encodeURIComponent(eventMission):''),undefined,inflight.signal);nextCursor=batch.cursor;incoming.push(...batch.events);pages++;}while(batch.has_more&&pages<4);}catch(e){secondaryNotice='Event feed unavailable';}
   if(version!==generation||paused||document.hidden)return;
   if(snapshot?.epoch!==current.epoch)feed.clear();
   if(snapshot?.memory?.generation!==current.memory.generation)clearMemory();
   snapshot=current;lastOkAt=current.observed_at||Date.now();failures=0;
   if(live&&missionId){observatory=live;obsCursor=Math.max(obsCursor,live.cursor||0);if(!obsStream)connectObsStream(missionId);}
   if(history&&(view==='Conversation'||missionId)&&history.generation===current.memory.generation)conversationHistory=history.items;
   cursor=nextCursor;for(const e of incoming)if(e.event_id)feed.set(e.event_id,e);while(feed.size>500)feed.delete(feed.keys().next().value);
   applyConnection(current.connectivity||deriveConnection({authorized:true,reachable:true,overviewStatus:current.status,failures:0}));
   $('notice').textContent='Observed '+stamp(current.observed_at)+' · '+(live?'Live Mission Observatory · ':'')+current.counts.scope+(secondaryNotice?' · '+secondaryNotice:'');
   render();
   if(batch.has_more)timer=setTimeout(()=>{timer=null;refresh();},250);
 }catch(e){
   if(version!==generation||paused||document.hidden)return;
   if(!authorized){applyConnection(deriveConnection({authorized:false}));render();return;}
   failures++;
   applyConnection(deriveConnection({authorized:true,reachable:false,failures,error:e.message,lastOkAt}));
   $('notice').textContent=e.message+(lastOkAt?' · Last successful observation '+stamp(lastOkAt)+'.':' Previous observations are stale.');
   render();
 }finally{busy=false;inflight=null;if(!timer&&!paused&&authorized&&!document.hidden)timer=setTimeout(()=>{timer=null;refresh();},version!==generation?250:Math.min(30000,2500*2**Math.min(failures,4)));}}
 $('pause').onclick=()=>{generation++;inflight?.abort();paused=!paused;$('pause').textContent=paused?'Resume updates':'Pause updates';applyConnection(deriveConnection({authorized,reachable:!!snapshot,paused,overviewStatus:snapshot?.status,failures}));if(paused){stopObsStream();clearTimeout(timer);}else{timer=null;refresh();}};
 document.addEventListener('visibilitychange',()=>{generation++;inflight?.abort();stopObsStream();clearTimeout(timer);timer=null;if(document.hidden){clearMemory();render();document.body.classList.add('offline');}else refresh();});
 function showDialog(d,trigger=document.activeElement){lastFocus=trigger;d.showModal();d.querySelector('textarea,button')?.focus();}for(const d of [$('new-dialog'),$('review-dialog')])d.addEventListener('close',()=>{const key=lastFocus?.dataset?.focusKey;const target=key?[...document.querySelectorAll('[data-focus-key]')].find(e=>e.dataset.focusKey===key):lastFocus;target?.focus();});
 $('new').onclick=()=>showDialog($('new-dialog'),$('new'));$('close-new').onclick=()=>$('new-dialog').close();$('close-review').onclick=()=>$('review-dialog').close();
 $('mission-form').onsubmit=async e=>{e.preventDefault();generation++;const version=generation;inflight?.abort();clearMemory();const b=e.submitter;b.disabled=true;$('submit-status').textContent='Registering bounded authority…';try{const m=await api('/api/assistant/mission',{action:'new',objective:$('request').value,model:selectedModel,worker:selectedWorker,request_id:crypto.randomUUID()});if(version!==generation||!authorized||document.hidden)return;$('request').value='';$('new-dialog').close();await refresh();if(version!==generation||!authorized||document.hidden)return;if(m.mission_id)selectMission(m.mission_id);else{view='Conversation';$('heading').textContent=view;await showAssistantReceipt(m,version);}}catch(error){if(version===generation)$('submit-status').textContent=error.message;}finally{b.disabled=false;}};
 function openReview(m,trigger){reviewMission=m;$('review-workspace').onclick=()=>{if(m.task_id)try{sessionStorage.setItem('airodromTask',m.task_id);}catch{}};$('review-status').textContent='';showDialog($('review-dialog'),trigger);}
 async function recordDecision(decision){try{await api('/api/product/accept-mission',{id:reviewMission.id,verification_id:reviewMission.verification.id,request_id:crypto.randomUUID(),decision,rationale:$('rationale').value,evidence:$('evidence').value});$('rationale').value='';$('evidence').value='';$('review-dialog').close();await refresh();}catch(e){$('review-status').textContent=e.message;}}
 $('review-form').onsubmit=e=>{e.preventDefault();recordDecision('accept');};$('rework').onclick=()=>recordDecision('rework');
 refresh();
})();
