# ADR 0053 — Developer Autonomy V1

Status: Proposed.

## Context

Issue #111 asks for routine software-development work end to end without recurring per-task WORK-template enrollment or manual disposable Git workspace management. Existing WORK templates (immutable, ≤1440 minutes), Zero Setup, Mission Approvals, Development Sessions, Autonomous Supervisor V1, and the model/worker router already provide scoped authority, verification, and Live Activity. They do not provide standing per-repository autonomy with automatic isolated workspaces.

## Decision

Add a host-owned Developer Autonomy module (`src/developer-autonomy.js`) that:

1. Records durable, revocable, owner-enrolled standing policies bound to exact repository identity (root + device/inode), named workflows, budgets, workers, and expiry.
2. Issues short-lived, sealed Mission grants within an active policy (exact files, verification, repair budget, TTL) validated before dispatch, application and Acceptance. Bind one initial Mission and its corrective lineage; intersect repair allowance with current policy revocation and expiry.
3. Prepares task-owned disposable local Git clones when the enrolled checkout is dirty or disposable work is requested, without modifying unique operator changes.
4. Prefers local OpenCode/Qwen; external workers only when independently qualified and explicitly listed on the policy.
5. Prepares draft-PR metadata only; never auto-merges or deploys.
6. Cleans only proven task-owned disposable workspaces with no uncommitted or unique commit content; otherwise HOLD. Cleanup also requires unchanged canonical directory identities, settled Mission lineage, independently verified termination and no active or uncertain writer/dispatch/lease. Preserve ignored content.
7. Surfaces standing status through Autonomous Supervisor / Live Activity and Control Center.

WORK templates remain immutable and mutually exclusive with Developer Autonomy grants on the same Mission. Creating or expanding standing scope still requires authenticated local operator consent. Protected merges, production deploy, credentials, security-policy changes, destructive operations, out-of-repo access, external paid disclosure, and privileged infrastructure remain separately gated.

## Consequences

- Routine “Fix this” work inside an enrolled repository no longer requires renewing an expired WORK template per task.
- Dirty and uniquely modified operator work is preserved; disposable local clones are preferred.
- Fixtures never imply live OpenCode qualification. Live acceptance requires an independently authorized disposable Mission.
- Revert by removing the module, API routes, Control Center panel, retention rows, and this ADR; existing WORK-template and Mission paths remain intact.

## Hardening and compatibility

Enrollment pins the trusted verifier baseline as well as task definitions. Grant task selection is limited to enrolled verification labels. Legacy policy/workspace records without these safety fields fail closed and require fresh owner enrollment/preparation; no legacy scope is silently expanded. Authenticated owner work intake uses standing consent, while MCP intake remains a proposal. Zero repair budgets are supported. Repeated authorization requests reuse one workspace/grant; terminal grants are consumed only after execution is quiescent. Disk usage is bounded at host allocation, dispatch, output application and Acceptance checkpoints, not by an OS quota. All acceptance claims in this PR remain synthetic until separately qualified on an authorized runtime.

Every Developer Autonomy Mission carries the existing canonical Mission contract and proportional security verification. The host derives its deny-by-default permissions and budget from the sealed grant; callers cannot substitute a broader contract. Corrective Missions inherit the same contract fingerprint and original grant expiry. The current sealed standing grant is the approval authority, so repair admission delegates to that grant only for this mechanism; ordinary contract Missions still require their existing approval. Repair ceilings cannot exceed the canonical contract maximum (five). Cleanup holds tracked files hidden by Git index flags and retains unique reflog history.
