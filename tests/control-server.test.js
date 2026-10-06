'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const Bridge = require('./fixtures/test-bridge.cjs');
const ControlServer = require('../src/control-server');
async function fixture(t) {
  const root = fs.mkdtempSync('/private/tmp/pi-http-');
  const profile = path.join(root,'source'); fs.mkdirSync(profile); fs.writeFileSync(path.join(profile,'settings.json'),'{}');
  const bridge = await new Bridge({ defaultRuntime: 'host', dataDir:path.join(root,'data'),sourceProfile:profile,allowFixtureWorker:true,executable:path.join(__dirname,'fixtures/host-worker.cjs') }).initialize();
  const ui = new ControlServer(bridge,{port:0, connectionStatus: async () => ({ state: 'not_connected', connected: false, tunnelHealthy: false, mcpProbe: 'unknown' })}); await ui.start();
  t.after(async()=>{ await ui.close(); await bridge.shutdown(); fs.rmSync(root,{recursive:true,force:true}); });
  const request = (route, {method='GET',body,headers={},authorized=true}={}) => new Promise((resolve,reject)=>{
    const req = http.request(ui.origin+route,{method,headers:{...(authorized?{authorization:`Bearer ${ui.token}`} : {}), ...(body?{'content-type':'application/json'}:{}),...headers}},res=>{let text='';res.on('data',p=>text+=p);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:JSON.parse(text)}));});
    req.on('error',reject); req.end(body?JSON.stringify(body):undefined);
  });
  return {bridge,ui,request};
}
test('HTTP is loopback-only, authenticated, same-origin, and exposes no raw RPC', async t=>{
  const {ui,request}=await fixture(t);
  assert.equal(ui.server.address().address,'127.0.0.1');
  assert.equal((await request('/api/state',{authorized:false})).status,401);
  assert.equal((await request(`/api/state?token=${ui.token}`,{authorized:false})).status,401);
  assert.equal((await request('/api/state',{headers:{host:'evil.example'}})).status,403);
  assert.equal((await request('/api/state',{headers:{origin:'https://evil.example'}})).status,403);
  const state=await request('/api/state'); assert.equal(state.status,200); assert.equal(state.body.bridge.directChatGPT,false);
  assert(state.headers['content-security-policy'].includes("frame-ancestors 'none'"));
  for(const route of ['/api/rpc','/api/bash','/api/switch_session']) assert.equal((await request(route,{method:'POST',body:{type:'bash',command:'echo bypass'}})).status,404);
  assert.equal((await request('/api/tasks',{method:'POST',body:{description:'Bad origin'},headers:{origin:'http://attacker.example'}})).status,403);
});
test('operator can create a task, store scoped memory, and submit a prompt; forged private workspace is rejected',async t=>{
  const {bridge,request}=await fixture(t);
  const created=await request('/api/tasks',{method:'POST',body:{description:'HTTP fixture'}}); assert.equal(created.status,201);
  const task=created.body;
  const malicious=await request('/api/tasks',{method:'POST',body:{description:'Forged scope',workspace:task.workspace}});assert.equal(malicious.status,400);assert.equal(bridge.tasks.list().length,1);
  const memory=await request('/api/memory',{method:'POST',body:{taskId:task.id,content:'Amber project deploy region west.',kind:'fact'}});assert.equal(memory.status,201);assert.equal(memory.body.provenance.source,'operator');
  const found=await request(`/api/memory?taskId=${task.id}&query=Amber`);assert.equal(found.body.items.length,1);
  const other=(await request('/api/tasks',{method:'POST',body:{description:'Other'}})).body;
  assert.equal((await request(`/api/memory?taskId=${other.id}&query=Amber`)).body.items.length,0);
  const prompt=await request(`/api/tasks/${task.id}/prompt`,{method:'POST',body:{message:'Explain Amber'}});assert.equal(prompt.status,202);
  const deadline=Date.now()+5000; while(bridge.inFlight.size && Date.now()<deadline) await new Promise(r=>setTimeout(r,20));
  assert.equal(bridge.tasks.get(task.id).lastResult,'FIXTURE_OK');
  assert.equal((await request(`/api/tasks/${task.id}/web`,{method:'POST',body:{url:'https://127.0.0.1/'}})).status,400);
});
test('approval API grants only an existing exact request and never exposes task-wide authorization',async t=>{
  const {bridge,request}=await fixture(t); const task=bridge.createTask('Approval HTTP fixture');
  const call={toolName:'project_create',input:{name:'Exact approval fixture',description:'Bounded local test'},toolCallId:'fixture-call'};
  const requested=await bridge.capabilityBroker.execute(task.id,call);const blocked=requested.decision;assert(blocked.approvalId);
  assert.equal((await request(`/api/approvals/${task.id}/approve`,{method:'POST',body:{}})).status,400);
  assert.equal((await request(`/api/approvals/${blocked.approvalId}/approve`,{method:'POST',body:{}})).status,202);
  const deadline=Date.now()+5000;while(bridge.inFlight.size && Date.now()<deadline) await new Promise(r=>setTimeout(r,20));
  assert.equal(bridge.policy.check(task.id,{...call,input:{...call.input,name:'different'}}).allow,false);
  assert.equal(bridge.projects.listProjects().length,1);assert.equal(bridge.policy.list(task.id).find(a=>a.id===blocked.approvalId).status,'consumed'); assert.equal(bridge.policy.check(task.id,call).allow,false);
});

