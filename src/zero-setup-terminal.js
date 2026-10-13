'use strict';
// Authenticated local Terminal consent for zero-setup WORK.
// Model/chat text is never consent. Only an explicit TTY y/yes after the host preview.
const path = require('node:path');
const terminal = require('./vault-cli');
const local = require('./local-bootstrap');

const ACTIVE_FILE = 'zero-setup-active.json';
const STATUS_TIMEOUT_MS = 30000;
const POLL_BUDGET_MS = 600000;
const MAX_FETCH_FAILURES = 12;

function preview(presentation = {}) {
  const files = (presentation.files || []).join(', ') || 'none';
  return [
    'Airodrom wants to:',
    '',
    presentation.goal || 'Bounded local work',
    '',
    'Project: ' + (presentation.project_name || 'Unresolved'),
    'Workspace: ' + (presentation.workspace_label || 'selected disposable workspace'),
    'File: ' + files,
    'Worker: ' + (presentation.worker || 'Local OpenCode'),
    'Verification: ' + (presentation.verification || 'Registered focused checks'),
    'Network: ' + (presentation.network || 'No external access'),
    'GitHub: ' + (presentation.github || 'No commits or pushes'),
    'Production: ' + (presentation.production || 'No access'),
    '',
  ].join('\n');
}

function terminalRequired(input, output) {
  if (!input?.isTTY || !output?.isTTY || typeof input.setRawMode !== 'function') {
    throw Error('Bounded work authorization requires an interactive owner terminal. Control Center Autonomous Goals remains available.');
  }
  if (input.listenerCount('data') || input.listenerCount('readable')) {
    throw Error('Detach ordinary chat input before authorizing bounded work.');
  }
}

function activePath(home) {
  return path.join(home, ACTIVE_FILE);
}

function rememberActive(home, requestId) {
  if (!home || !requestId) return;
  try {
    local.writePrivate(activePath(home), {
      version: 1,
      request_id: requestId,
      started_at: Date.now(),
      authority: false,
    });
  } catch { /* best effort; durable status still uses request_id */ }
}

function clearActive(home) {
  if (!home) return;
  try {
    const fs = require('node:fs');
    fs.rmSync(activePath(home), { force: true });
  } catch { /* ignore */ }
}

function readActive(home) {
  try {
    const row = local.ownedJSON(activePath(home));
    if (row?.version === 1 && typeof row.request_id === 'string' && row.request_id.length >= 8) return row;
  } catch { /* absent */ }
  return null;
}

function isTransportError(error) {
  const name = error?.name || '';
  const message = String(error?.message || error || '');
  if (['TimeoutError', 'AbortError', 'TypeError'].includes(name)) return true;
  return /fetch failed|timed out|ECONNREFUSED|ECONNRESET|socket|network|interrupted|Local discovery|ownership|not healthy|AbortError|TimeoutError/i.test(message);
}

async function statusOnce(home, requestId, { request = local.request, signal } = {}) {
  const route = '/api/assistant/zero-setup/status?request_id=' + encodeURIComponent(requestId);
  if (request.length >= 4 || request === local.request) {
    return request(home, route, undefined, { timeoutMs: STATUS_TIMEOUT_MS, signal });
  }
  return request(home, route);
}

async function poll(home, requestId, {
  signal,
  request = local.request,
  sleep = ms => new Promise(r => setTimeout(r, ms)),
  onUpdate = null,
} = {}) {
  const started = Date.now();
  let failures = 0;
  let lastSignature = '';
  while (!signal?.aborted && Date.now() - started < POLL_BUDGET_MS) {
    try {
      const view = await statusOnce(home, requestId, { request, signal });
      failures = 0;
      const signature = [
        view.state,
        view.outcome?.mission_state,
        view.presentation?.status,
        view.technical?.repair_of || '',
      ].join('|');
      if (onUpdate && signature !== lastSignature) {
        lastSignature = signature;
        try { onUpdate(view); } catch { /* UI updates must never abort observation */ }
      }
      const state = String(view.state || '').toUpperCase();
      const mission = view.outcome?.mission_state;
      const presentation = String(view.presentation?.status || '');
      const repairing = !!(view.technical?.repair_of || /Repairing|preparing automatic repair|Repair verification/i.test(presentation));
      if (['AWAITING_ACCEPTANCE', 'VERIFIED', 'COMPLETED'].includes(state) || ['awaiting_acceptance', 'completed'].includes(mission)) return view;
      // needs_rework is not terminal while authorized repair may still run.
      if (['FAILED', 'REJECTED', 'CLARIFY'].includes(state) || ['failed', 'cancelled'].includes(mission)) return view;
      if (state === 'BLOCKED' || mission === 'blocked') {
        if (repairing && !view.technical?.repair_blocked_reason) {
          await sleep(1000);
          continue;
        }
        return view;
      }
      if (mission === 'needs_rework' && !repairing && view.technical?.repair_blocked_reason) return view;
      await sleep(1000);
    } catch (error) {
      if (signal?.aborted) throw Error('Interrupted');
      if (!isTransportError(error)) throw error;
      failures += 1;
      if (failures >= MAX_FETCH_FAILURES) {
        throw Error('Connection to Airodrom was interrupted. The task may still be running. No duplicate task was started. Reopen Airodrom to inspect the same task.');
      }
      await sleep(Math.min(8000, 500 * (2 ** Math.min(failures, 4))));
    }
  }
  if (signal?.aborted) throw Error('Interrupted');
  throw Error('Timed out waiting for independent verification. Inspect Control Center before retrying.');
}

