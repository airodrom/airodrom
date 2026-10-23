# Multi-project development V1

## Path

```text
USER → ChatGPT → AIRODROM → OPENCODE (planner) → CURSOR (implementation)
  → OPENCODE (evaluator) → AIRODROM (independent verifier) → ChatGPT → USER
```

## Targets

Configured in [`config/development-targets-v1.json`](../config/development-targets-v1.json):

| id | repository_id | Typical root |
|---|---|---|
| `airodrom` | `airodrom/airodrom` | `~/code/airodrom-da-main` or `~/code/airodrom` |
| `arecibo` | `arecibo-inc/arecibo-core` | `~/code/arecibo-core-autopilot-main` |

### Adding a third repository

1. Append a target object to the catalog (path suffixes, remote patterns, instruction patterns, fail-closed codes).
2. Register a Control Center project + goal with the exact repository root.
3. Enroll Developer Autonomy with Cursor + cognitive discovery (owner `confirmed:true`).
4. No architecture change is required.

## Routing precedence

1. Explicit repository id / remote.
2. Explicit product or project name.
3. Catalog instruction patterns.
4. Fail closed (`DEVELOPMENT_TARGET_AMBIGUOUS` or `*_NOT_ENROLLED`).

Negation (`not Arecibo`, `not chatgpt-handoff`) never selects the negated product. Standing grants never transfer across projects.

## Operator startup

1. Protect dirty operator checkouts; use clean isolated worktrees for DA roots.
2. Run `node --experimental-sqlite scripts/prepare-development-target-enrollment.cjs`.
3. Confirm each proposal in Control Center → Developer Autonomy (Cursor + cognitive).
4. Enroll one standing Cursor development grant per repository via
   `POST /api/assistant/host-execution-policy/enroll-standing-cursor-development`
   (bind `policy_id`, cognitive path allowlist, `acknowledge_unknown_cost`). See
   [STANDING-CURSOR-DEVELOPMENT-V1.md](STANDING-CURSOR-DEVELOPMENT-V1.md).
5. Verify with MCP `list_development_targets` / `resolve_development_target` and
   host-execution-policy standing grant status.
6. Issue ordinary ChatGPT development asks; retrieve progress via
   `get_mission_engineering_report` and terminal notifications via
   `list_mission_notifications`.

## Isolation

Each target independently owns repository identity, workspace policy, DA enrollment,
standing Cursor grant, templates, verification, and Mission evidence. Planner paths
outside the sealed binding are rejected before Cursor dispatch. Airodrom grants never
authorize Arecibo work and vice versa.
