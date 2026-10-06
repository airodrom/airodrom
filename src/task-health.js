"use strict";
// Observation only: health never authorizes execution, termination or lease release.
function taskHealth({ active = false, startedAt, heartbeatAt, eventAt, outputAt,
  processState = 'unknown', leaseState = 'none', budgetMs, phase = null,
  recovered = false, now = Date.now(), quietMs = 60000, heartbeatMs = 20000 } = {}) {
  const valid = value => Number.isFinite(value) && value >= 0 && value <= now;
  const age = value => valid(value) ? now - value : null;
  const elapsedMs = age(startedAt);
  const scopedAge = value => valid(startedAt) && valid(value) && value >= startedAt ? age(value) : null;
  const heartbeatAgeMs = scopedAge(heartbeatAt), eventAgeMs = scopedAge(eventAt), outputAgeMs = scopedAge(outputAt);
  const ages = [eventAgeMs, outputAgeMs, elapsedMs].filter(x => x !== null);
  const progressAgeMs = ages.length ? Math.min(...ages) : null;
  const exceeded = Number.isFinite(budgetMs) && budgetMs >= 0 && elapsedMs !== null && elapsedMs >= budgetMs;
  const waiting = /approval|waiting_for|paused|blocked/.test(phase || '');
  const reasons = [];
  let status = 'Healthy';
  if (recovered && !active && leaseState === 'released') status = 'Recovered';
  else if (active) {
    if (leaseState === 'quarantined') reasons.push('termination_unverified');
    if (processState === 'dead') reasons.push('process_missing');
    if (exceeded) reasons.push('budget_exceeded');
    if (!waiting && progressAgeMs !== null && progressAgeMs >= quietMs) reasons.push('no_recent_progress');
    if (heartbeatAgeMs !== null && heartbeatAgeMs >= heartbeatMs) reasons.push('heartbeat_delayed');
    if (leaseState === 'expired') reasons.push('lease_expired');
    if (leaseState === 'quarantined' || processState === 'dead' || exceeded) status = 'Stalled';
    else if (reasons.length || (!waiting && elapsedMs >= quietMs && processState === 'unknown')) status = 'Possibly Stalled';
  }
  // Unknown signals contribute no points and no denominator; never invent telemetry.
  const signals = [
    [25, heartbeatAgeMs === null ? null : heartbeatAgeMs < heartbeatMs],
    [25, processState === 'unknown' || processState === 'absent' ? null : processState === 'alive'],
    [15, eventAgeMs === null ? null : eventAgeMs < quietMs],
    [15, outputAgeMs === null ? null : outputAgeMs < quietMs],
    [10, leaseState === 'none' ? null : ['held','released','not_required'].includes(leaseState)],
    [10, elapsedMs === null || !Number.isFinite(budgetMs) ? null : !exceeded]
  ];
  const available = signals.filter(([,value]) => value !== null);
  let score = available.length ? Math.round(100 * available.reduce((n,[w,v]) => n + (v ? w : 0),0) / available.reduce((n,[w]) => n+w,0)) : null;
  if (!active) score = null;
  if (status === 'Stalled' && score !== null) score = Math.min(score, 25);
  if (status === 'Possibly Stalled' && score !== null) score = Math.min(score, 65);
  return {status, score, active, phase, processState, leaseState, heartbeatAgeMs, eventAgeMs, outputAgeMs,
    elapsedMs, budgetMs: Number.isFinite(budgetMs) ? budgetMs : null, budgetExceeded: exceeded,
    waiting, reasons, observedAt: now, executionAuthority: false};
}
module.exports = { taskHealth };
