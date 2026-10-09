'use strict';
// Human-readable CLI views. Plain text unless the stream is a TTY and NO_COLOR is
// unset; --json callers keep receiving the original structured data unchanged.
const ADMISSION = { open: 'Open', draining: 'Maintenance hold', booting: 'Maintenance hold', stopping: 'Stopping' };

function styler(stream = process.stdout, env = process.env) {
  const on = stream?.isTTY === true && env.NO_COLOR === undefined && env.TERM !== 'dumb';
  const wrap = code => text => on ? `\x1b[${code}m${text}\x1b[0m` : text;
  return { bold: wrap('1'), dim: wrap('2'), good: wrap('32'), warn: wrap('33'), bad: wrap('31') };
}

function table(title, rows, next, s) {
  const width = Math.max(...rows.map(([label]) => label.length)) + 3;
  return [s.bold('AIRODROM · ' + title), '', ...rows.map(([label, value]) => label.padEnd(width) + value), '',
    s.bold('Next Action'), next, '', s.dim('Use --json for structured output.')].join('\n');
}

// One recommendation, in priority order, from observed facts only.
function nextAction({ stopped, healthy, admission, unresolved, opencodeReady, mcpReady }) {
  if (stopped) return 'Airodrom is stopped. Start it from the menu or with airodrom start.';
  if (!healthy) return 'Run airodrom doctor; the service is not answering health checks.';
  if (unresolved > 0) return 'Review unresolved execution records with airodrom admission status.';
  if (admission && admission.state !== 'open') return admission.idle && admission.reconciled ? 'Work is settled; reopen admission with airodrom admission resume.' : 'Review maintenance blockers with airodrom admission status.';
  if (!opencodeReady) return 'Restore qualified OpenCode, then run airodrom requalify.';
  if (!mcpReady) return 'Restart the service so it publishes MCP discovery.';
  return 'None. Airodrom is ready.';
}

// s: interactive status (or null when stopped); admission: lifecycle gate or null when the service has none.
function serviceStatus({ status = null, admission = null, mcpReady = false, stopped = false }, stream, env) {
  const s = styler(stream, env), p = status?.product || {}, healthy = !stopped && status?.healthy === true;
  const opencodeReady = status?.opencode?.ready === true;
  const unresolved = admission?.blockers?.runs ?? (status ? (status.active_runs || 0) + (status.quarantined_leases || 0) : 0);
  const rows = [
    ['Control Plane', stopped ? s.dim('Stopped') : healthy ? s.good('Running') : s.bad('Not answering')],
    ['Service Admission', stopped ? s.dim('—') : admission ? (admission.state === 'open' ? s.good('Open') : s.warn(ADMISSION[admission.state] || 'Unknown')) : s.dim('Not reported by this service')],
    ['Memory', healthy ? (p.memory && p.memory !== 'Unavailable' ? 'Protected · local' : s.warn(p.memory || 'Unavailable')) : s.dim('—')],
    ['MCP', healthy ? (mcpReady ? s.good('Ready') : s.warn('Not ready')) : s.dim('—')],
    ['Unresolved Runs', stopped ? s.dim('—') : unresolved ? s.warn(String(unresolved)) : '0'],
    ['OpenCode', stopped ? s.dim('—') : opencodeReady ? s.good('Available') : s.warn('Unavailable · ' + (status?.opencode?.reason || 'not observed').replaceAll('_', ' '))],
    ['Active Missions', healthy ? String(p.active_missions ?? 'Unavailable') : s.dim('—')]
  ];
  return table('SERVICE STATUS', rows, nextAction({ stopped, healthy, admission, unresolved, opencodeReady, mcpReady }), s);
}

function admissionStatus(gate, stream, env) {
  const s = styler(stream, env);
  if (!gate) return table('SERVICE ADMISSION', [['Admission', s.dim('Not reported by this service')]], 'This service predates the admission gate; use airodrom status.', s);
  const blocking = Object.entries(gate.blockers || {}).filter(([, n]) => n > 0);
  const rows = [['Admission', gate.state === 'open' ? s.good('Open') : s.warn(ADMISSION[gate.state] || 'Unknown')], ['Reconciled', gate.reconciled ? 'Yes' : s.warn('No')],
    ['Closed startup', gate.closed_startup ? 'Yes' : 'No'], ['Blockers', blocking.length ? s.warn(blocking.map(([k, n]) => k.replaceAll('_', ' ') + ' ' + n).join(', ')) : 'None']];
  const next = gate.state === 'open' ? 'None. Admission is open.' : !gate.reconciled ? 'Wait for startup reconciliation to finish.'
    : blocking.length ? 'Resolve the listed blockers; admission stays closed until they settle.' : 'Work is settled; reopen admission with airodrom admission resume.';
  return table('SERVICE ADMISSION', rows, next, s);
}

module.exports = { styler, serviceStatus, admissionStatus, nextAction };
