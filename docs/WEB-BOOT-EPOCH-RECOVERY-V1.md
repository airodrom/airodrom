# Web boot-epoch recovery V1

## Purpose

Recover a quarantined website-only research lease when the host run never recorded a browser PID, so same-boot PID ESRCH reconcile is impossible.

This path proves prior-boot execution is gone via an OS boot-epoch boundary after an owner-authorized cold reboot. It does **not** prove the research Mission succeeded and must not invent `browser_closed` receipts.

## Non-goals

- Missing PID, process-listing absence, or orphan attestation are never sufficient.
- Soft restart, service restart, logout, or sleep are not cold reboot.
- Sibling Mission runs are not settled by another run's reconcile.
- File evidence alone is not authoritative; the durable registry SHA-256 is required.

## Procedure

1. Ensure admission remains closed / product-control not Ready while quarantine remains.
2. Capture durable evidence (no reboot yet):

   `POST /api/control-v2/web-boot-recovery-prepare`  
   `{ "run_id", "lease_id", "request_id" }`

   Retain `evidence_id`, `sha256`, and reported `boot_epoch`. The control plane also seals the same SHA-256 into `cp_mission_web_boot_recovery` (state=`prepared`).

3. Owner-authorized **cold OS reboot** of the machine that owns the live install.
4. After boot, start the service only as needed for authenticated control-plane access. Do not relaunch research.
5. Reconcile the exact binding:

   `POST /api/control-v2/web-reconcile-boot`  
   `{ "run_id", "mission_id", "lease_id", "evidence_id", "sha256", "termination_verified": true, "recovery_kind": "cold_os_reboot", "request_id" }`

6. Repeat independently for any other interrupted run that still blocks (each needs its own prepare/reconcile; a run without a quarantined lease still requires exact mission/run binding and boot evidence).
7. Confirm dual-surface health: harness healthy/mcp_ready **and** product-control Ready. Do not claim Ready from one surface alone.

## Verification gates

Fail closed unless all hold:

- Canonical registry row exists for `evidence_id` in state `prepared` (not previously consumed).
- Caller `sha256`, registry `sha256`, and recomputed file digest are identical.
- Packet binds mission/run/lease, prior boot epoch, snapshot state/timestamps, and `browser_closed_receipt:false`.
- Packet fields match the independently sealed registry snapshot (no substitution).
- Live Mission/run/lease snapshot still matches the sealed packet (no stale drift).
- Current boot epoch ≠ sealed prior boot epoch.
- Run timestamps confined to the prior boot.
- No post-boot continuation on the named run across run, dispatch, invocation, lease, or execution events.
- In-memory uncertain browser handle absent.
- On success the registry row is marked `consumed` (replay denied) and resolution is `operator_web_boot_recovery` with `recovery_not_execution: true`.
