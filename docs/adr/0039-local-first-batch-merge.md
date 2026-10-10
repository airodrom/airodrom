# ADR 0039: Local-first Development Sessions and daily batch merge

- Status: Proposed
- Date: 2026-10-09
- Owner: Operator request
- Review: Pending
- Affected contracts: Control Center, Control Server, GitHub Actions candidate workflow, Memory retention
- Related: [CI branch protection](../CI-BRANCH-PROTECTION.md)

## Context

Per-Mission push/PR/CI spend and merge overhead dominate development time. Operator needs continuous local AI work with one controlled integration checkpoint.

## Decision

Add host-owned `DevelopmentSession` with fail-closed auto-push/merge/CI flags, configurable merge window, durable evidence that rejects worker-completion substitution, Control Center view, and workflow triggers limited to `main` integration plus dispatch. Coding Missions may bind `development_session_id` at create; dispatch re-validates worktree binding. Operator **Prepare Daily Integration** summarizes readiness without push, merge or hosted CI dispatch.

## Alternatives

Keep push-on-every-branch CI — rejected for cost. Auto-merge at window close — rejected; authorization required.

## Authority

Sessions cannot grant Mission authority, Acceptance, credentials, or production deploy. Merge remains operator-authorized.

## Validation

`tests/development-session-v1.test.js`. Distinguish fixture evidence from hosted CI.

## Rollback

Revert branch; tables inert when unused. Restore prior workflow `on:` if needed.
