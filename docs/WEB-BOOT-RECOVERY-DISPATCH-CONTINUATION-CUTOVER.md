# Web boot-recovery — pre-boot dispatch continuation cutover

**Status:** prepared for owner authorization. Not an execution approval.
**Base:** `88c693f` (merged #103). **This change:** distinguish historical pre-boot `running` dispatches from real post-boot continuation.

## Live sealed evidence (reuse; do not re-prepare)

| Field | Value |
| --- | --- |
| evidence_id | `4c33d49b-4c43-46e5-8e2b-b55e3938e387` |
| sha256 | `cb58d222702240fb75256f890623c940e48317a6514d23b7e6588e89de67aa53` |
| host run_id | `b5f79b6b-22cf-43fd-98bc-3295226a1360` |
| lease_id | `be1743be-2951-4cdf-945c-0e43a6809965` |
| mission_id | `127229ca-ab86-43f9-8cd3-0ce86a2e30c6` |
| prior boot fingerprint | `kern.boottime:1791778624.277648` |
| current boot (post-reboot) | already changed; no second reboot required unless epoch/evidence gates fail |

Checkpoint copy: `~/.airodrom/backups/boot-recovery-cutover-88c693f-20261013T232730Z/`.

## Why HOLD happened

`web-reconcile-boot` refused `post_boot_dispatch_continuation` because dispatch `6f5eb4e1-b760-4a41-bd31-1077bec732a3` remained `state=running` while all authoritative timestamps predated the new OS boot. That is durable pre-boot history, not post-boot execution.

## Governed cutover (after merge authorization)

1. Preserve dirty operator checkout `a1f97c5` and do not mutate Memory/Vault/credentials.
2. Build an immutable install of the merged tip (same pattern as the #103 boot-recovery install).
3. Exceptional owned-supervisor replacement to the new tip with ordinary Mission admission closed (durable blockers remain until reconcile). Do not force-release leases; do not clear locks manually; do not start a second supervisor.
4. Verify one supervisor, install identity, sealed evidence still `prepared` with matching SHA-256, and `/usr/sbin/sysctl kern.boottime` still differs from the sealed prior epoch.
5. Call **only** `POST /api/control-v2/web-reconcile-boot` for the host run with the existing evidence_id/sha256/`recovery_kind=cold_os_reboot`/`termination_verified=true`.
6. Expect host run settled, quarantined lease released, exact host dispatch blocked, evidence row `consumed`, `recovery_not_execution=true`.
7. Invocation settlement requires canonical run-scoped `cp_mission_web_evidence` binding `invocation_id`→host `run_id`. Live inspection found **no** such row for `134d8f08-a98b-49ac-8898-e04af8dff7c5`; leave that invocation `unknown` and treat it as continued HOLD for separate investigation. Never invent a task/Mission/timestamp join.
8. Do **not** call web-boot-recovery on bridge run `4616ce39-ea67-4dcc-a85a-826a2497386e` unless independent run-scoped web-execution proof exists (it does not today).
9. Confirm product-control Ready and harness healthy/`mcp_ready` only when unresolved ownership is actually zero. Do not claim Ready while bridge sibling and/or unproven invocations remain.
10. No arecibo.ca / public-web research retry. No second reboot unless a safety gate requires it.

## Bridge sibling — independent non-web mechanism

| Fact | Implication |
| --- | --- |
| `agent_id=bridge`, no `cp_mission_web_evidence` / web ledger on that `run_id` | `boot_recovery_bridge_web_unproven` — correctly refused by web path |
| Shares Mission/task with the host web run | Sharing is **not** web-execution proof |
| No recorded PID | Same-boot PID ESRCH reconcile does not apply |
| Resolution `reconcile_process` | Non-web interrupted ownership |
| Ledger bind inv→bridge run | Use `bridge-invocation-reconcile-boot` (see [BRIDGE-INVOCATION-BOOT-RECOVERY-V1.md](BRIDGE-INVOCATION-BOOT-RECOVERY-V1.md)) |

Do **not** falsely classify the bridge run as web execution. After host recovery, reconcile bridge ownership only through the stacked non-web API with the sealed host packet as boot-boundary witness. Consolidated owner procedure: [RUNTIME-RECOVERY-CONSOLIDATED-CUTOVER-V1.md](RUNTIME-RECOVERY-CONSOLIDATED-CUTOVER-V1.md).

## Rollback

Stop the new tip first. Retarget `local.json` to the previous immutable install (`88c693f` or the pre-cutover source recorded in the checkpoint). Relink CLI / desktop-login from that install. Never wipe `~/.airodrom/data`.

## Explicit stops

No merge, installation, or live reconciliation without a further owner authorization message naming this PR tip.
