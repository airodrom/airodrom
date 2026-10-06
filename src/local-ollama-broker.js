'use strict';

const http = require('node:http');
const { createHash } = require('node:crypto');
const {
  inspectOllamaShow,
  routeLocalOllamaModel
} = require('./local-model-capability');

const LOCAL_OLLAMA = Object.freeze({
  baseUrl: 'http://127.0.0.1:11434/v1',
  completionsUrl: 'http://127.0.0.1:11434/v1/chat/completions',
  hostname: '127.0.0.1',
  port: 11434,
  path: '/v1/chat/completions',
  // Primary reasoning/coding model. Privileged native-tool turns use toolModel
  // once that tag is capability-qualified. They may be the same installed tag.
  model: 'qwen3-coder:30b',
  toolModel: 'qwen3-coder:30b'
});
const LIMITS = Object.freeze({ inputBytes: 128 * 1024, outputBytes: 4 * 1024 * 1024, timeoutMs: 120_000, maxConcurrent: 1 });
const REQUEST_KEYS = new Set([
  // These are the complete fields emitted by the bounded provider transport
  // openai-completions transport for the configured local Ollama model. Do not
  // turn this into a general OpenAI-compatible proxy.
  'model', 'messages', 'stream', 'stream_options', 'store', 'max_completion_tokens',
  'temperature', 'tools', 'tool_choice'
]);
const MAX_COMPLETION_TOKENS = 8192;
const MAX_MESSAGE_CONTENT_CHARS = 96 * 1024;
const MAX_TOOL_NAME_CHARS = 128;
const MAX_TOOL_DESCRIPTION_CHARS = 16 * 1024;
const MAX_SCHEMA_DEPTH = 16;
const MAX_SCHEMA_NODES = 1024;
const TOOL_NAME = /^[A-Za-z0-9_-]+$/;
const TOOL_PROTOCOL_LIMITS = Object.freeze({ timeoutMs: 3_000, responseBytes: 256 * 1024, cacheMs: 60_000 });

