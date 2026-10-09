# Local-First Development & Daily Batch Merge V1

Host-owned Development Sessions group related Missions on one branch/worktree. Default: local implement → focused tests → local commit → next Mission. No per-Mission push, PR, merge, or hosted CI dispatch.

## Cost controls

Config `config/development-session-v1.json` (defaults false):

- `hosted_ci_auto_dispatch`
- `heavy_ci_auto_dispatch`
- `auto_push_per_mission`
- `auto_merge_per_mission`

GitHub workflow `.github/workflows/candidate.yml` runs on `push`/`pull_request` to `main` and `workflow_dispatch` only—not on every feature-branch push. `secret-history` and `dependency-license` remain on those checkpoints.

## Batch merge window

Default America/Vancouver 17:00–22:00. Window openness is informational. Checkpoint evaluation never merges; operator authorization is required.

## Control Center

**Development Sessions** shows goal, branch/worktree, Missions, evidence counts, local vs published, CI status, merge window, and that CI cost estimates are Unavailable.
