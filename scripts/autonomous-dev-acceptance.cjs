#!/usr/bin/env node
'use strict';
// Live governed acceptance against the registered safe-dev workspace.
// Uses the running tip service. Never accepts, restarts, or touches credentials.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const local = require('../src/local-bootstrap');

const WORKSPACE = fs.realpathSync('/Users/andrew/Documents/Codex/2026-10-13/airodrom-safe-dev-workspace');
const PROJECT = 'release-qualification';
const WORKSPACE_ALIAS = 'safe-dev';
const OBJECTIVE = 'Change fixture.txt from alpha to beta. Make its test pass.';

async function statusOf(home, missionId) {
  const s = await local.request(home, '/api/assistant/mission', {
    action: 'status', mission_id: missionId, request_id: randomUUID()
  }, { timeoutMs: 60000 });
  return s.mission || s;
}

async function settle(home, missionId, want = 'awaiting_acceptance', timeoutMs = 300000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await statusOf(home, missionId);
      if (last.state === want) return last;
      if (['blocked', 'needs_rework', 'cancelled', 'completed'].includes(last.state) && last.state !== want) {
        throw Error('Mission settled unexpectedly as ' + last.state + ': ' + (last.reason || ''));
      }
    } catch (error) {
      if (error.name !== 'TimeoutError' && !/timed out|TimeoutError|not JSON/i.test(error.message || '')) throw error;
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  throw Error('Timed out waiting for ' + want + '; last=' + (last && last.state));
}

async function main() {
  const home = local.localHome();
  const evidence = {
    started_at: new Date().toISOString(),
    workspace: WORKSPACE,
    project: PROJECT,
    workspace_alias: WORKSPACE_ALIAS,
    objective: OBJECTIVE,
    steps: [],
    authority: false
  };
  const note = (name, data) => { evidence.steps.push({ name, at: new Date().toISOString(), ...data }); };

  // Require a clean disposable tree for template registration semantics.
  const dirty = require('node:child_process').execFileSync('/usr/bin/git', ['-C', WORKSPACE, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
  if (dirty) {
    fs.writeFileSync(path.join(WORKSPACE, 'fixture.txt'), 'alpha\n');
    require('node:child_process').execFileSync('/usr/bin/git', ['-C', WORKSPACE, 'checkout', '--', 'fixture.txt'], { stdio: 'pipe' });
    note('reset_fixture', { prior_dirty: true });
  }

  const templates = await local.request(home, '/api/assistant/work-templates');
  const template = (templates.items || []).find(t => t.project === PROJECT && t.workspace_alias === WORKSPACE_ALIAS && t.state === 'active');
  if (!template || template.workspace !== WORKSPACE) throw Error('safe-dev work template not registered on live service');
  note('template', { state: template.state, workers: template.workers, allowed_files: template.allowed_files });

  const registry = await local.request(home, '/api/assistant/registry');
  const opencode = (registry.workers || []).find(w => w.id === 'opencode');
  if (!opencode?.available || opencode.version !== '2.0.25') throw Error('Qualified OpenCode 2.0.25 unavailable');
  note('runtime', { available: opencode.available, version: opencode.version, qualification: opencode.qualification });

  const packet = {
    version: 2,
    request_id: randomUUID(),
    objective: OBJECTIVE,
    mission_class: 'WORK',
    data_class: 'public',
    privacy: 'local_only',
    project: PROJECT,
    workspace: WORKSPACE_ALIAS,
    worker: 'opencode',
    model: 'auto'
  };
  const receipt = await local.request(home, '/api/assistant/handoff', packet, { timeoutMs: 30000 });
  note('handoff', {
    mission_id: receipt.mission_id,
    state: receipt.state,
    deferred_dispatch: receipt.deferred_dispatch === true,
    next_action: receipt.next_action || null,
    worker: receipt.route?.worker || null
  });
  if (!receipt.mission_id || receipt.route?.worker !== 'opencode') throw Error('OpenCode WORK handoff failed');

  const replay = await local.request(home, '/api/assistant/handoff', packet, { timeoutMs: 30000 });
  note('replay', { same_mission: replay.mission_id === receipt.mission_id });
  if (replay.mission_id !== receipt.mission_id) throw Error('Replay duplicated Mission');

  const denied = await local.request(home, '/api/assistant/handoff', {
    ...packet, request_id: randomUUID(), workspace: 'not-registered-alias'
  }, { timeoutMs: 30000 });
  note('out_of_scope_workspace', { state: denied.state, reason: denied.reason || null });
  if (denied.state !== 'WAIT') throw Error('Missing template must WAIT');

  await local.request(home, '/api/assistant/mission', {
    action: 'run', mission_id: receipt.mission_id, request_id: randomUUID()
  }, { timeoutMs: 30000 });
  note('dispatch', { mission_id: receipt.mission_id });

  const done = await settle(home, receipt.mission_id);
  const after = fs.readFileSync(path.join(WORKSPACE, 'fixture.txt'), 'utf8');
  note('awaiting_acceptance', { state: done.state, fixture: after, verification: done.verification || null, acceptance: done.acceptance || null });
  if (after !== 'beta\n') throw Error('OpenCode did not produce the permitted fixture change');
  if (done.acceptance?.status === 'accept' || done.settlement?.status === 'settled') {
    throw Error('Mission must not self-accept');
  }

  let dirtyFollow = null;
  try {
    dirtyFollow = await local.request(home, '/api/assistant/handoff', {
      ...packet,
      request_id: randomUUID(),
      objective: 'Change fixture.txt from beta to gamma. Touch only fixture.txt.'
    }, { timeoutMs: 30000 });
  } catch (error) {
    dirtyFollow = { state: 'DENIED', reason: error.message };
  }
  note('dirty_overlap_followon', dirtyFollow);
  if (!(dirtyFollow.state === 'WAIT' || /dirty/i.test(dirtyFollow.reason || ''))) {
    throw Error('Dirty follow-on work must be refused');
  }

  const handoffView = await local.request(home, '/api/assistant/handoff?id=' + encodeURIComponent(receipt.mission_id), undefined, { timeoutMs: 30000 });
  note('ui_surfaces', {
    handoff_state: handoffView.state,
    review: handoffView.review || null,
    verification: handoffView.verification?.status || null,
    authority: handoffView.authority
  });

  evidence.result = 'PASS';
  evidence.mission_id = receipt.mission_id;
  evidence.acceptance_required = true;
  evidence.accepted = false;
  evidence.runtime = { worker: 'opencode', version: '2.0.25', model: 'ollama/qwen3-coder:30b' };
  evidence.finished_at = new Date().toISOString();
  const outDir = path.join(process.env.HOME || '', 'Documents/Codex/2026-10-13/airodrom-autonomous-dev-acceptance');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'acceptance-' + Date.now() + '.json');
  fs.writeFileSync(outFile, JSON.stringify(evidence, null, 2));
  process.stdout.write(JSON.stringify({ ...evidence, evidence_file: outFile }, null, 2) + '\n');
}

main().catch(error => {
  process.stderr.write(String(error && error.stack || error) + '\n');
  process.exit(1);
});
