'use strict';
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PassThrough } = require('node:stream');
const local = require('./local-bootstrap');
const branding = require('./branding');
const render = require('./assistant-render');
const READ_COMMANDS = new Set(['models','workers','connectors','status','details','doctor','compat','compatibility','memory','runtime','sensitive','vault','secret','gmail','whatsapp','research','autopilot','gcp']);
function formatAutopilot(s) {
  const on = s.enabled === true;
  const lines = [
    'Autopilot  ' + (on ? '● ON · owner delegation active' : '○ OFF · governed defaults'),
    s.note || '',
    'Projects   ' + ((s.projects || []).length) + ' registered with repositories',
    'Stops      ' + (s.stop_count || 0),
  ];
  if (s.cancelled_missions != null) lines.push('Cancelled  ' + s.cancelled_missions + ' Autopilot Missions');
  return lines.filter(Boolean).join('\n');
}
async function autopilotControl(home, action) {
  if (action === 'status') return local.request(home, '/api/assistant/autopilot');
  if (action === 'on') return local.request(home, '/api/assistant/autopilot/enable', { confirmed: true, request_id: randomUUID() });
  if (action === 'off') return local.request(home, '/api/assistant/autopilot/disable', { confirmed: true, request_id: randomUUID() });
  if (action === 'stop') return local.request(home, '/api/assistant/autopilot/stop', { confirmed: true, request_id: randomUUID() });
  throw Error('Use /autopilot on|off|status|stop.');
}
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
const COMMANDS = '/name <name> · /about · /version · /models · /model auto|local|<id> · /workers [status|qualify <id> <model> --confirm-public-fixture|revoke <id>] · /worker auto|<id>\n/connectors · /connect gmail [send|manage|retry-open|show-local|fresh] · /connect calendar [manage|fresh] · /connect whatsapp · /gmail status|unread|recent|search|read|thread|approve|confirm · /whatsapp bind|status|discover|rotate-verify-token|commit-verify-token|rollback-verify-token|prepare-callback|search · /gcp help|status|list|enroll project <id> <number>|unenroll project <id>|tf-state preview somin|confirm <preview-id> [--ack-uncertain] · /remember-sensitive · /sensitive · /vault · /secret\n/remember <text> · /memory [query] · /forget <id or subject>\n/mission new [objective] · /mission list · /mission status [id] · /mission cancel [id] · /mission run [id] · /mission web on|off|all|status|revoke [id] [URLs] · /browser options|sessions|status|permissions|diagnostics|revoke|close [id] · /browser open <HTTPS URL> · /research search <query> · /research explore <URLs> · /research login <HTTPS URL> · /research account <HTTPS login URL> · /research report [mission-id] [--json]\n/autopilot on|off|status|stop · /logs [follow] [mission-id] · /status · /details · /doctor · /compat · /runtime [opencode] · /open · /task <mission.json> · /accept · /help · /quit';
const terminalBrand = require('./terminal-brand'), intro = terminalBrand.intro;
// Operator-local only: last Gmail authorization URL for LaunchServices retry / local show.
// Never written to Mission evidence, telemetry, or ChatGPT surfaces.
let pendingGmailAuthorization = null;

function clearPendingGmailAuthorization() { pendingGmailAuthorization = null; }

function rememberGmailAuthorization(result) {
  if (!result || typeof result.authorization_url !== 'string') {
    clearPendingGmailAuthorization();
    return null;
  }
  // Fail closed before retaining anything that is not the pinned Google auth host.
  try { require('./oauth-browser-launch').assertAuthorizationUrl(result.authorization_url); }
  catch {
    clearPendingGmailAuthorization();
    throw Error('Authorization URL host is not permitted. Pending Gmail authorization was not retained.');
  }
  pendingGmailAuthorization = {
    authorization_url: result.authorization_url,
    expires_at: Number(result.expires_at) || (Date.now() + 300000),
    read_only: result.read_only !== false,
    reused: result.reused === true,
  };
  return pendingGmailAuthorization;
}

function requirePendingGmailAuthorization({ forLocalReveal = false } = {}) {
  if (!pendingGmailAuthorization?.authorization_url) {
    throw Error('No pending Gmail authorization in this Terminal session. Run /connect gmail first.');
  }
  if (pendingGmailAuthorization.expires_at && pendingGmailAuthorization.expires_at < Date.now()) {
    clearPendingGmailAuthorization();
    throw Error('OAuth callback expired or the pending authorization timed out. Run /connect gmail to start a fresh read-only consent.');
  }
  require('./oauth-browser-launch').assertAuthorizationUrl(pendingGmailAuthorization.authorization_url);
  if (forLocalReveal) {
    const outIsTty = !!(process.stdout.isTTY || process.stderr.isTTY);
    const inIsTty = !!process.stdin.isTTY;
    if (!outIsTty || !inIsTty) {
      throw Error('show-local requires an interactive local Terminal TTY. Authorization URLs are not printed to redirected or non-interactive output.');
    }
  }
  return pendingGmailAuthorization;
}

