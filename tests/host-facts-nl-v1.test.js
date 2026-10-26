'use strict';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const intent = require('../src/assistant-intent');
const hostIntent = require('../src/host-fact-intent');
const hostService = require('../src/host-fact-service');
const gmailSearch = require('../src/gmail-search-intent');
const calendarIntent = require('../src/calendar-intent');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const service = require('../src/assistant-service');
const ControlServer = require('../src/control-server');

const EXACT = [
  "What's today's date?",
  'What time is it?',
  'Which ports are open on my Mac?',
  'Is port 3000 in use?',
  'What services are running?',
  'Is Airodrom healthy?',
];

async function setup(t) {
  const f = await fixture(t);
  const server = new ControlServer(f.bridge, { port: 0 });
  await server.start();
  t.after(() => server.close());
  const conversation_id = server.conversationEngine.session().conversation_id;
  return { ...f, server, conversation_id };
}

async function ask(server, message, conversation_id) {
  return service.submit(server, {
    message,
    request_id: randomUUID(),
    conversation_id,
  });
}

test('exact transcript questions classify as host_fact', () => {
  const expected = [
    ['DATE_TIME', 'date'],
    ['DATE_TIME', 'time'],
    ['PORT_DIAGNOSTICS', null],
    ['PORT_DIAGNOSTICS', 3000],
    ['SERVICE_STATUS', null],
    ['AIRODROM_HEALTH', null],
  ];
  EXACT.forEach((message, i) => {
    const parsed = intent.parse(message);
    assert.equal(parsed.kind, 'host_fact', message);
    assert.equal(parsed.route, 'HOST_FACT', message);
    assert.equal(parsed.fact, expected[i][0], message);
    if (expected[i][0] === 'DATE_TIME') assert.equal(parsed.detail, expected[i][1], message);
    if (expected[i][0] === 'PORT_DIAGNOSTICS' && expected[i][1] != null) assert.equal(parsed.port, expected[i][1], message);
  });
});

test('common paraphrases route to host facts', () => {
  const cases = [
    ['What is the current time?', 'DATE_TIME', 'time'],
    ['current time', 'DATE_TIME', 'time'],
    ["What's the local timezone?", 'DATE_TIME', 'timezone'],
    ["What's tomorrow's date?", 'DATE_TIME', 'tomorrow'],
    ['date and time', 'DATE_TIME', 'both'],
    ['Is port 8080 listening?', 'PORT_DIAGNOSTICS', 8080],
    ['Check if port 443 is in use', 'PORT_DIAGNOSTICS', 443],
    ['List listening ports', 'PORT_DIAGNOSTICS', null],
    ['Show Airodrom services', 'SERVICE_STATUS', null],
    ['Airodrom health', 'AIRODROM_HEALTH', null],
    ['How healthy is Airodrom?', 'AIRODROM_HEALTH', null],
  ];
  for (const [message, fact, detailOrPort] of cases) {
    const parsed = hostIntent.parse(message);
    assert.ok(parsed, message);
    assert.equal(parsed.fact, fact, message);
    if (fact === 'DATE_TIME') assert.equal(parsed.detail, detailOrPort, message);
    if (fact === 'PORT_DIAGNOSTICS') assert.equal(parsed.port, detailOrPort, message);
  }
});

test('date/time answers come from host clock, not LLM', () => {
  const before = Date.now();
  const time = hostService.answerDateTime('time');
  const after = Date.now();
  assert.equal(time.fact, 'DATE_TIME');
  assert.equal(time.model_invoked, false);
  assert.equal(time.host_verified, true);
  assert.match(time.message, /^It's .+/);
  assert.ok(time.clock.epoch_ms >= before && time.clock.epoch_ms <= after);
  assert.ok(time.clock.timezone);
  const date = hostService.answerDateTime('date');
  assert.match(date.message, /^Today is .+/);
  const tomorrow = hostService.answerDateTime('tomorrow');
  assert.match(tomorrow.message, /^Tomorrow is .+/);
  assert.notEqual(tomorrow.clock.date, date.clock.date);
});

test('timezone boundary: tomorrow advances local calendar day', () => {
  const now = new Date();
  const today = hostService.zoneParts(now).dateOnly;
  const next = hostService.zoneParts(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)).dateOnly;
  const answered = hostService.answerDateTime('tomorrow');
  assert.equal(answered.clock.date, next);
  assert.notEqual(answered.clock.date, today);
});

