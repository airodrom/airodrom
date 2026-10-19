# Developer Autonomy V1

Standing, revocable owner enrollment for **exact named repositories**. After enrollment, routine local development Missions proceed with short-lived grants, automatic isolated workspaces, independent verification, and optional draft-PR preparation — without renewing a WORK template for every task.

## What it authorizes

Inside an active policy:

- Repository reads/writes within exact per-Mission file ceilings
- Isolated feature-branch / disposable local clone preparation
- Local tests, lint/typecheck/build when those workflows are enrolled
- Bounded automatic repair within the standing repair budget (zero to five)
- Draft PR metadata preparation (never merge)

Execution uses **local OpenCode / Qwen**. Listing an independently qualified external worker does not grant disclosure or paid usage; V1 local grants do not authorize external execution.

## What it never authorizes

Protected branch merges, production deployment, credentials/secrets, security-policy changes, destructive operations, access outside registered repositories, external AI disclosure or paid usage, and privileged infrastructure changes. Those remain separately gated.

## Owner enrollment (once per repository)

Control Center → **Developer Autonomy**, or:

```http
POST /api/assistant/developer-autonomy/enroll
```

Requires authenticated local operator, `confirmed: true`, exact repository root, project/goal binding, named workflows, default verification tasks, budgets, and duration (1–90 days).

Revoke immediately with `POST /api/assistant/developer-autonomy/revoke`.

## Routine authorization

```http
POST /api/assistant/developer-autonomy/authorize
```

Always prepares a separate local clone from committed HEAD, issues a short-lived grant, and returns Mission ceilings. Authenticated Terminal/Control Center work requests use an existing enrollment automatically when exact files are identifiable. Ambiguous file scope needs clarification. MCP requests remain proposals until local owner approval. Neither path creates or broadens enrollment.

Grants bind one initial Mission and its bounded corrective lineage. Repairs retain the original grant, expiry, revocation and remaining repair allowance; zero repairs is supported. Grant capacity is released after terminal, independently quiescent execution. A `needs_rework` or `blocked` Mission whose grant cannot authorize another repair (no repair workflow, or repair budget exhausted) is terminal for that reservation and does not hold the concurrent Mission slot. The concurrent `max_worktrees` budget counts ready, invalid, and unsettled bound/held clones. Settled, idle clones may remain on disk as evidence and do not occupy that concurrent budget. Owner cleanup still requires explicit confirmation and continues to HOLD clones with unique or uncommitted content. Repeated request ids reuse the prepared workspace and grant. Enrolled verifier inputs remain immutable through creation, dispatch, application and Acceptance.

## Workspace lifecycle

- Clean enrolled checkout → self-contained local clone on a task branch
- Dirty or unique operator work → new disposable local clone from HEAD; source dirt untouched
- Pin canonical container/workspace directory identities; reject symlinks and replacement directories
- Cleanup requires settled Mission lineage, verified run termination, no active/uncertain dispatches or leases, and no dirty, ignored or unique committed content; otherwise HOLD
- Revoked or expired unused grants do not prevent cleanup of a proven clean, idle clone
- Disk limits are checked before cloning, grant/dispatch/Acceptance boundaries, and before applying worker output. The bound includes retained clones and ignored files. This is a host admission/application bound, not an operating-system filesystem quota; external filesystem growth is detected at the next boundary.

Mission history and evidence remain in the control plane.

## Validation

```bash
node scripts/run.cjs --test tests/developer-autonomy-v1.test.js
```

See ADR [0053](adr/0053-developer-autonomy.md) and Issue #111.
