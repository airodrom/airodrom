# Live Agent Observatory V1

Control Center Mission detail is a three-column Live Observatory:

- **Left** — Mission timeline and execution stages
- **Center** — current activity, elapsed time, heartbeat, live command/worker stream
- **Right** — files, Git diff, worker details, tests, verification/acceptance

Overview shows active Missions, working agents, waiting Approvals, recent failures, current operations, and system readiness.

## Transport

| Route | Role |
| --- | --- |
| `GET /api/product/observatory?mission=` | Durable Mission snapshot |
| `GET /api/product/live-events?mission=&after=&category=&q=` | Cursor polling fallback |
| `GET /api/product/live-stream?mission=&after=` | Authenticated SSE with reconnect cursor |
| `GET /api/product/observatory/diff?mission=&path=` | Bounded in-scope Git diff |

Hidden pages and paused feeds stop SSE. Events are deduplicated by `event_id` and ledger idempotency keys. Browser reload resumes from the last cursor.

## Capture (supported live events)

| Event class | Source | Timing |
| --- | --- | --- |
| `worker.started` / `worker.terminated` | OpenCode adapter | Mid-run / end of turn |
| `worker.tool_requested` / `worker.tool_completed` | OpenCode NDJSON `onLine` | Mid-run (tool name only) |
| `fs.file_*` | Host measurement of allowed paths | After worker turn |
| `git.diff_observed` | Host Git measurement | After worker turn |
| `shell.command.*` / `test.*` | Governed job ledger | When jobs register outcomes |
| Mission lifecycle STAGES | Product observability projection | Continuous ledger |

## Observation boundary

- Continuous filesystem watch: **unavailable** — file creates/modifies/deletes are host-measured after the worker turn.
- Mid-run tool **names** are observed from OpenCode NDJSON; arguments, prompts, and hidden reasoning are never stored.
- Diff viewer: Mission `allowed_files` only, capped at 200 lines / 24 KiB.
- Empty center stream shows **Detailed activity unavailable.** rather than inventing progress.

## Activation (owner-authorized only)

`live_cutover_authorized: false` until the operator explicitly authorizes.

1. Confirm PR head SHA and mandatory checks.
2. Install the Control Center artifacts from that revision into the service tree (`public/control-hub.{html,js,css}`, `src/live-observatory.js`, adapter/control-server wiring).
3. Backup current `public/control-hub.*` and `src/live-observatory.js` (if present) before replace.
4. Restart the local control service so routes and static assets reload.
5. Health: `scripts/harness-safe-status.cjs` allowlisted checks; open Control Center; open one Mission detail; confirm SSE or poll catch-up.
6. Rollback: restore backed-up Control Center files and previous `src` modules, then restart.

Production credentials, Memory, Mission state, and private discovery must not change during activation.

## Runtime integration

- OpenCode **2.0.25** qualification and pin-replacement requalify from PR #40 are merged into this branch.
- Observatory capture does not require PR #38.
- Authorized WORK-template live Missions still require host-approved WORK templates available on the installed service (may exist in the operator checkout separately from this PR).

## Focused tests

`node --test tests/live-observatory-v1.test.js`
