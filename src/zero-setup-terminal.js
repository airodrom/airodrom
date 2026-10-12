'use strict';
// Authenticated local Terminal consent for zero-setup WORK.
// Model/chat text is never consent. Only an explicit TTY y/yes after the host preview.
const terminal = require('./vault-cli');
const local = require('./local-bootstrap');

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

async function poll(home, requestId, { signal, request = local.request, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const started = Date.now();
  while (!signal?.aborted && Date.now() - started < 600000) {
    const view = await request(home, '/api/assistant/zero-setup/status?request_id=' + encodeURIComponent(requestId));
    const state = String(view.state || '').toUpperCase();
    const mission = view.outcome?.mission_state;
    if (['AWAITING_ACCEPTANCE', 'VERIFIED', 'COMPLETED'].includes(state) || ['awaiting_acceptance', 'completed'].includes(mission)) return view;
    if (['BLOCKED', 'FAILED', 'REJECTED', 'CLARIFY'].includes(state) || ['blocked', 'needs_rework', 'failed', 'cancelled'].includes(mission)) return view;
    await sleep(500);
  }
  if (signal?.aborted) throw Error('Interrupted');
  throw Error('Timed out waiting for independent verification. Inspect Control Center before retrying.');
}

function resultText(view) {
  const mission = view.outcome?.mission_state;
  const verification = view.outcome?.verification;
  const repaired = !!(view.technical?.repair_of || view.repair_of || /Repairing/i.test(view.presentation?.status || ''));
  const passed = verification?.result === 'passed' || ['awaiting_acceptance', 'completed'].includes(mission);
  if (passed) {
    const files = (view.presentation?.files || []).join(', ') || 'the requested file';
    return [
      repaired ? 'Automatic repair completed. Verification passed.' : 'Verification passed.',
      'Updated ' + files + '.',
      'Acceptance remains a separate owner decision. Nothing was settled automatically.',
    ].join('\n');
  }
  if (String(view.state || '').toUpperCase() === 'REJECTED' || mission === 'cancelled') return view.message || 'Cancelled. Nothing was written.';
  if (/Repairing/i.test(view.presentation?.status || '') || String(view.state || '').toUpperCase() === 'RUNNING') {
    return view.message || 'Working… diagnosing and repairing the failed verification within the original approved scope.';
  }
  return view.message || ('Work did not finish cleanly (' + (mission || view.state || 'unknown') + '). No Acceptance was recorded.');
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
  const approved = await terminal.confirm(input, output, { prompt: 'Approve this bounded change? [y/N]', signal });
  if (!approved || signal?.aborted) {
    try { await request(home, '/api/assistant/zero-setup/reject', { request_id: requestId, confirmed: true }); } catch { /* best-effort cancel */ }
    output.write('Airo\nCancelled. Nothing was written.\n');
    return { kind: 'zero_setup', state: 'REJECTED', message: 'Cancelled. Nothing was written.', authority: false, execution_authorized: false };
  }
  output.write('Airo\nWorking...\n');
  const started = await request(home, '/api/assistant/zero-setup/approve', { request_id: requestId, confirmed: true });
  if (!started.execution_authorized) throw Error('Host authorization did not enable execution');
  const done = await poll(home, requestId, { signal, request });
  output.write('Airo\n' + resultText(done) + '\n');
  return done;
}

module.exports = { guide, preview, resultText, poll, terminalRequired };