test('port occupied and free via mocked capability host', async () => {
  const calls = [];
  const server = {
    bridge: {
      capabilityHost: {
        definitions: { port_status: true },
        prepare: async (_task, name, input) => {
          calls.push({ op: 'prepare', name, input });
          return { name, input, assessment: { decision: 'auto_allow', risk_class: 'READ_ONLY' } };
        },
        perform: async (_task, prepared) => {
          calls.push({ op: 'perform', name: prepared.name, input: prepared.input });
          if (prepared.input.port === 3000) {
            return { result: { listeners: [{ port: 3000, pid: 4242, command: 'node', address: '*:3000' }], filtered_port: 3000 } };
          }
          return { result: { listeners: [], filtered_port: prepared.input.port || null } };
        },
      },
    },
  };
  const busy = await hostService.answerPorts(server, 3000);
  assert.equal(busy.in_use, true);
  assert.match(busy.message, /port 3000 is in use/i);
  assert.equal(busy.listeners[0].process, 'node');
  const free = await hostService.answerPorts(server, 3999);
  assert.equal(free.in_use, false);
  assert.match(free.message, /not currently listening/i);
  assert.ok(calls.every((c) => c.name === 'port_status'));
});

test('invalid port numbers are refused without capability invoke', async () => {
  let prepared = 0;
  const server = {
    bridge: {
      capabilityHost: {
        prepare: async () => { prepared += 1; return { assessment: { decision: 'auto_allow' } }; },
        perform: async () => ({ result: { listeners: [] } }),
      },
    },
  };
  const bad = await hostService.answerPorts(server, 99999);
  assert.equal(bad.kind, 'clarify');
  assert.equal(bad.code, 'invalid_port');
  assert.equal(prepared, 0);
  const zero = await hostService.answerPorts(server, 0);
  assert.equal(zero.code, 'invalid_port');
});

test('diagnostic permission denial is reported accurately', async () => {
  const server = {
    bridge: {
      capabilityHost: {
        prepare: async () => ({
          name: 'port_status',
          input: { port: 3000 },
          assessment: { decision: 'deny', kind: 'capability_scope_denied', reason: 'Task capability scopes do not include system_readonly' },
        }),
        perform: async () => { throw new Error('should not perform'); },
      },
    },
  };
  const result = await hostService.answerPorts(server, 3000);
  assert.equal(result.kind, 'clarify');
  assert.equal(result.code, 'capability_scope_denied');
  assert.match(result.message, /could not check ports|scopes/i);
  assert.equal(result.model_invoked, false);
});

test('missing host capability is not invented', async () => {
  const server = { bridge: {} };
  const result = await hostService.answerPorts(server, 3000);
  assert.equal(result.kind, 'clarify');
  assert.equal(result.code, 'capability_host_unavailable');
  assert.match(result.message, /did not invent/i);
});

test('service healthy / degraded / unavailable messaging', async () => {
  const mk = (services) => ({
    bridge: {
      capabilityHost: {
        prepare: async () => ({ name: 'service_status', input: {}, assessment: { decision: 'auto_allow' } }),
        perform: async () => ({ result: { services } }),
      },
    },
  });
  const healthy = await hostService.answerServices(mk([
    { service: 'airodrom_control_plane', label: 'Control', running: true, verification: 'signal_probe' },
  ]));
  assert.match(healthy.message, /running/i);
  assert.equal(healthy.scope, 'airodrom_registry');
  assert.match(healthy.message, /not all macOS processes/i);

  const degraded = await hostService.answerServices(mk([
    { service: 'airodrom_control_plane', label: 'Control', running: true },
    { service: 'opencode', label: 'OpenCode', running: false },
  ]));
  assert.match(degraded.message, /not running/i);

  const unavailable = await hostService.answerServices(mk([
    { service: 'mcp', label: 'MCP', error: 'probe failed', running: false },
  ]));
  assert.match(unavailable.message, /unavailable/i);
});