function fail(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function allowedModels() {
  return new Set([LOCAL_OLLAMA.model, LOCAL_OLLAMA.toolModel].filter(Boolean));
}
function nativeToolChoiceRequested(payload) {
  const choice = payload?.tool_choice;
  return Array.isArray(payload?.tools) && payload.tools.length > 0 &&
    (choice === 'required' || (plainObject(choice) && choice.type === 'function'));
}
function privilegedNativeToolTurn(payload) {
  const choice = payload?.tool_choice;
  const tools = Array.isArray(payload?.tools) ? payload.tools : [];
  if (tools.length === 0) return false;
  if (choice === 'required' || (plainObject(choice) && choice.type === 'function')) return true;
  return Array.isArray(payload?.messages) && payload.messages.some(message => message?.role === 'tool');
}
function safeToolProtocolStatus(status) {
  return {
    available: status?.available === true,
    source: status?.source === 'ollama_show' || status?.source === 'capability_registry' ? status.source : 'unknown',
    reason: typeof status?.reason === 'string' && /^[a-z0-9_]{1,80}$/.test(status.reason) ? status.reason : null
  };
}
function safeCapabilityStatus(status) {
  return {
    allow: status?.allow === true,
    status: ['qualified', 'stale', 'unqualified'].includes(status?.status) ? status.status : 'unqualified',
    reason: typeof status?.reason === 'string' && /^[a-z0-9_]{1,80}$/.test(status.reason) ? status.reason : null,
    model: typeof status?.record?.model === 'string' ? status.record.model : null,
    digest: typeof status?.record?.digest === 'string' ? status.record.digest : null,
    template_hash: typeof status?.record?.template_hash === 'string' ? status.record.template_hash : null
  };
}
function exactObject(value, required) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key));
}
function plainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function boundedString(value, limit) { return typeof value === 'string' && value.length <= limit; }
function validToolName(value) { return boundedString(value, MAX_TOOL_NAME_CHARS) && TOOL_NAME.test(value); }
function validJsonValue(value, state, depth = 0) {
  if (depth > MAX_SCHEMA_DEPTH || ++state.nodes > MAX_SCHEMA_NODES) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(entry => validJsonValue(entry, state, depth + 1));
  if (!plainObject(value)) return false;
  return Object.entries(value).every(([key, entry]) => boundedString(key, 256) && key !== '__proto__' && key !== 'constructor' && key !== 'prototype' && validJsonValue(entry, state, depth + 1));
}
function validContent(content) {
  if (boundedString(content, MAX_MESSAGE_CONTENT_CHARS)) return true;
  if (!Array.isArray(content) || content.length < 1 || content.length > 512) return false;
  return content.every(part => exactObject(part, ['type', 'text']) && part.type === 'text' && boundedString(part.text, MAX_MESSAGE_CONTENT_CHARS));
}
function validToolCalls(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= 64 && value.every(call =>
    exactObject(call, ['id', 'type', 'function']) && boundedString(call.id, 256) && call.type === 'function' &&
    exactObject(call.function, ['name', 'arguments']) && validToolName(call.function.name) && boundedString(call.function.arguments, MAX_MESSAGE_CONTENT_CHARS));
}
function validMessage(message) {
  if (!plainObject(message) || typeof message.role !== 'string') return false;
  if (message.role === 'system' || message.role === 'developer' || message.role === 'user') {
    return exactObject(message, ['role', 'content']) && validContent(message.content);
  }
  if (message.role === 'assistant') {
    if (!Object.keys(message).every(key => ['role', 'content', 'tool_calls'].includes(key)) || !Object.hasOwn(message, 'content')) return false;
    return (message.content === null || boundedString(message.content, MAX_MESSAGE_CONTENT_CHARS)) &&
      (message.tool_calls === undefined || validToolCalls(message.tool_calls));
  }
  if (message.role === 'tool') {
    return exactObject(message, ['role', 'content', 'tool_call_id']) &&
      boundedString(message.content, MAX_MESSAGE_CONTENT_CHARS) && boundedString(message.tool_call_id, 256);
  }
  return false;
}
function validTools(tools) {
  return Array.isArray(tools) && tools.length <= 64 && tools.every(tool =>
    exactObject(tool, ['type', 'function']) && tool.type === 'function' && plainObject(tool.function) &&
    Object.keys(tool.function).every(key => ['name', 'description', 'parameters', 'strict'].includes(key)) &&
    validToolName(tool.function.name) && boundedString(tool.function.description, MAX_TOOL_DESCRIPTION_CHARS) &&
    plainObject(tool.function.parameters) && tool.function.strict === false &&
    validJsonValue(tool.function.parameters, { nodes: 0 }));
}
function validToolChoice(value) {
  if (value === 'auto' || value === 'none' || value === 'required') return true;
  return exactObject(value, ['type', 'function']) && value.type === 'function' &&
    exactObject(value.function, ['name']) && validToolName(value.function.name);
}
function validatePayload(payload) {
  if (!plainObject(payload) || Object.keys(payload).some(key => !REQUEST_KEYS.has(key))) throw fail('Local Ollama request includes an unsupported parameter');
  if (!allowedModels().has(payload.model) || payload.stream !== true || !Array.isArray(payload.messages) || payload.messages.length < 1 || payload.messages.length > 512 || !payload.messages.every(validMessage)) throw fail('Local Ollama model or streaming request is invalid');
  if (!exactObject(payload.stream_options, ['include_usage']) || payload.stream_options.include_usage !== true) throw fail('Local Ollama stream options are invalid');
  if (payload.store !== false) throw fail('Local Ollama store option is invalid');
  if (!Number.isInteger(payload.max_completion_tokens) || payload.max_completion_tokens < 1 || payload.max_completion_tokens > MAX_COMPLETION_TOKENS) throw fail('Local Ollama completion limit is invalid');
  if (payload.temperature !== undefined && (typeof payload.temperature !== 'number' || !Number.isFinite(payload.temperature) || payload.temperature < 0 || payload.temperature > 2)) throw fail('Local Ollama temperature is invalid');
  if (payload.tools !== undefined && !validTools(payload.tools)) throw fail('Local Ollama tool request is invalid');
  if (payload.tool_choice !== undefined && !validToolChoice(payload.tool_choice)) throw fail('Local Ollama tool choice is invalid');
}
function validateInboundRequest(body, task) {
  if (!exactObject(body, ['sessionId', 'url', 'method', 'headers', 'body'])) throw fail('Local Ollama request shape is invalid');
  if (typeof body.sessionId !== 'string' || body.sessionId.length < 1 || body.sessionId.length > 256 || body.sessionId !== task.sessionId) throw fail('Local Ollama request session is not authorized', 403);
  if (body.url !== LOCAL_OLLAMA.completionsUrl || body.method !== 'POST') throw fail('Local Ollama destination is not authorized', 403);
  if (!body.headers || typeof body.headers !== 'object' || Array.isArray(body.headers) || Object.keys(body.headers).length > 32 ||
      Object.entries(body.headers).some(([key, value]) => typeof key !== 'string' || key.length > 200 || typeof value !== 'string' || value.length > 4096)) {
    throw fail('Local Ollama request headers are invalid');
  }
  if (typeof body.body !== 'string' || Buffer.byteLength(body.body) < 2 || Buffer.byteLength(body.body) > LIMITS.inputBytes) throw fail('Local Ollama request exceeds the input limit');
  let payload;
  try { payload = JSON.parse(body.body); } catch { throw fail('Local Ollama request body is not JSON'); }
  validatePayload(payload);
  return { payload, body: body.body, inputBytes: Buffer.byteLength(body.body), inputSha256: hash(body.body) };
}