test('menu status is authenticated and returns only aggregate measurements and fixed labels', async t => {
  const { bridge, ui, request } = await fixture(t);
  const now=Date.now();
  const secret = 'PRIVATE-TASK-PROMPT-OR-TOKEN';
  const first = bridge.tasks.get(bridge.createTask(secret).id);
  Object.assign(first, { connected: true, status: 'thinking', lastActivityAt: now-200, lastHeartbeatAt: now-100, error: secret, lastResult: secret });
  const second = bridge.tasks.get(bridge.createTask(secret).id);
  Object.assign(second, { status: secret, lastActivityAt: now, lastHeartbeatAt: null });
  const lease = bridge.leases.acquire(first.id);
  t.after(() => bridge.leases.releaseIfOwner(lease, { verified: true }));
  assert.equal((await request('/api/status', { authorized: false })).status, 401);
  assert.equal((await request('/api/status', { headers: { authorization: `Bearer ${ui.mcpToken}` } })).status, 401);
  assert.equal((await request('/api/status', { headers: { host: 'localhost' } })).status, 403);
  const response = await request('/api/status');
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.body).sort(), ['execution', 'healthy', 'lastActivityAt', 'lastHeartbeatAt', 'mcp', 'now', 'pid', 'tasks'].sort());
  assert.deepEqual(response.body.tasks, { active: 1, connected: 1, total: 2, counts: { thinking: 1, unknown: 1 } });
  assert.equal(response.body.execution.activeCount, 1);
  assert.equal(response.body.execution.activeTaskId, first.id);
  assert.deepEqual(response.body.mcp, { ready: true, lastCallAt: null });
  assert.equal(response.body.lastActivityAt, now);
  assert.equal(response.body.lastHeartbeatAt, now-100);
  assert.equal(response.body.pid, process.pid);
  assert(!JSON.stringify(response.body).includes(secret));
  assert.equal(bridge.snapshot().bridge.directChatGPT, false);
});

test('MCP health is credential-separated, read-only, and does not imply remote connectivity', async t => {
  const { bridge, ui, request } = await fixture(t);
  const headers = { authorization: `Bearer ${ui.mcpToken}` };
  assert.equal((await request('/api/mcp/health', { authorized: false })).status, 401);
  assert.equal((await request('/api/mcp/health')).status, 401, 'UI credential cannot authenticate MCP');
  assert.equal((await request('/api/mcp/health', { method: 'POST', body: {}, headers })).status, 405);
  assert.equal((await request('/api/mcp/health', { headers: { ...headers, origin: 'https://evil.example' } })).status, 403);
  const health = await request('/api/mcp/health', { headers });
  assert.equal(health.status, 200);
  assert.deepEqual(Object.keys(health.body).sort(), ['now', 'pid', 'ready']);
  assert.equal(health.body.ready, true);
  assert.equal(health.body.pid, process.pid);
  assert.equal(bridge.tasks.list().length, 0);
  assert.equal((await request('/api/status')).body.mcp.lastCallAt, null);
  assert(!require('../src/mcp-tools').TOOLS.some(tool => tool.name === 'health'));

  const task = bridge.tasks.get(bridge.createTask('Existing MCP fixture').id);
  task.source = { transport: 'mcp' };
  const failed = await request('/api/mcp/call', { method: 'POST', headers, body: { name: 'get_task_status', args: { task_id: 'invalid' } } });
  assert.equal(failed.status, 400);
  assert.equal((await request('/api/status')).body.mcp.lastCallAt, null);
  const before = Date.now();
  const call = await request('/api/mcp/call', { method: 'POST', headers, body: { name: 'get_task_status', args: { task_id: task.id } } });
  assert.equal(call.status, 200);
  const lastCallAt = (await request('/api/status')).body.mcp.lastCallAt;
  assert(lastCallAt >= before && lastCallAt <= Date.now());
  await request('/api/mcp/health', { headers });
  assert.equal((await request('/api/status')).body.mcp.lastCallAt, lastCallAt);
  assert.equal(bridge.snapshot().bridge.directChatGPT, false);
});

 test('Control Center exposes fresh tunnel states independently of task and MCP activity', async t => {
  const {ui,request}=await fixture(t);
  ui.lastMcpCallAt=Date.now();
  for(const state of ['connected','degraded','not_connected']) {
    const observation={state,connected:state==='connected',tunnelHealthy:state!=='not_connected',mcpProbe:state==='connected'?'ok':'failed'};
    ui.connectionStatus=async()=>observation;
    const response=await request('/api/state');
    assert.deepEqual(response.body.bridge.chatgptConnection,observation);
    assert.equal(response.body.bridge.directChatGPT,state==='connected');
    assert.equal((await request('/api/state',{headers:{authorization:`Bearer ${ui.mcpToken}`}})).status,401);
  }
});

test('public branding asset is same-origin, CSP compatible and exposes only public metadata', async t => {
  const { ui } = await fixture(t);
  const response = await new Promise((resolve, reject) => {
    http.get(ui.origin + '/branding.js', res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /text\/javascript/);
  assert.match(response.headers['content-security-policy'], /script-src 'self'/);
  assert.equal(response.body, fs.readFileSync(require.resolve('../public/branding'), 'utf8'));
  assert(!response.body.includes(ui.token));
});
