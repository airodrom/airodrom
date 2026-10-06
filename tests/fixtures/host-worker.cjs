#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const http = require('node:http');
const readline = require('node:readline');
const args = process.argv.slice(2);
const value = name => args[args.indexOf(name) + 1];
const sessionId = args.includes('--session-id') ? value('--session-id') : 'review-session';
const startupMs = Number(process.env.BRIDGE_REVIEW_STARTUP_MS || 0);
const closeMs = Number(process.env.BRIDGE_REVIEW_CLOSE_MS || 0);
const readyHang = process.env.BRIDGE_REVIEW_READY_HANG === '1';
const exitBeforeReady = process.env.BRIDGE_REVIEW_EXIT_BEFORE_READY === '1';
const faultBeforeReady = process.env.BRIDGE_REVIEW_FAULT_BEFORE_READY === '1';
const hangBeforeOutput = process.env.BRIDGE_REVIEW_HANG_BEFORE_OUTPUT === '1';
const ignoreSignals = process.env.BRIDGE_REVIEW_IGNORE_SIGNALS === '1';
const protocol = args.includes('--review-protocol') ? value('--review-protocol') : '';
const send = data => process.stdout.write(JSON.stringify(data) + '\n');
const state = { sessionId, model: { id: 'disposable-fixture' } };
let ending = false;
function close() {
  if (ignoreSignals) return;
  if (!ending) { ending = true; setTimeout(() => process.exit(0), closeMs); }
}
process.on('SIGTERM', close);
process.on('SIGINT', close);
const heartbeat = setInterval(() => {}, 1000);
process.stdin.on('end', () => { if (!ignoreSignals) close(); });

if (hangBeforeOutput) {
  setInterval(() => {}, 1000);
  // Intentionally never speak on stdout/stderr protocol channels.
} else if (exitBeforeReady) {
  setTimeout(() => process.exit(3), Math.max(5, startupMs));
} else if (faultBeforeReady) {
  setTimeout(() => {
    process.stderr.write('fixture fault before ready\n');
    process.exit(4);
  }, Math.max(5, startupMs));
} else {
  if (process.env.BRIDGE_POLICY_SOCKET && !readyHang) setTimeout(() => {
    const req = http.request({ socketPath: process.env.BRIDGE_POLICY_SOCKET, method: 'POST', path: '/ready', headers: { authorization: `Bearer ${process.env.BRIDGE_TASK_TOKEN}`, 'Content-Type': 'application/json' } }, res => res.resume());
    req.on('error', () => process.exit(2));
    req.end(JSON.stringify({ sessionId, cwd: process.cwd() }));
  }, startupMs);

  readline.createInterface({ input: process.stdin }).on('line', line => {
    const command = JSON.parse(line);
    if (command.type === 'get_state' && protocol) {
      process.stdout.write(protocol === 'null' ? 'null\n' : '{invalid-json\n');
      return;
    }
    const response = data => send({ id: command.id, type: 'response', success: true, data });
    if (command.type === 'get_state') {
      if (readyHang) return setTimeout(() => response(state), Math.max(startupMs, 60_000));
      return setTimeout(() => response(state), startupMs);
    }
    if (command.type === 'get_session_stats') return response({ contextUsage: { tokens: 1, contextWindow: 1000 } });
    if (command.type === 'abort') return response({});
    if (command.type === 'prompt') {
      fs.appendFileSync('wire.log', JSON.stringify({ pid: process.pid, message: command.message }) + '\n');
      response({});
      send({ type: 'agent_start' });
      if (command.message === 'never settle' || command.message.endsWith('\nnever settle')) return;
      // FIXTURE_POLICY_SCRIPT:<base64 JSON [{path, body}]> drives real host policy
      // calls in order before settling, so tests observe true terminal state.
      // The last marker is the current instruction; earlier ones are wrapped context.
      const scripted = [...command.message.split('Current turn instruction:\n').at(-1).matchAll(/FIXTURE_POLICY_SCRIPT:([A-Za-z0-9+/=]+)/g)].at(-1);
      if (scripted && process.env.BRIDGE_POLICY_SOCKET) {
        const steps = JSON.parse(Buffer.from(scripted[1], 'base64').toString('utf8'));
        const results = [];
        const post = step => new Promise(resolve => {
          const req = http.request({ socketPath: process.env.BRIDGE_POLICY_SOCKET, method: 'POST', path: step.path, headers: { authorization: `Bearer ${process.env.BRIDGE_TASK_TOKEN}`, 'Content-Type': 'application/json' } }, res => {
            let raw = ''; res.on('data', c => { raw += c; }); res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({ raw }); } });
          });
          req.on('error', error => resolve({ error: error.message }));
          req.end(JSON.stringify(step.body));
        });
        (async () => {
          for (const step of steps) {
            send({ type: 'tool_execution_start', toolName: step.body?.toolName });
            results.push(await post(step));
            send({ type: 'tool_execution_end', toolName: step.body?.toolName });
          }
          fs.writeFileSync('policy-script-results.json', JSON.stringify(results));
          send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'FIXTURE_SCRIPT_OK' }], stopReason: 'stop' } });
          send({ type: 'agent_settled' });
        })();
        return;
      }
      if (command.message.includes('simulate broker authorization failure')) {
        send({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '403: {"message":"No active trusted mission grant","type":"local_ollama_broker_error"}' } });
        send({ type: 'agent_settled' });
        return;
      }
      const inert = command.message.split('FIXTURE_INERT_OUTPUT:').at(-1);
      send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: command.message.includes('FIXTURE_INERT_OUTPUT:') ? inert : 'FIXTURE_OK' }], stopReason: 'stop' } });
      send({ type: 'agent_settled' });
    }
  });
}
