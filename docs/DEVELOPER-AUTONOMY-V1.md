# Developer Autonomy V1

Standing, revocable owner enrollment for **exact named repositories**. After enrollment, routine local development Missions proceed with short-lived grants, automatic isolated workspaces, independent verification, and optional draft-PR preparation — without renewing a WORK template for every task.

## What it authorizes

Inside an active policy:

- Repository reads/writes within exact per-Mission file ceilings
- Isolated feature-branch / disposable worktree preparation
- Local tests, lint/typecheck/build when those workflows are enrolled
- Bounded automatic repair within the standing repair budget
- Draft PR metadata preparation (never merge)

Default worker: **local OpenCode / Qwen**. External workers only when independently qualified and explicitly listed.

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

Prepares a disposable worktree if needed, issues a short-lived grant, and returns Mission ceilings. Grants are validated again at every dispatch. Expired or revoked policies fail closed.

## Workspace lifecycle

- Clean enrolled checkout → linked worktree on a task branch
- Dirty or unique operator work → new disposable worktree from HEAD; source dirt untouched
- Cleanup only when disposable, task-owned, clean, and with no unique commits; otherwise HOLD

Mission history and evidence remain in the control plane.

## Validation

```bash
node scripts/run.cjs --test tests/developer-autonomy-v1.test.js
```

See ADR [0053](adr/0053-developer-autonomy.md) and Issue #111.
