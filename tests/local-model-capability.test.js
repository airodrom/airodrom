'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  inspectOllamaShow,
  assessQualification,
  routeLocalOllamaModel,
  LocalModelCapabilityRegistry,
  TRANSPORT_CONTRACT,
  hash
} = require('../src/local-model-capability');
const { LocalOllamaToolProtocolVerifier, LOCAL_OLLAMA } = require('../src/local-ollama-broker');
const { EventEmitter } = require('node:events');

test('SIMULATION: qwen3 RENDERER/PARSER counts as native-tool structure; bare Prompt template does not', () => {
  const qwen3 = inspectOllamaShow({
    capabilities: ['completion', 'tools'],
    template: '{{ .Prompt }}',
    modelfile: 'FROM /blob/sha256-1194192cf2a187eb02722edcc3f77b11d21f537048ce04b67ccf8ba78863006a\nTEMPLATE {{ .Prompt }}\nRENDERER qwen3-coder\nPARSER qwen3-coder\n'
  });
  assert.equal(qwen3.available, true);
  assert.equal(qwen3.qwen3RendererParser, true);
  assert.equal(qwen3.templateHasTools, false);
  assert.equal(qwen3.digest, 'sha256:1194192cf2a187eb02722edcc3f77b11d21f537048ce04b67ccf8ba78863006a');

  const bare = inspectOllamaShow({
    capabilities: ['completion', 'tools'],
    template: '{{ .Prompt }}',
    modelfile: 'FROM /blob/sha256-deadbeef\nTEMPLATE {{ .Prompt }}\n'
  });
  assert.equal(bare.available, false);
  assert.equal(bare.reason, 'native_tool_template_missing');

  const classic = inspectOllamaShow({
    capabilities: ['completion', 'tools'],
    template: 'before {{ .Tools }} middle {{ .ToolCalls }} after',
    modelfile: 'FROM qwen2.5\n'
  });
  assert.equal(classic.available, true);
  assert.equal(classic.templateHasTools, true);
});

test('SIMULATION: capability qualification fails closed on missing, unqualified, digest, or template changes', () => {
  const record = {
    schema_version: 1,
    model: 'qwen3-coder:30b',
    digest: 'sha256:abc',
    template_hash: hash('{{ .Prompt }}'),
    provider: 'ollama',
    supports_native_tools: true,
    qualification_status: 'qualified',
    qualification_timestamp: '2026-09-30T00:00:00.000Z',
    tested_transport: 'http://127.0.0.1:11434/v1/chat/completions',
    transport_contract: TRANSPORT_CONTRACT,
    registry_tool_schema_sha256: 'a'.repeat(64),
    forced_tool_result: { passed: true, cases: 1, passed_cases: 1 },
    auto_selection_evaluation: { version: 'qwen-native-tools-auto-v1', correct: 1, wrong: 0, unnecessary: 0, missing: 0, malformed: 0, total: 1 }
  };
  assert.equal(assessQualification(record, { digest: 'sha256:abc', templateHash: record.template_hash }).allow, true);
  assert.equal(assessQualification(null, {}).reason, 'capability_record_missing');
  assert.equal(assessQualification({ ...record, qualification_status: 'unqualified' }, {}).reason, 'model_not_qualified');
  assert.equal(assessQualification(record, { digest: 'sha256:other' }).reason, 'model_digest_changed');
  assert.equal(assessQualification(record, { templateHash: 'ffff' }).reason, 'template_hash_changed');
  assert.equal(assessQualification({ ...record, transport_contract: 'other' }, {}).reason, 'transport_contract_changed');
});

