'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { fixture } = require('./fixtures/mission-fixture.cjs');
const { missionView } = require('../src/product-observability');

const hash = v => createHash('sha256').update(v).digest('hex');

class Browser {
  constructor(o) { this.evidenceDir = o.evidenceDir; this.url = null; }
  async start() {}
  ownedProcessId() { return null; }
  async close() { return { closed: true, termination_verified: true, owned_process_termination: 'verified' }; }
  verify() { return true; }
  async execute(a) {
    if (a.type === 'navigate') { this.url = a.url; return { state: 'navigated' }; }
    const id = randomUUID();
    const text = 'Arecibo public homepage synthetic body for Trusted Autonomy.';
    const row = {
      id, url: this.url || a.url, title: 'Arecibo — synthetic public page', text, content: text,
      sha256: hash(text), classification: 'observed', links: [], forms: [],
      viewport: { width: 1280, height: 800 }, captured_at: Date.now(), authority: false, untrusted: true
    };
    const bytes = Buffer.from(JSON.stringify(row) + '\n');
    const file = path.join(this.evidenceDir, id + '.json');
    fs.writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' });
    row.evidence_ref = { id, path: file, sha256: hash(bytes) };
    return row;
  }
}

function synth(f) {
  f.bridge.options.researchMission = {
    workspace: f.repo, synthetic: true, baselineFiles: ['docs/README.md'],
    maxPages: 4, maxActions: 30, timeoutMs: 30000
  };
  f.bridge.missions.web.options = { synthetic: true, browserFactory: o => new Browser(o) };
}

test('standing origins load from Trusted Autonomy config; unapproved origins stay denied', async t => {
  const f = await fixture(t);
  const risk = f.bridge.missions.riskAcceptance;
  assert.equal(risk.preference().enabled, true);
  assert.ok(risk.standingOrigins().includes('https://arecibo.ca'));
  assert.equal(risk.originsApproved(['https://arecibo.ca']), true);
  assert.equal(risk.originsApproved(['https://arecibo.ca', 'https://evil.example']), false);
  risk.revokeStandingOrigin('https://arecibo.ca', 'operator');
  assert.equal(risk.originsApproved(['https://arecibo.ca']), false);
  assert.equal(risk.originsApproved(['https://evil.example']), false);
  risk.approveStandingOrigin('https://arecibo.ca', 'operator');
  assert.equal(risk.originsApproved(['https://arecibo.ca']), true);
});

test('standing approved-origin research auto-grants, completes, settles, and audits non-human Acceptance', async t => {
  const f = await fixture(t);
  synth(f);
  const risk = f.bridge.missions.riskAcceptance;
  assert.equal(risk.preference().enabled, true);

  // Without interactive confirmed — Trusted Autonomy supplies consent for standing origin only.
  const created = f.bridge.missions.web.createResearch({
    request_id: randomUUID(),
    objective: 'Research https://arecibo.ca/ read-only public homepage.',
    mode: 'on',
    entries: ['https://arecibo.ca/'],
    permission_mode: 'strict',
    duration_ms: 60000
  }, 'operator');
  const m = f.bridge.controlStore.requireMission(created.mission_id);
  const grant = f.bridge.missions.web.grant(m, { active: false });
  assert.deepEqual(grant.policy.origins, ['https://arecibo.ca']);

  f.bridge.missions.dispatch(created.mission_id, { request_id: randomUUID() });
  const done = await f.settle(created.mission_id, 'completed');
  assert.equal(done.state, 'completed');
  assert.equal(done.acceptance.length, 1);
  assert.equal(done.acceptance[0].decision, 'accept');
  assert.equal(done.program_contract.settlement.state, 'settled');
  const payload = JSON.parse(done.acceptance[0].rationale);
  assert.match(payload.rationale, /Trusted Autonomy/);
  assert.match(payload.evidence, /human_acceptance=false/);
  const view = missionView(f.bridge, f.bridge.controlStore.requireMission(created.mission_id));
  assert.equal(view.acceptance.mode, 'automatically_verified');
  const audited = f.bridge.ledger.list({ missionId: created.mission_id, limit: 100, order: 'desc' }).events
    .some(e => e.event_type === 'trusted_autonomy.public_research.completed' && e.metadata?.human_acceptance === false);
  assert.equal(audited, true);

  // Unapproved origin still requires explicit confirmed consent and cannot auto-authorize.
  assert.throws(() => f.bridge.missions.web.createResearch({
    request_id: randomUUID(),
    objective: 'Research https://evil.example/ read-only.',
    mode: 'on',
    entries: ['https://evil.example/'],
    permission_mode: 'strict',
    duration_ms: 60000
  }, 'operator'), /operator_web_consent_required|unapproved|Public HTTPS|safeOrigin|origin/);
});

test('Trusted Autonomy OFF blocks public research auto-completion', async t => {
  const f = await fixture(t);
  synth(f);
  const risk = f.bridge.missions.riskAcceptance;
  const created = f.bridge.missions.web.createResearch({
    request_id: randomUUID(),
    objective: 'Research https://arecibo.ca/ read-only public homepage.',
    mode: 'on',
    entries: ['https://arecibo.ca/'],
    confirmed: true,
    permission_mode: 'strict',
    duration_ms: 60000
  }, 'operator');
  risk.setPreference({ enabled: false, confirmed: true }, 'operator');
  f.bridge.missions.dispatch(created.mission_id, { request_id: randomUUID() });
  const waiting = await f.settle(created.mission_id, 'awaiting_acceptance');
  assert.equal(waiting.acceptance.length, 0);
  assert.equal(risk.attemptPublicResearch(created.mission_id).reason, 'trusted_autonomy_off');
});
