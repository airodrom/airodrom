# ADR 0033 — Host idle run settlement

Status: Proposed. Canonical predicate on this branch. Integrating it into the
uncommitted ServiceLifecycle and bootstrap maintenance gates is a separate,
owner-applied step.

Numbering note: ADRs 0020–0032 exist as unmerged proposals elsewhere; this record
uses 0033 so the sequences cannot collide.

## Context

`control-execution.js` settles verified host turns with `process_state='idle'`: the
reusable host session can outlive the turn, but nothing executes for that run. The
run store accepts `idle`. The admission and maintenance gates accepted only `exited`
and `not_started`, so every settled host run counted as unresolved forever. On the
operator installation, four such records (three cancelled and one completed, all
`termination_verified=1`, liveness `settled`, no PID, ended, leases released) held
admission closed.

## Decision

`src/run-settlement.js` is the single definition of a settled run. A run is settled
when its state is terminal, `termination_verified` is 1, and either:
- `process_state` is `exited` or `not_started`, or
- `process_state` is `idle`, the agent is `host`, liveness is `settled`, no PID is
  recorded, an end time exists, and no unreleased lease is attached to the run.

NULL or unrecognised values are unresolved (COALESCE fails closed). `idle` never
settles a non-host run. `durableBlockers(db)` keeps the existing global counters:
leases, invocations, dispatches, continuations, Slack effects and outbox effects.
The in-memory checks in the lifecycle (requests, leases, jobs, ticks) stay where
they are.

Production data is not edited. With the contract fixed, those four records are
correctly settled. A read-only evaluation against the installed database counts 4
unresolved runs with the old gate and 0 with this contract.

## Consequences

Admission can reopen after legitimate host work, through the existing reconciled,
operator-authorized resume. Crashed or unverified runs still keep it closed, and a
restart under the managed supervisor (PR #36) cannot reopen it over unresolved work.
