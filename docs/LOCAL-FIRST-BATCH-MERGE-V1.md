# Local-First Development & Daily Batch Merge V1

Host-owned Development Sessions group related Missions on one branch/worktree. Default: local implement → focused tests → local commit → next Mission. No per-Mission push, PR, merge, or hosted CI dispatch.

**Status (2026-10-09):** source on `feat/local-first-batch-merge-v1`; feature impl `7c2217e127140e3d25fd3511e59cc4bab4e978c7` (later docs-sync commits may tip the branch); focused tests 9/9; **not pushed/merged**; not SHIPPED on main; standing merge grant INACTIVE.

## Cost controls

Config `config/development-session-v1.json` (defaults false):

- `hosted_ci_auto_dispatch`
- `heavy_ci_auto_dispatch`
- `auto_push_per_mission`
- `auto_merge_per_mission`

GitHub workflow `.github/workflows/candidate.yml` runs on `push`/`pull_request` to `main` and `workflow_dispatch` only—not on every feature-branch push. `secret-history` and `dependency-license` remain on those checkpoints.

## Batch merge window

Default America/Vancouver 17:00–22:00. Window openness is informational. Checkpoint evaluation never merges; operator authorization is required.

## Mission lifecycle

Operator coding Missions may set `development_session_id` at create. The Mission workspace must equal the session worktree; the envelope records the session identity; attach is durable. Dispatch re-checks the binding. Missions cannot change repository, worktree or execution permissions through the session.

Default path: Mission → Development Session → OpenCode/Qwen → focused local verification → local commit → next Mission. No per-Mission push, PR, merge or hosted CI.

## Prepare Daily Integration

Operator action (`prepareDailyIntegration` / Control Center **Prepare Daily Integration**) summarizes completed session work, changed files, commits, branch freshness, focused-test evidence, mandatory CI requirements and eligible PRs. It never pushes, merges or dispatches hosted CI.

## Control Center

**Development Sessions** shows active sessions, related Missions, assigned worker, branch/worktree, local changes, test evidence, local vs published status, integration readiness, pending approvals and the daily integration checkpoint. Status values are host-observed.