// Audit the transport contract without retaining prompt text, tool descriptions,
// schemas, headers, or the request body. This makes a live native-tool failure
// diagnosable from the durable ledger while preserving the payload boundary.
function transportSummary(payload, { toolProtocol, capability, route, response } = {}) {
  const tools = Array.isArray(payload?.tools) ? payload.tools : [];
  const choice = payload?.tool_choice;
  const toolChoice = typeof choice === 'string'
    ? choice
    : choice?.type === 'function' && typeof choice.function?.name === 'string'
      ? `function:${choice.function.name}`
      : null;
  const summary = {
    temperature: typeof payload?.temperature === 'number' ? payload.temperature : null,
    toolsPresent: tools.length > 0,
    toolNames: tools.map(tool => tool.function.name),
    toolSchemaSha256: tools.length > 0 ? hash(JSON.stringify(tools)) : null,
    toolChoice,
    selectedModel: typeof payload?.model === 'string' ? payload.model : null,
    routeRole: route?.role === 'tool' || route?.role === 'primary' ? route.role : null,
    primaryModel: LOCAL_OLLAMA.model,
    toolModel: LOCAL_OLLAMA.toolModel
  };
  if (toolProtocol) summary.toolProtocol = safeToolProtocolStatus(toolProtocol);
  if (capability) summary.capability = safeCapabilityStatus(capability);
  if (response) summary.response = response;
  return summary;
}

function createResponseSummary() {
  let buffered = '';
  let malformed = false;
  let terminalFinishReason = null;
  const toolNames = new Set();
  const consume = event => {
    const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
    if (!data || data === '[DONE]') return;
    let payload;
    try { payload = JSON.parse(data); } catch { malformed = true; return; }
    for (const choice of Array.isArray(payload?.choices) ? payload.choices : []) {
      if (typeof choice?.finish_reason === 'string') terminalFinishReason = choice.finish_reason;
      const calls = choice?.delta?.tool_calls || choice?.message?.tool_calls;
      for (const call of Array.isArray(calls) ? calls : []) {
        if (typeof call?.function?.name === 'string' && validToolName(call.function.name)) toolNames.add(call.function.name);
      }
    }
  };
  return {
    observe(chunk) {
      buffered += Buffer.from(chunk).toString('utf8');
      while (true) {
        const boundary = buffered.search(/\r?\n\r?\n/);
        if (boundary < 0) break;
        const event = buffered.slice(0, boundary);
        const separator = buffered.slice(boundary).match(/^\r?\n\r?\n/)[0].length;
        buffered = buffered.slice(boundary + separator);
        consume(event);
      }
      if (Buffer.byteLength(buffered) > 64 * 1024) { malformed = true; buffered = ''; }
    },
    finish() {
      if (buffered) consume(buffered);
      return {
        finishReason: terminalFinishReason,
        nativeToolCallsPresent: toolNames.size > 0,
        nativeToolNames: [...toolNames],
        malformedSse: malformed
      };
    }
  };
}

class LocalOllamaToolProtocolVerifier {
  constructor({ request = http.request, now = () => Date.now(), cacheMs = TOOL_PROTOCOL_LIMITS.cacheMs } = {}) {
    this.request = request; this.now = now; this.cacheMs = cacheMs; this.cache = new Map();
  }