async function openGmailAuthorization(output, authorizationUrl, { launch = null } = {}) {
  const browser = require('./oauth-browser-launch');
  const launchFn = launch || browser.launchAuthorizationUrl;
  const opened = await launchFn(authorizationUrl);
  if (opened.ok) {
    output.write(terminalText(opened.message) + '\n');
    output.write('Read-only Gmail scope only. Airodrom reports connected only after Google consent and the localhost callback succeed.\n');
    return opened;
  }
  const err = Error(browser.recoveryMessage(opened));
  err.code = opened.code || 'oauth_browser_launch_failed';
  err.oauth_browser = { code: opened.code, status: opened.status ?? null, signal: opened.signal ?? null };
  throw err;
}
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
function help() { return `${branding.name} — ${branding.tagline}\n\nSHELL COMMANDS · run in Terminal\nUsage: airodrom [command]\n\n  (no command) / chat   Attach to the managed service and open conversation\n  status                Show live service health (client; never starts a supervisor)\n  autopilot on|off|status|stop\n                        Global Autopilot owner controls (defaults OFF; emergency STOP)\n  doctor                Safe readiness, pins, and CLI install alignment\n  help                  Show this guidance\n  open                  Open Control Center through private discovery\n  logs follow           Stream host-observed Live Activity events (redacted)\n  memory [query]        List/search Personal Memory V2\n  service start         Start the managed local service when stopped\n  service stop          Gracefully stop the owned local service\n  service restart       Stop then start the owned local service\n  service status        Same as airodrom status\n  start|stop|restart    Legacy aliases for service start|stop|restart\n  menu                  Open the native macOS menu helper\n  requalify             Fresh confined qualification while stopped\n  browser options       Show browser connection availability\n  task <file>           Register and dispatch a scoped Mission JSON\n  whatsapp              bind | status | discover | use-test | rotate-verify-token | commit-verify-token | rollback-verify-token | prepare-callback <https://host/webhooks/whatsapp>\n  secret                prepare | put [operator|gmail|whatsapp] | forget <ref> | status\n  mcp                   Existing MCP stdio transport\n  --version             Show version\n\nClient commands discover the existing managed service and never launch a second supervisor.\nUse airodrom service start only when the service is stopped.\n\nINTERACTIVE COMMANDS · type inside Airodrom\n${COMMANDS}\n\nWhatsApp credentials use hidden Terminal input only (airodrom whatsapp bind). Public ingress stays OFF.\nRead-only commands accept --json for developer output.\n/mcp explains the separate shell transport.\n\n${branding.website}\n`; }
async function waitResult(home, id, { signal, onProgress, timeoutMs=130000 } = {}) {
  const deadline = Date.now() + timeoutMs; let lastState=null;
  while (Date.now() < deadline) {
    if (signal?.aborted) { await local.request(home, '/api/interactive/cancel', { mission_id: id, request_id: randomUUID() }); throw Error('Task cancelled. The CLI is still open.'); }
    const r = await local.request(home, '/api/interactive/task?mission_id=' + encodeURIComponent(id));
    if(r.state!==lastState){lastState=r.state;onProgress?.(r);}
    if (['awaiting_acceptance', 'completed'].includes(r.state)) return r;
    if(r.state==='waiting_for_operator')return r;
    if (['blocked', 'needs_rework', 'cancelled'].includes(r.state)) throw Error(r.reason || 'Mission stopped; inspect its status. The CLI is still open.');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await local.request(home, '/api/interactive/cancel', { mission_id: id, request_id: randomUUID() });
  throw Error('Bounded task timed out and cancellation was requested. Check /mission status; the CLI is still open.');
}
function isTransportTimeout(error) {
  return error?.name === 'TimeoutError' || /aborted due to timeout|timed out|TimeoutError/i.test(String(error?.message || error || ''));
}
async function waitConversation(home, turn, { signal, onProgress, timeoutMs = 130000 } = {}) {
  const identity = { conversation_id: turn.conversation_id, turn_id: turn.turn_id };
  if (!identity.conversation_id || !identity.turn_id) throw Error('Conversation receipt is unavailable.');
  const cancel = () => local.request(home, '/api/assistant/conversation/cancel', identity);
  const deadline = Date.now() + Math.max(1000, timeoutMs);
  const cancelled = 'Conversation cancelled. The CLI is still open.';
  const timedOut = 'Conversation timed out while waiting for the local model. Check /status and retry; the CLI is still open.';
  let lastActivity = null;
  while (Date.now() < deadline) {
    if (signal?.aborted) { await cancel(); throw Error(cancelled); }
    let result;
    try {
      result = await local.request(home, '/api/assistant/conversation?conversation_id=' + encodeURIComponent(identity.conversation_id) + '&turn_id=' + encodeURIComponent(identity.turn_id), undefined, { timeoutMs: 10000, signal });
    } catch (error) {
      if (signal?.aborted) { await cancel(); throw Error(cancelled); }
      // Transient poll transport loss must not cancel a healthy in-flight turn.
      if (isTransportTimeout(error) || /ECONNRESET|fetch failed|network/i.test(String(error?.message || error || ''))) {
        await new Promise(resolve => setTimeout(resolve, 200));
        continue;
      }
      await cancel().catch(() => {});
      throw error;
    }
    if (signal?.aborted) { await cancel(); throw Error(cancelled); }
    if (result.activity && result.activity !== lastActivity) { lastActivity = result.activity; onProgress?.(result); }
    if (result.state === 'completed') return result;
    if (['failed', 'cancelled'].includes(result.state)) throw Error(result.reason || 'Conversation stopped. The CLI is still open.');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await cancel();
  throw Error(timedOut);
}
async function admitConversation(home, body, { signal, timeoutMs = 15000 } = {}) {
  const request_id = body.request_id || randomUUID();
  const payload = { ...body, request_id };
  try {
    // Admission uses its own budget. Operator cancel (signal) still aborts the HTTP
    // attempt, but a pure admission timeout reconnects instead of killing inference.
    return await local.request(home, '/api/assistant/input', payload, { timeoutMs, signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (!isTransportTimeout(error)) throw error;
    if (payload.conversation_id) {
      const active = await local.request(home, '/api/assistant/conversation?conversation_id=' + encodeURIComponent(payload.conversation_id) + '&active=1', undefined, { timeoutMs: 5000, signal }).catch(() => null);
      if (active?.kind === 'chat' && active.state === 'running' && active.turn_id) return active;
    }
    // Durable request identity recovers a turn admitted after the socket closed.
    try {
      return await local.request(home, '/api/assistant/input', payload, { timeoutMs: 10000, signal });
    } catch {
      throw error;
    }
  }
}
function secureIngressLine(line) {
  const value = String(line || '').trim();
  if (!value) return false;
  if (/^\/(?:vault|secret|quit|exit|help|status|mission|connect|remember|forget|provider|workspace|task|google|gmail|calendar|drive|browser|research)\b/i.test(value)) return true;
  try {
    if (require('./assistant-intent').secret(value)) return true;
    // ADR 0015/0017: browser consent owns a detached input reader. Discard
    // trailing paste before opening it, just as for the private-storage guides.
    // Oversized ordinary paste must still preview and wait for Enter; its
    // validation error must not turn it into an automatically submitted line.
    if (Buffer.byteLength(value) <= 4000 && !value.includes('\0')) {
      const parsed = require('./assistant-intent').parse(value);
      if (parsed.kind === 'research_session' || parsed.pending_research === 'session') return true;
    }
    if (require('./private-vault-intent').parse(value) || require('./private-vault-intent').containsPrivate(value)) return true;
    if (require('./personal-storage-intent').containsPrivate(value) || require('./personal-storage-intent').parse(require('./personal-storage-intent').normalize(value))) return true;
  } catch { return true; }
  return false;
}
/** Strip pasted CSI/OSC and other C0 controls; keep newlines and tabs for ordinary chat. */
function sanitizePaste(text) {
  return String(text || '')
    .replace(/\r\n|\r/g, '\n')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b./g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}
function pastePreview(text, { maxLines = 6, maxChars = 480 } = {}) {
  const lines = String(text || '').split('\n');
  const shown = [];
  let used = 0;
  for (let i = 0; i < lines.length && shown.length < maxLines && used < maxChars; i++) {
    let line = lines[i];
    const room = maxChars - used;
    if (line.length > room) line = line.slice(0, Math.max(0, room - 1)) + '…';
    shown.push(line);
    used += line.length + 1;
  }
  const omitted = lines.length - shown.length;
  const head = `Paste · ${lines.length} line${lines.length === 1 ? '' : 's'} · Enter to send · Ctrl+C to cancel\n`;
  return head + shown.join('\n') + (omitted > 0 ? `\n… ${omitted} more line${omitted === 1 ? '' : 's'}` : '') + '\n';
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
  // Client-first: attach to the managed service. Never spawn a second supervisor.
  const s = await local.attach(home);
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
  let pendingPaste = null, pasteBuffer = null;
  let assistantNickname=s.nickname,model='auto',worker='auto',runtime = s.default_runtime, lastMission = null, conversationId = null, active = null, indicator = null, quitting = false;
  const interrupt = () => {
    if (active) { active.abort(); return; }
    // Staged ordinary paste cancels without quitting the conversation.
    if (pendingPaste !== null) {
      pendingPaste = null;
      try { output.write('^C\n'); } catch { /* ignore */ }
      showPrompt();
      return;
    }
    quitting = true;
    rl?.close();
  };
  // Secure Vault/private first lines still fail closed: admit only the first
  // line with no echo of trailing paste. Ordinary paste never auto-submits.
  const admitSecureLine = text => {
    pendingPaste = text;
    readerLocked = true;
    readerInput.write(Buffer.from('\n'));
  };
  const stageOrdinaryPaste = pasted => {
    const clean = sanitizePaste(pasted).replace(/\n+$/, '');
    if (!clean.trim()) return;
    const lines = clean.split('\n');
    if (lines.length === 1) {
      // Visible + editable in the normal readline buffer; wait for real Enter.
      pendingPaste = null;
      readerInput.write(Buffer.from(clean, 'utf8'));
      return;
    }
    // Multiline: readable preview, exact content staged, wait for Enter.
    pendingPaste = clean;
    try { output.write(pastePreview(clean)); } catch { /* ignore */ }
    showPrompt();
  };
  const acceptPaste = pasted => {
    const clean = sanitizePaste(pasted).replace(/\n+$/, '');
    if (!clean.trim()) return;
    if (secureIngressLine(clean.split('\n')[0])) {
      admitSecureLine(clean.split('\n')[0]);
      return;
    }
    stageOrdinaryPaste(clean);
  };
  const attachReader = () => {
    const previous = new Set(input.listeners('data'));
    readerLocked = false;
    pendingPaste = null;
    pasteBuffer = null;
    if (input.isTTY && output.isTTY) {
      // Bracketed paste keeps ordinary multiline chat intact. Vault/secret first
      // lines still fail closed: only the first line is admitted and the rest is dropped.
      readerInput = new PassThrough();
      readerInput.isTTY = true;
      readerInput.setRawMode = enabled => input.setRawMode(enabled);
      Object.defineProperty(readerInput, 'isRaw', { get: () => input.isRaw });
      try { output.write('\x1b[?2004h'); } catch { /* non-capable terminals ignore */ }
      const forward = chunk => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (readerLocked) { if (bytes.includes(3)) interrupt(); return; }
        const body = bytes.toString('utf8');
        if (pasteBuffer !== null) {
          pasteBuffer += body;
          const end = pasteBuffer.indexOf('\x1b[201~');
          if (end < 0) return;
          const pasted = pasteBuffer.slice(0, end);
          pasteBuffer = null;
          acceptPaste(pasted);
          return;
        }
        const start = body.indexOf('\x1b[200~');
        if (start >= 0) {
          const before = body.slice(0, start);
          if (before) forward(Buffer.from(before, 'utf8'));
          pasteBuffer = body.slice(start + 6);
          if (pasteBuffer.includes('\x1b[201~')) forward(Buffer.alloc(0));
          return;
        }
        if (!/[\r\n]/.test(body)) { readerInput.write(bytes); return; }
        const parts = body.replace(/\r\n|\r/g, '\n').replace(/\n$/,'').split('\n');
        if (parts.length > 1) {
          acceptPaste(parts.join('\n'));
          return;
        }
        readerLocked = true;
        readerInput.write(Buffer.from(parts[0] + '\n', 'utf8'));
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
    pendingPaste = null; pasteBuffer = null;
    reader?.pause();
    if (reader) { reader.line = ''; reader.removeListener('SIGINT', interrupt); reader.close(); }
    for (const listener of readerDataListeners) input.removeListener('data', listener);
    readerDataListeners = [];
    if (readerEndListener) input.removeListener('end', readerEndListener);
    readerEndListener = null;
    await iterator?.return?.();
    if (readerInput !== input) readerInput.destroy();
    input.pause();
    try { if (input.isTTY && output.isTTY) output.write('\x1b[?2004l'); } catch { /* ignore */ }
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
  const ensureActive=()=>{
    if(!active) active=new AbortController();
    return active;
  };
  const startAnswer=()=>{
    const controller=ensureActive();
    output.write('\nAiro\n');
    indicator=render.waiting(output,{env,signal:controller.signal});
  };
  const stopAnswer=()=>{indicator?.stop();indicator=null;};
  const answer=async (id,options={})=>{
    if(!indicator)startAnswer();
    const controller=ensureActive();
    try { return await waitResult(home,id,{signal:controller.signal,...options}); }
    finally { stopAnswer(); }
  };
  const handleReceipt = async (receipt, json = false, message = null) => {
    if (receipt.kind === 'preference') assistantNickname=receipt.nickname;
    if(receipt.kind==='public_web_offer'){stopAnswer();await detachReader();let next;try{next=await require('./mission-web-guide').guide({offer:receipt,input,output,home,signal:active?.signal});}finally{await attachReader();}await handleReceipt(next,json,message);return;}
    if(receipt.kind==='zero_setup'){stopAnswer();await detachReader();try{const done=await require('./zero-setup-terminal').guide({receipt,input,output,home,signal:active?.signal});if(done?.technical?.mission_id)lastMission=done.technical.mission_id;if(json)show(output,done,()=>'',true);}finally{await attachReader();}return;}
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
    // Reconnect observes the same durable zero-setup request; never creates a duplicate Mission.
    if (require('./zero-setup-terminal').readActive(home) && input.isTTY && output.isTTY) {
      active = new AbortController();
      await detachReader();
      try {
        const resumed = await require('./zero-setup-terminal').resumeActive(home, { input, output, signal: active.signal });
        if (resumed?.technical?.mission_id) lastMission = resumed.technical.mission_id;
      } finally {
        active = null;
        if (!quitting && !input.readableEnded) { while (input.read() !== null) {} attachReader(); }
      }
    }
    showPrompt();
    while (lines) {
      const next = await lines.next();
      if (next.done) break;
      const line = pendingPaste !== null ? pendingPaste : next.value;
      pendingPaste = null;
      if (quitting) break;
      const {value:rawValue,command,arg,json}=parseLine(line);
      // Preserve newlines from ordinary multiline paste; collapse only horizontal whitespace.
      const value=String(rawValue||'').replace(/[\u200B-\u200D\uFEFF]/g,'').replace(/[^\S\n]+/g,' ').replace(/ ?\n ?/g,'\n').trim();
      if (!value) { nameOffered=false;await refreshName();readerLocked=false;showPrompt(); continue; }
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
        if(['help','about','version','mcp','status','details','doctor','compat','compatibility','connectors'].includes(command)&&arg)throw Error('Submit this command on its own, or use --json for read-only details.');
        if (command === 'quit') {if(arg)throw Error('Submit /quit on its own.');break;}
        if (command === 'help') output.write(help());
        else if (command === 'about'||command==='version') output.write(branding.name+' '+require('../package.json').version+' · PRE-RELEASE\n');
        else if (command==='mcp') output.write('MCP is a shell transport: run airodrom mcp from a separate terminal. submit_mission/get_mission_handoff/cancel_mission_handoff use canonical Airodrom authority.\n');
        else if (command === 'autopilot') {
          const action = (arg || 'status').trim().split(/\s+/)[0] || 'status';
          if (!['on', 'off', 'status', 'stop'].includes(action)) throw Error('Use /autopilot on|off|status|stop.');
          show(output, await autopilotControl(home, action), formatAutopilot, json);
        }
        else if (['models','workers','model','worker'].includes(command)) {
          if(command==='workers'&&arg&&arg!=='status'){
            const parts=arg.split(/\s+/),action=parts.shift(),id=parts.shift();
            if(action==='revoke'&&id&&!parts.length){show(output,await local.request(home,'/api/assistant/workers/revoke',{worker:id}),v=>'Worker qualification revoked. Active work cancellation requested.\n',json);readerLocked=false;showPrompt();continue;}
            if(action==='qualify'&&id&&parts.length===2&&parts[1]==='--confirm-public-fixture'){
              if(!input.isTTY||!output.isTTY)throw Error('Qualification consent requires an interactive owner terminal.');
              output.write('Checking the selected vendor with one public disposable edit fixture, no personal Memory or repository access; up to two minutes.\n');
              show(output,await local.request(home,'/api/assistant/workers/qualify',{worker:id,model:parts[0],confirmed:true,request_id:randomUUID()},{timeoutMs:125000}),v=>JSON.stringify(v,null,2)+'\n',json);readerLocked=false;showPrompt();continue;
            }
            throw Error('Use /workers status, /workers qualify <id> <exact-model> --confirm-public-fixture, or /workers revoke <id>.');
          }
          const registry=await local.request(home,'/api/assistant/registry');
          if(['model','worker'].includes(command)&&arg){
            const next={model:command==='model'?arg:model,worker:command==='worker'?arg:worker};
            if(arg!=='auto'){
              const route=require('./model-worker-router').select(registry,{...next,mission_class:'WORK',data_class:'public',privacy:'approved_external'});
              if(route.state!=='READY')throw Error('Selection unavailable: '+route.reason.replaceAll('_',' ')+'. Current selection preserved.');
            }
            model=next.model;worker=next.worker;
          }else if(arg&&!(command==='workers'&&arg==='status'))throw Error('Use /models or /workers; select with /model or /worker.');
          show(output,registry,c=>command.startsWith('model')?render.models(c,model):render.workers(c,worker),json);
        }
        else if(command==='connectors')show(output,await local.request(home,'/api/assistant/connectors'),render.connectors,json);
        else if(command==='connect') {
          const [connector,...connectParts]=String(arg||'').trim().split(/\s+/).filter(Boolean);
          const connectAction=(connectParts[0]||'').toLowerCase();
          if(!['gmail','google','whatsapp','calendar','drive'].includes(connector))throw Error('Use /connect gmail, /connect gmail send, /connect gmail manage, /connect calendar, /connect calendar manage, /connect drive, or /connect whatsapp');
          if(connector==='google')throw Error('Use /connect gmail for mail, /connect calendar for Google Calendar, or /connect drive for Drive. They are separate consents.');
          if(connector==='whatsapp'){
            active=new AbortController();
            try{
              await require('./whatsapp-credential-onboarding').run({home,input,output,signal:active.signal});
            }finally{active=null;}
            readerLocked=false;showPrompt();continue;
          }
          if(connectAction==='retry-open'){
            const pending=requirePendingGmailAuthorization();
            await openGmailAuthorization(output, pending.authorization_url);
            continue;
          }
          if(connectAction==='show-local'){
            const pending=requirePendingGmailAuthorization({forLocalReveal:true});
            // Local interactive Terminal TTY only — never route this URL through ChatGPT/MCP/Mission logs.
            output.write('Local Terminal only — authorization URL (do not paste into ChatGPT or remote chats):\n');
            output.write(pending.authorization_url+'\n');
            output.write('Complete Google consent in your browser. Airodrom waits on the localhost callback.\n');
            continue;
          }
          if(connector==='calendar'){
            if(connectAction&&!['fresh','manage','write','events',''].includes(connectAction)){
              throw Error('Use /connect calendar, /connect calendar manage, or /connect calendar fresh.');
            }
            const connectBody={connector:'calendar'};
            if(connectAction==='fresh')connectBody.force_new=true;
            if(connectAction==='manage'||connectAction==='write'||connectAction==='events')connectBody.mode='events';
            const result=await local.request(home,'/api/assistant/connect',connectBody);
            if(result.authorization_url){
              rememberGmailAuthorization(result);
              if(result.reused)output.write('Reusing the still-active Calendar authorization session.\n');
              else if(connectBody.mode==='events')output.write('Starting Calendar manage consent (calendar.events). This is separate from Gmail and from read-only Calendar.\n');
              else output.write('Starting read-only Calendar consent (calendar.readonly). Gmail consent does not grant Calendar.\n');
              await openGmailAuthorization(output, result.authorization_url);
            }else{
              clearPendingGmailAuthorization();
              output.write(terminalText(result.message)+'\n');
            }
            continue;
          }
          if(connector==='drive'){
            if(connectAction&&!['fresh',''].includes(connectAction)){
              throw Error('Use /connect drive or /connect drive fresh. Stage B is drive.file read/enrollment only.');
            }
            const connectBody={connector:'drive'};
            if(connectAction==='fresh')connectBody.force_new=true;
            const result=await local.request(home,'/api/assistant/connect',connectBody);
            if(result.authorization_url){
              rememberGmailAuthorization(result);
              if(result.reused)output.write('Reusing the still-active Drive authorization session.\n');
              else output.write('Starting Google Drive consent (drive.file only). Then enroll exact file/folder ids with /drive enroll …\n');
              await openGmailAuthorization(output, result.authorization_url);
            }else{
              clearPendingGmailAuthorization();
              output.write(terminalText(result.message)+'\n');
            }
            continue;
          }
          if(connectAction&&!['fresh','send','manage','modify','write','retry-open','show-local',''].includes(connectAction)){
            throw Error('Use /connect gmail, /connect gmail send, /connect gmail manage, /connect gmail retry-open, /connect gmail show-local, or /connect gmail fresh.');
          }
          const connectBody={connector:'gmail'};
          if(connectAction==='fresh')connectBody.force_new=true;
          if(connectAction==='send')connectBody.mode='send';
          if(connectAction==='manage'||connectAction==='modify'||connectAction==='write')connectBody.mode='manage';
          const result=await local.request(home,'/api/assistant/connect',connectBody);
          if(result.authorization_url){
            rememberGmailAuthorization(result);
            if(result.reused){
              output.write(connectBody.mode==='manage'
                ?'Reusing the still-active Gmail manage authorization session.\n'
                :connectBody.mode==='send'
                  ?'Reusing the still-active Gmail send authorization session.\n'
                  :'Reusing the still-active read-only Gmail authorization session.\n');
            }else if(connectBody.mode==='manage'){
              output.write('Starting Gmail manage consent (gmail.modify + gmail.send). Separate from read-only and from Calendar.\n');
            }else if(connectBody.mode==='send'){
              output.write('Starting Gmail send consent (gmail.readonly + gmail.send). Does not grant mailbox modify.\n');
            }else{
              output.write('Starting read-only Gmail consent (gmail.readonly).\n');
            }
            await openGmailAuthorization(output, result.authorization_url);
          }else{
            clearPendingGmailAuthorization();
            output.write(terminalText(result.message)+'\n');
          }
        }
        else if(command==='drive'){
          const parts=String(arg||'').trim().split(/\s+/).filter(Boolean);
          const action=(parts[0]||'status').toLowerCase();
          const driveConversationId=await session();
          const driveInput=async (message)=>{
            ensureActive();
            const result=await local.request(home,'/api/assistant/input',{message,request_id:randomUUID(),conversation_id:driveConversationId});
            await handleReceipt(result,json);
            active=null;
          };
          if(action==='enroll'){
            const kind=(parts[1]||'').toLowerCase();
            const resourceId=parts[2];
            if(kind!=='file'&&kind!=='folder')throw Error('Use /drive enroll file|folder <id> [label…]');
            if(!resourceId)throw Error('Use /drive enroll file|folder <id> [label…]');
            const label=parts.slice(3).join(' ').trim()||null;
            await driveInput(`/drive enroll ${kind} ${resourceId}${label?` ${label}`:''}`);
          }else if(action==='unenroll'){
            const resourceId=parts[1];
            if(!resourceId)throw Error('Use /drive unenroll <resource-id>');
            await driveInput(`/drive unenroll ${resourceId}`);
          }else if(action==='select'||action==='picker'){
            const offer=await local.request(home,'/api/assistant/drive/picker',{request_id:randomUUID()});
            if(offer.authorization_url||offer.picker_url){
              const openUrl=offer.picker_url||offer.authorization_url;
              output.write((offer.message||'Opening Google Drive file picker…')+'\n');
              try{require('node:child_process').spawnSync('open',[openUrl],{timeout:5000});}catch{/* */}
            }else{
              output.write((offer.message||'Drive picker unavailable.')+'\n');
            }
          }else if(action==='help'||action==='status'){
            await driveInput(action==='status'?'/drive status':'help me use google drive');
          }else if(action==='read'){
            const resourceId=parts[1]||'';
            await driveInput(resourceId?`/drive read ${resourceId}`:'/drive read');
          }else if(action==='meta'||action==='metadata'){
            const resourceId=parts[1];
            if(!resourceId)throw Error('Use /drive meta <file-id>');
            await driveInput(`/drive meta ${resourceId}`);
          }else if(action==='search'){
            const query=parts.slice(1).join(' ').trim();
            if(!query)throw Error('Use /drive search <query>');
            await driveInput(`/drive search ${query}`);
          }else if(action==='list'||action==='ls'){
            if(action==='ls'&&parts[1]) await driveInput(`/drive ls ${parts[1]}`);
            else await driveInput('/drive list');
          }else{
            throw Error('Use /drive help|status|select|read [id]|meta <id>|list|search <query>|enroll file|folder <id> [label]|unenroll <id>, or ask in natural language.');
          }
        }
        else if(command==='calendar'){
          const parts=String(arg||'').trim().split(/\s+/).filter(Boolean);
          const action=(parts[0]||'help').toLowerCase();
          // Preview/approve/confirm must bind to the same Terminal conversation session
          // that staged the durable Calendar write (never omit conversation_id).
          const calendarConversationId=await session();
          if(action==='approve'){
            const id=parts[1];
            if(!id)throw Error('Use /calendar approve <approval-id>');
            const result=await local.request(home,'/api/assistant/input',{message:`/calendar approve ${id}`,request_id:randomUUID(),conversation_id:calendarConversationId});
            await handleReceipt(result,json);
          }else if(action==='confirm'){
            const id=parts[1];
            const destructive=parts.includes('--destructive');
            if(!id)throw Error('Use /calendar confirm <preview-id> [--destructive]');
            const result=await local.request(home,'/api/assistant/input',{message:`/calendar confirm ${id}${destructive?' --destructive':''}`,request_id:randomUUID(),conversation_id:calendarConversationId});
            await handleReceipt(result,json);
          }else if(action==='help'||action==='status'){
            const result=await local.request(home,'/api/assistant/input',{message:'help me control my calendar',request_id:randomUUID(),conversation_id:calendarConversationId});
            await handleReceipt(result,json);
          }else{
            throw Error('Use /calendar help|status|approve <approval-id>|confirm <preview-id> [--destructive], or ask in natural language.');
          }
        }
        else if(command==='gcp'){
          // Host-governed GCP rail: Terminal must register /gcp or it fails as Unknown command
          // before assistant-intent. Preview/confirm require the same conversation session.
          const gcpConversationId=await session();
          const parts=String(arg||'').trim().split(/\s+/).filter(Boolean);
          const action=(parts[0]||'help').toLowerCase();
          const usage='Use /gcp help|status|list|enroll project <id> <number>|unenroll project <id>|tf-state preview somin|confirm <preview-id> [--ack-uncertain]. Chat cannot authorize cloud writes.';
          if(!['help','status','list','enroll','unenroll','tf-state','preview','confirm'].includes(action))throw Error(usage);
          if(action==='confirm'){
            const id=parts[1];
            if(!id||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)){
              throw Error('Use /gcp confirm <preview-id> [--ack-uncertain]');
            }
          }else if(action==='tf-state'){
            if((parts[1]||'').toLowerCase()!=='preview')throw Error('Use /gcp tf-state preview somin');
          }else if(action==='preview'){
            if((parts[1]||'').toLowerCase()!=='tf-state'&&(parts[1]||'').toLowerCase()!=='somin'&&parts.length>1)throw Error(usage);
          }else if(action==='enroll'){
            if((parts[1]||'').toLowerCase()!=='project'||!parts[2]||!parts[3])throw Error('Use /gcp enroll project <project-id> <project-number>');
          }else if(action==='unenroll'){
            if((parts[1]||'').toLowerCase()!=='project'||!parts[2])throw Error('Use /gcp unenroll project <project-id>');
          }
          const message=`/gcp${arg?` ${arg}`:''}`;
          const result=await local.request(home,'/api/assistant/input',{message,request_id:randomUUID(),conversation_id:gcpConversationId});
          await handleReceipt(result,json);
        }
        else if(command==='gmail'||command==='whatsapp') {
          if(command==='gmail'){
            const gmailParts=String(arg||'').trim().split(/\s+/).filter(Boolean);
            const gmailAction=(gmailParts[0]||'status').toLowerCase();
            // Approve/confirm/help must reuse the authenticated Terminal conversation
            // identity that created the durable Gmail preview. Omitting conversation_id
            // falsely fails closed as "authenticated Terminal conversation session".
            if(gmailAction==='approve'){
              const id=gmailParts[1];
              if(!id)throw Error('Use /gmail approve <approval-id>');
              const result=await local.request(home,'/api/assistant/input',{message:`/gmail approve ${id}`,request_id:randomUUID(),conversation_id:await session()});
              await handleReceipt(result,json);
              readerLocked=false;showPrompt();continue;
            }
            if(gmailAction==='confirm'){
              const id=gmailParts[1];
              const destructive=gmailParts.includes('--destructive');
              const ackUncertain=gmailParts.includes('--ack-uncertain');
              if(!id)throw Error('Use /gmail confirm <preview-id> [--destructive] [--ack-uncertain]');
              const flags=(destructive?' --destructive':'')+(ackUncertain?' --ack-uncertain':'');
              const result=await local.request(home,'/api/assistant/input',{message:`/gmail confirm ${id}${flags}`,request_id:randomUUID(),conversation_id:await session()});
              await handleReceipt(result,json);
              readerLocked=false;showPrompt();continue;
            }
            if(gmailAction==='help'&&gmailParts.length<=1){
              const result=await local.request(home,'/api/assistant/input',{message:'help me control gmail writes',request_id:randomUUID(),conversation_id:await session()});
              await handleReceipt(result,json);
              readerLocked=false;showPrompt();continue;
            }
          }
          const [actionArg='status',...parts]=String(arg||'').split(/\s+/),action=actionArg==='draft-reply'?'draft_reply':actionArg,query=parts.join(' '),selected=['read','thread','summarize','draft_reply'].includes(action);
          if(command==='whatsapp'&&['bind','onboard','discover','prepare-callback','rotate-verify-token','commit-verify-token','rollback-verify-token'].includes(action)){
            active=new AbortController();
            try{
              const onboard=require('./whatsapp-credential-onboarding');
              if(action==='bind'||action==='onboard')await onboard.run({home,input,output,signal:active.signal,callbackUrl:parts[0]&&parts[0].startsWith('https://')?parts[0]:null});
              else if(action==='discover')await onboard.runDiscover(home,output);
              else if(action==='rotate-verify-token')await onboard.runRotateVerifyToken(home,input,output,{signal:active.signal});
              else if(action==='commit-verify-token')await onboard.runCommitVerifyToken(home,input,output,{signal:active.signal});
              else if(action==='rollback-verify-token')await onboard.runRollbackVerifyToken(home,input,output,{signal:active.signal});
              else await onboard.runPrepare(home,output,parts[0]);
            }finally{active=null;}
            readerLocked=false;showPrompt();continue;
          }
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
        else if (command === 'logs') {
          const parts = (arg || 'follow').split(/\s+/).filter(Boolean);
          const mode = parts[0] === 'follow' || parts[0] === 'once' ? parts.shift() : 'follow';
          const mission = parts[0] && /^[a-f0-9-]{36}$/i.test(parts[0]) ? parts.shift() : (lastMission || null);
          if (parts.length) throw Error('Use /logs [follow|once] [mission-id].');
          await require('../scripts/live-logs.cjs').main(['follow', ...(mode === 'once' ? ['--once'] : []), ...(mission ? ['--mission', mission] : []), ...(json ? ['--json'] : [])]);
        }
        else if (command === 'compat'||command==='compatibility') {
          const report=await local.request(home,'/api/product/compatibility');
          show(output,report,r=>{
            const lines=['Installation · '+(r.installation?.overall||'Unavailable')+(r.installation?.mutations_allowed?' · mutations allowed':' · mutations blocked')];
            for(const c of r.installation?.components||[])lines.push(c.component+' · '+c.state+(c.guidance?' · '+c.guidance:''));
            lines.push('Contracts · family '+(r.contracts?.family||'Unavailable'));
            for(const item of r.runtime_security?.items||[]){const props=Object.entries(item.properties||{}).map(([k,v])=>k+':'+v.state).join(', ');lines.push('Security · '+item.adapter+' · '+props);}
            lines.push('No credentials or private Memory are included.');
            return lines.join('\n');
          },json);
        }
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
        else if(command==='browser'){
          const [action='options',target,...extra]=(arg||'options').split(/\s+/);if(extra.length||!['options','sessions','status','permissions','diagnostics','revoke','close','open'].includes(action))throw Error('Use /browser options|sessions|status|permissions|diagnostics|revoke|close [Mission] or open <HTTPS URL>.');
          if(action==='open'){active=new AbortController();await handleReceipt(await sessionGuide(target),json);active=null;}
          else {const id=target||lastMission;if(['status','permissions','diagnostics','revoke','close'].includes(action)&&!id)throw Error('Select a browser Mission first.');let result;if(['revoke','close'].includes(action))result=await local.request(home,'/api/assistant/browser/'+action,{mission_id:id,request_id:randomUUID()});else result=await local.request(home,'/api/assistant/browser/'+(action==='permissions'?'status':action)+(id&&!['options','sessions'].includes(action)?'?mission_id='+encodeURIComponent(id):''));show(output,result,require('./browser-render').render,json);}
        }
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
        else if(command==='workspace'){
          const parts=arg.split(/\s+/);if(parts.length!==2||parts[1]!=='--confirm-public-files'||!input.isTTY||!output.isTTY)throw Error('Use /workspace <template.json> --confirm-public-files in the owner terminal; only explicitly public files may be shared.');
          const file=fs.realpathSync(parts[0]),stat=fs.statSync(file);if(!stat.isFile()||stat.size>32768)throw Error('Bounded template JSON required');const body=JSON.parse(fs.readFileSync(file,'utf8'));body.confirmed=true;
          show(output,await local.request(home,'/api/assistant/workspaces/register',body),v=>'Public worker template registered: '+terminalText(v.project)+' / '+terminalText(v.workspace_alias)+'\n',json);
        }
        else if (command === 'task') { lastMission = await scopedTask(home, arg,{model,worker}); output.write('Scoped Mission dispatched: ' + lastMission + '\n'); }
        else if (command === 'mission') {
          if (!arg) output.write('/mission new [objective] · /mission list · /mission status [id] · /mission cancel [id]\n');
          else {
            const [action, ...parts] = arg.split(/\s+/);
            if(action==='web'){
              const selected=parts.shift(),mode=selected==='revoke'?'off':selected;if(!['on','off','all','status'].includes(mode))throw Error('Use /mission web on|off|all [id] [public HTTPS URLs].');
              const id=/^[a-f0-9-]{36}$/i.test(parts[0]||'')?parts.shift():lastMission;if(!id)throw Error('Select a qualified Work Mission first.');
              if(mode==='status'){show(output,await local.request(home,'/api/assistant/mission/web/status?mission_id='+encodeURIComponent(id)),require('./browser-render').render,json);active=null;readerLocked=false;showPrompt();continue;}
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
          const created = await admitConversation(home, {
            message: value,
            request_id: randomUUID(),
            include_memory: true,
            model,
            worker,
            conversation_id: await session(),
            workspace: fs.realpathSync(process.cwd())
          }, { signal: active.signal, timeoutMs: 15000 });
          await handleReceipt(created, false, value); active = null;
        }
      } catch (error) {
        stopAnswer();
        active = null;
        const timeout = isTransportTimeout(error);
        const cancelled = error.name === 'AbortError' || /cancelled/i.test(error.message || '');
        const inferenceTimeout = /timed out while waiting for the local model/i.test(error.message || '');
        const nullSignal = error?.name === 'TypeError' && /reading ['"]signal['"]/i.test(String(error.message || ''));
        const message = nullSignal
          ? 'Conversation cancellation context was unavailable. The CLI recovered; send the message again.'
          : inferenceTimeout
            ? error.message
            : timeout
              ? 'Local admission timed out. If a reply is still generating, wait or retry; the CLI is still open.'
              : cancelled
                ? (error.message || 'Request cancelled. The CLI is still open.')
                : require('./secret-observation').safeValue(error.message);
        output.write('Airo: ' + terminalText(message) + '\n');
      }
      readerLocked=false;
      await refreshName();
      showPrompt();
    }
  } finally { indicator?.stop();process.removeListener('SIGINT', interrupt); await detachReader(); }
  output.write('Local service remains available. Use airodrom service stop to stop it.\n');
}
async function showStatus(home, json = false) {
  if (local.isStopped(home)) {
    show(process.stdout, { state: 'stopped' }, () => 'Airodrom is stopped. Run airodrom service start.', json);
    return;
  }
  show(process.stdout, await local.attach(home), rows, json);
}
async function serviceCommand(home, action, rest = []) {
  if (!action || action === 'status') return showStatus(home, rest.includes('--json'));
  if (action === 'start' && !rest.length) { process.stdout.write(rows(await local.start(home))); return; }
  if (action === 'stop' && !rest.length) { await local.stop(home); process.stdout.write('Airodrom stopped. Personal Memory is preserved.\n'); return; }
  if (action === 'restart' && !rest.length) { await local.stop(home); process.stdout.write(rows(await local.start(home))); return; }
  throw Error('Use airodrom service start|stop|restart|status.');
}
async function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args, home = local.localHome();
  if (!command || command === 'chat') return interactive(home);
  if (['help', '--help', '-h'].includes(command)) { process.stdout.write(help()); return; }
  if (command === 'menu') { const app = require('../scripts/macos/prepare-local-menu.cjs').prepare(home); const r = require('node:child_process').spawnSync('/usr/bin/open',[app],{stdio:'ignore',timeout:5000}); if(r.status!==0) throw Error('Native menu could not open.'); process.stdout.write('Airodrom menu opened. Service lifecycle is separate.\n'); return; }
  if(command==='browser'&&rest[0]==='options'&&rest.length===1){process.stdout.write(require('./browser-render').render(require('./browser-connections').availability()));return;}
  if (command === 'doctor') {
    const report = await require('./product-diagnostics').doctor(home);
    const install = require('./cli-command-inspect').inspectInstalledCommand({ root: local.ROOT });
    if (rest.includes('--json')) show(process.stdout, { ...report, install }, () => '', true);
    else {
      show(process.stdout, report, require('./product-diagnostics').summary, false);
      process.stdout.write(require('./cli-command-inspect').formatInstallAdvice(install) + '\n');
    }
    return;
  }
  if (command === 'requalify') { await local.requalify(home); process.stdout.write('OpenCode requalified. Run airodrom service start.\n'); return; }
  if(command==='gmail'&&rest[0]==='setup'){if(rest.length!==2||!rest[1].endsWith('.apps.googleusercontent.com'))throw Error('Use airodrom gmail setup <Google desktop client ID>');local.privateDirectory(home,true);const data=local.privateDirectory(path.join(home,'data'),true),file=path.join(data,'gmail-oauth-config.json');if(fs.existsSync(file))throw Error('Existing Gmail config preserved. Configure through an explicitly reviewed change.');local.writePrivate(file,{clientId:rest[1]});process.stdout.write('Owner OAuth client configured. Prepare the Keychain helper, restart Airodrom, then /connect gmail. No account connected.\n');return;}
  if(command==='drive'&&rest[0]==='picker-setup'){
    if(rest.length!==3)throw Error('Use airodrom drive picker-setup <Google Picker API key> <GCP project number>');
    local.privateDirectory(home,true);local.privateDirectory(path.join(home,'data'),true);
    const dataDir=path.join(home,'data');
    let clientId=null;
    for(const name of ['drive-oauth-config.json','gmail-oauth-config.json']){
      try{
        const cfg=JSON.parse(fs.readFileSync(path.join(dataDir,name),'utf8'));
        if(typeof cfg?.clientId==='string'&&cfg.clientId.endsWith('.apps.googleusercontent.com')){clientId=cfg.clientId;break;}
      }catch{/* */}
    }
    require('./drive-picker').writeConfig(dataDir,{apiKey:rest[1],appId:rest[2],clientId});
    process.stdout.write('Drive Picker configured (api key stored privately). Restart is not required. Run /connect drive fresh, complete consent, then select a nonsensitive file.\n');
    return;
  }
  if(command==='secret'){
    if(rest[0]==='put'&&rest[1]==='whatsapp'&&(rest[2]==='bind'||rest[2]==='onboard')){
      return require('./whatsapp-credential-onboarding').run({home,input:process.stdin,output:process.stdout});
    }
    return require('./vault-cli').run(home,rest,process.stdin,process.stdout);
  }
  if(command==='whatsapp'){
    const action=rest[0]||'status';
    const onboard=require('./whatsapp-credential-onboarding');
    if(action==='bind'||action==='onboard')return onboard.run({home,input:process.stdin,output:process.stdout,callbackUrl:rest[1]&&rest[1].startsWith('https://')?rest[1]:null});
    if(action==='discover')return onboard.runDiscover(home,process.stdout,rest[1]&&/^[0-9]{5,32}$/.test(rest[1])?rest[1]:null);
    if(action==='use-test'||action==='configure-test')return onboard.runConfigureTest(home,process.stdout);
    if(action==='rotate-verify-token')return onboard.runRotateVerifyToken(home,process.stdin,process.stdout);
    if(action==='commit-verify-token')return onboard.runCommitVerifyToken(home,process.stdin,process.stdout);
    if(action==='rollback-verify-token')return onboard.runRollbackVerifyToken(home,process.stdin,process.stdout);
    if(action==='prepare-callback')return onboard.runPrepare(home,process.stdout,rest[1]);
    if(action==='status')return onboard.runStatus(home,process.stdout,rest.includes('--json'));
    throw Error('Use airodrom whatsapp bind|status|discover|use-test|rotate-verify-token|commit-verify-token|rollback-verify-token|prepare-callback <https://host/webhooks/whatsapp>');
  }
  if (command === '--version') { process.stdout.write(branding.name + ' ' + require('../package.json').version + '\n'); return; }
  if (command === 'status') return showStatus(home, rest.includes('--json'));
  if (command === 'autopilot') {
    await local.attach(home);
    const action = rest[0] || 'status';
    if (!['on', 'off', 'status', 'stop'].includes(action) || rest.length > 1 && !(rest.length === 2 && rest[1] === '--json')) {
      throw Error('Use airodrom autopilot on|off|status|stop.');
    }
    show(process.stdout, await autopilotControl(home, action), formatAutopilot, rest.includes('--json'));
    return;
  }
  if (command === 'logs') {
    await local.attach(home);
    return require('../scripts/live-logs.cjs').main(rest.length ? rest : ['follow']);
  }
  if (command === 'service') return serviceCommand(home, rest[0], rest.slice(1));
  if (command === 'stop') return serviceCommand(home, 'stop');
  if (command === 'restart') return serviceCommand(home, 'restart');
  if (command === 'start') return serviceCommand(home, 'start');
  if (command === 'open') {
    await local.attach(home);
    local.open(home);
    process.stdout.write('Control Center opened.\n');
    return;
  }
  if (command === 'memory') {
    await local.attach(home);
    await memory(home, rest.filter(x => x !== '--json').join(' '), process.stdout, rest.includes('--json'));
    return;
  }
  if (command === 'task') {
    await local.attach(home);
    process.stdout.write('Scoped Mission dispatched: ' + await scopedTask(home, rest[0]) + '\n');
    return;
  }
  throw Error('Unknown command. Use airodrom --help.');
}
if (require.main === module) main().catch(error => { console.error('Airodrom: ' + terminalText(require('./secret-observation').safeValue(error.message))); process.exitCode = error.message === 'Unknown command. Use airodrom --help.' ? 2 : 1; });
module.exports = {
  parseLine, intro, rows, help, terminalText, memory, scopedTask, waitResult, waitConversation,
  admitConversation, isTransportTimeout, sanitizePaste, pastePreview, secureIngressLine, missionReceipt,
  interactive, main, showStatus, serviceCommand, formatAutopilot, autopilotControl,
  openGmailAuthorization, rememberGmailAuthorization, requirePendingGmailAuthorization,
  clearPendingGmailAuthorization,
  // Test seam: inspect/replace pending authorization without printing secrets elsewhere.
  _pendingGmailAuthorization: () => pendingGmailAuthorization,
  _setPendingGmailAuthorization: (value) => { pendingGmailAuthorization = value; },
};
