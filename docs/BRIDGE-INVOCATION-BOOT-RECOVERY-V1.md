# Bridge invocation boot-epoch recovery V1

## Purpose

Reconcile an interrupted `agent_id=bridge` **invocation-lease** Run after an owner-authorized cold OS reboot when:

- the Run is not web-execution proven (no `cp_mission_web_evidence` / research browser ledger on that `run_id`),
- there is no quarantined workspace lease on that Run,
- a durable Event Ledger bind proves exact `request_id` ownership on that `run_id`,
- and an independently sealed web-boot evidence packet witnesses the prior boot boundary.

This path returns `recovery_not_execution: true`. It does **not** prove the capability succeeded, does not invent browser-close receipts, and does not consume host web-boot evidence.

## Non-goals

- Shared Mission/task with a host web Run is never ownership proof.
- Timestamp proximity is never ownership proof.
- Process absence alone is never sufficient without a cold-boot boundary witness.
- Web-proven bridge Runs must use `web-reconcile-boot`, not this path.
- Unknown invocations without a ledger bind on the named Run stay `unknown` (HOLD).
- Capability replay is refused; Mission must already be `cancelled`.

## API

`POST /api/control-v2/bridge-invocation-reconcile-boot`

```json
{
  "run_id": "<bridge run>",
  "mission_id": "<mission>",
  "invocation_id": "<cp_invocations.request_id>",
  "boot_boundary_evidence_id": "<host web-boot evidence_id>",
  "boot_boundary_sha256": "<64 hex>",
  "termination_verified": true,
  "recovery_kind": "cold_os_reboot",
  "request_id": "<operator idempotency uuid>"
}
```

## Verification gates

Fail closed unless all hold:

1. Run `agent_id=bridge`, state `interrupted`/`termination_unverified`, unverified, no PID.
2. Mission/task binding exact; Mission state `cancelled`.
3. No web evidence / research browser ledger on this `run_id`.
4. No held/quarantined lease and no dispatch bound to this `run_id`.
5. Ledger ownership: authoritative event on this `run_id` of type
   `orchestrator.capability.requested` or `capability.requested` with exact
   matching `request_id` (column and/or metadata) **and** a non-empty
   `metadata.capability`. `lifecycle.lease_acquired` is never sufficient
   (lease acquire precedes `latestMcpRequestId` assignment and can carry a
   previous invocation id).
6. Boot-boundary witness: existing `cp_mission_web_boot_recovery` row (`prepared` **or** `consumed`) for the same Mission, different Run, digest-intact packet, current boot ≠ sealed prior boot. Witness row is **not** consumed by this path.
7. Run/invocation timestamps confined to prior boot; no post-boot execution events on the Run (observational `approval.decision` / task-phase events allowed when Mission is cancelled).
8. Settlement is exact-Run + exact-invocation only; siblings remain untouched.

## Relationship to web boot recovery

| Path | Settles | Evidence | Invocation rule |
| --- | --- | --- | --- |
| `web-reconcile-boot` | Host (or web-proven bridge) Run + quarantined lease + exact dispatch | Consumes prepared web-boot packet | Only via run-scoped `cp_mission_web_evidence` |
| `bridge-invocation-reconcile-boot` | Bridge invocation-lease Run + proven invocation | Witnesses web-boot packet (no consume) | Only via ledger bind on that Run |

Both paths preserve PR #104 semantics: historical pre-boot `running` dispatch is not automatic post-boot proof; unproven same-task invocations stay protected.