  async verify(model) {
    const cached = this.cache.get(model);
    if (cached && cached.expiresAt > this.now()) return cached.status;
    const status = await new Promise(resolve => {
      const body = JSON.stringify({ name: model });
      let settled = false;
      const finish = value => { if (!settled) { settled = true; resolve(value); } };
      let request;
      try {
        request = this.request({ hostname: LOCAL_OLLAMA.hostname, port: LOCAL_OLLAMA.port, path: '/api/show', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) } }, response => {
          const chunks = []; let bytes = 0;
          response.on('data', chunk => {
            bytes += Buffer.byteLength(chunk);
            if (bytes > TOOL_PROTOCOL_LIMITS.responseBytes) return request.destroy();
            chunks.push(Buffer.from(chunk));
          });
          response.once('error', () => finish({ available: false, source: 'ollama_show', reason: 'model_info_unavailable' }));
          response.once('end', () => {
            if (response.statusCode !== 200 || bytes > TOOL_PROTOCOL_LIMITS.responseBytes) return finish({ available: false, source: 'ollama_show', reason: 'model_info_unavailable' });
            try {
              const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              const inspected = inspectOllamaShow(value);
              finish({
                available: inspected.available,
                source: 'ollama_show',
                reason: inspected.reason,
                digest: inspected.digest,
                templateHash: inspected.templateHash,
                qwen3RendererParser: inspected.qwen3RendererParser === true,
                templateHasTools: inspected.templateHasTools === true
              });
            } catch { finish({ available: false, source: 'ollama_show', reason: 'model_info_unavailable' }); }
          });
        });
        request.setTimeout?.(TOOL_PROTOCOL_LIMITS.timeoutMs, () => request.destroy());
        request.once('error', () => finish({ available: false, source: 'ollama_show', reason: 'model_info_unavailable' }));
        request.end(body);
      } catch { finish({ available: false, source: 'ollama_show', reason: 'model_info_unavailable' }); }
    });
    this.cache.set(model, { status, expiresAt: this.now() + this.cacheMs });
    return status;
  }
}

function writeJsonError(response, statusCode, message) {
  if (response.writableEnded || response.destroyed) return;
  response.writeHead(statusCode, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify({ error: { message, type: 'local_ollama_broker_error' } }));
}

class LocalOllamaBroker {
  constructor({
    authorize, isTaskActive, record = () => {}, request = http.request,
    verifyToolProtocol = async () => ({ available: true, source: 'unknown', reason: null }),
    verifyCapability = async () => ({ allow: true, status: 'qualified', reason: null, record: null }),
    now = () => Date.now()
  } = {}) {
    if (typeof authorize !== 'function' || typeof isTaskActive !== 'function') throw new Error('Local Ollama broker requires authorization and task-activity checks');
    this.authorize = authorize; this.isTaskActive = isTaskActive; this.record = record; this.request = request;
    this.verifyToolProtocol = verifyToolProtocol; this.verifyCapability = verifyCapability; this.now = now;
    this.active = new Map();
  }

