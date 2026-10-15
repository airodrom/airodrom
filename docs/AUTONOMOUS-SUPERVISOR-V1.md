# Autonomous Supervisor V1

Completes Issue #108 on top of [Unified Autonomous Development V1](UNIFIED-AUTONOMOUS-DEVELOPMENT-V1.md) and Live Activity V2. Decision record: [ADR 0052](adr/0052-autonomous-supervisor.md).

Airodrom remains the only execution authority and scheduler. This surface **does not** add a second orchestration system. It projects Mission V2 / CAE / repair / worker-router state into Live Activity, CLI logs, and session cleanup helpers.

## Flow

```
USER → ChatGPT (orchestrator) → Airodrom → qualified AI worker → implementation
     → independent verification → automatic diagnosis/repair → retry or qualified fallback
     → verified result → ChatGPT → USER
```

ChatGPT may disconnect; already-authorized Missions continue under host CAE and repair budgets.

## Live monitoring

| Surface | How |
| --- | --- |
| Control Center | **Live Activity & Logs** → Now / Recent / History |
| API | `GET /api/product/live-activity`, `GET /api/product/live-events`, `GET /api/product/live-stream` (SSE), `GET /api/product/execution-sessions` |
| CLI | `airodrom logs follow [--mission <uuid>] [--once] [--json]` and interactive `/logs` |

Now shows only live execution or authorized non-terminal recovery. Obsolete blocked `needs_rework` is excluded from Now and can be presentation-archived (evidence retained). Idle Terminal/MCP client sessions are never counted as agent Runs.

Execution states: `QUEUED`, `RUNNING`, `VERIFYING`, `REPAIRING`, `BLOCKED`, `AWAITING_ACCEPTANCE`, `COMPLETED`, `FAILED`, `CANCELLED`.

A worker is shown active only when an advancing `cp_runs` row exists **and** process evidence is trustworthy (`alive` / `starting` / pre-alive `not_started`). Interrupted, `termination_unverified`, and `process_state=unknown` Runs are labeled for recovery (`run_ownership`) and never increment `active_agent_runs`. Cursor IDE saved-file observations are never Cursor Agent execution.

Continuous filesystem observation (when enabled) is limited to independently authorized active Mission or WORK-template allowlists. Sensitive paths (`.env`, keys/pem, credentials/secrets trees), idle projects, host roots, symlink escapes (including in-repo directory symlink parents), and Mission-null global observations outside that allowlist are refused. Writer attribution binds to the exact canonical workspace, allowlisted path, and Mission/Run — same basenames in different workspaces never cross-attribute. Control Center labels unverified/unknown Run ownership for review instead of showing only “No active Run”.

## AUTO worker selection

Reuses `src/model-worker-router.js` and Mission agent selection. AUTO admits only currently qualified and authorized WORK workers. Default preference is local OpenCode/Qwen when suitable. Explicit user preferences are preserved. Privacy, disclosure, cost, sandbox, and credential boundaries fail closed. Cursor Agent remains unqualified until live qualification evidence is recorded.

## Standing development authorization

Owner-registered **WORK templates** (`src/work-templates.js`) remain the standing, scope-limited authorization for trusted local workspaces. Routine operations inside an exact approved template do not require repeated prompts. Production deploy, credential changes, security-policy changes, destructive ops, disclosure, scope expansion, and privileged mutations stay outside standing consent.

## Continuous repair

Reuse Mission V2 / CAE repair: structured failure → classifier → authorized bounded corrective Mission (`repair_of`) → tests → independent verification → retry or stop on budget / unsupported capability / owner gate. Idempotent dispatch identities and crash recovery are host-owned; this V1 only surfaces repair budget and recovery phase in Live Activity.

Repair-budget projection walks the full `repair_of` lineage (ancestors and descendants) via `mission-evidence.lineageFor` and takes the strictest of contract / Goal Plan / approval ceilings. When no ceiling is available it reports `unavailable` rather than an undercount.

## Scope isolation

This surface does **not** change Trusted Autonomy defaults, standing public-research origins, automatic Acceptance, bridge-invocation recovery, or Mission-web navigation. Those remain on preserve branches (`preserve/pr109-full-stack`, `preserve/trusted-autonomy-public-research`, `preserve/bridge-invocation-and-web-stack`) for separate review. Quarantined live Runs are never cleared by this projection.

## Cleanup

`POST /api/product/archive-obsolete-rework-preview` and `archive-obsolete-rework` (confirmed) presentation-archive obsolete `needs_rework` Missions that pass existing archive eligibility. Never archives uncertain active execution as completed.

## Validation notes

Fixture suites prove projection, Now filtering, admission honesty, and CLI wiring. Live monitoring against a real agent Run requires an installed service with an advancing Run; do not infer live qualification from fixtures alone. Disposable OpenCode demos require an active owner WORK template.
