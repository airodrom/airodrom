# Runtime recovery — consolidated cutover V1

**Status:** prepared for owner authorization. Not merge, install, or reconcile approval.
**Stack:** PR #104 (web dispatch gate) + this bridge-invocation recovery PR.
**Live install today:** `88c693f`. Dirty operator checkout `a1f97c5` must remain untouched.

## Sealed host evidence (reuse; do not re-prepare)

| Field | Value |
| --- | --- |
| evidence_id | `4c33d49b-4c43-46e5-8e2b-b55e3938e387` |
| sha256 | `cb58d222702240fb75256f890623c940e48317a6514d23b7e6588e89de67aa53` |
| host run_id | `b5f79b6b-22cf-43fd-98bc-3295226a1360` |
| lease_id | `be1743be-2951-4cdf-945c-0e43a6809965` |
| mission_id | `127229ca-ab86-43f9-8cd3-0ce86a2e30c6` |
| bridge run_id | `4616ce39-ea67-4dcc-a85a-826a2497386e` |
| invocation_id | `134d8f08-a98b-49ac-8898-e04af8dff7c5` |
| dispatch_id | `6f5eb4e1-b760-4a41-bd31-1077bec732a3` |
| prior boot | `kern.boottime:1791778624.277648` |
| post-reboot boot | `kern.boottime:1791935044.938659` (already observed) |

Checkpoint: `~/.airodrom/backups/boot-recovery-cutover-88c693f-20261013T232730Z/`.

## Ownership facts (read-only)

- Host Run is the browser worker with quarantined lease + running dispatch; eligible for `web-reconcile-boot` once #104 is installed.
- Bridge Run is an orchestrator `mission_web` **invocation lease** (`agent_id=bridge`), not web-boot-eligible (no run-scoped web evidence).
- Invocation `134d8f08-…` is ledger-bound to the bridge Run via `orchestrator.capability.requested` / capability metadata — not to host web evidence.
- Cold reboot already proves prior-boot processes are gone; it does **not** prove external side-effect outcome. Settlement is `recovery_not_execution`.
- No second reboot is required for this source correction while the current boot epoch still differs from the sealed prior epoch.

## One installation / recovery procedure

Perform only after owner authorizes merge of both PRs and then live cutover.

A. Verify exact merged SHAs (main includes #104 tip and this tip).
B. Confirm required CI + focused tests (`public-web-termination`, `bridge-invocation-recovery`, authority/SDK typechecks).
C. Verify live supervisor identity, quarantine still present, current OS boot ≠ sealed prior.
D. Preserve checkpoint, Memory, Vault, credentials, Mission records, recovery evidence, rollback notes. Do not overwrite sealed evidence timestamps.
E. Build a fresh immutable installation of the merged tip (same pattern as the #103 cutover).
F. Exceptional single-supervisor replacement only after explicit owner authorization. Keep ordinary admission closed / recovery-only.
G. Confirm sealed host evidence still `prepared`, SHA-256 unchanged, file intact.
H. Confirm current boot epoch still differs from sealed prior.
I. Host reconcile only:

   `POST /api/control-v2/web-reconcile-boot` with host `run_id` / `mission_id` / `lease_id` / evidence_id / sha256 / `termination_verified:true` / `recovery_kind:cold_os_reboot`.

J. Bridge reconcile only (witnesses the same evidence; does not re-prepare or re-consume):

   `POST /api/control-v2/bridge-invocation-reconcile-boot` with bridge `run_id`, `mission_id`, `invocation_id=134d8f08-…`, `boot_boundary_evidence_id`/`boot_boundary_sha256` of the host packet, `termination_verified:true`, `recovery_kind:cold_os_reboot`.

K. Verify blockers: host Run settled, lease released, host dispatch blocked, bridge Run settled, proven invocation settled, evidence row `consumed` only by host path, no unknown execution ownership.
L. Resume ordinary admission only when lifecycle reports idle blockers = 0 and product-control Ready is honestly earned.
M. Confirm one owned supervisor, correct installed SHA, harness healthy / MCP ready, Memory/Missions/Vault intact.
N. Record final receipts and rollback points. No website research retry.

## Explicit holds

- If bridge ledger ownership cannot be re-verified on the live DB, leave the invocation `unknown` and remain HOLD.
- If current boot equals sealed prior, stop — do not invent post-reboot evidence; request a new owner-authorized reboot only if that gate fails.
- Do not force-release leases, manually edit SQLite, or claim Ready from one surface alone.

## Rollback

Stop the new tip first. Retarget `local.json` to the previous immutable install recorded in the checkpoint. Relink CLI / desktop-login. Never wipe `~/.airodrom/data`.

## Owner-approval boundary

No merge, installation, supervisor replacement, live reconcile, quarantine release, reboot, or admission resume is authorized by this document alone. Machine-readable request: [owner-approval/RUNTIME-RECOVERY-CONSOLIDATED-OWNER-APPROVAL.json](owner-approval/RUNTIME-RECOVERY-CONSOLIDATED-OWNER-APPROVAL.json).
