'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { ConversationEngine } = require('../src/conversation-engine');
const router = require('../src/model-worker-router');
const policy = require('../src/provider-policy');
const intent = require('../src/assistant-intent');
const grounding = require('../src/conversation-grounding');

const response = (content) => new Response(JSON.stringify({
  choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }]
}));

async function setup(t, answer) {
  const f = await fixture(t);
  const packets = [];
  const engine = new ConversationEngine(f.bridge, {
    qualify: async () => ({ state: 'READY', model: router.MODEL }),
    request: async (_url, o) => {
      packets.push(JSON.parse(o.body));
      return response(typeof answer === 'function' ? answer(packets) : answer);
    }
  });
  t.after(() => engine.close());
  return {
    ...f,
    engine,
    packets,
    start: (message, extra = {}) => engine.start({ message, request_id: randomUUID(), include_memory: false, ...extra }),
    settle: async (r) => {
      await engine.active.get(r.turn_id)?.promise;
      return engine.result({ conversation_id: r.conversation_id, turn_id: r.turn_id });
    }
  };
}

test('host Mission facts distinguish active, current, completed and historical', async (t) => {
  const f = await fixture(t);
  const facts = grounding.missionFactSnapshot(f.bridge);
  assert.equal(facts.source, 'host_overview');
  assert.equal(facts.authority, false);
  for (const key of ['active', 'current', 'completed', 'historical', 'retained']) {
    assert.equal(typeof facts[key], 'number');
    assert.ok(Number.isSafeInteger(facts[key]));
  }
  assert.match(grounding.formatMissionFacts(facts), /active=\d+/);
  assert.match(grounding.formatMissionFacts(facts), /current=\d+/);
  assert.doesNotMatch(grounding.formatMissionFacts(facts), /\bsettled=\d+/);
});

test('grounding rewrites current-as-active Mission count misstatements', () => {
  const facts = {
    source: 'host_overview',
    authority: false,
    active: 0,
    current: 62,
    completed: 10,
    historical: 50,
    retained: 62,
    semantics: {
      active: 'dispatching, running, or verifying',
      current: 'not completed or cancelled',
      completed: 'state completed',
      historical: 'completed or cancelled retained Missions'
    }
  };
  const raw = 'Prioritize the 62 active missions and review open workstreams.';
  const grounded = grounding.groundMissionClaims(raw, facts);
  assert.equal(grounded.disputed, true);
  assert.doesNotMatch(grounded.text, /\b62 active missions\b/i);
  assert.match(grounded.text, /0 active Missions \(host-verified; model claimed 62 unverified\)/i);
  assert.match(grounded.text, /Host-verified Mission counts: active=0, current=62/);
  const ok = grounding.groundMissionClaims('There are 0 active Missions and 62 current Missions.', facts);
  assert.equal(ok.disputed, false);
  assert.equal(ok.text, 'There are 0 active Missions and 62 current Missions.');
});

test('ConversationEngine delivers grounded counts when the model mislabels current as active', async (t) => {
  const f = await setup(t, 'Prioritize the 62 active missions from the current batch.');
  f.engine.missionFacts = () => ({
    source: 'host_overview',
    authority: false,
    active: 0,
    current: 62,
    completed: 40,
    historical: 50,
    retained: 62,
    semantics: {
      active: 'dispatching, running, or verifying',
      current: 'not completed or cancelled',
      completed: 'state completed',
      historical: 'completed or cancelled retained Missions'
    }
  });
  const turn = await f.start('Give a morning focus brief using host Mission counts.');
  const result = await f.settle(turn);
  assert.equal(result.state, 'completed');
  assert.doesNotMatch(result.summary, /\b62 active missions\b/i);
  assert.match(result.summary, /0 active Missions \(host-verified; model claimed 62 unverified\)/i);
  assert.match(JSON.stringify(f.packets[0].messages[0].content), /active=0/);
  assert.match(JSON.stringify(f.packets[0].messages[0].content), /current=62/);
});

test('authorized Development Session metadata is usable; credentials stay blocked', async (t) => {
  const allowed = [
    'Active Development Session: id=2eb98c6a-88f8-4478-bee0-e867e1ce8dac',
    'branch feat/ds-continue-session-v1 with integration PR_OPEN',
    'worktree airodrom-ds-continue repository airodrom-ds-continue',
    'Primary Development Session id=2eb98c6a-88f8-4478-bee0-e867e1ce8dac branch feat/ds-continue-session-v1'
  ];
  for (const message of allowed) {
    assert.equal(policy.operatorSecretLike(message), false, message);
    assert.notEqual(intent.parse(message).kind, 'secret', message);
  }
  const denied = [
    'Cookie: session=synthetic-canary',
    'session=synthetic-canary',
    'session for app.monarch.com',
    'session synthetic-canary',
    'SESSION_TOKEN=abc123secretvalue',
    'My password is synthetic-private-canary',
    'Authorization: Bearer sk-ant-abcdefghijklmnopqrstuvwxyz',
    'Open an authenticated browser session for app.monarch.com. password is synthetic-canary'
  ];
  for (const message of denied) {
    assert.equal(intent.parse(message).kind, 'secret', message);
  }
  assert.equal(policy.operatorSecretLike('Verify Session Continuity across current Missions.'), false);
  assert.equal(policy.operatorSecretLike('Begin session with clear awareness of current work.'), false);

  const f = await setup(t, 'Continue the Development Session on branch feat/ds-continue-session-v1.');
  f.engine.missionFacts = () => ({
    source: 'host_overview',
    authority: false,
    active: 0,
    current: 62,
    completed: 0,
    historical: 0,
    retained: 62,
    semantics: {
      active: 'dispatching, running, or verifying',
      current: 'not completed or cancelled',
      completed: 'state completed',
      historical: 'completed or cancelled retained Missions'
    }
  });
  f.engine.developmentFacts = () => ({
    id: '2eb98c6a-88f8-4478-bee0-e867e1ce8dac',
    branch: 'feat/ds-continue-session-v1',
    worktree_basename: 'airodrom-ds-continue',
    repository_basename: 'airodrom-ds-continue',
    integration_state: 'PR_OPEN',
    mission_count: 2
  });
  const ok = await f.start('Active Development Session: id=2eb98c6a-88f8-4478-bee0-e867e1ce8dac branch feat/ds-continue-session-v1 with integration PR_OPEN');
  assert.equal((await f.settle(ok)).state, 'completed');
  assert.match(JSON.stringify(f.packets[0].messages), /feat\/ds-continue-session-v1/);
  assert.match(JSON.stringify(f.packets[0].messages[0].content), /development workstream metadata/i);

  await assert.rejects(
    () => f.start('Cookie: session=synthetic-canary'),
    /Credentials|sensitive|vault/i
  );
});
