'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { runtime, qualifyCanonical } = require('./fixtures/opencode-fixture.cjs');
const ControlServer = require('../src/control-server');

test('Control Center enrolls exact discovery and caller delegation, displays limits and revokes it', async t => {
  const f = await fixture(t, { opencode: runtime(t).options }), b = f.bridge;
  b.missionAuthority.initializeOperatorKey(); qualifyCanonical(b);
  const project = b.projects.listProjects({ status: 'active' })[0], goal = b.projects.summary(project.projectId).goals[0];
  const server = new ControlServer(b, { port: 0 }); await server.start(); t.after(() => server.close());
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.addInitScript(token => sessionStorage.setItem('airodromToken', token), server.token);
  const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.accept());
  await page.goto(server.origin);
  await page.locator('.nav-more > summary').click();
  await page.getByRole('button', { name: 'Developer Autonomy', exact: true }).click();
  for (const [name, value] of Object.entries({ alias: 'browser-cognitive', repository: f.repo, project_id: project.projectId, goal_id: goal.goalId,
    diff_check: 'diff-check', default_tests: 'fixture-test', workflows: 'routine_edit,test', duration_days: '1', cognitive_files: 'fixture.txt', cognitive_callers: 'mcp:380c1915-b24c-40c5-9f7a-8e87c2da61f0' })) {
    await page.locator('[name="' + name + '"]').fill(value);
  }
  await page.getByRole('button', { name: 'Review and enroll', exact: true }).click();
  await page.getByText('browser-cognitive', { exact: true }).waitFor();
  await page.getByText('Inspect policy', { exact: true }).click();
  await page.getByText('Automatic planning files: fixture.txt', { exact: true }).waitFor();
  await page.getByText('Planning attempts: 2; execution: one attempt; repairs: 0; OpenCode result review required.', { exact: true }).waitFor();
  const policy = b.developerAutonomy.list('operator')[0]; assert.equal(policy.cognitive.delegated_callers.length, 1);
  await page.getByRole('button', { name: 'Revoke policy', exact: true }).click();
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].some(b => b.textContent === 'Revoke policy'));
  assert.equal(b.developerAutonomy.inspect(policy.policy_id).state, 'revoked'); assert.deepEqual(errors, []);
});
