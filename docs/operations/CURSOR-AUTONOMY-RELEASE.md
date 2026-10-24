# Cursor autonomy integration and qualification

This procedure integrates ADRs [0064](../adr/0064-preventive-policy-diagnostics.md) and [0065](../adr/0065-cursor-only-routine-autonomy.md). It is a release contract, not a record of installation or owner authorization.

The frozen route is USER → ChatGPT → Airodrom → OpenCode → Airodrom → ChatGPT → USER. Within Airodrom, OpenCode plans and evaluates; Cursor implements and corrects. Airodrom remains the sole authority for admission, exact repository/file binding, dispatch, leases, verification, Acceptance and Settlement. There is no automatic implementation fallback or second controller. Routine work reuses existing finite standing authorization without subscription/account inspection or repeated approval. Missing or expired authority stays blocked.

## Dependency and runtime security

The npm peer dependency of `@slack/socket-mode@3.1.0` resolves to `undici@7.30.1` through its existing `^7.0.0 || ^8.0.0` range. A normal `npm update undici --package-lock-only --ignore-scripts` changes only that package resolution. No override or direct dependency is needed. Slack imports Undici WebSocket/Agent and can use its fetch implementation; `@slack/web-api` also uses fetch.

Node's global fetch is a separate copy. Node 22.23.3 embeds Undici 6.28.1; updating npm dependencies does not patch it. The supported minimum and CI pin are now Node 22.23.4, which embeds 6.29.1. Existing executable pins cannot be silently repointed. A managed runtime change requires qualification and applicable cutover authorization.

The upstream [Undici 7.30.1 release](https://github.com/nodejs/undici/releases/tag/v7.30.1) fixes the excessive-content-encoding process crash ([CVE-2026-109869](https://github.com/nodejs/undici/security/advisories/GHSA-xjj6-f33q-929c)), three other high-severity issues involving TLS renegotiation, custom TLS verification and redirect/cache origin binding, and medium-severity decompression, SRI, EventSource and WebSocket buffering defects. [Node 22.23.4](https://nodejs.org/en/blog/release/v22.23.4) includes the corresponding bundled-library update. Reachability varies; an unused interceptor is not a reason to retain a vulnerable package.

`tests/undici-security.test.js` exercises both bundled and npm fetch against a local malicious-response fixture in child processes. A caught fetch rejection must not be followed by an uncaught orphaned-stream error. It also rejects a mismatched integrity digest with an uppercase algorithm token. Run Slack integration regressions and locked installation/audit/license checks as well. Do not use a green npm audit result as proof about Node's built-in libraries.

## Stable source qualification

Authority qualification compares the bridge's captured fingerprint with current source and package manifests. Source edits or a lockfile update during a running suite correctly trigger `Source/live fingerprint mismatch`. A later successful rerun alone does not establish stability or identify the edited file.

Finish source/dependency edits before starting qualification. Record the exact commit, a clean status, runtime version and source fingerprint. Run lifecycle fixtures from that fixed candidate; do not edit `src`, `package.json` or `package-lock.json` while they run. Record the fingerprint again afterward and invalidate the run if it differs. Repeat a previously unstable case against the same bytes. `tests/qualification-source-stability.test.js` preserves the drift denial and demonstrates which inputs change the fingerprint; it does not weaken qualification or patch a global cache.

## Canonical lifecycle and correction evidence

Intake uses `planning`; Mission progression uses `ready → dispatching → running → verifying → awaiting_acceptance → completed`. A repairable result follows `verifying → needs_rework → ready` with a new specialist attempt. An evaluator failure can use `blocked`, then return to `ready` only under the existing recovery checks. Automatic Acceptance is an accepted record, and Settlement is a separate settled execution/program record. `CORRECTING` and `AUTOMATICALLY_ACCEPTED` are descriptions, not new persisted Mission states.

In isolated qualification, reuse the existing controlled Cursor fixture: initial `alpha` plus LF, first result `gamma` plus LF, separate corrective Cursor run yielding `beta` plus LF. Retain the initial failed host checks, distinct Cursor IDs, planner/evaluator IDs, current verification, Acceptance, settlement, verified termination, and zero held/quarantined leases. An evaluator retry reuses a completed Cursor result and must never be reported as implementation correction. Duplicate requests and interruption/reopen must preserve identity and avoid duplicate workers. Invalid scope, verifier tampering, revoked authority, unknown failures and unverified termination remain denials.

## Staging, cutover and rollback

1. Reconcile current remote main, reviewed candidate and installed source SHA. Preserve dirty, unique, active, unmerged and rollback worktrees. Source, isolated proof, PR readiness, merge, installation and live canary are separate claims.
2. Validate a checksum-bound source archive with a fresh locked install, patched Node, declared checks, secret scan, package allowlist and reproducible archives. Prepare native artifacts against private staging directories only; do not register login items or start a second production controller.
3. Check repository-required CI, exact revision, conflicts, independent review and owner release authorization. A stale historical cutover request is not current authorization. A blocked required check keeps the PR in Draft.
4. Before an authorized managed cutover, recheck admission, active/uncertain Missions, writer ownership and leases. Create the standard private online SQLite recovery checkpoint and integrity/restore check, preserve the current installation and service configuration, and record the rollback SHA. Do not print discovery documents or credentials.
5. Drain and change only the managed service after its release gate is satisfied. Preserve identity, credentials, scopes and standing permissions. Qualify the patched Node/OpenCode executable pins and startup compatibility, then verify the service, MCP and installed source fingerprint.
6. Run a fresh canary from the actual ChatGPT connector only after installation is verified and an existing grant covers the disposable repository, exact file, controlled wrong-result capability and correction budget. Do not transfer a handoff grant to Self-Repair Acceptance or substitute an unrelated repository. If no eligible authorization exists, report live qualification as unproven.
7. Roll back by draining/stopping the candidate and restoring the preceding reviewed service configuration and installation. Keep SQLite history, reservations, grants, receipts and uncertain leases intact; never replay completed work. The preceding runtime may still have the security advisory, so rollback is recovery, not security clearance.

For the live canary, report exact Mission, initial/corrective Cursor and OpenCode run IDs; compare bytes and current host checks; verify automatic Acceptance and Settlement plus termination of every worker and release of every lease. A clean first attempt, an isolated fixture or an old installed SHA cannot satisfy this gate.
