'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { LocalOllamaBroker, LocalOllamaToolProtocolVerifier, LOCAL_OLLAMA } = require('../src/local-ollama-broker');
const { authorizeLocalOllamaInference } = require('../src/bridge-controller');

class Response extends EventEmitter {
  constructor() { super(); this.headers = null; this.statusCode = null; this.chunks = []; this.writableEnded = false; this.destroyed = false; }
  writeHead(statusCode, headers) { this.statusCode = statusCode; this.headers = headers; }
  write(chunk) { this.chunks.push(Buffer.from(chunk)); }
  end(chunk) { if (chunk) this.write(chunk); this.writableEnded = true; this.emit('finish'); }
  text() { return Buffer.concat(this.chunks).toString('utf8'); }
}
function body(overrides = {}) {
  return {
    sessionId: 'session-1', url: LOCAL_OLLAMA.completionsUrl, method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: LOCAL_OLLAMA.model, stream: true, stream_options: { include_usage: true }, store: false, max_completion_tokens: 8192,
      messages: [{ role: 'user', content: 'fixture' }], ...overrides
    })
  };
}
function upstream(statusCode = 200, headers = { 'content-type': 'text/event-stream' }) {
  const response = new EventEmitter(); response.statusCode = statusCode; response.headers = headers; response.resume = () => {};
  return response;
}
function fixture({ statusCode = 200, headers, sseChunks } = {}) {
  const seen = [], audits = [];
  const request = (options, callback) => {
    const request = new EventEmitter(); request.setTimeout = () => request;
    request.destroy = error => { if (error) request.emit('error', error); };
    request.end = raw => {
      seen.push({ options, raw });
      const response = upstream(statusCode, headers);
      queueMicrotask(() => {
        callback(response);
        if (statusCode === 200) {
          for (const chunk of sseChunks || ['data: {"choices":[{"delta":{"content":"SIMULATION"}}]}\n\n', 'data: [DONE]\n\n']) response.emit('data', Buffer.from(chunk));
        }
        response.emit('end');
      });
    };
    return request;
  };
  const broker = new LocalOllamaBroker({ authorize: () => ({ allow: true }), isTaskActive: () => true, request, record: entry => audits.push(entry) });
  return { broker, seen, audits };
}
const task = { id: 'task-1', sessionId: 'session-1', mission: { id: 'mission-1' } };

function trustedAuthorizationFixture() {
  const workspace = fs.realpathSync(path.resolve(__dirname, '..'));
  const task = {
    id: 'trusted-task', sessionId: 'trusted-session', workspace, status: 'thinking', source: { transport: 'mcp' },
    activeRunId: 'trusted-run-a', mission: { id: 'trusted-mission', requireGrant: false, status: 'active' }
  };
  let currentTask = task;
  const runtime = {
    taskId: task.id, sessionId: task.sessionId, localOllamaTransport: true,
    provider: 'ollama', model: 'qwen3-coder:30b', endpoint: LOCAL_OLLAMA.baseUrl, runId: task.activeRunId
  };
  let grantChecks = 0;
  const bridge = {
    trustedDeveloperMode: true,
    tasks: { get: id => id === task.id ? currentTask : undefined },
    runtimes: new Map([[task.id, runtime]]), inFlight: new Set([task.id]), leases: { get: id => id === task.id ? { runId: task.activeRunId } : null },
    workerSandbox: { repoRoot: workspace }, config: { provider: 'ollama', model: 'qwen3-coder:30b' },
    missionAuthority: { verify: () => { grantChecks++; return { allow: false, reason: 'No active trusted mission grant' }; } }
  };
  return { bridge, task, runtime, setCurrent: value => { currentTask = value; }, grantChecks: () => grantChecks };
}