function resultText(view) {
  const mission = view.outcome?.mission_state;
  const verification = view.outcome?.verification;
  const repairOf = view.technical?.repair_of || view.repair_of || null;
  const repaired = !!(repairOf || /Repairing|repair completed/i.test(view.presentation?.status || ''));
  const passed = verification?.result === 'passed' || verification?.result === 'operator_review' || ['awaiting_acceptance', 'completed'].includes(mission);
  if (passed && ['awaiting_acceptance', 'completed'].includes(mission)) {
    const files = (view.presentation?.files || []).join(', ') || 'the requested file';
    const lines = [];
    if (repaired) {
      lines.push('Initial verification failed.');
      lines.push('Airodrom repaired the file automatically.');
      lines.push('Repair completed. Verification passed.');
    } else {
      lines.push('Verification passed.');
    }
    lines.push('');
    lines.push('Updated ' + files + '.');
    lines.push('Original Goal resumed.');
    lines.push('Awaiting owner Acceptance.');
    return lines.join('\n');
  }
  if (String(view.state || '').toUpperCase() === 'REJECTED' || mission === 'cancelled') return view.message || 'Cancelled. Nothing was written.';
  if (/Repairing|preparing automatic repair|Repair verification/i.test(view.presentation?.status || '') || String(view.state || '').toUpperCase() === 'RUNNING') {
    return view.message || 'Working… first verification failed; diagnosing and repairing within the original approved scope.';
  }
  if (String(view.state || '').toUpperCase() === 'BLOCKED' || view.technical?.repair_blocked_reason) {
    const reason = view.technical?.repair_blocked_reason;
    return view.message || ('Automatic repair stopped safely' + (reason ? ' (' + reason + ')' : '') + '. Independent verification did not pass. No unsafe retry was performed.');
  }
  if (mission === 'needs_rework') {
    return view.message || 'Automatic repair stopped safely. Independent verification did not pass. No unsafe retry was performed.';
  }
  return view.message || ('Work did not finish cleanly (' + (mission || view.state || 'unknown') + '). No Acceptance was recorded.');
}

async function resumeActive(home, { input, output, signal, request = local.request } = {}) {
  const active = readActive(home);
  if (!active) return null;
  output.write('Airo\nResuming observation of the same authorized task...\n');
  try {
    const done = await poll(home, active.request_id, {
      signal,
      request,
      onUpdate(view) {
        if (/Repairing/i.test(view.presentation?.status || '')) {
          output.write('Airo\nInitial verification failed. Airodrom is repairing the file automatically.\n');
        }
      },
    });
    clearActive(home);
    output.write('Airo\n' + resultText(done) + '\n');
    return done;
  } catch (error) {
    if (/interrupted\. The task may still be running/i.test(String(error.message || ''))) {
      output.write('Airo\n' + error.message + '\n');
      return { kind: 'zero_setup', state: 'RUNNING', message: error.message, technical: { request_id: active.request_id }, authority: false };
    }
    throw error;
  }
}

async function guide({ receipt, input, output, home, signal, request = local.request }) {
  if (!receipt || receipt.kind !== 'zero_setup') return receipt;
  if (String(receipt.state || '').toUpperCase() === 'CLARIFY') {
    const lines = ['Airo\n' + (receipt.message || 'I need one short clarification.')];
    for (const choice of receipt.choices || []) {
      lines.push('- ' + (choice.project_name || 'Project') + (choice.workspace_label ? ' · ' + choice.workspace_label : ''));
    }
    output.write(lines.join('\n') + '\n');
    return receipt;
  }
  if (String(receipt.state || '').toUpperCase() !== 'WAIT') {
    output.write('Airo\n' + resultText(receipt) + '\n');
    return receipt;
  }
  const requestId = receipt.technical?.request_id;
  if (!requestId) throw Error('Prepared task identity unavailable');
  terminalRequired(input, output);
  output.write('Airo\n' + preview(receipt.presentation));
  const approved = await terminal.confirm(input, output, { prompt: 'Approve this task? [y/N]', signal });
  if (!approved || signal?.aborted) {
    try { await request(home, '/api/assistant/zero-setup/reject', { request_id: requestId, confirmed: true }); } catch { /* best-effort cancel */ }
    clearActive(home);
    output.write('Airo\nCancelled. Nothing was written.\n');
    return { kind: 'zero_setup', state: 'REJECTED', message: 'Cancelled. Nothing was written.', authority: false, execution_authorized: false };
  }
  output.write('Airo\nWorking...\n');
  const started = await request(home, '/api/assistant/zero-setup/approve', { request_id: requestId, confirmed: true });
  if (!started.execution_authorized) throw Error('Host authorization did not enable execution');
  rememberActive(home, requestId);
  let announcedRepair = false;
  try {
    const done = await poll(home, requestId, {
      signal,
      request,
      onUpdate(view) {
        if (!announcedRepair && /Repairing/i.test(view.presentation?.status || '')) {
          announcedRepair = true;
          output.write('Airo\nInitial verification failed. Airodrom is repairing the file automatically.\n');
        }
      },
    });
    clearActive(home);
    output.write('Airo\n' + resultText(done) + '\n');
    return done;
  } catch (error) {
    if (/interrupted\. The task may still be running/i.test(String(error.message || ''))) {
      output.write('Airo\n' + error.message + '\n');
      return { kind: 'zero_setup', state: 'RUNNING', message: error.message, technical: { request_id: requestId }, authority: false };
    }
    throw error;
  }
}

module.exports = { guide, preview, resultText, poll, terminalRequired, rememberActive, clearActive, readActive, resumeActive, isTransportError };
