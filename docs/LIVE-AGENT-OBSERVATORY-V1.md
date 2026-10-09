# Live Agent Observatory V1

Control Center Mission detail is a three-column Live Observatory:

- **Left** — Mission timeline and execution stages
- **Center** — current activity, elapsed time, heartbeat, live command/worker stream
- **Right** — files, Git diff, worker details, tests, verification/acceptance

## Transport

| Route | Role |
| --- | --- |
| `GET /api/product/observatory?mission=` | Durable Mission snapshot |
| `GET /api/product/live-events?mission=&after=&category=&q=` | Cursor polling fallback |
| `GET /api/product/live-stream?mission=&after=` | Authenticated SSE with reconnect cursor |
| `GET /api/product/observatory/diff?mission=&path=` | Bounded in-scope Git diff |

Hidden pages and paused feeds stop SSE. Events are deduplicated by `event_id` and ledger idempotency keys.

## Capture

- OpenCode: `worker.*` from NDJSON lines during execution; host-measured `fs.*` / `git.diff_observed` after apply
- Trusted/governed jobs: existing `shell.command.*`, `test.*`, `git.*.observed` ledger events now project into the UI
- Never fabricates progress percentages or test counts from log text

## Limits

- OpenCode does not stream file contents mid-turn; file panels update from host measurement
- Diff viewer shows at most 200 lines / 24 KiB, Mission-scoped only
- Model reasoning and tool arguments are never stored
