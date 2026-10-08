'use strict';
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PassThrough } = require('node:stream');
const local = require('./local-bootstrap');
const branding = require('./branding');
const render = require('./assistant-render');
const READ_COMMANDS = new Set(['models','workers','connectors','status','details','doctor','memory','runtime','sensitive','vault','secret','gmail','whatsapp','research']);
function parseLine(line) {
 const raw=line.trim().replace(/^(?:You\s*[›>]|>)\s*(?=\/|--help|--version)/,'');
 const value=({'--version':'/version','--help':'/help','-h':'/help'}[raw])||raw;
 const match=/^\/(\S+)(?:\s+([\s\S]*))?$/.exec(value);
 const command=match?.[1]; let arg=match?.[2]?.trim()||'';
 const json=READ_COMMANDS.has(command)&&/(?:^|\s)--json$/.test(arg);
 if(json)arg=arg.replace(/(?:^|\s)--json$/,'').trim();
 return {value,command,arg,json};
}
function show(output,data,formatter,json=false){output.write(terminalText(json?JSON.stringify(data,null,2):formatter(data))+'\n');}
const terminalText = value => require('node:util').stripVTControlCharacters(String(value)).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
const COMMANDS = '/name <name> · /about · /version · /models · /model auto|local|<id> · /workers · /worker auto|<id>\n/connectors · /connect gmail · /gmail status|unread|recent|search|read|thread · /whatsapp status|search · /remember-sensitive · /sensitive · /vault · /secret\n/remember <text> · /memory [query] · /forget <id or subject>\n/mission new [objective] · /mission list · /mission status [id] · /mission cancel [id] · /mission run [id] · /mission web on|off|all [id] [URLs] · /research search <query> · /research explore <URLs> · /research login <HTTPS URL> · /research account <HTTPS login URL> · /research report [mission-id] [--json]\n/status · /details · /doctor · /runtime [opencode] · /open · /task <mission.json> · /accept · /help · /quit';
const terminalBrand = require('./terminal-brand'), intro = terminalBrand.intro;
function rows(s) {
 const p=s.product, runtime=p?.runtime|| (s.opencode?.ready?'Ready':s.opencode?.reason==='opencode_runtime_pins_changed'?'Degraded':'Unavailable');
 return `OpenCode   ${runtime==='Ready'?'● Ready · Primary':runtime+' · '+(p?.runtimeReason||s.opencode?.reason||'Not observed')}${s.opencode?.version?' · '+s.opencode.version:''}
Memory V2  ${p?.memory||'Unavailable'} · Local
Control    ${p?.control|| (s.healthy?'Ready':'Unavailable')} · Local
Provider   ${p?.provider||'Unavailable'} · Ollama
Model      ${p?.model||'Unavailable'}
Routing    ${p?.routing||'Unavailable'}
Missions   ${p?.active_missions??'Unavailable'} active · ${p?.approvals??'Unavailable'} approvals waiting
Verifier   Host boundary checks · factual review by operator
Connectors ${p?.connectors||'Unavailable'}
Privacy    Local inference · scoped Memory · credentials stay private
`;
}
function help() { return `${branding.name} — ${branding.tagline}\n\nSHELL COMMANDS · run in Terminal\nUsage: airodrom [command]\n\n  (no command) Interactive terminal\n  menu         Open the native macOS menu helper\n  help         Show full command guidance\n  doctor       Inspect safe readiness and pin categories\n  requalify    Fresh confined qualification while stopped\n  status       Inspect the local service\n  start        Start or attach to the local service\n  stop         Gracefully stop the owned local service\n  restart      Stop and start the owned local service\n  open         Open the optional Control Center\n  memory       List/search Personal Memory V2\n  task <file>  Register and dispatch a scoped Mission JSON\n  mcp          Existing MCP stdio transport\n  --version    Show version\n\nINTERACTIVE COMMANDS · type inside Airodrom\n${COMMANDS}\n\nRead-only commands accept --json for developer output.\n/mcp explains the separate shell transport.\n\n${branding.website}\n`; }
async function waitResult(home, id, { signal, onProgress, timeoutMs=130000 } = {}) {
  const deadline = Date.now() + timeoutMs; let lastState=null;
  while (Date.now() < deadline) {
    if (signal?.aborted) { await local.request(home, '/api/interactive/cancel', { mission_id: id, request_id: randomUUID() }); throw Error('Task cancelled.'); }
    const r = await local.request(home, '/api/interactive/task?mission_id=' + encodeURIComponent(id));
    if(r.state!==lastState){lastState=r.state;onProgress?.(r);}
    if (['awaiting_acceptance', 'completed'].includes(r.state)) return r;
    if(r.state==='waiting_for_operator')return r;
    if (['blocked', 'needs_rework', 'cancelled'].includes(r.state)) throw Error(r.reason || 'Mission stopped; inspect its status.');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await local.request(home, '/api/interactive/cancel', { mission_id: id, request_id: randomUUID() });
  throw Error('Bounded task timed out and cancellation was requested.');
}
async function waitConversation(home, turn, { signal } = {}) {
  const identity = { conversation_id: turn.conversation_id, turn_id: turn.turn_id };
  if (!identity.conversation_id || !identity.turn_id) throw Error('Conversation receipt is unavailable.');
  const cancel = () => local.request(home, '/api/assistant/conversation/cancel', identity);
  const deadline = Date.now() + 130000;
  try {
    while (Date.now() < deadline) {
      if (signal?.aborted) { await cancel(); throw Error('Conversation cancelled.'); }
      const result = await local.request(home, '/api/assistant/conversation?conversation_id=' + encodeURIComponent(identity.conversation_id) + '&turn_id=' + encodeURIComponent(identity.turn_id));
      if (signal?.aborted) { await cancel(); throw Error('Conversation cancelled.'); }
      if (result.state === 'completed') return result;
      if (['failed', 'cancelled'].includes(result.state)) throw Error(result.reason || 'Conversation stopped.');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await cancel();
    throw Error('Conversation timed out and cancellation was requested.');
  } catch (error) {
    // A lost delivery must not leave an inference turn running in the background.
    if (!['Conversation cancelled.', 'Conversation timed out and cancellation was requested.'].includes(error.message)) {
      await cancel().catch(() => {});
    }
    throw error;
  }
}
function missionReceipt(data) {
  const items = data.missions || (data.kind === 'missions' ? data.items : null);
  if (items) return items.length ? items.map(m => `${m.id || m.mission_id} · ${m.state}\n${m.objective || m.label || 'Work Mission'}`).join('\n\n') + '\n' : 'No active Missions.\n';
  const mission = data.mission || data;
  return `Mission ${mission.id || mission.mission_id}${mission.state ? ' · ' + mission.state : ''}\n${mission.message || data.message || mission.objective || 'Use /mission status or /details to inspect the governed work.'}\n`;
}
async function memory(home, query, output, json=false) {
  const data = await local.request(home, '/api/interactive/memory' + (query ? '?query=' + encodeURIComponent(query) : ''));
  show(output,data,render.memories,json);
  return data;
}
async function scopedTask(home, file,preferences={}) {
  if (!file) throw Error('Use /task <mission.json> with declared workspace, allowed files, criteria and registered verification.');
  const s = fs.lstatSync(path.resolve(file));
  if (!s.isFile() || s.isSymbolicLink() || s.size > 64000) throw Error('Mission JSON must be a bounded regular file.');
  const input = require('./authority-json').parseAuthorityJSON(fs.readFileSync(path.resolve(file), 'utf8'));
  const mission = await local.request(home, '/api/control-v2/create-mission', { ...input,...preferences, request_id: input.request_id || randomUUID() });
  await local.request(home, '/api/control-v2/dispatch-mission', { id: mission.id, request_id: randomUUID() });
  return mission.id;
}
async function interactive(home, { input = process.stdin, output = process.stdout, env = process.env } = {}) {
  output.write(intro({ mode: terminalBrand.colorMode({tty:!!output.isTTY,env}), graphics:terminalBrand.imageProtocol({tty:!!output.isTTY,env}), unicode: env.TERM !== 'dumb', columns:output.columns||80, rows:output.rows||40 }));
  const s = await local.start(home, env);
  output.write('\nType a question, or /help for commands. Chat is visible while you type.\nPasswords and API keys belong only in /vault’s hidden prompt. Screening after Enter cannot hide echoed text or detect every secret.\n');
  const address=require('./conversation-address');
  let userName=null,nameOffered=false;
  const refreshName=async()=>{
    if(!input.isTTY||!output.isTTY)return;
    try { const row=address.saved((await local.request(home,'/api/interactive/memory?query=name')).items);userName=row?address.contentName(row.content):null; }
    catch { userName=null; }
  };
  await refreshName();
  if(input.isTTY&&output.isTTY){
    nameOffered=!userName;
    output.write(userName?`\nAiro\nHello, ${userName}.\n`:'\nAiro\nMay I ask what you’d like me to call you? You can reply “Call me …”. If you share a name here, I’ll remember it for future conversations. Press Enter to continue as You.\n');
  }
  const prompt=()=>`\n${userName||'You'} › `;
  const showPrompt=()=>{ if(output.isTTY){rl.setPrompt(prompt());rl.prompt();} };
  let rl, lines, readerDataListeners = [], readerInput = input, readerEndListener = null, readerLocked = false;
  let assistantNickname=s.nickname,model='auto',worker='auto',runtime = s.default_runtime, lastMission = null, conversationId = null, active = null, indicator = null, quitting = false;
  const interrupt = () => { if (active) active.abort(); else { quitting = true; rl?.close(); } };
  const attachReader = () => {
    const previous = new Set(input.listeners('data'));
    readerLocked = false;
    if (input.isTTY && output.isTTY) {
      // Admit one terminal line at a time. Pasted follow-up lines cannot enter
      // readline or echo while a secure workflow is being selected.
      readerInput = new PassThrough();
      readerInput.isTTY = true;
      readerInput.setRawMode = enabled => input.setRawMode(enabled);
      Object.defineProperty(readerInput, 'isRaw', { get: () => input.isRaw });
      const forward = chunk => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (readerLocked) { if (bytes.includes(3)) interrupt(); return; }
        const end = bytes.findIndex(byte => byte === 10 || byte === 13);
        if (end >= 0) readerLocked = true;
        readerInput.write(end < 0 ? bytes : bytes.subarray(0, end + 1));
      };
      input.on('data', forward);
      readerEndListener = () => readerInput.end();
      input.once('end', readerEndListener);
      input.resume();
    } else readerInput = input;
    // Ordinary chat uses visible readline editing, with history disabled.
    // Screening before dispatch cannot undo echo; credential capture is a
    // separate detached raw no-echo workflow, never this reader.
    rl = readline.createInterface({ input: readerInput, output, historySize:0, terminal: !!input.isTTY && !!output.isTTY });
    lines = rl[Symbol.asyncIterator]();
    readerDataListeners = input.listeners('data').filter(listener => !previous.has(listener));
    rl.on('SIGINT', interrupt);
  };
  const detachReader = async () => {
    const reader = rl, iterator = lines;
    rl = null; lines = null;
    reader?.pause();
    if (reader) { reader.line = ''; reader.removeListener('SIGINT', interrupt); reader.close(); }
    for (const listener of readerDataListeners) input.removeListener('data', listener);
    readerDataListeners = [];
    if (readerEndListener) input.removeListener('end', readerEndListener);
    readerEndListener = null;
    await iterator?.return?.();
    if (readerInput !== input) readerInput.destroy();
    input.pause();
    // Discard pasted/queued ordinary input at the secure-entry boundary.
    if (input.isTTY) while (input.read() !== null) {}
  };
  const secureGuide = async (plan = null, message = null) => {
    if (!input.isTTY || !output.isTTY || !input.setRawMode) throw Error('Secure Vault requires an interactive operator terminal. Use /vault in Terminal.');
    await detachReader();
    try { output.write('\nAiro\n');if(plan)await require('./personal-storage-guide').guide({input,output,home,signal:active?.signal,plan,message});else await require('./secure-vault-guide').guide({ input, output, home, signal: active?.signal }); }
    finally { if (!quitting && !input.readableEnded) {while(input.read()!==null){};attachReader();} }
  };
  const privateGuide = async message => {
    if (!input.isTTY || !output.isTTY || !input.setRawMode) throw Error('Private Vault requires an interactive operator terminal.');
    await detachReader();
    try { output.write('\nAiro\n');await require('./natural-private-vault').guide({message,input,output,home,signal:active?.signal,nickname:assistantNickname}); }
    finally { if (!quitting && !input.readableEnded) {while(input.read()!==null){};attachReader();} }
  };
  const accountGuide = async entry_url => {
    await detachReader();
    try { return await require('./research-account-guide').guide({entry_url,input,output,home,signal:active?.signal}); }
    finally { if (!quitting && !input.readableEnded) {while(input.read()!==null){};attachReader();} }
  };
  const sessionGuide = async entry_url => {
    await detachReader();try{return await require('./research-session-guide').guide({entry_url,input,output,home,signal:active?.signal});}
    finally{if(!quitting&&!input.readableEnded){while(input.read()!==null){};attachReader();}}
  };
  const sessionReady = async mission_id => {
    await detachReader();try{return await require('./research-session-guide').ready({mission_id,input,output,home,signal:active?.signal});}
    finally{if(!quitting&&!input.readableEnded){while(input.read()!==null){};attachReader();}}
  };
  const session = async () => {
    if (!conversationId) conversationId = (await local.request(home, '/api/assistant/conversation/session', {})).conversation_id;
    if (!conversationId) throw Error('Conversation session is unavailable.');
    return conversationId;
  };
  const startAnswer=()=>{
    output.write('\nAiro\n');
    indicator=render.waiting(output,{env,signal:active.signal});
  };
  const stopAnswer=()=>{indicator?.stop();indicator=null;};
  const answer=async (id,options={})=>{
    if(!indicator)startAnswer();
    try { return await waitResult(home,id,{signal:active.signal,...options}); }
    finally { stopAnswer(); }
  };
  const handleReceipt = async (receipt, json = false, message = null) => {
    if (receipt.kind === 'preference') assistantNickname=receipt.nickname;
    if(receipt.kind==='public_web_offer'){stopAnswer();await detachReader();let next;try{next=await require('./mission-web-guide').guide({offer:receipt,input,output,home,signal:active?.signal});}finally{await attachReader();}await handleReceipt(next,json,message);return;}
    if(receipt.kind==='research_session'){stopAnswer();await handleReceipt(await sessionGuide(receipt.entry_url),json,message);return;}
    if (receipt.kind === 'chat') {
      if (!indicator) startAnswer();
      const result = await waitConversation(home, receipt, { signal: active?.signal });
      stopAnswer();
      output.write(terminalText(result.summary || '') + '\n');
    } else if (receipt.kind === 'conversation') {
      // Retained legacy receipts describe an actual governed Mission.
      lastMission = receipt.mission_id;
      const result = await answer(lastMission);
      output.write(terminalText(result.summary || '') + '\n');
    } else if (receipt.kind === 'private_storage') {
      stopAnswer();
      await secureGuide(receipt,message);
    } else if (receipt.kind === 'vault') {
      stopAnswer();
      await secureGuide();
    } else if (['mission', 'missions', 'mission_status'].includes(receipt.kind)) {
      stopAnswer();
      if (receipt.mission_id || receipt.mission?.id) lastMission = receipt.mission_id || receipt.mission.id;
      show(output, receipt, missionReceipt, json);
      if (receipt.kind === 'mission' && ['dispatching', 'running', 'verifying'].includes(receipt.state)) {
        let result = await answer(lastMission,receipt.browser_research_available?{timeoutMs:200000}:{});
        if(receipt.session_mode==='dedicated_manual'&&result.state==='waiting_for_operator'){
          const status=await local.request(home,'/api/assistant/mission',{action:'status',mission_id:lastMission,request_id:randomUUID()});
          if(status.mission?.research?.handoff_required&&await sessionReady(lastMission))result=await answer(lastMission,{timeoutMs:200000});
        }

        if(receipt.browser_research_available&&['awaiting_acceptance','completed'].includes(result.state)){const report=await local.request(home,'/api/assistant/research/report?mission_id='+encodeURIComponent(lastMission));show(output,report,render.researchReport,json);}
        else if(receipt.browser_research_available)output.write('Research needs owner intervention. Use /mission status or Control Center to review the required action. No report has been qualified.\n');
        else output.write(terminalText(result.summary || '') + '\n');
      }
    } else {
      stopAnswer();
      show(output, receipt, render.receipt, json);
      if (receipt.kind === 'connect_required' && receipt.can_start_oauth) output.write('Type /connect ' + terminalText(receipt.connector) + ' to authorize access in your browser.\n');
    }
  };
  attachReader(); process.on('SIGINT', interrupt);
  try {
    showPrompt();
    while (lines) {
      const next = await lines.next();
      if (next.done) break;
      const line = next.value;
      if (quitting) break;
      const {value,command,arg,json}=parseLine(line); if (!value) { nameOffered=false;await refreshName();readerLocked=false;showPrompt(); continue; }
      try {
        const ingress=require('./assistant-intent').parse(value,{nickname:assistantNickname});
        if(ingress.kind==='secret'){nameOffered=false;output.write('\nAiro\n'+ingress.message+'\n');await refreshName();readerLocked=false;showPrompt();continue;}
        if(ingress.kind==='vault'&&!command){nameOffered=false;active=new AbortController();try{await secureGuide();}finally{active=null;}await refreshName();readerLocked=false;showPrompt();continue;}
        if(ingress.kind==='private_storage'){nameOffered=false;active=new AbortController();await secureGuide(ingress,value);active=null;await refreshName();readerLocked=false;showPrompt();continue;}
        if(ingress.kind==='clarify'&&require('./personal-storage-intent').containsPrivate(value)){nameOffered=false;output.write(ingress.message+'\n');await refreshName();readerLocked=false;showPrompt();continue;}
        if(ingress.kind==='private_vault'){nameOffered=false;active=new AbortController();await privateGuide(value);active=null;await refreshName();readerLocked=false;showPrompt();continue;}
        if(nameOffered&&/^(?:no|skip|no thanks|no name|prefer not to say)[.!]?$/i.test(value)){
          nameOffered=false;await refreshName();output.write('\nAiro\nOf course. I’ll use You.\n');readerLocked=false;showPrompt();continue;
        }
        const offered=address.answer(value,{bare:nameOffered});nameOffered=false;
        if(offered){
          await local.request(home,'/api/interactive/remember',{content:`My name is ${offered}.`});
          await refreshName();output.write(`\nAiro\nThank you, ${offered}. I’ll call you ${offered}.\n`);
          readerLocked=false;showPrompt();continue;
        }
        if(command==='name')throw Error('Use /name followed by the name you’d like me to use. Credentials require /vault.');
        await refreshName();
        if(command)output.write('\n');
        if(['help','about','version','mcp','status','details','doctor','connectors'].includes(command)&&arg)throw Error('Submit this command on its own, or use --json for read-only details.');
        if (command === 'quit') {if(arg)throw Error('Submit /quit on its own.');break;}
        if (command === 'help') output.write(help());
        else if (command === 'about'||command==='version') output.write(branding.name+' '+require('../package.json').version+' · PRE-RELEASE\n');
        else if (command==='mcp') output.write('MCP is a shell transport: run airodrom mcp from a separate terminal. submit_mission/get_mission_handoff/cancel_mission_handoff use canonical Airodrom authority.\n');
        else if (['models','workers','model','worker'].includes(command)) {
          const registry=await local.request(home,'/api/assistant/registry');
          if(['model','worker'].includes(command)&&arg){
            const next={model:command==='model'?arg:model,worker:command==='worker'?arg:worker};
            if(arg!=='auto'){
              const route=require('./model-worker-router').select(registry,next);
              if(route.state!=='READY')throw Error('Selection unavailable: '+route.reason.replaceAll('_',' ')+'. Current selection preserved.');
            }
            model=next.model;worker=next.worker;
          }else if(arg)throw Error('Use /models or /workers; select with /model or /worker.');
          show(output,registry,c=>command.startsWith('model')?render.models(c,model):render.workers(c,worker),json);
        }
        else if(command==='connectors')show(output,await local.request(home,'/api/assistant/connectors'),render.connectors,json);
        else if(command==='connect') {if(!['gmail','whatsapp'].includes(arg))throw Error('Use /connect gmail or /connect whatsapp');const result=await local.request(home,'/api/assistant/connect',{connector:arg});if(result.authorization_url){const r=require('node:child_process').spawnSync('/usr/bin/open',[result.authorization_url],{stdio:'ignore',timeout:5000});if(r.status!==0)throw Error('OAuth browser could not open.');output.write('Read-only Gmail OAuth opened. Complete the operator authorization in your browser.\n');}else output.write(terminalText(result.message)+'\n');}
        else if(command==='gmail'||command==='whatsapp') {
          const [actionArg='status',...parts]=arg.split(/\s+/),action=actionArg==='draft-reply'?'draft_reply':actionArg,query=parts.join(' '),selected=['read','thread','summarize','draft_reply'].includes(action);
          active=new AbortController();
          const receipt=await local.request(home,'/api/assistant/connector',{connector:command,action,input:query?{[selected?'id':action==='draft'?'body':'query']:query}:{}});
          await handleReceipt(receipt,json);active=null;
        }
        else if(command==='remember-sensitive'){const item=await local.request(home,'/api/assistant/sensitive',{content:arg});output.write('Sensitive Memory saved; operator-only ID '+item.memoryId+'\n');}
        else if(command==='sensitive'){const parts=arg.split(/\s+/);if(parts[0]==='correct'){const r=await local.request(home,'/api/assistant/sensitive',{id:parts[1],content:parts.slice(2).join(' ')});output.write('Corrected sensitive ID '+r.memoryId+'\n');}else show(output,await local.request(home,parts[0]==='reveal'?'/api/assistant/reveal-sensitive':'/api/assistant/sensitive',parts[0]==='reveal'?{id:parts[1]}:undefined),render.sensitive,json);}
        else if(command==='vault'||command==='secret'){
          if(arg && !['guide','status'].includes(arg))throw Error('Use /vault for secure entry. Secret values never belong in commands.');
          if(json||arg==='status')show(output,new (require('./secret-vault').SecretVault)(require('./local-bootstrap').privateDirectory(path.join(home,'data'),true)).status(),render.vault,json);
          else { active=new AbortController();await secureGuide();active=null; }
        }
        else if (command === 'doctor') show(output,await require('./product-diagnostics').doctor(home),require('./product-diagnostics').summary,json);
        else if (command === 'status'||command==='details') {
          const detail=lastMission?await local.request(home,'/api/product/mission?id='+encodeURIComponent(lastMission)):null;
          if(command==='status'){
            const status=await local.status(home);
            show(output,detail?{...status,mission:detail}:status,d=>rows(d)+(d.mission?render.rail(d.mission):''),json);
          }else if(detail)show(output,detail,render.rail,json);
          else output.write('No Mission is selected.\n');
        }
        else if (command === 'runtime') { if (arg) runtime = require('./default-runtime').defaultRuntime(arg);show(output,{runtime},d=>'Runtime for fresh tasks: '+render.name(d.runtime),json); }
        else if (command === 'open') { local.open(home); output.write('Control Center opened.\n'); }
        else if(command==='research'){
          if(/^report(?:\s+[a-f0-9-]{36})?$/i.test(arg)){
            const id=arg.split(/\s+/)[1]||lastMission;if(!id)throw Error('Select a research Mission or use /research report <mission-id>.');
            show(output,await local.request(home,'/api/assistant/research/report?mission_id='+encodeURIComponent(id)),render.researchReport,json);
            active=null;readerLocked=false;showPrompt();continue;
          }
          if(/^(search|explore)\s+/i.test(arg)){await handleReceipt(require('./mission-web-guide').parse(arg.replace(/^search\s+/i,'search the web for ')),false,arg);active=null;readerLocked=false;showPrompt();continue;}
          if(json)throw Error('Use /research report [mission-id] --json for verified developer evidence.');
          if(!/^(?:login|account)\s+https:\/\/\S+$/i.test(arg))throw Error('Use /research login <HTTPS URL> for dedicated manual login, or /research account <HTTPS login URL> for stored Vault credentials.');
          active=new AbortController();const receipt=await (/^login\s/i.test(arg)?sessionGuide(arg.replace(/^login\s+/i,'')):accountGuide(arg.replace(/^account\s+/i,'')));await handleReceipt(receipt,json);active=null;
        }
        else if (command === 'memory') await memory(home, arg, output,json);
        else if (command === 'remember') { const item = await local.request(home, '/api/interactive/remember', { content: arg }); output.write('Remembered in Memory V2. ID: ' + item.memoryId + '\n'); }
        else if (command === 'forget') { const r = await local.request(home, '/api/interactive/forget', { selection: arg }); output.write('Forgotten. Fresh Missions cannot retrieve this record. ID: ' + r.memoryId + '\n'); }
        else if (command === 'task') { lastMission = await scopedTask(home, arg,{model,worker}); output.write('Scoped Mission dispatched: ' + lastMission + '\n'); }
        else if (command === 'mission') {
          if (!arg) output.write('/mission new [objective] · /mission list · /mission status [id] · /mission cancel [id]\n');
          else {
            const [action, ...parts] = arg.split(/\s+/);
            if(action==='web'){
              const mode=parts.shift();if(!['on','off','all'].includes(mode))throw Error('Use /mission web on|off|all [id] [public HTTPS URLs].');
              const id=/^[a-f0-9-]{36}$/i.test(parts[0]||'')?parts.shift():lastMission;if(!id)throw Error('Select a qualified Work Mission first.');
              if(mode==='off'){const receipt=await local.request(home,'/api/assistant/mission/web',{mission_id:id,mode,request_id:randomUUID()});output.write(receipt.message+'\n');active=null;readerLocked=false;showPrompt();continue;}
              const status=await local.request(home,'/api/assistant/mission',{action:'status',mission_id:id,request_id:randomUUID()}),proposal=require('./mission-web-policy').proposal(status.mission.objective);
              const offer={mode,entries:parts.length?parts:proposal.entries,...(!parts.length&&!proposal.entries.length?{query:status.mission.objective}:{})};
              await detachReader();let receipt;try{receipt=await require('./mission-web-guide').guide({offer,mission_id:id,input,output,home});}finally{await attachReader();}output.write(receipt.message+'\n');active=null;readerLocked=false;showPrompt();continue;
            }
            if (!['new','list','status','cancel','run'].includes(action) || action==='list'&&parts.length || ['status','cancel','run'].includes(action)&&parts.length>1) throw Error('Use /mission new [objective], list, status [id], or cancel [id].');
            active=new AbortController();
            const receipt=await local.request(home,'/api/assistant/mission',{action,request_id:randomUUID(),...(action==='new'?{workspace:fs.realpathSync(process.cwd()),objective:parts.join(' '),model,worker}:['status','cancel','run'].includes(action)&& (parts[0]||lastMission)?{mission_id:parts[0]||lastMission}: {})});
            await handleReceipt(receipt);active=null;
          }
        }
        else if (command === 'accept') {
          if (!lastMission) throw Error('No Mission is selected.');
          const r = await local.request(home, '/api/interactive/task?mission_id=' + encodeURIComponent(lastMission));
          await local.request(home, '/api/control-v2/accept-mission', { id: lastMission, request_id: randomUUID(), verification_id: r.verification_id, decision: 'accept', rationale: 'Authenticated local operator reviewed the result.', evidence: arg || 'Operator reviewed the conversation response.' }); output.write('Accepted and settled locally.\n');
        } else if (command) throw Error('Unknown command. Use /help.');
        else {
          if(!output.isTTY)output.write(`\n${userName||'You'} › `+terminalText(value)+'\n');
          active = new AbortController();
          startAnswer();
          const created = await local.request(home, '/api/assistant/input', { message:value,request_id:randomUUID(),include_memory:true,model,worker,conversation_id:await session(),workspace:fs.realpathSync(process.cwd()) });
          await handleReceipt(created,false,value);active=null;
        }
      } catch (error) { stopAnswer();active = null; output.write('Airo: ' + terminalText(require('./secret-observation').safeValue(error.message)) + '\n'); }
      readerLocked=false;
      await refreshName();
      showPrompt();
    }
  } finally { indicator?.stop();process.removeListener('SIGINT', interrupt); await detachReader(); }
  output.write('Local service remains available. Use airodrom stop to stop it.\n');
}
async function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args, home = local.localHome();
  if (!command) return interactive(home);
  if (['help', '--help', '-h'].includes(command)) { process.stdout.write(help()); return; }
  if (command === 'menu') { const app = require('../scripts/macos/prepare-local-menu.cjs').prepare(home); const r = require('node:child_process').spawnSync('/usr/bin/open',[app],{stdio:'ignore',timeout:5000}); if(r.status!==0) throw Error('Native menu could not open.'); process.stdout.write('Airodrom menu opened. Service lifecycle is separate.\n'); return; }
  if (command === 'doctor') { show(process.stdout,await require('./product-diagnostics').doctor(home),require('./product-diagnostics').summary,rest.includes('--json')); return; }
  if (command === 'requalify') { await local.requalify(home); process.stdout.write('OpenCode requalified. Run airodrom start.\n'); return; }
  if(command==='gmail'&&rest[0]==='setup'){if(rest.length!==2||!rest[1].endsWith('.apps.googleusercontent.com'))throw Error('Use airodrom gmail setup <Google desktop client ID>');local.privateDirectory(home,true);const data=local.privateDirectory(path.join(home,'data'),true),file=path.join(data,'gmail-oauth-config.json');if(fs.existsSync(file))throw Error('Existing Gmail config preserved. Configure through an explicitly reviewed change.');local.writePrivate(file,{clientId:rest[1]});process.stdout.write('Owner OAuth client configured. Prepare the Keychain helper, restart Airodrom, then /connect gmail. No account connected.\n');return;}
  if(command==='secret'){return require('./vault-cli').run(home,rest,process.stdin,process.stdout);}
  if (command === '--version') { process.stdout.write(branding.name + ' ' + require('../package.json').version + '\n'); return; }
  if (command === 'status') { if(local.isStopped(home))show(process.stdout,{state:'stopped'},()=> 'Airodrom is stopped. Run airodrom to start.',rest.includes('--json'));else show(process.stdout,await local.status(home),rows,rest.includes('--json')); return; }
  if (command === 'stop') { await local.stop(home); process.stdout.write('Airodrom stopped. Personal Memory is preserved.\n'); return; }
  if (command === 'restart') { await local.stop(home); process.stdout.write(rows(await local.start(home))); return; }
  if (!['start', 'open', 'memory', 'task'].includes(command) || ['start', 'open'].includes(command) && rest.length) throw Error('Unknown command. Use airodrom --help.');
  const s = await local.start(home);
  if (command === 'start') process.stdout.write(rows(s));
  else if (command === 'open') { local.open(home); process.stdout.write('Control Center opened.\n'); }
  else if (command === 'memory') await memory(home, rest.filter(x=>x!=='--json').join(' '), process.stdout,rest.includes('--json'));
  else process.stdout.write('Scoped Mission dispatched: ' + await scopedTask(home, rest[0]) + '\n');
}
if (require.main === module) main().catch(error => { console.error('Airodrom: ' + terminalText(require('./secret-observation').safeValue(error.message))); process.exitCode = error.message === 'Unknown command. Use airodrom --help.' ? 2 : 1; });
module.exports = { parseLine, intro, rows, help, terminalText, memory, scopedTask, waitResult, waitConversation, missionReceipt, interactive, main };
