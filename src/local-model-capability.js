'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const CAPABILITY_SCHEMA_VERSION = 1;
const TRANSPORT_CONTRACT = 'ollama-openai-completions-v1';
const EVAL_VERSION = 'qwen-native-tools-auto-v1';
const QUALIFIED = 'qualified';
const STALE = 'stale';
const UNQUALIFIED = 'unqualified';

function hash(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value, limit) {
  return typeof value === 'string' && value.length > 0 && value.length <= limit;
}

function safeReason(value) {
  return typeof value === 'string' && /^[a-z0-9_]{1,80}$/.test(value) ? value : 'invalid_capability_record';
}

function templateSupportsNativeTools(template) {
  return typeof template === 'string' && /\.Tools\b/.test(template) && /\.ToolCalls\b/.test(template);
}

function modelfileSupportsQwen3NativeTools(modelfile) {
  if (typeof modelfile !== 'string' || !modelfile) return false;
  const lines = modelfile.split(/\r?\n/).map(line => line.trim());
  return lines.includes('RENDERER qwen3-coder') && lines.includes('PARSER qwen3-coder');
}

function extractDigest(show) {
  if (boundedString(show?.digest, 128)) return show.digest;
  const modelfile = typeof show?.modelfile === 'string' ? show.modelfile : '';
  const match = modelfile.match(/^FROM\s+.*?(sha256-[a-f0-9]{64})/m) || modelfile.match(/^FROM\s+(sha256:[a-f0-9]{64})/m);
  if (match) {
    const value = match[1];
    return value.startsWith('sha256:') ? value : value.replace(/^sha256-/, 'sha256:');
  }
  return null;
}

function inspectOllamaShow(show) {
  const capabilities = Array.isArray(show?.capabilities) ? show.capabilities.filter(value => typeof value === 'string') : [];
  const template = typeof show?.template === 'string' ? show.template : '';
  const modelfile = typeof show?.modelfile === 'string' ? show.modelfile : '';
  const templateHash = template ? hash(template) : null;
  const digest = extractDigest(show);
  const hasToolsCapability = capabilities.includes('tools');
  const templateNative = templateSupportsNativeTools(template);
  const qwen3RendererNative = modelfileSupportsQwen3NativeTools(modelfile);
  const available = hasToolsCapability && (templateNative || qwen3RendererNative);
  let reason = null;
  if (!hasToolsCapability) reason = 'tools_capability_missing';
  else if (!available) reason = 'native_tool_template_missing';
  return {
    available,
    source: 'ollama_show',
    reason,
    capabilities,
    digest,
    templateHash,
    templateHasTools: templateNative,
    qwen3RendererParser: qwen3RendererNative,
    family: typeof show?.details?.family === 'string' ? show.details.family : null,
    parameterSize: typeof show?.details?.parameter_size === 'string' ? show.details.parameter_size : null,
    quantization: typeof show?.details?.quantization_level === 'string' ? show.details.quantization_level : null
  };
}

function normalizeRecord(raw) {
  if (!plainObject(raw)) return null;
  const model = boundedString(raw.model, 200) ? raw.model : null;
  const digest = boundedString(raw.digest, 128) ? raw.digest : null;
  const templateHash = boundedString(raw.template_hash, 64) ? raw.template_hash : null;
  const provider = boundedString(raw.provider, 64) ? raw.provider : null;
  const status = [QUALIFIED, STALE, UNQUALIFIED].includes(raw.qualification_status) ? raw.qualification_status : null;
  if (!model || !digest || !templateHash || !provider || !status) return null;
  return {
    schema_version: Number.isInteger(raw.schema_version) ? raw.schema_version : CAPABILITY_SCHEMA_VERSION,
    model,
    digest,
    template_hash: templateHash,
    provider,
    supports_native_tools: raw.supports_native_tools === true,
    qualification_status: status,
    qualification_timestamp: boundedString(raw.qualification_timestamp, 64) ? raw.qualification_timestamp : null,
    tested_transport: boundedString(raw.tested_transport, 80) ? raw.tested_transport : null,
    transport_contract: boundedString(raw.transport_contract, 80) ? raw.transport_contract : null,
    registry_tool_schema_sha256: boundedString(raw.registry_tool_schema_sha256, 64) ? raw.registry_tool_schema_sha256 : null,
    forced_tool_result: plainObject(raw.forced_tool_result) ? {
      passed: raw.forced_tool_result.passed === true,
      cases: Number.isInteger(raw.forced_tool_result.cases) ? raw.forced_tool_result.cases : null,
      passed_cases: Number.isInteger(raw.forced_tool_result.passed_cases) ? raw.forced_tool_result.passed_cases : null
    } : null,
    auto_selection_evaluation: plainObject(raw.auto_selection_evaluation) ? {
      version: boundedString(raw.auto_selection_evaluation.version, 80) ? raw.auto_selection_evaluation.version : null,
      correct: Number.isInteger(raw.auto_selection_evaluation.correct) ? raw.auto_selection_evaluation.correct : null,
      wrong: Number.isInteger(raw.auto_selection_evaluation.wrong) ? raw.auto_selection_evaluation.wrong : null,
      unnecessary: Number.isInteger(raw.auto_selection_evaluation.unnecessary) ? raw.auto_selection_evaluation.unnecessary : null,
      missing: Number.isInteger(raw.auto_selection_evaluation.missing) ? raw.auto_selection_evaluation.missing : null,
      malformed: Number.isInteger(raw.auto_selection_evaluation.malformed) ? raw.auto_selection_evaluation.malformed : null,
      total: Number.isInteger(raw.auto_selection_evaluation.total) ? raw.auto_selection_evaluation.total : null
    } : null,
    notes: boundedString(raw.notes, 500) ? raw.notes : null
  };
}

function loadCapabilityFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (Array.isArray(raw?.models)) {
      return {
        schema_version: Number.isInteger(raw.schema_version) ? raw.schema_version : CAPABILITY_SCHEMA_VERSION,
        updated_at: boundedString(raw.updated_at, 64) ? raw.updated_at : null,
        models: raw.models.map(normalizeRecord).filter(Boolean)
      };
    }
    const single = normalizeRecord(raw);
    return single ? { schema_version: CAPABILITY_SCHEMA_VERSION, updated_at: single.qualification_timestamp, models: [single] } : null;
  } catch {
    return null;
  }
}

function writeCapabilityFile(filePath, document) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(document, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

function assessQualification(record, live) {
  if (!record) {
    return { allow: false, status: UNQUALIFIED, reason: 'capability_record_missing', record: null };
  }
  if (record.supports_native_tools !== true || record.qualification_status !== QUALIFIED) {
    return { allow: false, status: record.qualification_status || UNQUALIFIED, reason: 'model_not_qualified', record };
  }
  if (record.transport_contract && record.transport_contract !== TRANSPORT_CONTRACT) {
    return { allow: false, status: STALE, reason: 'transport_contract_changed', record };
  }
  if (live?.digest && record.digest !== live.digest) {
    return { allow: false, status: STALE, reason: 'model_digest_changed', record };
  }
  if (live?.templateHash && record.template_hash !== live.templateHash) {
    return { allow: false, status: STALE, reason: 'template_hash_changed', record };
  }
  // Tool schema fingerprints are retained for audit of the qualification run.
  // Worker descriptions are not byte-identical to the probe registry, so they
  // must not invalidate a still-valid installed model artifact on their own.
  if (live?.strictToolSchema === true && live?.toolSchemaSha256 && record.registry_tool_schema_sha256 &&
      record.registry_tool_schema_sha256 !== live.toolSchemaSha256) {
    return { allow: false, status: STALE, reason: 'tool_registry_hash_changed', record };
  }
  return { allow: true, status: QUALIFIED, reason: null, record };
}

function routeLocalOllamaModel({ primaryModel, toolModel, payload }) {
  const tools = Array.isArray(payload?.tools) ? payload.tools : [];
  const choice = payload?.tool_choice;
  const forced = choice === 'required' || (plainObject(choice) && choice.type === 'function');
  const hasToolMessages = Array.isArray(payload?.messages) && payload.messages.some(message => message?.role === 'tool');
  const requiresNativeTools = tools.length > 0 && (forced || hasToolMessages);
  const selected = requiresNativeTools ? toolModel : primaryModel;
  return {
    role: requiresNativeTools ? 'tool' : 'primary',
    model: selected,
    requiresNativeTools,
    toolChoice: typeof choice === 'string'
      ? choice
      : choice?.type === 'function' && typeof choice.function?.name === 'string'
        ? `function:${choice.function.name}`
        : null
  };
}

class LocalModelCapabilityRegistry {
  constructor({ filePath = null, records = null } = {}) {
    this.filePath = filePath;
    this.document = records
      ? { schema_version: CAPABILITY_SCHEMA_VERSION, updated_at: null, models: records.map(normalizeRecord).filter(Boolean) }
      : loadCapabilityFile(filePath) || { schema_version: CAPABILITY_SCHEMA_VERSION, updated_at: null, models: [] };
  }

  get(model) {
    return this.document.models.find(entry => entry.model === model) || null;
  }

  evaluate(model, live = {}) {
    return assessQualification(this.get(model), live);
  }

  upsert(record) {
    const normalized = normalizeRecord(record);
    if (!normalized) throw new Error('Invalid local model capability record');
    const models = this.document.models.filter(entry => entry.model !== normalized.model);
    models.push(normalized);
    this.document = {
      schema_version: CAPABILITY_SCHEMA_VERSION,
      updated_at: new Date().toISOString(),
      models
    };
    if (this.filePath) writeCapabilityFile(this.filePath, this.document);
    return normalized;
  }
}

module.exports = {
  CAPABILITY_SCHEMA_VERSION,
  TRANSPORT_CONTRACT,
  EVAL_VERSION,
  QUALIFIED,
  STALE,
  UNQUALIFIED,
  hash,
  inspectOllamaShow,
  templateSupportsNativeTools,
  modelfileSupportsQwen3NativeTools,
  normalizeRecord,
  loadCapabilityFile,
  writeCapabilityFile,
  assessQualification,
  routeLocalOllamaModel,
  LocalModelCapabilityRegistry
};
