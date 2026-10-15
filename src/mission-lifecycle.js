'use strict';
/**
 * Authoritative Mission lifecycle.
 * Historical aliases project through canonicalize(); product views use project().
 */
const TRANSITIONS = Object.freeze({
  draft: ['cancelled'],
  planned: ['ready', 'cancelled'],
  ready: ['draft', 'dispatching', 'cancelled', 'blocked', 'paused'],
  dispatching: ['running', 'blocked', 'cancelled'],
  running: ['waiting_for_operator', 'verifying', 'blocked', 'needs_rework', 'cancelled', 'paused'],
  waiting_for_operator: ['ready', 'blocked', 'cancelled', 'paused'],
  waiting_for_dependency: ['ready', 'blocked', 'cancelled'],
  verifying: ['awaiting_acceptance', 'needs_rework', 'blocked', 'cancelled'],
  awaiting_acceptance: ['completed', 'verifying', 'needs_rework', 'blocked', 'cancelled'],
  needs_rework: ['ready', 'verifying', 'cancelled'],
  // awaiting_acceptance/completed: restore or Accept after mistaken authority-TTL block of verified work
  blocked: ['ready', 'cancelled', 'paused', 'awaiting_acceptance', 'completed'],
  paused: ['ready', 'blocked', 'cancelled'],
  cancelled: [],
  completed: []
});

/** Parallel vocabularies collapse to the authoritative state on read and write. */
const ALIASES = Object.freeze({
  verification: 'verifying',
  awaiting_orchestrator_acceptance: 'awaiting_acceptance',
  waiting_for_agent: 'waiting_for_operator'
});

const CANONICAL_STATES = Object.freeze(Object.keys(TRANSITIONS));

function canonicalize(state) {
  if (typeof state !== 'string') throw new Error('Invalid Mission state');
  const next = ALIASES[state] || state;
  if (!TRANSITIONS[next]) throw new Error('Invalid Mission state');
  return next;
}

function assertTransition(from, to) {
  const a = canonicalize(from), b = canonicalize(to);
  if (!TRANSITIONS[a]?.includes(b)) throw new Error(`Invalid Mission transition: ${from} → ${to}`);
  return { from: a, to: b };
}

function project(state) {
  const canonical = canonicalize(state);
  return {
    state: canonical,
    raw: state,
    aliased: canonical !== state,
    terminal: TRANSITIONS[canonical].length === 0,
    next: TRANSITIONS[canonical].slice()
  };
}

module.exports = { TRANSITIONS, ALIASES, CANONICAL_STATES, canonicalize, assertTransition, project };
