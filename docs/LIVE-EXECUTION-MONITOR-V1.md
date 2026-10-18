# Live Execution Monitor V1

Unified real-time Mission activity inside Control Center. Reuses Live Agent Observatory transport, the canonical event ledger, and Mission lifecycle controls. Does not add a second authority system.

## Operator experience

Opening an **active** Mission (`dispatching` / `running` / `verifying`, or advancing activity) shows the **Live Execution Monitor**:

| Column | Content |
| --- | --- |
| Left | Chronological Mission timeline (timestamps, category, label, worker identity, expandable sanitized output) |
| Center | Filtered live activity (worker / command / test), SSE connection state, observation boundary |
| Right | Host-measured file changes with line counts, bounded diffs, verification, Acceptance, tests |

Counters: execution status, worker, files changed, test pass/fail, elapsed time, telemetry mode (`real-time` / `post-run` / `none`). When no further telemetry is available, the monitor says so explicitly.

Completed Missions keep the existing tabbed Outcome / Live Logs / Worker / Files / Tests / Verification / Audit detail.

Stop / Cancel, Review Acceptance, Verification, and Acceptance continue to use existing Control Center actions and the canonical Mission lifecycle.

## Capture by worker

| Worker | Mid-run | Post-execution | Not claimed |
| --- | --- | --- | --- |
| OpenCode | NDJSON tool names via `observeOpenCodeLine` | Host-measured files / git.diff via `observeOpenCodeResult` | Arguments, reasoning, unsaved typing |
| Cursor | stream-json tool names via `observeCursorEvent` when emitted | Host-measured files via `observeCursorResult` (`terminate: false`; exit already on `worker.exited`) | Fabricated tools; events the CLI does not emit |
| Other / host | Lifecycle STAGES, governed jobs | Same | Continuous FS watch |

Snapshot `version: 2` exposes `activity.telemetry`, `activity.files_changed`, test counters, and `observation_boundary.real_time_vs_post` so UI can distinguish real-time worker events from post-execution observations.

## Transport (unchanged contracts)

| Route | Role |
| --- | --- |
| `GET /api/product/observatory?mission=` | Durable snapshot (v2 fields additive) |
| `GET /api/product/live-events?mission=&after=` | Poll / cursor catch-up |
| `GET /api/product/live-stream?mission=&after=` | Authenticated SSE, reconnect, dedupe |
| `GET /api/product/observatory/diff?mission=&path=` | Mission-scoped bounded Git diff |

## Security

Credentials, private reasoning, hidden prompts, sensitive environment values, unrestricted terminal output, and unauthorized file contents are never projected. Mission scoping, subscription authorization, and tenant boundaries are preserved.

## Focused tests

```bash
node --test tests/live-observatory-v1.test.js
```

Covers sanitized projection, SSE reconnect/dedupe, OpenCode NDJSON (no reasoning), Cursor progressive mid-run before post-execution files, Control Center `executionMonitor` / `obs-grid` contracts, and API e2e.

## Installation / verification

Use the managed rollback-capable installation process. After cutover:

1. Confirm installed SHA matches the merged revision.
2. Open Control Center → active Mission → confirm Live Execution Monitor three-column layout and SSE/poll status.
3. During a running OpenCode or Cursor Mission, confirm tool/lifecycle events appear **before** the Mission finishes when the worker emits them.
4. Confirm Stop/Cancel still routes through Mission cancel, not a parallel authority path.

Until installed and browser-verified on the running service, this feature is **source-complete only**, not live.

## Related

- [Live Agent Observatory V1](LIVE-AGENT-OBSERVATORY-V1.md)
- [ADR 0036](adr/0036-live-agent-observatory-v1.md)
- [Known limitations](KNOWN-LIMITATIONS.md)
