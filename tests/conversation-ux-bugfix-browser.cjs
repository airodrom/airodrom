'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.AIRODROM_PLAYWRIGHT_MODULE || 'playwright-core');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const ControlServer = require('../src/control-server');
const { ConversationEngine } = require('../src/conversation-engine');

test('Start new / Continue / refresh / Claude unavailable keep Qwen and isolate sessions', async (t) => {
  const f = await fixture(t);
  const engine = new ConversationEngine(f.bridge, {
    qualify: async () => ({ state: 'READY', model: 'ollama/qwen3-coder:30b' }),
  });
  t.after(() => engine.close());
  f.bridge.conversationEngine = engine;
  const server = new ControlServer(f.bridge, { port: 0 });
  await server.start();
  t.after(() => server.close());

  const first = engine.session({ channel: 'browser' });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((token) => sessionStorage.setItem('airodromToken', token), server.token);
  await page.addInitScript((id) => sessionStorage.setItem('airodromConversationSession', id), first.conversation_id);
  await page.goto(server.origin + '/?view=Conversation', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.getByRole('heading', { name: 'Talk to Airodrom' }).waitFor({ timeout: 20000 });
  await page.waitForTimeout(1000);

  let text = await page.locator('body').innerText();
  assert.match(text, /Continuing session/);
  assert.match(text, /Claude · unavailable · WAIT until qualified/);

  await page.getByRole('button', { name: 'Start new conversation' }).click();
  await page.waitForTimeout(500);
  text = await page.locator('body').innerText();
  assert.match(text, /New conversation ready · first send creates a fresh host session/);
  assert.match(text, /New conversation\. Previous browser session closed/);
  assert.doesNotMatch(text, /Continuing session/);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Talk to Airodrom' }).waitFor({ timeout: 20000 });
  await page.waitForTimeout(1000);
  text = await page.locator('body').innerText();
  assert.doesNotMatch(text, /Continuing session/);
  assert.match(text, /New conversation ready · first send creates a fresh host session|New browser session starts on first send/);

  const cont = page.getByRole('button', { name: 'Continue previous conversation' });
  assert.equal(await cont.isEnabled(), true);
  await cont.click();
  await page.waitForTimeout(1000);
  text = await page.locator('body').innerText();
  assert.match(text, /Continuing (persistent browser )?session|Continuing session/);

  const select = page.getByLabel('Conversation model');
  await select.selectOption('claude');
  await page.getByRole('button', { name: 'Use selected model' }).click();
  await page.waitForTimeout(700);
  text = await page.locator('body').innerText();
  assert.match(text, /Claude is unavailable for everyday conversation until independently qualified/);
  assert.match(text, /Qwen remains the selected working provider/);
  assert.equal(await select.inputValue(), 'qwen');

  const fresh = engine.session({ channel: 'browser', new: true });
  assert.notEqual(fresh.conversation_id, first.conversation_id);
  assert.deepEqual(errors, []);
});
