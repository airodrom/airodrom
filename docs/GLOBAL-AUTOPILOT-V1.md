# Global Autopilot V1

Owner-controlled mode for routine autonomous work across registered projects
and connected integrations. Defaults **OFF**.

Autopilot changes how routine work is **admitted and prepared**. It does not
add another control plane, scheduler, or cognitive coordinator. Architecture
remains:

    `USER → ChatGPT → AIRODROM → OPENCODE → (specialist when authorized) → OPENCODE → AIRODROM → ChatGPT → USER`

## Local-First Autopilot V3 (current operating mode)

Paid **Cursor execution through Airodrom is disabled by default** via durable
host preference `cp_host_execution_policy` (`CURSOR_EXECUTION_DISABLED`).

| Rule | Behavior |
|------|----------|
| Default worker | Local OpenCode (installed runtime + Ollama/Qwen) for plan, local code when suitable, and evaluate |
| Cursor selection | Excluded from automatic Autopilot enrollment and worker lists |
| Explicit “in Cursor” | Fails closed with durable `CURSOR_EXECUTION_DISABLED` |
| Stale spend grants | Cannot dispatch Cursor while disabled |
| Adapter / Milestone B | Preserved; historical Missions remain readable |
| External Cursor billing | **Unaffected** — this is an Airodrom policy, not a subscription cancellation |
| Reactivation | Authenticated operator only: `POST /api/assistant/host-execution-policy/enable-cursor` with `confirmed: true` (or matching disable endpoint). Model/MCP/browser text cannot flip it |

Local-only Arecibo work does **not** require Cursor spend, disclosure grants, or
Cursor availability. OpenCode planning uses compact schema-first proposals with
a separate planning stream budget and one bounded overflow recovery; host
verification remains authoritative. See [ADR 0060](adr/0060-host-execution-policy.md).

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
| Standing Autopilot policy | `autopilot-02054eab4648-*` (OpenCode worker while Cursor host-disabled; cognitive v3) |

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

Local-first (no Cursor spend):

- `Start the Arecibo release-readiness audit using local OpenCode only. Do not deploy production, call Cursor, enable Plaid LIVE, or use external AI providers.`
- `Continue developing Arecibo with local OpenCode.`

These resolve the configured default repository, ensure a standing Autopilot DA
policy, use OpenCode for planning/local coding/evaluation, and keep Airodrom
host verification authoritative. Production deploy, Plaid LIVE, IAM/DNS, and
credential changes remain separately gated.

Historical Cursor shapes (`… in Cursor`) remain parseable but settle as
`CURSOR_EXECUTION_DISABLED` until an authenticated operator re-enables Cursor
execution. After reactivation, paid Cursor still requires qualification plus an
owner-signed spend/disclosure grant.

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
| `CURSOR_EXECUTION_DISABLED` | Host Local-First policy | Use local OpenCode wording; or authenticated operator enable-cursor if paid Cursor is intentionally restored |
| `EVALUATION_UNAVAILABLE: opencode_unavailable_or_unsupported` after local OpenCode implementation | Evaluator retry assumed a completed **Cursor** run, or treated OpenCode implementation + failed evaluator as non-retryable; DA/Autopilot Missions without `approval_id` were rejected by Cursor-only evaluation continuation | Local-First recovery: one never-started OpenCode evaluator may retry after host verification passed for either Cursor or OpenCode specialists; readiness uses a fresh probe; continuation uses `assertAuthority` when no approval exists. Historical blocked Mission stays immutable |
| `opencode_output_bound` on Autopilot audit second assignment | Enrolled discovery included oversized indexes (Arecibo `docs/README.md` ~78KB) that OpenCode re-read into a JSONL stream over `MAX_OUTPUT` (64KB) | Discovery and planner permitted_paths admit only files ≤ `MAX_DISCOVERY_FILE` (16KB) via `planningContextAdmissible`; report/audit read-only plans coerce to one enrolled edit when edit is authorized. Historical Mission `cbc4e596-…` stays immutable |
| `BLOCKED_SPEND_AUTHORIZATION` | Cursor spend not in standing grant (only after Cursor re-enabled) | Owner-signed spend grant; Autopilot does not invent spend. Historical: host `a48dabaf-…` / ChatGPT-MCP `ad4e7ebb-…` reached WAIT on spend after Cursor assignment — superseded as the default path by Local-First V3 |
| `cognitive_list_invalid` on ordinary audits | OpenCode returned empty/oversized/wrapped task lists | Host coerces into the sealed assignment ceiling; authority fields still fail closed |
| Wrong project | Token shared across projects | Prefer unique project name or set default project id via defaults |

See [ADR 0054](adr/0054-global-autopilot.md) and [Developer Autonomy V1](DEVELOPER-AUTONOMY-V1.md).
