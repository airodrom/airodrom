'use strict';
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const local = require('./local-bootstrap');
const branding = require('./branding');
const terminalText = value => require('node:util').stripVTControlCharacters(String(value)).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
const COMMANDS = '/about · /version · /models · /model auto|local|<id> · /workers · /worker auto|<id>\n/connectors · /connect gmail · /gmail status|unread|recent|search|read|thread · /whatsapp status|search · /remember-sensitive · /sensitive · /vault · /secret\n/remember <text> · /memory [query] · /forget <id or subject>\n/status · /doctor · /runtime [opencode] · /open · /task <mission.json> · /accept · /help · /quit';
const intro = require('./terminal-brand').intro;
function rows(s) {
  const p=s.product, runtime=p?.runtime|| (s.opencode.ready?'Ready':s.opencode.reason==='opencode_runtime_pins_changed'?'Degraded':'Unavailable');
  return `OpenCode   ${runtime==='Ready'?'● Ready · Primary':runtime+' · '+(p?.runtimeReason||s.opencode.reason)}\nMemory V2  ${p?.memory||'Unavailable'} · Local\nControl    ${p?.control|| (s.healthy?'Ready':'Unavailable')} · Local\nProvider   ${p?.provider||'Unavailable'}\nModel      ${p?.model||'Unavailable'} · Local · ${p?.routing||'AUTO'}\nContext    Limit / usage / tokens / cost: Unavailable\nMissions   ${p?.active_missions??'Unavailable'} active · ${p?.approvals??'Unavailable'} approvals waiting\nPrivacy    Prompts, reasoning and credentials stay private\n`;
}
function help() { return `${branding.name} — ${branding.tagline}\n\nUsage: airodrom [command]\n\n  (no command) Interactive terminal\n  menu         Open the native macOS menu helper\n  help         Show full command guidance\n  doctor       Inspect safe readiness and pin categories\n  requalify    Fresh confined qualification while stopped\n  status       Inspect the local service\n  start        Start or attach to the local service\n  stop         Gracefully stop the owned local service\n  restart      Stop and start the owned local service\n  open         Open the optional Control Center\n  memory       List/search Personal Memory V2\n  task <file>  Register and dispatch a scoped Mission JSON\n  mcp          Existing MCP stdio transport\n  --version    Show version\n\n${COMMANDS}\n\n${branding.website}\n`; }
async function waitResult(home, id, { signal } = {}) {
  const deadline = Date.now() + 130000;
  while (Date.now() < deadline) {
    if (signal?.aborted) { await local.request(home, '/api/interactive/cancel', { mission_id: id, request_id: randomUUID() }); throw Error('Task cancelled.'); }
    const r = await local.request(home, '/api/interactive/task?mission_id=' + encodeURIComponent(id));
    if (['awaiting_acceptance', 'completed'].includes(r.state)) return r;
    if (['blocked', 'needs_rework', 'cancelled'].includes(r.state)) throw Error(r.reason || 'Mission stopped; inspect its status.');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await local.request(home, '/api/interactive/cancel', { mission_id: id, request_id: randomUUID() });
  throw Error('Bounded task timed out and cancellation was requested.');
}
async function memory(home, query, output) {
  const data = await local.request(home, '/api/interactive/memory' + (query ? '?query=' + encodeURIComponent(query) : ''));
  if (!data.items.length) output.write('No current memories found.\n');
  else for (const item of data.items) output.write(terminalText(`${item.memoryId}  ${item.content}\n`));
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
  output.write(intro({ mode: require('./terminal-brand').colorMode({tty:!!output.isTTY,env}), unicode: env.TERM !== 'dumb', columns:output.columns||80, rows:output.rows||40 }));
  const s = await local.start(home, env); output.write(rows(s));
  output.write('\nType a question, or /help for commands. Each question gets a fresh bounded Mission.\n');
  const rl = readline.createInterface({ input, output, terminal: !!input.isTTY && !!output.isTTY });
  let model='auto',worker='auto',runtime = s.default_runtime, lastMission = null, active = null, quitting = false;
  const interrupt = () => { if (active) active.abort(); else { quitting = true; rl.close(); } };
  rl.on('SIGINT', interrupt); process.on('SIGINT', interrupt);
  try {
    if (output.isTTY) output.write('\nYou › ');
    for await (const line of rl) {
      if (quitting) break;
      const raw=line.trim(),value=['--version','--help','-h'].includes(raw)?({'--version':'/version','--help':'/help','-h':'/help'}[raw]):raw; if (!value) { if (output.isTTY) output.write('You › '); continue; }
      try {
        const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(value), command = match?.[1], arg = match?.[2]?.trim() || '';
        if (command === 'quit') {if(arg)throw Error('Submit /quit on its own.');break;}
        if (command === 'help') output.write(help());
        else if (command === 'about'||command==='version') output.write(branding.name+' '+require('../package.json').version+' · PRE-RELEASE\n');
        else if (command==='mcp') output.write('MCP is a shell transport: run airodrom mcp from a separate terminal. submit_mission/get_mission_handoff/cancel_mission_handoff use canonical Airodrom authority.\n');
        else if (['models','workers','model','worker'].includes(command)) {
          const registry=await local.request(home,'/api/assistant/registry');
          if(command==='model'&&arg){if(!['auto','local'].includes(arg)&&!registry.models.some(m=>m.id===arg))throw Error('Unknown registered model');model=arg;}
          if(command==='worker'&&arg){if(arg!=='auto'&&!registry.workers.some(w=>w.id===arg))throw Error('Unknown registered worker');worker=arg;}
          output.write('Selection: '+(command.startsWith('model')?model:worker)+'\n'+terminalText(JSON.stringify(command.startsWith('model')?registry.models:registry.workers,null,2))+'\n');
        }
        else if(command==='connectors')output.write(terminalText(JSON.stringify(await local.request(home,'/api/assistant/connectors'),null,2))+'\n');
        else if(command==='connect') {if(!['gmail','whatsapp'].includes(arg))throw Error('Use /connect gmail or /connect whatsapp');const result=await local.request(home,'/api/assistant/connect',{connector:arg});if(result.authorization_url){const r=require('node:child_process').spawnSync('/usr/bin/open',[result.authorization_url],{stdio:'ignore',timeout:5000});if(r.status!==0)throw Error('OAuth browser could not open.');output.write('Read-only Gmail OAuth opened. Complete the operator authorization in your browser.\n');}else output.write(terminalText(result.message)+'\n');}
        else if(command==='gmail'||command==='whatsapp') {
          const [actionArg='status',...parts]=arg.split(/\s+/),action=actionArg==='draft-reply'?'draft_reply':actionArg,query=parts.join(' '),selected=['read','thread','summarize','draft_reply'].includes(action);
          const receipt=await local.request(home,'/api/assistant/connector',{connector:command,action,input:query?{[selected?'id':action==='draft'?'body':'query']:query}:{}});if(receipt.kind==='conversation'){lastMission=receipt.mission_id;active=new AbortController();const result=await waitResult(home,lastMission,{signal:active.signal});output.write(terminalText(result.summary)+'\n[Review: /accept · No message sent]\n');active=null;}else output.write(terminalText(JSON.stringify(receipt,null,2))+'\n');
        }
        else if(command==='remember-sensitive'){const item=await local.request(home,'/api/assistant/sensitive',{content:arg});output.write('Sensitive Memory saved; operator-only ID '+item.memoryId+'\n');}
        else if(command==='sensitive'){const parts=arg.split(/\s+/);if(parts[0]==='correct'){const r=await local.request(home,'/api/assistant/sensitive',{id:parts[1],content:parts.slice(2).join(' ')});output.write('Corrected sensitive ID '+r.memoryId+'\n');continue;}output.write(terminalText(JSON.stringify(await local.request(home,parts[0]==='reveal'?'/api/assistant/reveal-sensitive':'/api/assistant/sensitive',parts[0]==='reveal'?{id:parts[1]}:undefined),null,2))+'\n');}
        else if(command==='vault'||command==='secret')output.write(terminalText(JSON.stringify(new (require('./secret-vault').SecretVault)(require('./local-bootstrap').privateDirectory(path.join(home,'data'),true)).status()))+'\nUse airodrom secret put from the shell for hidden secure input. /secret never takes values.\n');
        else if (command === 'doctor') output.write(require('./product-diagnostics').summary(await require('./product-diagnostics').doctor(home)));
        else if (command === 'status') output.write(rows(await local.status(home)));
        else if (command === 'runtime') { if (arg) runtime = require('./default-runtime').defaultRuntime(arg); output.write('Runtime for fresh tasks: ' + runtime + '\n'); }
        else if (command === 'open') { local.open(home); output.write('Control Center opened.\n'); }
        else if (command === 'memory') await memory(home, arg, output);
        else if (command === 'remember') { const item = await local.request(home, '/api/interactive/remember', { content: arg }); output.write('Remembered ' + item.memoryId + '\n'); }
        else if (command === 'forget') { const r = await local.request(home, '/api/interactive/forget', { selection: arg }); output.write('Forgot ' + r.memoryId + '\n'); }
        else if (command === 'task') { lastMission = await scopedTask(home, arg,{model,worker}); output.write('Scoped Mission dispatched: ' + lastMission + '\n'); }
        else if (command === 'accept') {
          if (!lastMission) throw Error('No Mission is selected.');
          const r = await local.request(home, '/api/interactive/task?mission_id=' + encodeURIComponent(lastMission));
          await local.request(home, '/api/control-v2/accept-mission', { id: lastMission, request_id: randomUUID(), verification_id: r.verification_id, decision: 'accept', rationale: 'Authenticated local operator reviewed the result.', evidence: arg || 'Operator reviewed the conversation response.' }); output.write('Accepted and settled locally.\n');
        } else if (command) throw Error('Unknown command. Use /help.');
        else {
          active = new AbortController();
          const created = await local.request(home, '/api/assistant/input', { message:value,request_id:randomUUID(),include_memory:true,model,worker });
          if(created.kind!=='conversation'){output.write(terminalText(created.message||JSON.stringify(created.items||created))+'\n');active=null;}
          else {
            lastMission=created.mission_id;
            output.write('Airodrom · '+created.route.mode+' · '+created.route.model+' · local\n');
            const r=await waitResult(home,lastMission,{signal:active.signal});
            output.write(terminalText(r.summary)+'\n');
            output.write('[Response ready · Verification: host boundary checked · Review: /accept · Settlement: pending]\n');active=null;
          }
        }
      } catch (error) { active = null; output.write('Airodrom: ' + terminalText(require('./secret-observation').safeValue(error.message)) + '\n'); }
      if (output.isTTY) output.write('\nYou › ');
    }
  } finally { process.removeListener('SIGINT', interrupt); rl.close(); }
  output.write('Local service remains available. Use airodrom stop to stop it.\n');
}
async function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args, home = local.localHome();
  if (!command) return interactive(home);
  if (['help', '--help', '-h'].includes(command)) { process.stdout.write(help()); return; }
  if (command === 'menu') { const app = require('../scripts/macos/prepare-local-menu.cjs').prepare(home); const r = require('node:child_process').spawnSync('/usr/bin/open',[app],{stdio:'ignore',timeout:5000}); if(r.status!==0) throw Error('Native menu could not open.'); process.stdout.write('Airodrom menu opened. Service lifecycle is separate.\n'); return; }
  if (command === 'doctor') { process.stdout.write(require('./product-diagnostics').summary(await require('./product-diagnostics').doctor(home))); return; }
  if (command === 'requalify') { await local.requalify(home); process.stdout.write('OpenCode requalified. Run airodrom start.\n'); return; }
  if(command==='gmail'&&rest[0]==='setup'){if(rest.length!==2||!rest[1].endsWith('.apps.googleusercontent.com'))throw Error('Use airodrom gmail setup <Google desktop client ID>');local.privateDirectory(home,true);const data=local.privateDirectory(path.join(home,'data'),true),file=path.join(data,'gmail-oauth-config.json');if(fs.existsSync(file))throw Error('Existing Gmail config preserved. Configure through an explicitly reviewed change.');local.writePrivate(file,{clientId:rest[1]});process.stdout.write('Owner OAuth client configured. Prepare the Keychain helper, restart Airodrom, then /connect gmail. No account connected.\n');return;}
  if(command==='secret'){return require('./vault-cli').run(home,rest,process.stdin,process.stdout);}
  if (command === '--version') { process.stdout.write(branding.name + ' ' + require('../package.json').version + '\n'); return; }
  if (command === 'status') { process.stdout.write(local.isStopped(home) ? 'Airodrom is stopped. Run airodrom to start.\n' : rows(await local.status(home))); return; }
  if (command === 'stop') { await local.stop(home); process.stdout.write('Airodrom stopped. Personal Memory is preserved.\n'); return; }
  if (command === 'restart') { await local.stop(home); process.stdout.write(rows(await local.start(home))); return; }
  if (!['start', 'open', 'memory', 'task'].includes(command) || ['start', 'open'].includes(command) && rest.length) throw Error('Unknown command. Use airodrom --help.');
  const s = await local.start(home);
  if (command === 'start') process.stdout.write(rows(s));
  else if (command === 'open') { local.open(home); process.stdout.write('Control Center opened.\n'); }
  else if (command === 'memory') await memory(home, rest.join(' '), process.stdout);
  else process.stdout.write('Scoped Mission dispatched: ' + await scopedTask(home, rest[0]) + '\n');
}
if (require.main === module) main().catch(error => { console.error('Airodrom: ' + terminalText(require('./secret-observation').safeValue(error.message))); process.exitCode = error.message === 'Unknown command. Use airodrom --help.' ? 2 : 1; });
module.exports = { intro, rows, help, terminalText, memory, scopedTask, waitResult, interactive, main };
