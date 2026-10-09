# ADR 0037 — Cursor IDE task bridge vs Agent execution

- Status: Proposed
- Date: 2026-10-09
- Owner: Control-plane maintainers
- Review: Pending
- Affected contracts and components: `cursor_run_task` / IDE task capabilities, Capability Host agent status, Control Center worker projection
- Related decisions: ADR 0005 (OpenCode execution boundary), ADR 0009 (product observability)

## Context and problem

Operators need a bounded way to run registered `.vscode/tasks.json` process tasks from Mission workspaces (including disposable WORK checkouts). Separately, Cursor Agent ACP execution remains unqualified (`cursor_tool_and_credential_isolation_unqualified`). Collapsing IDE task success into “Cursor Ready” would misrepresent Agent qualification.

## Decision

1. `cursor_run_task` (and VS Code equivalents) remain a **classified IDE process/shell task runner**: approved repository or Mission workspace, readable tasks file, allowlisted argv, no shell operators. This is not Cursor Agent execution.
2. Cursor **Agent** status stays fail-closed: `unavailable` / `unqualified` with categorical reasons (`cursor_execution_unqualified`, auth/quota classes). IDE task completion never marks Agent Ready.
3. OpenCode remains the supported Mission coding worker. Full ACP Agent qualification is out of scope for this decision.

## Alternatives considered

- Treat registered VS Code tasks as Agent proof — rejected; tasks cannot launch a qualified Agent coding session.
- Unrestricted shell task execution — rejected; violates command classification.
- Ship ACP Agent dispatch in the same change — deferred until credential isolation qualification exists.

## Authority, privacy and ownership

IDE tasks still require Capability Broker scopes (`repo` / `developer_environment`), classification, and Mission workspace binding. No Mission ceiling, Acceptance, or Settlement authority changes. Secrets and process arguments remain redacted in observations.

## Compatibility and migration

Additive status fields (`agent_execution`, `agent_availability`, `last_ide_task`) and clearer task-plan errors. Existing deny semantics for destructive/non-allowlisted commands are preserved. No durable schema migration. Live Cursor Agent qualification remains a separate activation.

## Consequences

Control Center can show last IDE-task dispatch honestly while Agent stays unqualified. Operators keep OpenCode as the Mission coding path. Follow-up: ACP Agent qualification when isolation evidence exists.

## Validation and evidence

Focused fixture tests: missing/unreadable/mismatched tasks.json errors; safe dispatch; destructive deny; agent status never Ready from IDE task success. Live Agent qualification is not inferred from fixture passes.

## Rollback

Revert IDE task error/workspace and status projection changes. No irreversible durable state.

## Decision outcome

Proposed pending maintainer review with the Cursor execution bridge + risk Acceptance V1 PR.