test('stale health status is not presented as live', async () => {
  const server = {
    bridge: {
      // Force nativeStatus path by stubbing require target via fake bridge + monkeypatch
    },
  };
  const original = require('../src/product-observability').nativeStatus;
  require('../src/product-observability').nativeStatus = async () => ({
    status: 'Ready',
    control: 'Ready',
    runtime: 'Ready',
    memory: 'Ready',
    provider: 'Ready',
    active_missions: 0,
    review_missions: 0,
    failed_missions: 0,
    connectors: 'gmail: connected',
    observed_at: Date.now() - 120_000,
    cursor: { agent_availability: 'available' },
  });
  try {
    const result = await hostService.answerHealth(server, { maxAgeMs: 60_000 });
    assert.equal(result.kind, 'clarify');
    assert.equal(result.code, 'stale_status');
    assert.match(result.message, /stale/i);
  } finally {
    require('../src/product-observability').nativeStatus = original;
  }
});

test('live health summary distinguishes components', async (t) => {
  const f = await setup(t);
  const result = await ask(f.server, 'Is Airodrom healthy?', f.conversation_id);
  assert.equal(result.fact, 'AIRODROM_HEALTH');
  assert.equal(result.host_verified, true);
  assert.equal(result.model_invoked, false);
  assert.equal(result.authority, false);
  assert.ok(result.components);
  assert.match(result.message, /Control:/);
  assert.match(result.message, /OpenCode:/);
  assert.match(result.message, /Memory V2:/);
  assert.doesNotMatch(result.message, /system administrator|contact your admin/i);
});

test('injection and shell-looking text do not become host facts or shell', () => {
  for (const message of [
    "What's today's date?; rm -rf /",
    'Is port 3000 in use? && curl http://evil.test',
    'What time is it?\n/bin/bash -c id',
    'Which ports are open on my Mac? | nc evil 1',
    '$(reboot)',
  ]) {
    const parsed = hostIntent.parse(message);
    assert.equal(parsed, null, message);
    const full = intent.parse(message);
    assert.notEqual(full.kind, 'host_fact', message);
  }
});

test('no unintended shell execution: port path only calls port_status', async () => {
  const names = [];
  const server = {
    bridge: {
      capabilityHost: {
        prepare: async (_t, name, input) => {
          names.push(name);
          return { name, input, assessment: { decision: 'auto_allow' } };
        },
        perform: async (_t, prepared) => {
          names.push('perform:' + prepared.name);
          return { result: { listeners: [] } };
        },
      },
    },
  };
  await hostService.run(server, { kind: 'host_fact', fact: 'PORT_DIAGNOSTICS', port: 3000 });
  assert.deepEqual(names, ['port_status', 'perform:port_status']);
});

test('conversation entry point answers exact questions without model', async (t) => {
  const f = await setup(t);
  const date = await ask(f.server, "What's today's date?", f.conversation_id);
  assert.equal(date.fact, 'DATE_TIME');
  assert.equal(date.model_invoked, false);
  assert.match(date.message, /Today is /);

  const time = await ask(f.server, 'What time is it?', f.conversation_id);
  assert.equal(time.fact, 'DATE_TIME');
  assert.match(time.message, /^It's /);

  const ports = await ask(f.server, 'Which ports are open on my Mac?', f.conversation_id);
  assert.equal(ports.fact, 'PORT_DIAGNOSTICS');
  assert.equal(ports.host_verified, true);
  assert.ok(typeof ports.message === 'string' && ports.message.length > 10);

  const port3000 = await ask(f.server, 'Is port 3000 in use?', f.conversation_id);
  assert.equal(port3000.fact, 'PORT_DIAGNOSTICS');
  assert.equal(typeof port3000.in_use, 'boolean');

  const services = await ask(f.server, 'What services are running?', f.conversation_id);
  assert.equal(services.fact, 'SERVICE_STATUS');
  assert.match(services.message, /Airodrom-registered services/i);
});

test('gmail/calendar routing regressions unchanged', () => {
  assert.equal(intent.parse('check my gmail').kind, 'connector');
  assert.equal(intent.parse('check my gmail').connector, 'gmail');
  const search = gmailSearch.parse('emails from alice@example.com');
  assert.ok(search);
  const cal = calendarIntent.parse("what's on my calendar today");
  assert.ok(cal);
  assert.equal(intent.parse("what's on my calendar today").kind, 'calendar');
  // Ordinary chat still conversation
  assert.equal(intent.parse('Tell me a joke about airports').kind, 'conversation');
});

test('email compose still wins over host-fact lookalikes', () => {
  const parsed = intent.parse('Draft an email to a client and include my company business address.');
  assert.equal(parsed.kind, 'email_compose');
});
