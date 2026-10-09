# Live Agent Observatory V1 — Controlled Activation

`live_cutover_authorized: false` until the operator explicitly authorizes merge, install, restart, or live WORK dispatch.

## Source revision

Use the exact PR #41 head SHA recorded at activation time (verify with `git rev-parse` on `feat/live-agent-observatory-v1`).

## Install file set (replace atomically after backup)

Backend / routes:

- `src/live-observatory.js`
- `src/apps/opencode-adapter.js` (2.0.25 + Observatory `onLine` hooks)
- `src/product-observability.js` (worker/file/command/test STAGES + 2.0.25 version display)
- `src/local-bootstrap.js` (pin-replacement requalify from OpenCode 2.0.25)
- `src/model-worker-router.js` (version string alignment)
- `config/agent-runtime-qualification-v1.json`

Control Center UI (restart required for static reload):

- `public/control-hub.html`
- `public/control-hub.js`
- `public/control-hub.css`

Docs/tests may install with the revision but are not required for runtime serving.

## Backup

Before replace, copy the currently installed versions of every path above into a timestamped directory, for example:

`~/airodrom-backups/observatory-v1-<UTC-timestamp>/`

Retain the previous service PID / start command used by the local launcher.

## Install steps (owner-authorized)

1. Confirm PR head SHA and that focused Observatory tests passed on that SHA.
2. Create the backup directory and copy the install file set from the running tree.
3. Copy the same paths from the activation revision into the service tree.
4. Restart the local control service so API routes and static Control Center assets reload.
5. Confirm Control Center serves `/control-hub.js` containing `LIVE MISSION OBSERVATORY` and APIs:
   - `/api/product/observatory`
   - `/api/product/live-events`
   - `/api/product/live-stream`
   - `/api/product/observatory/diff`
6. Allowlisted health only: `scripts/harness-safe-status.cjs`.

## Rollback

1. Stop the control service.
2. Restore every file from the backup directory over the service tree.
3. Restart with the prior launcher.
4. Re-check harness-safe status and Control Center load.

## Harmless WORK Mission plan (dispatch only with owner authorization)

Disposable workspace Mission, OpenCode preferred, scoped to one fixture file and one focused test:

- Objective: create/read/modify one harmless fixture file; run one focused test; leave a measurable Git diff.
- `allowed_files`: exactly the fixture path(s) under a disposable workspace.
- Verification: `git diff --check` plus one registered focused test.
- Runtime: OpenCode 2.0.25 (qualified).
- Authority: existing WORK template / Mission create path only — no approval bypass.
- Observatory expectations after dispatch:
  - `worker.started` / tool events (mid-run NDJSON names) / `worker.terminated`
  - after-turn `fs.file_*` + `git.diff_observed`
  - command/test ledger events when verification jobs run
  - Mission lifecycle STAGES
  - SSE reconnect via `after=` cursor; poll fallback on `/live-events`
  - secrets/reasoning absent from projections

If no host-approved WORK template is present on the installed service, do not fabricate success — install templates or use an already-authorized Mission create path first.
