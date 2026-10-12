#!/usr/bin/env node
'use strict';
/**
 * Owner-installation Control Center memory-layer acceptance (read-only).
 * Uses live overview JSON + optional Chrome against the private Control Center.
 * Never prints memory contents or credentials.
 */
const path = require('node:path');
const fs = require('node:fs');
const local = require('../src/local-bootstrap');
const { readPrivateJSON } = require('../src/private-json');

const REQUIRED = [
  { id: 'personal', label: /Personal Memory V2/i },
  { id: 'project', label: /Project Memory V2/i },
  { id: 'architecture', label: /Architecture/i },
  { id: 'context_pack', label: /ContextPack/i },
  { id: 'developer', label: /Developer Memory V1/i }
];

function assert(cond, msg) {
  if (!cond) throw Error(msg);
}

async function main() {
  const home = local.localHome();
  const dataDir = path.join(home, 'data');
  const overview = await local.request(home, '/api/product/overview');
  const layers = overview.memory?.layers || [];
  const report = { api: {}, browser: null, authority: false };

  for (const req of REQUIRED) {
    const layer = layers.find(l => l.id === req.id);
    assert(layer, 'missing layer ' + req.id);
    assert(req.label.test(layer.label || ''), 'label mismatch ' + req.id);
    assert(layer.capacity_kind === 'reference_soft', 'capacity_kind not reference_soft: ' + req.id);
    assert(!/disk utilization|database utilization/i.test(String(layer.detail || '')), 'disk utilization label leak: ' + req.id);
    assert(/reference soft/i.test(String(layer.detail || '')), 'missing reference-soft detail: ' + req.id);
    report.api[req.id] = {
      state: layer.state,
      used: layer.used,
      capacity: layer.capacity,
      percent: layer.percent,
      capacity_kind: layer.capacity_kind
    };
  }

  assert(report.api.developer.state === 'Disabled', 'Developer Memory must display Disabled');
  assert(report.api.personal.state === 'Ready' || report.api.personal.state === 'Configured', 'Personal unexpected state');
  assert(report.api.project.state === 'Ready' || report.api.project.state === 'Configured', 'Project unexpected state');

  let playwright;
  try {
    playwright = require('playwright-core');
  } catch {
    report.browser = { skipped: true, reason: 'playwright-core_unavailable' };
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }

  const ui = readPrivateJSON(path.join(dataDir, 'ui.json'));
  const control = readPrivateJSON(path.join(dataDir, 'control-credential.json'));
  // Private discovery URL may embed token in hash; prefer credential + origin.
  const origin = `http://127.0.0.1:${ui.port}`;
  // Prefer private discovery URL (hash token). sessionStorage is a secondary path.
  const entry = typeof ui.url === 'string' && ui.url.includes('#token=') ? ui.url : (origin + '/#token=' + control.token);
  const browser = await playwright.chromium.launch({
    channel: process.env.AIRODROM_BROWSER_CHANNEL || 'chrome',
    headless: true
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.addInitScript(token => sessionStorage.setItem('airodromToken', token), control.token);
    await page.goto(entry, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.getByText(/Live · local|Authorization required|Memory layers/i).first().waitFor({ timeout: 20000 });
    const authBlocked = (await page.getByText('Authorization required', { exact: true }).count()) > 0;
    if (authBlocked) {
      report.browser = { skipped: false, authorized: false, reason: 'authorization_required' };
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      return;
    }
    await page.getByRole('button', { name: 'Overview', exact: true }).click().catch(() => {});
    await page.getByText(/Memory layers · live/i).first().waitFor({ timeout: 15000 });
    const body = await page.locator('body').innerText();
    assert(!/Bearer |token=|mcp-preserved|PRIVATE_/i.test(body), 'credential leak in Overview DOM');

    const overviewHits = {};
    for (const req of REQUIRED) {
      overviewHits[req.id] = (await page.getByText(req.label).count()) > 0;
    }
    assert(Object.values(overviewHits).every(Boolean), 'Overview missing one or more layer labels');
    assert(/reference soft capacity/i.test(body), 'Overview missing reference-soft capacity copy');
    assert((await page.getByText('Disabled', { exact: true }).count()) > 0, 'Developer Disabled chip not visible on Overview');

    const memoryNav = page.getByRole('button', { name: 'Memory', exact: true });
    await memoryNav.click();
    await page.getByText(/All memory layers · live/i).first().waitFor({ timeout: 15000 });
    const memBody = await page.locator('body').innerText();
    assert(!/Bearer |token=/i.test(memBody), 'credential leak on Memory page');
    const memoryPage = {
      present: true,
      layer_labels: Object.fromEntries(REQUIRED.map(r => [r.id, (memBody.match(r.label) != null)])),
      has_reference_soft: /reference soft capacity/i.test(memBody),
      developer_disabled: /Developer Memory V1[\s\S]{0,120}Disabled/i.test(memBody) || /Disabled/i.test(memBody)
    };
    assert(Object.values(memoryPage.layer_labels).every(Boolean), 'Memory page missing layer labels');
    assert(memoryPage.has_reference_soft, 'Memory page missing reference-soft capacity copy');

    // Progress tracks present for live layers
    const tracks = await page.locator('.memory-layer-track').count();
    assert(tracks >= 5, 'expected animated/progress tracks for five layers, got ' + tracks);

    report.browser = {
      skipped: false,
      authorized: true,
      overview_layer_signals: overviewHits,
      memory_page: memoryPage,
      progress_tracks: tracks,
      developer_disabled_visible: true
    };
  } finally {
    await browser.close();
  }

  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

main().catch(error => {
  process.stderr.write((error && error.message) || String(error));
  process.stderr.write('\n');
  process.exitCode = 1;
});
