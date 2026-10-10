'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { ConversationEngine } = require('../src/conversation-engine');

const root = path.join(__dirname, '..');
const hub = fs.readFileSync(path.join(root, 'public/control-hub.js'), 'utf8');

test('Start new conversation clears browser display and avoids auto-restoring host session', () => {
  assert.match(hub, /pendingNewConversation/);
  assert.match(hub, /airodromConversationPendingNew/);
  assert.match(hub, /airodromPreviousConversationSession/);
  assert.match(hub, /New conversation ready · first send creates a fresh host session/);
  assert.match(hub, /Do not auto-restore the latest browser session while the operator asked for a new conversation/);
  assert.match(hub, /!pendingNewConversation/);
  assert.match(hub, /forceNew/);
  assert.match(hub, /if\(pendingNewConversation\)\{conversationHistory=\[\];conversationStreaming=null;\}/);
});

test('Continue previous restores saved prior session identity without merging into pending new', () => {
  assert.match(hub, /Continue previous conversation/);
  assert.match(hub, /previousConversationSessionId/);
  assert.match(hub, /const restore=conversationSessionId\|\|previousConversationSessionId/);
  assert.match(hub, /pendingNewConversation=false;conversationSessionId=restore/);
});

test('Browser refresh preserves pending-new isolation and does not merge sessions', () => {
  assert.match(hub, /sessionStorage\.setItem\('airodromConversationPendingNew','1'\)/);
  assert.match(hub, /if\(sessionStorage\.getItem\('airodromConversationPendingNew'\)==='1'\)\{pendingNewConversation=true;conversationSessionId=null;\}/);
  assert.match(hub, /conversation_id:await conversationSession\(\{forceNew:startNew\}\)/);
  assert.match(hub, /\.\.\.\(\(forceNew\|\|pendingNewConversation\)\?\{new:true\}:\{\}\)/);
});

test('Claude unavailable selection keeps Qwen as the working provider', () => {
  assert.match(hub, /Claude · unavailable · WAIT until qualified/);
  assert.match(hub, /Claude is unavailable for everyday conversation until independently qualified/);
  assert.match(hub, /Qwen remains the selected working provider/);
  assert.match(hub, /No Claude activation, API key, or subscription workaround/);
  assert.match(hub, /select\.value='qwen'/);
  assert.match(hub, /Set notice after refresh: refresh\/clearMemory would otherwise wipe the unavailable explanation/);
  assert.doesNotMatch(hub, /Claude preference recorded · WAIT until qualified\. No transmission authorized\./);
  assert.doesNotMatch(hub, /Claude · subscription · WAIT until qualified/);
});

test('ConversationEngine new:true isolates browser sessions from the latest retained session', async (t) => {
  const f = await fixture(t);
  const engine = new ConversationEngine(f.bridge, {
    qualify: async () => ({ state: 'READY', model: 'ollama/qwen3-coder:30b' }),
  });
  t.after(() => engine.close());
  const first = engine.session({ channel: 'browser' });
  const again = engine.session({ channel: 'browser' });
  assert.equal(again.conversation_id, first.conversation_id);
  const fresh = engine.session({ channel: 'browser', new: true });
  assert.notEqual(fresh.conversation_id, first.conversation_id);
  assert.match(fresh.conversation_id, /^[a-f0-9-]{36}$/i);
  assert.equal(typeof randomUUID(), 'string');
});
