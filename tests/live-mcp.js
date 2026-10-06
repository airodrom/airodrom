'use strict';
// Local MCP-client proof only. This is NOT a ChatGPT-originated call.
// Uses the running bridge and leaves its dedicated task visible in Control Center.
const assert = require('node:assert/strict');
const { TOOLS } = require('../src/mcp-tools');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const readline = require('node:readline');
const command = 'git branch --show-current && git status --porcelain=v1';
const nonce = `mcp-proof-${randomUUID()}`;
const child = spawn(process.execPath, [path.join(__dirname, '../src/mcp.js')], { stdio: ['pipe', 'pipe', 'inherit'] });
const pending = new Map(); let serial = 0;
const lines = readline.createInterface({ input: child.stdout });
lines.on('line', line => {
  const response = JSON.parse(line), receiver = pending.get(response.id);
  if (!receiver) return;
  pending.delete(response.id); clearTimeout(receiver.timer);
  response.error ? receiver.reject(new Error(JSON.stringify(response.error))) : receiver.resolve(response.result);
});
function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP request deadline')); }, 20000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
async function call(name, args) {
  const response = await request('tools/call', { name, arguments: args });
  assert(!response.isError, JSON.stringify(response));
  return response.structuredContent;
}
const harmless = process.argv.includes('--harmless');
const proof = { testedAt: new Date().toISOString(), origin: 'local MCP test client, NOT ChatGPT', nonce, command: harmless || process.argv.includes('--catalog-only') ? null : command, chatgptOriginated: false };
async function run() {
  const init = await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'pi-bridge-local-acceptance-test', version: '1' } });
  assert.equal(init.serverInfo.name, 'pi-chatgpt-bridge');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const list = await request('tools/list', {});
  assert.deepEqual(list.tools, TOOLS);
  proof.toolCount = list.tools.length;
  if (process.argv.includes('--catalog-only')) {
    proof.success = true;
    console.log(JSON.stringify(proof));
    return;
  }
  if (harmless) {
    const task = await call('create_task', { description: `MCP harmless acceptance ${nonce}`, workspace: 'isolated', request_id: nonce, message: 'Reply exactly MCP_LOCAL_OK. Do not use tools or change files.' });
    proof.taskId = task.task_id;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const status = await call('get_task_status', { task_id: task.task_id });
      assert.equal(status.session_id, task.session_id);
      assert.equal(status.approvals.length, 0);
      if (!status.busy && status.status === 'completed') {
        assert.equal(status.result.trim(), 'MCP_LOCAL_OK');
        assert.deepEqual(await request('ping', {}), {});
        assert.deepEqual((await request('tools/list', {})).tools, TOOLS);
        proof.success = true;
        console.log(JSON.stringify(proof));
        return;
      }
      if (!status.busy && ['error', 'blocked', 'cancelled'].includes(status.status)) throw new Error(`Pi stopped: ${status.status}`);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('Harmless acceptance deadline');
  }
  const task = await call('create_task', { description: `MCP Git acceptance ${nonce}`, workspace: 'bridge', request_id: nonce, message: `This is a read-only Git inspection of the current workspace. Correlation nonce: ${nonce}. Use bash exactly once with command "${command}" and timeout 10. Do not use any other tools. If approval is required, STOP immediately and await the operator; never change the command or retry. After the command succeeds, report the nonce, exact current branch and clean/dirty state based on its output. Do not guess.` });
  proof.taskId = task.task_id; proof.sessionId = task.session_id;
  console.log(JSON.stringify({ taskId: proof.taskId, sessionId: proof.sessionId, nonce, waiting: 'Local operator must review the exact Git command in Control Center' }));
  let requested = false;
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const status = await call('get_task_status', { task_id: task.task_id });
    if (!status.busy && status.approvals.length && !requested) {
      const approval = status.approvals.find(a => a.tool === 'bash' && a.input?.command === command && a.input?.timeout === 10);
      assert(approval, 'Pi did not request the expected exact Git command; inspect manually');
      const review = await call('approve_once', { task_id: task.task_id, approval_id: approval.id });
      assert.equal(review.approved, false); assert.equal(review.operator_confirmation_required, true);
      proof.approvalId = approval.id; proof.reviewDoesNotGrant = true; requested = true;
      console.log(JSON.stringify({ awaitingOperator: true, approvalId: approval.id, command, taskId: task.task_id }));
    }
    if (!status.busy && status.status === 'completed') {
      assert(requested, 'Completion without an exact approval is not proof of Git execution');
      assert(status.result && /clean|dirty/i.test(status.result), 'No Git clean/dirty response');
      // The exact retry prompt may omit the nonce; correlation still comes from the
      // task/session/request receipt, which must remain identical throughout.
      assert.equal(status.session_id, proof.sessionId); assert.equal(status.source.request_id, nonce);
      proof.success = true; proof.result = status.result; proof.events = status.events;
      console.log(JSON.stringify({ success: true, origin: proof.origin, taskId: task.task_id, sessionId: task.session_id, result: status.result }));
      return;
    }
    if (!status.busy && ['error', 'cancelled', 'blocked'].includes(status.status)) throw new Error(`Pi stopped: ${status.status}: ${status.error || status.result}`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('Timed out awaiting Pi/operator; inspect the task before retrying');
}
run().catch(error => { proof.success = false; proof.error = error.message; console.error(error.message); process.exitCode = 1; }).finally(() => {
  child.stdin.end();
  for (const item of pending.values()) clearTimeout(item.timer);
  if (process.env.BRIDGE_PROOF_FILE) fs.writeFileSync(process.env.BRIDGE_PROOF_FILE, JSON.stringify(proof, null, 2) + '\n');
});