test('SIMULATION: trusted developer authorization is bound to the current active MCP task, session, workspace, and fixed local Ollama transport', () => {
  const allowed = trustedAuthorizationFixture();
  assert.deepEqual(authorizeLocalOllamaInference(allowed.bridge, allowed.task, allowed.runtime), { allow: true, source: 'trusted-developer-current-mcp-task' });
  assert.equal(allowed.grantChecks(), 0);

  const wrongTask = trustedAuthorizationFixture(); wrongTask.setCurrent({ ...wrongTask.task });
  assert.equal(authorizeLocalOllamaInference(wrongTask.bridge, wrongTask.task, wrongTask.runtime).allow, false);
  assert.equal(wrongTask.grantChecks(), 1);

  const wrongSession = trustedAuthorizationFixture(); wrongSession.runtime.sessionId = 'other-session';
  assert.equal(authorizeLocalOllamaInference(wrongSession.bridge, wrongSession.task, wrongSession.runtime).allow, false);

  const inactive = trustedAuthorizationFixture(); inactive.bridge.inFlight.clear();
  assert.equal(authorizeLocalOllamaInference(inactive.bridge, inactive.task, inactive.runtime).allow, false);

  const wrongProvider = trustedAuthorizationFixture(); wrongProvider.runtime.provider = 'other';
  assert.equal(authorizeLocalOllamaInference(wrongProvider.bridge, wrongProvider.task, wrongProvider.runtime).allow, false);
  const wrongModel = trustedAuthorizationFixture(); wrongModel.runtime.model = 'qwen3-coder:other';
  assert.equal(authorizeLocalOllamaInference(wrongModel.bridge, wrongModel.task, wrongModel.runtime).allow, false);

  const hardened = trustedAuthorizationFixture(); hardened.bridge.trustedDeveloperMode = false;
  assert.equal(authorizeLocalOllamaInference(hardened.bridge, hardened.task, hardened.runtime).allow, false);
  assert.equal(hardened.grantChecks(), 1);

  const staleRun = trustedAuthorizationFixture(); staleRun.runtime.runId = 'trusted-run-old';
  assert.equal(authorizeLocalOllamaInference(staleRun.bridge, staleRun.task, staleRun.runtime).allow, false);
  assert.equal(staleRun.grantChecks(), 1);

  const staleRequestRun = trustedAuthorizationFixture();
  assert.equal(authorizeLocalOllamaInference(staleRequestRun.bridge, staleRequestRun.task, staleRequestRun.runtime, 'trusted-run-old').allow, false);
  assert.equal(staleRequestRun.grantChecks(), 1);

  const staleRuntime = trustedAuthorizationFixture();
  assert.equal(authorizeLocalOllamaInference(staleRuntime.bridge, staleRuntime.task, { ...staleRuntime.runtime }).allow, false);
  assert.equal(staleRuntime.grantChecks(), 1);

  const crossTask = trustedAuthorizationFixture();
  const unrelated = { ...crossTask.task, id: 'unrelated-task', sessionId: 'unrelated-session', activeRunId: 'unrelated-run' };
  crossTask.bridge.tasks.get = id => id === unrelated.id ? unrelated : undefined;
  crossTask.bridge.runtimes.set(unrelated.id, crossTask.runtime);
  crossTask.bridge.inFlight.add(unrelated.id);
  crossTask.bridge.leases.get = id => id === unrelated.id ? { runId: unrelated.activeRunId } : null;
  assert.equal(authorizeLocalOllamaInference(crossTask.bridge, unrelated, crossTask.runtime, unrelated.activeRunId).allow, false);
  assert.equal(crossTask.grantChecks(), 1);

  const safetyStopped = trustedAuthorizationFixture(); safetyStopped.task.safetyStop = { latched: true };
  assert.equal(authorizeLocalOllamaInference(safetyStopped.bridge, safetyStopped.task, safetyStopped.runtime).allow, false);
  assert.equal(safetyStopped.grantChecks(), 1);
});

test('SIMULATION: the broker gives its current runtime and captured request run to authorization, so a stale task runtime cannot inherit a newer lease', async () => {
  let authorizedRuntime = null;
  let authorizedRunId = null;
  const broker = new LocalOllamaBroker({
    authorize: (_task, runtime, context) => { authorizedRuntime = runtime; authorizedRunId = context.runId; return { allow: false, reason: 'stale runtime' }; },
    isTaskActive: () => true,
    request: () => { throw new Error('must not connect'); }
  });
  const runtime = { runId: 'current-run' };
  const response = new Response();
  await broker.proxy({ task, runtime, runId: 'captured-old-run', body: body(), response });
  assert.equal(authorizedRuntime, runtime);
  assert.equal(authorizedRunId, 'captured-old-run');
  assert.equal(response.statusCode, 403);
  assert.match(response.text(), /stale runtime/);
});

