# Global Autopilot V1

Owner-controlled mode for routine autonomous work across registered projects
and connected integrations. Defaults **OFF**.

Autopilot changes how routine work is **admitted and prepared**. It does not
add another control plane, scheduler, or cognitive coordinator. Architecture
remains:

`USER → ChatGPT → AIRODROM → OPENCODE → CURSOR/CLAUDE/CODEX → OPENCODE → AIRODROM → ChatGPT → USER`

## Commands

Terminal (shell):

- `airodrom autopilot on`
- `airodrom autopilot off`
- `airodrom autopilot status`
- `airodrom autopilot stop`

Interactive conversation:

- `/autopilot on|off|status|stop`

Control Center: **Autopilot** view and **Automation & Permissions** switch.

## Behavior

| Mode | Behavior |
|------|----------|
| OFF | Existing governed behavior (WORK templates, optional Developer Autonomy enrollment). |
| ON | Authenticated owner delegation; zero-setup ensures `autopilot:*` DA policies for resolved repos; Missions may carry `envelope.autopilot`. |
| STOP | Immediate disable + cancel Autopilot Missions + revoke `autopilot:*` policies. |

Only the authenticated local owner can enable Autopilot. Model, browser, email,
MCP, and repository text cannot.

## Verified Arecibo default (this host)

| Field | Value |
|-------|-------|
| Project | Arecibo Core (`02054eab-4648-4db4-9fa0-aaa3239544db`) |
| Default repository label | `arecibo-core-autopilot-main` |
| Git remote | `github.com:arecibo-inc/arecibo-core` |
| Approved branch | `main` |
| Persistence | `cp_project_defaults` in durable `~/.airodrom` data (survives managed install upgrades) |
| Standing Autopilot policy | `autopilot-02054eab4648-*` (opencode + cursor workers, cognitive v3, ~30-day expiry) |

Four cleaned non-Git DA leftover directories may remain listed on the project;
live-Git filtering ignores them. Separate project **Arecibo product research**
points at a different checkout and is not the Autopilot default.

## Project default repositories

When a project has more than one enrolled path (for example cleaned disposable
DA leftovers still listed beside a primary clone), set one authoritative default:

```http
GET  /api/assistant/project-defaults
POST /api/assistant/project-defaults/set
POST /api/assistant/project-defaults/clear
```

`set` requires authenticated local operator, `confirmed: true`, an active
project id, and a repository that is already enrolled and a live Git root.
Defaults persist in `cp_project_defaults` across service restarts and managed
upgrades (data lives under the durable `~/.airodrom` data directory, not the
install tree). Clear with the matching `clear` endpoint.

### Selection precedence

1. Exact authorized repository path supplied by the caller.
2. Exact unique enrolled workspace label that matches a live enrollment.
3. Owner-configured project default repository (when still live).
4. One unambiguous live authorized repository for the project (non-disposable preferred).
5. Otherwise fail closed with `ENROLLED_REPOSITORY_AMBIGUOUS` (or
   `ENROLLED_WORKSPACE_REQUIRED` when no live Git root remains).

Cleaned non-Git leftover directories are ignored. Historical enrollments are
not deleted solely because a default exists.

### Verification without inventing tasks

Autopilot standing policy prefers `.vscode/tasks.json` process tasks
(`diff-check` plus at least one test). When that file is absent, Autopilot
reuses verification labels from an **already-active** Work template for the
exact workspace. It never invents unverified commands. Missing both still
fails closed.

## Supported natural-language shapes (with Autopilot ON + default set)

- `Continue developing Arecibo in Cursor.`
- `Start the Arecibo release-readiness audit in Cursor. Do not deploy production.`

These resolve the configured default repository, ensure a standing Autopilot DA
policy, prefer OpenCode planning, and route to a qualified specialist when
authorized. Paid Cursor execution still requires an existing owner-signed spend
grant; production deploy, Plaid LIVE, IAM/DNS, and credential changes remain
separately gated.

## Security

- Fail closed on OFF/STOP.
- No credential values in Autopilot activity.
- External provider auth and account permissions remain in force.
- Untrusted content is never treated as new owner authorization.
- Repository authorization, spend ceilings, host verification, and STOP stay active.

## Troubleshooting

| Symptom | Likely cause | Recovery |
|---------|--------------|----------|
| `ENROLLED_REPOSITORY_AMBIGUOUS` | Multiple live repos, no default | Set project default; or name exact path/label |
| Autopilot clarify about verification | No tasks.json and no active Work template | Register tasks or activate a Work template |
| Disposable worktree without `node_modules` | Source deps use an external store (pnpm/yarn links outside the repo) | Expected skip; install deps inside the disposable clone when verification needs them |
| `cognitive_ambiguous_worker` with OpenCode + Cursor | Planner phrases (“to plan” / “for planning”) were treated as a second specialist; ChatGPT prose used “to plan” while host tests used “for planning” | Shared `resolveWorkerRoles` strips both forms; genuine dual *execution* specialists still fail closed |
| `opencode_sensitive_context` on ordinary audits | Setup README mentioning `.env` was forwarded as planner input | Autopilot discovery and planning filter those files; real secrets remain denied |
| Disk budget exhausted with idle ready / settled clones | Pre-V2 charged unbound ready clones and retained evidence toward disposable disk | Idle ready without a grant and settled evidence do not charge disk; worktree *slot* limits still count unbound ready; prepare reclaims only clean idle ready trees; untracked leftovers and active/uncertain work still charge; new enrollments default to 4096 MB |
| `Worktree budget exhausted` after unique HOLD cleanup | Idle grantless HOLD evidence still charged concurrent `max_worktrees` | Concurrent slots count ready/invalid and unsettled bound/held only; idle unique HOLD evidence stays on disk without filling the ceiling ([Developer Autonomy V1](DEVELOPER-AUTONOMY-V1.md)) |
| `BLOCKED_SPEND_AUTHORIZATION` | Cursor spend not in standing grant | Owner-signed spend grant; Autopilot does not invent spend. Host-origin Arecibo acceptance `a48dabaf-d71a-407c-bcc9-4963825ee06f` (install `23ead46`) and ChatGPT-MCP acceptance `ad4e7ebb-4407-43d0-8842-b9a126ab74b7` (install `5938d4f`) reached WAIT here after OpenCode planning assigned Cursor — not a routing/repo/disk/worker-role false positive |
| `cognitive_list_invalid` on ordinary audits | OpenCode returned empty/oversized/wrapped task lists | Host coerces into the sealed assignment ceiling; authority fields still fail closed |
| Wrong project | Token shared across projects | Prefer unique project name or set default project id via defaults |

See [ADR 0054](adr/0054-global-autopilot.md) and [Developer Autonomy V1](DEVELOPER-AUTONOMY-V1.md).
