# ADR 0053 — Developer Autonomy V1

Status: Proposed.

## Context

Issue #111 asks for routine software-development work end to end without recurring per-task WORK-template enrollment or manual disposable Git workspace management. Existing WORK templates (immutable, ≤1440 minutes), Zero Setup, Mission Approvals, Development Sessions, Autonomous Supervisor V1, and the model/worker router already provide scoped authority, verification, and Live Activity. They do not provide standing per-repository autonomy with automatic isolated workspaces.

## Decision

Add a host-owned Developer Autonomy module (`src/developer-autonomy.js`) that:

1. Records durable, revocable, owner-enrolled standing policies bound to exact repository identity (root + device/inode), named workflows, budgets, workers, and expiry.
2. Issues short-lived, sealed Mission grants within an active policy (exact files, verification, repair budget, TTL) validated before each dispatch.
3. Prepares task-owned disposable Git worktrees when the enrolled checkout is dirty or disposable work is requested, without modifying unique operator changes.
4. Prefers local OpenCode/Qwen; external workers only when independently qualified and explicitly listed on the policy.
5. Prepares draft-PR metadata only; never auto-merges or deploys.
6. Cleans only proven task-owned disposable workspaces with no uncommitted or unique commit content; otherwise HOLD.
7. Surfaces standing status through Autonomous Supervisor / Live Activity and Control Center.

WORK templates remain immutable and mutually exclusive with Developer Autonomy grants on the same Mission. Creating or expanding standing scope still requires authenticated local operator consent. Protected merges, production deploy, credentials, security-policy changes, destructive operations, out-of-repo access, external paid disclosure, and privileged infrastructure remain separately gated.

## Consequences

- Routine “Fix this” work inside an enrolled repository no longer requires renewing an expired WORK template per task.
- Dirty and uniquely modified operator work is preserved; disposable worktrees are preferred.
- Fixtures never imply live OpenCode qualification. Live acceptance requires an independently authorized disposable Mission.
- Revert by removing the module, API routes, Control Center panel, retention rows, and this ADR; existing WORK-template and Mission paths remain intact.
