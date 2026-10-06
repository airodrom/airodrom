'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const el = (tag, text, cls) => { const n=document.createElement(tag); if(text!==undefined)n.textContent=String(text);if(cls)n.className=cls;return n; };
  const fragment=new URLSearchParams(location.hash.slice(1));
  let token=fragment.get('token')||'';try { if(token)sessionStorage.setItem('piBridgeToken',token);else token=sessionStorage.getItem('piBridgeToken')||''; } catch {}
  if(fragment.has('token'))history.replaceState(null,'',location.pathname+location.search);
  const sections = ['Overview','Projects','Missions','Agents','Activity','Decisions','Approvals','Memory','Architecture Memory','Memory Candidates','Context Packs','Tasks','Git & Files','Capabilities','Instruction Ledger','Runs / Leases','Result Inbox','Codex Relay','Agent Dispatch','Outbox','Providers','Reasoning Admissions','Next Action','Verification','Acceptance','Leases','System'];
  const nav=new Map(), rows=new Map(), events=new Map(), pins=new Set();
  let agentRefreshAt=0;
  let section='Overview', generation=0, paused=false, cursor=0, busy=false, selected=null;
  async function api(path,body) { const r=await fetch(path,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),cache:'no-store'});if(!r.ok)throw Error(r.status===401?'Open your private Control Center link first.':`Service unavailable (${r.status}).`);return r.json(); }
  const actions=el('div',undefined,'hub-actions');$('hub-detail').insertBefore(actions,$('detail-json'));
  async function detail(item) {
    actions.replaceChildren();
    if(section==='Architecture Memory')actions.append(el('p','Why the runtime knew this: exact canonical source, source version, and supersession chain below. Memory grants no authority.'));
    if(section==='Context Packs'&&item.id){try{item=await api('/api/control-v2/context-inspector?id='+encodeURIComponent(item.id));}catch{}}
    try{if(item.envelope)item=await api('/api/control-v2/mission?id='+encodeURIComponent(item.id));else if(item.question){const data=await api('/api/control-v2/decision?id='+encodeURIComponent(item.id));item={...data.decision,details:data};}}catch(error){$('hub-status').textContent=error.message;return;}
    if(item.continuity?.status==='continuity_unverified'||item.results?.some(r=>r.result?.continuity?.status==='continuity_unverified'))actions.append(el('p','Continuity unverified: retrieval and rework required.'));
    const send=async(action,body)=>{try{await api('/api/control-v2/'+action,{...body,request_id:crypto.randomUUID()});$('hub-detail').close();await refresh(true);}catch(error){$('detail-time').textContent=error.message;}};
    const button=(label,fn)=>{const b=el('button',label,'button secondary');b.type='button';b.onclick=fn;actions.append(b);return b;};
    if(section==='Architecture Memory')button('View project version history',async()=>{try{const data=await api('/api/control-v2/architecture-memory?history=true&project_id='+encodeURIComponent(item.project_id));$('detail-json').textContent=JSON.stringify(data,null,2);}catch(error){$('detail-time').textContent=error.message;}});
    const field=(label)=>{const wrapper=el('label',label);const input=el('textarea');input.rows=3;input.maxLength=4000;wrapper.append(input);actions.append(wrapper);return input;};
    if(item.question&&item.state==='waiting_for_operator'){
      actions.append(el('p',item.question));
      for(const option of item.options){button(option.label+(option.recommended?' · Recommended':''),()=>send('answer',{id:item.id,option_id:option.id}));if(option.description)actions.append(el('p',option.description));}
      if(item.free_text){const answer=field('Your answer');button('Submit answer',()=>send('answer',{id:item.id,free_text:answer.value}));}
      actions.append(el('p','An answer continues this Mission. Protected approvals remain separate.'));
    }
    if(item.question&&item.state!=='waiting_for_operator')actions.append(el('p',`Decision ${item.state}. Recorded answers are immutable.`));
    if(section==='Result Inbox'){actions.append(el('p','Reported completion remains untrusted until verification and acceptance.'));if(item.state!=='reviewed')button('Mark read',()=>send('result-review',{run_id:item.run_id,state:'read'}));button('Mark reviewed',()=>send('result-review',{run_id:item.run_id,state:'reviewed'}));}
    if(section==='Providers'&&item.kind==='provider'){
      actions.append(el('p',`${item.availability||'unknown'} · ${item.auth_state||'unknown'} · ${item.locality||'unknown'} · ${item.privacy_class||'unknown'}`));
      actions.append(el('p','Provider metadata grants no execution authority. Circuit resets require settled inference.'));
      for(const m of item.models||[])if(m.circuit?.circuit!=='CLOSED')button(`Reset circuit: ${m.profile_id||m.id}`,()=>send('provider-circuit-reset',{id:item.id,profile:m.profile_id||m.id}));
    }
    if(section==='Next Action'&&item.plan){button('Pause chain',()=>send('next-action-pause',{id:item.id}));if(item.state==='paused')button('Resume within original budget',()=>send('next-action-resume',{id:item.id}));}
    if(section==='Approvals'){actions.append(el('p','Protected approvals are distinct from questions. Review the exact operation in the Control Center.'));const link=el('a','Open Control Center');link.href='/';actions.append(link);}
    if(item.envelope){
      actions.append(el('p',item.envelope.objective),el('p',`Agent: ${item.dispatches?.at(-1)?.route?.selected|| (item.envelope.route_mode==='automatic'?'automatic':item.envelope.preferred_agent||'unassigned')} · State: ${item.state} · Acceptance: ${item.acceptance_strength||'pending'}`));
      if(['ready','needs_rework','blocked'].includes(item.state))button('Dispatch Mission',()=>send('dispatch-mission',{id:item.id}));
      if(item.state==='awaiting_acceptance'){
        const rationale=field('Reason for your decision'),evidence=field('Review evidence (required for unsupported criteria)');
        for(const decision of ['accept','rework'])button(decision==='accept'?'Accept Mission':'Request rework',()=>send('accept-mission',{id:item.id,verification_id:item.verifications[0]?.id,decision,rationale:rationale.value,evidence:evidence.value}));
      }
      if(!['completed','cancelled'].includes(item.state))button('Emergency STOP · revoke authority',()=>send('cancel-mission',{id:item.id}));
    }
    selected=item;const ts=item.timestamp||item.created_at||item.updated_at;
    $('detail-time').textContent=ts?`${new Date(ts).toLocaleString()} · ${new Date(ts).toISOString()}`:'';
    $('detail-heading').textContent=item.event_type||item.id||item.name||'Details';
    $('detail-json').textContent=JSON.stringify(item,null,2);
    $('detail-pin').hidden=!item.event_id; $('detail-pin').textContent=pins.has(item.event_id)?'Unpin event':'Pin event';
    $('hub-detail').showModal();
  }
  $('detail-close').onclick=()=>$('hub-detail').close();
  $('detail-copy').onclick=async()=>{try{await navigator.clipboard.writeText(selected.event_id||selected.id||selected.missionId||selected.projectId||'');}catch{$('detail-time').textContent='Copy unavailable. The ID is shown below.';}};
  $('detail-pin').onclick=()=>{const id=selected.event_id;pins.has(id)?pins.delete(id):pins.add(id);$('detail-pin').textContent=pins.has(id)?'Unpin event':'Pin event';renderEvents();};
  function row(item, key) {
    const button=el('button',undefined,'hub-row');button.type='button';button.dataset.key=key;
    const at=item.timestamp_ms||item.created_at||item.createdAt||item.checked_at;
    const stamp=el('time',at?new Date(at).toLocaleString():item.kind||item.agent_id||'Record');
    if(at){stamp.dateTime=new Date(at).toISOString();stamp.title=stamp.dateTime;}
    button.append(stamp,el('strong',item.event_type||item.name||item.state||item.status||item.id||'Details'),el('span',[item.agent||item.agent_id,item.task_id,item.run_id,item.status,item.question||item.objective||item.envelope?.objective||item.reason||item.description||item.subject,item.duration_ms!=null?`${item.duration_ms} ms`:null].filter(Boolean).join(' · ')));
    button.onclick=()=>detail(item);return button;
  }
  function renderEvents() {
    const anchor=[...rows.values()].find(r=>!r.hidden&&r.getBoundingClientRect().bottom>0);
    const previousTop=anchor?.getBoundingClientRect().top;
    const query=$('event-search').value.toLowerCase();
    for(const [id,item] of events){let r=rows.get(id);if(!r){r=row(item,id);rows.set(id,r);$('hub-content').append(r);}r.hidden=query&&!JSON.stringify(item).toLowerCase().includes(query);r.classList.toggle('hub-pinned',pins.has(id));r.setAttribute('aria-label',`${pins.has(id)?'Pinned. ':''}${item.event_type}. ${item.agent}. ${new Date(item.timestamp_ms).toLocaleString()}`);}
    for(const [id,r] of rows)if(!events.has(id)){r.remove();rows.delete(id);}
    if(anchor?.isConnected&&!anchor.hidden)window.scrollBy(0,anchor.getBoundingClientRect().top-previousTop);
  }
  function showItems(items) { $('hub-content').replaceChildren(); if(!items.length){$('hub-content').append(el('p','No records yet.','empty-copy'));return;}for(const [i,item]of items.entries())$('hub-content').append(row(item,item.id||i)); }
  async function refresh(force=false) {
    if(busy||document.hidden||$('hub-detail').open||(!force&&$('hub-content').contains(document.activeElement))||(section==='Activity'&&paused))return;busy=true;const version=generation;
    try {
      if(section==='Activity') {
        const data=await api(`/api/control-v2/events?limit=100&${cursor?`afterSequence=${cursor}`:'order=desc'}`);if(version!==generation)return;
        if(!cursor){data.events.reverse();$('hub-content').replaceChildren();rows.clear();}
        for(const item of data.events){events.set(item.event_id,item);cursor=Math.max(cursor,item.sequence);}
        while(events.size>500){const id=[...events.keys()].find(id=>!pins.has(id));if(!id)break;events.delete(id);}
        renderEvents();$('hub-status').textContent=`Live · ${events.size} retained events · sequence ${cursor}. Updates preserve your scroll position.`;
      } else {
        let data;
        if(section==='Overview'||section==='System')data=await api('/api/control-v2/health');
        else if(section==='Memory')data=await api('/api/personal-memory');
        else if(section==='Capabilities')data=await api('/api/capabilities');
        else if(section==='Instruction Ledger')data=await api('/api/control-v2/events?limit=100&order=desc');
        else if(section==='Projects')data=await api('/api/projects');
        else if(section==='Agents'){if(Date.now()-agentRefreshAt>30000){await api('/api/control-v2/refresh-agents',{});agentRefreshAt=Date.now();}data=await api('/api/control-v2/agents');}
        else data=await api('/api/control-v2/'+({'Architecture Memory':'architecture-memory','Memory Candidates':'candidates','Missions':'missions','Decisions':'decisions','Approvals':'approvals','Context Packs':'context','Tasks':'tasks','Git & Files':'git-files','Runs / Leases':'runs','Result Inbox':'result-inbox','Codex Relay':'codex','Agent Dispatch':'agent-dispatches','Outbox':'outbox','Providers':'providers','Reasoning Admissions':'reasoning-admissions','Next Action':'next-action','Verification':'verifications','Acceptance':'acceptance','Leases':'leases'}[section]));
        if(version!==generation)return;
        if(data.items)showItems(section==='Agents'?data.items.map(a=>({...a,description:a.observation?.runtime_profile?`${a.observation.runtime_profile.availability} · ${a.observation.runtime_profile.transport} · ${a.observation.runtime_profile.reason||'ready'} · ${a.observation.runtime_profile.auth_state}`:a.observation?.reason})):section==='Providers'?[...data.items.map(p=>({...p,description:`${p.availability||p.state||'unknown'} · ${p.auth_state||'not checked'} · ${p.locality||'unknown'} · ${(p.models||[]).length} profiles`})),...(data.routes||[]).map(r=>({...r,kind:'provider_route',id:r.request_id,description:`${r.selected_agent||'unassigned'} · ${r.selected_provider||'WAIT'} · ${r.selected_model||r.wait_reason||''} · ${r.data_class} · ${r.cost_class||'unknown'}`}))]:section==='Tasks'?data.items.map(t=>({...t,description:t.health?`${t.authority ? t.authority.label + ' · ' + t.authority.status + ' · ' : ''}${t.health.status} · ${t.health.score===null?'Unknown score':t.health.score+'%'} · Process: ${t.health.processState} · Lease: ${t.health.leaseState}`:t.status})):data.items);else{$('hub-content').replaceChildren(el('pre',JSON.stringify(data,null,2),'card'));}
        $('hub-status').textContent=`Updated ${new Date().toLocaleString()} · Select a record to inspect evidence and available actions.`;
      }
    } catch(error){if(version===generation)$('hub-status').textContent=`Degraded · ${error.message} Existing content is retained.`;}finally{busy=false;}
  }
  for(const name of sections){const b=el('button',name,'button secondary');b.type='button';b.onclick=()=>{section=name;generation++;$('heading').textContent=name;$('activity-controls').hidden=name!=='Activity';$('hub-content').replaceChildren();rows.clear();if(name==='Activity'){events.clear();cursor=0;}for(const [n,button]of nav)button.setAttribute('aria-current',n===name?'page':'false');$('hub-status').textContent='Loading…';refresh(true);};nav.set(name,b);$('hub-nav').append(b);}
  nav.get(section).setAttribute('aria-current','page');
  $('live-toggle').onclick=()=>{paused=!paused;$('live-toggle').textContent=paused?'Resume updates':'Pause updates';$('hub-status').textContent=paused?'Updates paused. Retained events remain available.':'Resuming…';if(!paused)refresh();};
  $('event-search').oninput=renderEvents;
  refresh();setInterval(refresh,2500);
})();
