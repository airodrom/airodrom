#!/usr/bin/env node
'use strict';

/**
 * Offline qualification helper for local Ollama native-tool models.
 * Does not download models. Writes config/local-model-capability-v1.json only
 * when --write is passed and probes pass.
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {
  inspectOllamaShow, hash, TRANSPORT_CONTRACT, EVAL_VERSION, writeCapabilityFile
} = require('../src/local-model-capability');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'config/local-model-capability-v1.json');
const MODEL = process.env.BRIDGE_QUALIFY_MODEL || 'qwen3-coder:30b';

function requestJson(urlPath, body, timeoutMs = 180_000) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port: 11434, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode, body: JSON.parse(text) }); }
        catch (error) { reject(error); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(payload);
  });
}

function buildTools() {
  const names = [
    'read', 'ls', 'find', 'grep', 'write', 'edit', 'run_job', 'mission_checkpoint', 'memory_search',
    'personal_memory_get', 'personal_memory_search', 'personal_memory_recent', 'personal_memory_remember',
    'personal_memory_update', 'personal_memory_forget', 'project_list', 'project_get', 'project_summary',
    'project_next_action', 'project_create', 'project_create_goal', 'project_create_mission',
    'project_set_mission_status', 'project_archive', 'web_fetch', 'chatgpt_notify'
  ];
  return names.map(name => ({
    type: 'function',
    function: {
      name,
      description: `Broker capability ${name}.`,
      parameters: { type: 'object', properties: {}, additionalProperties: true }
    }
  }));
}

async function chat(messages, { tools, toolChoice }) {
  const body = {
    model: MODEL, messages, tools, temperature: 0, stream: false, max_tokens: 512
  };
  if (toolChoice !== undefined) body.tool_choice = toolChoice;
  const response = await requestJson('/v1/chat/completions', body);
  const choice = response.body?.choices?.[0] || {};
  const message = choice.message || {};
  return {
    finish: choice.finish_reason,
    toolCalls: message.tool_calls || [],
    content: message.content || '',
    names: (message.tool_calls || []).map(call => call.function?.name).filter(Boolean)
  };
}

async function main() {
  const write = process.argv.includes('--write');
  const show = await requestJson('/api/show', { name: MODEL });
  const inspected = inspectOllamaShow(show.body);
  console.log(JSON.stringify({ model: MODEL, inspected }, null, 2));
  if (!inspected.available) {
    console.error('NO-GO: installed artifact lacks native tool structure');
    process.exit(2);
  }

  const tools = buildTools();
  const sys = 'Tool protocol: registered tools execute only through the structured tool-calling interface. When a capability is requested, invoke the matching registered tool. Do not describe or simulate a tool call in ordinary assistant text; only a real structured tool call runs.';
  const forcedCases = [
    ['personal_memory_search', 'Use personal_memory_search with query "smoke verification" domain "personal".', { type: 'function', function: { name: 'personal_memory_search' } }],
    ['personal_memory_remember', 'Use personal_memory_remember with domain personal type preference subject editor content prefers VS Code.', { type: 'function', function: { name: 'personal_memory_remember' } }],
    ['project_list', 'Use project_list for active projects.', { type: 'function', function: { name: 'project_list' } }],
    ['project_next_action', 'Use project_next_action.', { type: 'function', function: { name: 'project_next_action' } }],
    ['project_create', 'Use project_create with name Fixture Project Alpha.', { type: 'function', function: { name: 'project_create' } }]
  ];
  let forcedPass = 0;
  for (const [name, prompt, choice] of forcedCases) {
    const result = await chat([{ role: 'system', content: sys }, { role: 'user', content: prompt }], { tools, toolChoice: choice });
    const ok = result.names.includes(name) && !String(result.content).includes('<function=');
    forcedPass += Number(ok);
    console.log('forced', name, ok ? 'PASS' : 'FAIL', result.finish, result.names);
  }

  const autoCases = [
    ['mem', 'What personal memories mention VS Code?', 'personal_memory_search', true],
    ['list', 'List active projects.', 'project_list', true],
    ['next', 'What should this project do next? Use project_next_action.', 'project_next_action', true],
    ['read', 'Read the file at path fixtures/safe-autonomy-level1/route.txt.', 'read', true],
    ['math', 'What is 2+2? Answer with only the number.', null, false]
  ];
  const auto = { correct: 0, wrong: 0, unnecessary: 0, missing: 0, malformed: 0, total: 0 };
  for (const [label, prompt, expected, need] of autoCases) {
    const result = await chat([{ role: 'system', content: sys }, { role: 'user', content: prompt }], { tools, toolChoice: 'auto' });
    auto.total += 1;
    const has = result.toolCalls.length > 0;
    const malformed = has && String(result.content).includes('<function=');
    let verdict = 'correct';
    if (malformed) { auto.malformed += 1; verdict = 'malformed'; }
    else if (need && !has) { auto.missing += 1; verdict = 'missing'; }
    else if (need && expected && !result.names.includes(expected)) { auto.wrong += 1; verdict = 'wrong'; }
    else if (!need && has) { auto.unnecessary += 1; verdict = 'unnecessary'; }
    else auto.correct += 1;
    console.log('auto', label, verdict, result.names);
  }

  // Forced native protocol is the hard gate. Auto selection must not emit
  // malformed/inert text calls; exact tool choice quality is scored and must
  // remain free of missing/malformed entries on the fixed evaluation set.
  const qualified = forcedPass === forcedCases.length && auto.malformed === 0 && auto.missing === 0 && auto.unnecessary === 0;
  const record = {
    schema_version: 1,
    model: MODEL,
    digest: inspected.digest,
    template_hash: inspected.templateHash,
    provider: 'ollama',
    supports_native_tools: qualified,
    qualification_status: qualified ? 'qualified' : 'unqualified',
    qualification_timestamp: new Date().toISOString(),
    tested_transport: 'http://127.0.0.1:11434/v1/chat/completions',
    transport_contract: TRANSPORT_CONTRACT,
    registry_tool_schema_sha256: hash(JSON.stringify(tools)),
    forced_tool_result: { passed: forcedPass === forcedCases.length, cases: forcedCases.length, passed_cases: forcedPass },
    auto_selection_evaluation: { version: EVAL_VERSION, ...auto },
    notes: qualified
      ? 'Qualified by scripts/qualify-local-ollama-tools.cjs'
      : 'Probe failed; privileged native tools remain fail-closed'
  };
  console.log(JSON.stringify(record, null, 2));
  if (write && qualified) {
    writeCapabilityFile(OUT, { schema_version: 1, updated_at: record.qualification_timestamp, models: [record] });
    console.log('wrote', OUT);
  }
  process.exit(qualified ? 0 : 3);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