test('SIMULATION: local model routing uses tool model only for forced native tools or tool-result continuations', () => {
  assert.deepEqual(routeLocalOllamaModel({
    primaryModel: 'primary', toolModel: 'tools',
    payload: { model: 'primary', messages: [{ role: 'user', content: 'hi' }] }
  }), { role: 'primary', model: 'primary', requiresNativeTools: false, toolChoice: null });

  assert.equal(routeLocalOllamaModel({
    primaryModel: 'primary', toolModel: 'tools',
    payload: {
      tools: [{ type: 'function', function: { name: 'personal_memory_search' } }],
      tool_choice: { type: 'function', function: { name: 'personal_memory_search' } },
      messages: [{ role: 'user', content: 'search' }]
    }
  }).role, 'tool');

  assert.equal(routeLocalOllamaModel({
    primaryModel: 'primary', toolModel: 'tools',
    payload: {
      tools: [{ type: 'function', function: { name: 'personal_memory_search' } }],
      tool_choice: 'auto',
      messages: [
        { role: 'user', content: 'search' },
        { role: 'tool', content: '{}', tool_call_id: 'call-1' }
      ]
    }
  }).model, 'tools');
});

test('SIMULATION: capability registry persists and reloads without prompt contents', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-capability-'));
  const filePath = path.join(directory, 'capability.json');
  const registry = new LocalModelCapabilityRegistry({ filePath });
  registry.upsert({
    schema_version: 1,
    model: LOCAL_OLLAMA.toolModel,
    digest: 'sha256:1194192cf2a187eb02722edcc3f77b11d21f537048ce04b67ccf8ba78863006a',
    template_hash: 'b507b9c2f6ca642bffcd06665ea7c91f235fd32daeefdf875a0f938db05fb315',
    provider: 'ollama',
    supports_native_tools: true,
    qualification_status: 'qualified',
    qualification_timestamp: '2026-09-30T00:00:00.000Z',
    tested_transport: 'http://127.0.0.1:11434/v1/chat/completions',
    transport_contract: TRANSPORT_CONTRACT,
    registry_tool_schema_sha256: 'b'.repeat(64),
    forced_tool_result: { passed: true, cases: 11, passed_cases: 11 },
    auto_selection_evaluation: { version: 'qwen-native-tools-auto-v1', correct: 4, wrong: 1, unnecessary: 0, missing: 0, malformed: 0, total: 5 },
    notes: 'fixture'
  });
  const reloaded = new LocalModelCapabilityRegistry({ filePath });
  const evaluation = reloaded.evaluate(LOCAL_OLLAMA.toolModel, {
    digest: 'sha256:1194192cf2a187eb02722edcc3f77b11d21f537048ce04b67ccf8ba78863006a',
    templateHash: 'b507b9c2f6ca642bffcd06665ea7c91f235fd32daeefdf875a0f938db05fb315'
  });
  assert.equal(evaluation.allow, true);
  assert.equal(JSON.stringify(reloaded.document).includes('smoke verification'), false);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('SIMULATION: verifier accepts qwen3 renderer/parser modelfile from /api/show', async () => {
  const request = (_options, callback) => {
    const client = new EventEmitter();
    client.setTimeout = () => client;
    client.destroy = () => {};
    client.end = () => {
      const response = new EventEmitter(); response.statusCode = 200;
      queueMicrotask(() => {
        callback(response);
        response.emit('data', Buffer.from(JSON.stringify({
          capabilities: ['completion', 'tools'],
          template: '{{ .Prompt }}',
          modelfile: 'FROM /x/sha256-1194192cf2a187eb02722edcc3f77b11d21f537048ce04b67ccf8ba78863006a\nTEMPLATE {{ .Prompt }}\nRENDERER qwen3-coder\nPARSER qwen3-coder\n'
        })));
        response.emit('end');
      });
    };
    return client;
  };
  const verifier = new LocalOllamaToolProtocolVerifier({ request });
  const status = await verifier.verify('qwen3-coder:30b');
  assert.equal(status.available, true);
  assert.equal(status.qwen3RendererParser, true);
  assert.equal(status.digest, 'sha256:1194192cf2a187eb02722edcc3f77b11d21f537048ce04b67ccf8ba78863006a');
});