test('SIMULATION: brokered local Ollama streaming uses only the fixed loopback endpoint and records redacted metadata', async () => {
  const f = fixture(); const response = new Response();
  await f.broker.proxy({ task, runtime: {}, body: body({ tools: [{ type: 'function', function: { name: 'read', description: 'Read one fixture file.', parameters: { type: 'object' }, strict: false } }] }), response });
  assert.equal(f.seen.length, 1);
  assert.deepEqual(f.seen[0].options, {
    hostname: '127.0.0.1', port: 11434, path: '/v1/chat/completions', method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'Content-Length': String(Buffer.byteLength(f.seen[0].raw)) }
  });
  assert.equal(response.statusCode, 200);
  assert.match(response.text(), /SIMULATION/);
  assert.equal(f.audits[0].decision, 'allow');
  assert.equal(f.audits[0].executionStatus, 'COMPLETED');
  assert.equal(Object.hasOwn(f.audits[0], 'body'), false);
  assert.deepEqual(f.audits[0].transport, {
    temperature: null, toolsPresent: true, toolNames: ['read'],
    toolSchemaSha256: f.audits[0].transport.toolSchemaSha256, toolChoice: null,
    selectedModel: LOCAL_OLLAMA.model, routeRole: 'primary',
    primaryModel: LOCAL_OLLAMA.model, toolModel: LOCAL_OLLAMA.toolModel,
    response: { finishReason: null, nativeToolCallsPresent: false, nativeToolNames: [], malformedSse: false }
  });
  assert.match(f.audits[0].transport.toolSchemaSha256, /^[a-f0-9]{64}$/);
});

function modelInfoRequest(modelInfo) {
  return (_options, callback) => {
    const client = new EventEmitter();
    client.setTimeout = () => client;
    client.destroy = () => { queueMicrotask(() => client.emit('error', new Error('destroyed'))); };
    client.end = () => {
      const response = new EventEmitter(); response.statusCode = 200;
      queueMicrotask(() => { callback(response); response.emit('data', Buffer.from(JSON.stringify(modelInfo))); response.emit('end'); });
    };
    return client;
  };
}

test('SIMULATION: model capability gate requires an Ollama template that renders native tool calls', async () => {
  const supported = new LocalOllamaToolProtocolVerifier({ request: modelInfoRequest({ capabilities: ['completion', 'tools'], template: '{{ .Tools }} {{ .ToolCalls }}' }) });
  assert.deepEqual(await supported.verify(LOCAL_OLLAMA.model), {
    available: true, source: 'ollama_show', reason: null, digest: null,
    templateHash: require('../src/local-model-capability').hash('{{ .Tools }} {{ .ToolCalls }}'),
    qwen3RendererParser: false, templateHasTools: true
  });
  const unsupported = new LocalOllamaToolProtocolVerifier({ request: modelInfoRequest({ capabilities: ['completion', 'tools'], template: '{{ .Prompt }}' }) });
  assert.deepEqual(await unsupported.verify(LOCAL_OLLAMA.model), {
    available: false, source: 'ollama_show', reason: 'native_tool_template_missing', digest: null,
    templateHash: require('../src/local-model-capability').hash('{{ .Prompt }}'),
    qwen3RendererParser: false, templateHasTools: false
  });

  const audits = [];
  const broker = new LocalOllamaBroker({
    authorize: () => ({ allow: true }), isTaskActive: () => true,
    verifyToolProtocol: async () => ({ available: false, source: 'ollama_show', reason: 'native_tool_template_missing' }),
    request: () => { throw new Error('native inference must not start'); }, record: entry => audits.push(entry)
  });
  const response = new Response();
  await broker.proxy({ task, runtime: {}, body: body({ tools: [{ type: 'function', function: { name: 'personal_memory_search', description: 'Search memory.', parameters: { type: 'object' }, strict: false } }], tool_choice: { type: 'function', function: { name: 'personal_memory_search' } } }), response });
  assert.equal(response.statusCode, 503);
  assert.match(response.text(), /cannot make native tool calls/);
  assert.equal(audits.length, 1);
  assert.deepEqual(audits[0].transport.toolProtocol, { available: false, source: 'ollama_show', reason: 'native_tool_template_missing' });
});

test('SIMULATION: privileged native tool turns fail closed without a qualified capability record', async () => {
  const audits = [];
  const broker = new LocalOllamaBroker({
    authorize: () => ({ allow: true }), isTaskActive: () => true,
    verifyToolProtocol: async () => ({ available: true, source: 'ollama_show', reason: null, digest: 'sha256:abc', templateHash: 'tmpl' }),
    verifyCapability: async () => ({ allow: false, status: 'unqualified', reason: 'capability_record_missing', record: null }),
    request: () => { throw new Error('native inference must not start'); }, record: entry => audits.push(entry)
  });
  const response = new Response();
  await broker.proxy({
    task, runtime: {},
    body: body({
      tools: [{ type: 'function', function: { name: 'personal_memory_search', description: 'Search memory.', parameters: { type: 'object' }, strict: false } }],
      tool_choice: { type: 'function', function: { name: 'personal_memory_search' } }
    }),
    response
  });
  assert.equal(response.statusCode, 503);
  assert.match(response.text(), /not capability-qualified/);
  assert.equal(audits[0].transport.capability.allow, false);
  assert.equal(audits[0].transport.capability.reason, 'capability_record_missing');
  assert.equal(audits[0].transport.routeRole, 'tool');
});