  async proxy({ task, runtime, runId = runtime?.runId, body, response, signal }) {
    const startedAt = this.now();
    let verified, toolProtocol, capability, route, authorizationDenied=false;
    try {
      if (!runtime || !this.isTaskActive(task)) throw fail('Local Ollama inference is unavailable for this task', 403);
      verified = validateInboundRequest(body, task);
      route = routeLocalOllamaModel({
        primaryModel: LOCAL_OLLAMA.model,
        toolModel: LOCAL_OLLAMA.toolModel,
        payload: verified.payload
      });
      if (this.active.size >= LIMITS.maxConcurrent || this.active.has(task.id)) throw fail('Local Ollama inference concurrency limit reached', 429);
      const authorization = this.authorize(task, runtime, { runId });
      if (!authorization?.allow) {authorizationDenied=true;throw fail(authorization?.reason || 'Mission grant does not authorize local inference', 403);}
      if (privilegedNativeToolTurn(verified.payload)) {
        toolProtocol = await this.verifyToolProtocol(verified.payload.model);
        if (toolProtocol?.available !== true) throw fail('Configured local Ollama model cannot make native tool calls', 503);
        capability = await this.verifyCapability(verified.payload.model, {
          digest: toolProtocol.digest || null,
          templateHash: toolProtocol.templateHash || null
        });
        if (capability?.allow !== true) throw fail('Configured local Ollama model is not capability-qualified for native tools', 503);
      }
    } catch (error) {
      this.record({ task, authorizationDenied, decision: 'deny', executionStatus: 'NOT EXECUTED', reason: error.message, inputBytes: verified?.inputBytes || 0, inputSha256: verified?.inputSha256 || null, ...(verified ? { transport: transportSummary(verified.payload, { toolProtocol, capability, route }) } : {}), durationMs: this.now() - startedAt });
      writeJsonError(response, error.statusCode || 400, error.message);
      return;
    }

    await new Promise(resolve => {
      let completed = false, outputBytes = 0, upstream, timer, responseStarted = false;
      const responseSummary = createResponseSummary();
      const controller = new AbortController();
      const finish = (decision, executionStatus, reason = null) => {
        if (completed) return;
        completed = true; clearTimeout(timer); this.active.delete(task.id);
        this.record({ task, decision, executionStatus, reason, inputBytes: verified.inputBytes, inputSha256: verified.inputSha256, transport: transportSummary(verified.payload, { toolProtocol, capability, route, response: responseSummary.finish() }), outputBytes, durationMs: this.now() - startedAt });
        resolve();
      };
      const abort = reason => {
        if (completed) return;
        controller.abort();
        upstream?.destroy?.(new Error(reason));
        // A JSON error after SSE headers would corrupt the provider stream parser.
        // End an already-started stream instead; send JSON only before headers.
        if (!response.destroyed && !response.writableEnded) {
          if (responseStarted) response.destroy?.();
          else writeJsonError(response, 499, reason);
        }
        finish('deny', 'CANCELLED', reason);
      };
      if (signal?.aborted) return abort('Local Ollama inference cancelled');
      signal?.addEventListener('abort', () => abort('Local Ollama inference cancelled'), { once: true });
      response.once?.('close', () => { if (!response.writableEnded) abort('Local Ollama client disconnected'); });
      timer = setTimeout(() => abort('Local Ollama inference timed out'), LIMITS.timeoutMs);
      this.active.set(task.id, controller);
      try {
        upstream = this.request({
          hostname: LOCAL_OLLAMA.hostname, port: LOCAL_OLLAMA.port, path: LOCAL_OLLAMA.path, method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'Content-Length': String(verified.inputBytes) }
        }, upstreamResponse => {
          const status = Number(upstreamResponse.statusCode || 502);
          const contentType = String(upstreamResponse.headers?.['content-type'] || '').toLowerCase();
          if (status >= 300 && status < 400) {
            upstreamResponse.resume?.(); writeJsonError(response, 502, 'Local Ollama redirect rejected'); return finish('deny', 'NOT EXECUTED', 'redirect rejected');
          }
          if (status !== 200 || !contentType.includes('text/event-stream')) {
            upstreamResponse.resume?.(); writeJsonError(response, status >= 400 && status < 600 ? status : 502, 'Local Ollama returned an unsupported response'); return finish('deny', 'NOT EXECUTED', 'unsupported upstream response');
          }
          responseStarted = true;
          response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          upstreamResponse.on('data', chunk => {
            if (completed) return;
            outputBytes += Buffer.byteLength(chunk);
            if (outputBytes > LIMITS.outputBytes) return abort('Local Ollama inference output limit exceeded');
            responseSummary.observe(chunk);
            response.write(chunk);
          });
          upstreamResponse.once('error', error => {
            if (!completed) {
              if (responseStarted) response.destroy?.();
              else writeJsonError(response, 502, 'Local Ollama stream failed');
              finish('deny', 'NOT EXECUTED', error.message);
            }
          });
          upstreamResponse.once('end', () => {
            if (completed) return;
            response.end(); finish('allow', 'COMPLETED');
          });
        });
        upstream.setTimeout?.(LIMITS.timeoutMs, () => abort('Local Ollama inference timed out'));
        upstream.once?.('error', error => {
          if (!completed) {
            if (responseStarted) response.destroy?.();
            else writeJsonError(response, 502, 'Local Ollama connection failed');
            finish('deny', 'NOT EXECUTED', error.message);
          }
        });
        upstream.end(verified.body);
      } catch (error) {
        if (responseStarted) response.destroy?.();
        else writeJsonError(response, 502, 'Local Ollama connection failed');
        finish('deny', 'NOT EXECUTED', error.message);
      }
    });
  }
}

module.exports = {
  LOCAL_OLLAMA, LIMITS, LocalOllamaBroker, LocalOllamaToolProtocolVerifier,
  validateInboundRequest, validatePayload, transportSummary,
  nativeToolChoiceRequested, privilegedNativeToolTurn, allowedModels
};
