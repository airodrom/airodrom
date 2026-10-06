'use strict';
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const local = require('./local-bootstrap');
const branding = require('./branding');
const terminalText = value => require('node:util').stripVTControlCharacters(String(value)).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
const COMMANDS = '/remember <text> · /memory [query] · /forget <id or subject>\n/status · /runtime [opencode] · /open · /task <mission.json> · /accept · /help · /quit';
function intro({ color = false, unicode = true } = {}) {
  const title = color ? '\u001b[1;36mAIRODROM\u001b[0m' : 'AIRODROM';
  return `${unicode ? '◈ ' : ''}${title}\nMANY AGENTS. ONE CONTROL PLANE.\n`;
}
function rows(s) {
  return `OpenCode   ${s.opencode.ready ? '● Ready · Primary' : 'unavailable · ' + s.opencode.reason}\nMemory V2  ● Ready · Local\nControl    ${s.healthy ? '● Local' : 'unavailable'}\nRuntime    ${s.default_runtime}\n`;
}
function help() { return `${branding.name} — ${branding.tagline}\n\nUsage: airodrom [command]\n\n  (no command) Interactive terminal\n  status       Inspect the local service\n  start        Start or attach to the local service\n  stop         Gracefully stop the owned local service\n  restart      Stop and start the owned local service\n  open         Open the optional Control Center\n  memory       List/search Personal Memory V2\n  task <file>  Register and dispatch a scoped Mission JSON\n  mcp          Existing MCP stdio transport\n  --version    Show version\n\n${COMMANDS}\n\n${branding.website}\n`; }
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
async function scopedTask(home, file) {
  if (!file) throw Error('Use /task <mission.json> with declared workspace, allowed files, criteria and registered verification.');
  const s = fs.lstatSync(path.resolve(file));
  if (!s.isFile() || s.isSymbolicLink() || s.size > 64000) throw Error('Mission JSON must be a bounded regular file.');
  const input = require('./authority-json').parseAuthorityJSON(fs.readFileSync(path.resolve(file), 'utf8'));
  const mission = await local.request(home, '/api/control-v2/create-mission', { ...input, request_id: input.request_id || randomUUID() });
  await local.request(home, '/api/control-v2/dispatch-mission', { id: mission.id, request_id: randomUUID() });
  return mission.id;
}
async function interactive(home, { input = process.stdin, output = process.stdout, env = process.env } = {}) {
  output.write(intro({ color: !!output.isTTY && env.NO_COLOR === undefined && env.TERM !== 'dumb', unicode: env.TERM !== 'dumb' }));
  const s = await local.start(home, env); output.write(rows(s));
  output.write('\nType a question, or /help for commands. Each question gets a fresh bounded Mission.\n');
  const rl = readline.createInterface({ input, output, terminal: !!input.isTTY && !!output.isTTY });
  let runtime = s.default_runtime, lastMission = null, active = null, quitting = false;
  const interrupt = () => { if (active) active.abort(); else { quitting = true; rl.close(); } };
  rl.on('SIGINT', interrupt); process.on('SIGINT', interrupt);
  try {
    if (output.isTTY) output.write('\nairo › ');
    for await (const line of rl) {
      if (quitting) break;
      const value = line.trim(); if (!value) { if (output.isTTY) output.write('airo › '); continue; }
      try {
        const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(value), command = match?.[1], arg = match?.[2]?.trim() || '';
        if (command === 'quit') break;
        if (command === 'help') output.write(COMMANDS + '\n');
        else if (command === 'status') output.write(rows(await local.status(home)));
        else if (command === 'runtime') { if (arg) runtime = require('./default-runtime').defaultRuntime(arg); output.write('Runtime for fresh tasks: ' + runtime + '\n'); }
        else if (command === 'open') { local.open(home); output.write('Control Center opened.\n'); }
        else if (command === 'memory') await memory(home, arg, output);
        else if (command === 'remember') { const item = await local.request(home, '/api/interactive/remember', { content: arg }); output.write('Remembered ' + item.memoryId + '\n'); }
        else if (command === 'forget') { const r = await local.request(home, '/api/interactive/forget', { selection: arg }); output.write('Forgot ' + r.memoryId + '\n'); }
        else if (command === 'task') { lastMission = await scopedTask(home, arg); output.write('Scoped Mission dispatched: ' + lastMission + '\n'); }
        else if (command === 'accept') {
          if (!lastMission) throw Error('No Mission is selected.');
          const r = await local.request(home, '/api/interactive/task?mission_id=' + encodeURIComponent(lastMission));
          await local.request(home, '/api/control-v2/accept-mission', { id: lastMission, request_id: randomUUID(), verification_id: r.verification_id, decision: 'accept', rationale: 'Authenticated local operator reviewed the result.', evidence: arg || 'Operator reviewed the conversation response.' }); output.write('Accepted and settled locally.\n');
        } else if (command) throw Error('Unknown command. Use /help.');
        else {
          active = new AbortController();
          const created = await local.request(home, '/api/interactive/tasks', { message: value, request_id: randomUUID(), include_memory: true, runtime }); lastMission = created.mission_id;
          output.write('Running ' + created.runtime + ' · bounded local Mission\n');
          const r = await waitResult(home, created.mission_id, { signal: active.signal });
          output.write(terminalText(r.summary) + '\n'); output.write('Answer ready for your review. /accept records Acceptance and local Settlement.\n'); active = null;
        }
      } catch (error) { active = null; output.write('Airodrom: ' + terminalText(require('./secret-observation').safeValue(error.message)) + '\n'); }
      if (output.isTTY) output.write('\nairo › ');
    }
  } finally { process.removeListener('SIGINT', interrupt); rl.close(); }
  output.write('Local service remains available. Use airodrom stop to stop it.\n');
}
async function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args, home = local.localHome();
  if (!command) return interactive(home);
  if (['--help', '-h'].includes(command)) { process.stdout.write(help()); return; }
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