test('SIMULATION: broker records native tool-call response metadata from the final SSE stream without retaining its content', async () => {
  const f = fixture({ sseChunks: [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"personal_memory_search","arguments":"{\\"query\\":\\"smoke verification\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n'
  ] });
  const response = new Response();
  await f.broker.proxy({
    task, runtime: {},
    body: body({
      tools: [{ type: 'function', function: { name: 'personal_memory_search', description: 'Search memory.', parameters: { type: 'object' }, strict: false } }],
      tool_choice: { type: 'function', function: { name: 'personal_memory_search' } }
    }),
    response
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(f.audits[0].transport.response, {
    finishReason: 'tool_calls', nativeToolCallsPresent: true,
    nativeToolNames: ['personal_memory_search'], malformedSse: false
  });
  assert.equal(JSON.stringify(f.audits[0]).includes('smoke verification'), false);
});

test('SIMULATION: local Ollama broker rejects cross-session, substituted model, proxy target, and unsupported request parameters before connecting', async () => {
  const cases = [
    { body: { ...body(), sessionId: 'other-session' }, message: /session is not authorized/ },
    { body: body({ model: 'qwen3-coder:other' }), message: /model or streaming request is invalid/ },
    { body: { ...body(), url: 'http://127.0.0.1:11434/v1/models' }, message: /destination is not authorized/ },
    { body: body({ proxy: 'http://elsewhere.invalid' }), message: /unsupported parameter/ }
  ];
  for (const sample of cases) {
    const f = fixture(); const response = new Response();
    await f.broker.proxy({ task, runtime: {}, body: sample.body, response });
    assert.equal(f.seen.length, 0);
    assert.equal(response.statusCode, sample.body.sessionId === 'other-session' || sample.body.url !== LOCAL_OLLAMA.completionsUrl ? 403 : 400, sample.message);
    assert.match(response.text(), sample.message);
    assert.equal(f.audits[0].executionStatus, 'NOT EXECUTED');
  }
});

test('SIMULATION: broker accepts only the pinned Pi 0.87.1 OpenAI-Completions shape, including bounded function tools', async () => {
  const tool = { type: 'function', function: {
    name: 'read', description: 'Read one fixture file.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false }, strict: false
  } };
  const f = fixture(); const response = new Response();
  await f.broker.proxy({ task, runtime: {}, body: body({ temperature: 0.2, tools: [tool], tool_choice: { type: 'function', function: { name: 'read' } } }), response });
  assert.equal(response.statusCode, 200);
  assert.equal(f.seen.length, 1);

  const invalid = [
    [{ store: true }, /store option is invalid/],
    [{ stream_options: { include_usage: false } }, /stream options are invalid/],
    [{ max_completion_tokens: 8193 }, /completion limit is invalid/],
    [{ temperature: 2.1 }, /temperature is invalid/],
    [{ tools: [{ ...tool, function: { ...tool.function, strict: true } }] }, /tool request is invalid/],
    [{ tool_choice: { type: 'function', function: { name: '../escape' } } }, /tool choice is invalid/],
    [{ service_tier: 'priority' }, /unsupported parameter/]
  ];
  for (const [overrides, message] of invalid) {
    const denied = fixture(); const deniedResponse = new Response();
    await denied.broker.proxy({ task, runtime: {}, body: body(overrides), response: deniedResponse });
    assert.equal(denied.seen.length, 0);
    assert.equal(deniedResponse.statusCode, 400);
    assert.match(deniedResponse.text(), message);
  }
});

test('SIMULATION: a denied grant, inactive task, redirect, or cancelled call fails closed', async () => {
  const inactive = new LocalOllamaBroker({ authorize: () => ({ allow: true }), isTaskActive: () => false, request: () => { throw new Error('must not connect'); } });
  const inactiveResponse = new Response();
  await inactive.proxy({ task, runtime: {}, body: body(), response: inactiveResponse });
  assert.equal(inactiveResponse.statusCode, 403);

  const denied = new LocalOllamaBroker({ authorize: () => ({ allow: false, reason: 'grant expired' }), isTaskActive: () => true, request: () => { throw new Error('must not connect'); } });
  const deniedResponse = new Response();
  await denied.proxy({ task, runtime: {}, body: body(), response: deniedResponse });
  assert.equal(deniedResponse.statusCode, 403);
  assert.match(deniedResponse.text(), /grant expired/);

  const redirected = fixture({ statusCode: 302, headers: { location: 'http://127.0.0.1:11434/elsewhere' } });
  const redirectResponse = new Response();
  await redirected.broker.proxy({ task, runtime: {}, body: body(), response: redirectResponse });
  assert.equal(redirectResponse.statusCode, 502);
  assert.match(redirectResponse.text(), /redirect rejected/);
  assert.equal(redirected.audits[0].executionStatus, 'NOT EXECUTED');
});

test('SIMULATION: a post-header stream failure terminates SSE instead of appending a JSON error', async () => {
  const request = (_options, callback) => {
    const client = new EventEmitter();
    client.setTimeout = () => client;
    client.destroy = () => client;
    client.end = () => {
      const source = upstream();
      queueMicrotask(() => {
        callback(source);
        source.emit('data', Buffer.from('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
        source.emit('error', new Error('fixture stream failure'));
      });
    };
    return client;
  };
  const audits = [];
  const broker = new LocalOllamaBroker({ authorize: () => ({ allow: true }), isTaskActive: () => true, request, record: entry => audits.push(entry) });
  const response = new Response();
  response.destroy = () => { response.destroyed = true; };
  await broker.proxy({ task, runtime: {}, body: body(), response });
  assert.equal(response.statusCode, 200);
  assert.match(response.text(), /partial/);
  assert.doesNotMatch(response.text(), /local_ollama_broker_error/);
  assert.equal(response.destroyed, true);
  assert.equal(audits[0].executionStatus, 'NOT EXECUTED');
});

test('SIMULATION: isolated workspace cannot inherit repository inference authority; exact signed inference grant remains required',()=>{
 const f=trustedAuthorizationFixture();f.task.workspace=fs.mkdtempSync('/private/tmp/grant-workspace-');try{assert.equal(authorizeLocalOllamaInference(f.bridge,f.task,f.runtime).allow,false);assert.equal(f.grantChecks(),1);}finally{fs.rmSync(f.task.workspace,{recursive:true,force:true});}
});

test('SIMULATION: valid signed reasoning grant reaches provider outage; absent grant fails closed without transport and is classified separately',async()=>{
 const {MissionAuthority}=require('../src/mission-authority');const previous=process.env.NODE_ENV;process.env.NODE_ENV='test';const authority=new MissionAuthority({fixtureOnly:true});if(previous===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previous;
 const workspace=fs.mkdtempSync('/private/tmp/reasoning-grant-');try{const mission={id:'reasoning-fixture',workspace,objective:'Reason about abstract priorities',criteria:[],requireGrant:true};const grant=authority.issueFixtureGrant(mission,{capabilities:['inference']});mission.grantId=grant.id;assert.equal(authority.verify(mission,'inference').allow,true);let requests=0,audits=[];const broker=new LocalOllamaBroker({authorize:()=>authority.verify(mission,'inference'),isTaskActive:()=>true,record:e=>audits.push(e),request:()=>{requests++;throw Object.assign(Error('ECONNREFUSED'),{code:'ECONNREFUSED'});}});const task={id:'signed',sessionId:'session-1'},response=new Response();await broker.proxy({task,runtime:{},body:body(),response});assert.equal(requests,1);const {NativeExecutionRouter}=require('../src/native-execution-router');const router=new NativeExecutionRouter({config:{provider:'ollama'},_ledgerRecord:()=>{},_ledgerContext:()=>({})});task.reasoningProviderUnavailable=true;assert.equal(router.providerFailure(task,Error('ECONNREFUSED')),true);assert.equal(task.status,'waiting_for_provider');delete mission.grantId;audits=[];await broker.proxy({task,runtime:{},body:body(),response:new Response()});assert.equal(requests,1);assert.equal(audits[0].authorizationDenied,true);task.reasoningAuthorizationDenied={reason:'trusted_inference_authorization_denied'};assert.equal(router.providerFailure(task,Error('403 No active trusted mission grant')),false);assert.equal(task.failureKind,'mission_grant_denied');assert.equal(task.providerWait,null);
 }finally{fs.rmSync(workspace,{recursive:true,force:true});}
});
