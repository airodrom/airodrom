# Web boot-epoch recovery V1

## Purpose

Recover a quarantined website-only research lease when the host run never recorded a browser PID, so same-boot PID ESRCH reconcile is impossible.

This path proves prior-boot execution is gone via an OS boot-epoch boundary after an owner-authorized cold reboot. It does **not** prove the research Mission succeeded and must not invent `browser_closed` receipts.

## Non-goals

- Missing PID, process-listing absence, or orphan attestation are never sufficient.
- Soft restart, service restart, logout, or sleep are not cold reboot.
- Sibling Mission runs are not settled by another run's reconcile.

## Procedure

1. Ensure admission remains closed / product-control not Ready while quarantine remains.
2. Capture durable evidence (no reboot yet):

   `POST /api/control-v2/web-boot-recovery-prepare`  
   `{ "run_id", "lease_id", "request_id" }`

   Retain `evidence_id`, `sha256`, and reported `boot_epoch`.

3. Owner-authorized **cold OS reboot** of the machine that owns the live install.
4. After boot, start the service only as needed for authenticated control-plane access. Do not relaunch research.
5. Reconcile the exact binding:

   `POST /api/control-v2/web-reconcile-boot`  
   `{ "run_id", "mission_id", "lease_id", "evidence_id", "termination_verified": true, "recovery_kind": "cold_os_reboot", "request_id" }`

6. Repeat independently for any other interrupted run that still blocks (each needs its own prepare/reconcile; a run without a quarantined lease still requires exact mission/run binding and boot evidence).
7. Confirm dual-surface health: harness healthy/mcp_ready **and** product-control Ready. Do not claim Ready from one surface alone.

## Verification gates

- Evidence packet binds mission/run/lease and prior boot epoch; integrity-checked at reconcile.
- Current boot epoch ≠ sealed prior boot epoch.
- Run timestamps confined to the prior boot; no post-boot browser/run execution events for that run.
- In-memory uncertain browser handle absent.
- Outcome resolution is `operator_web_boot_recovery` with `recovery_not_execution: true`.
