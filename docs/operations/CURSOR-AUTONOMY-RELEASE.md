# Cursor autonomy integration and qualification

This procedure integrates ADRs [0064](../adr/0064-preventive-policy-diagnostics.md) and [0065](../adr/0065-cursor-only-routine-autonomy.md). It is a release contract, not a record of installation or owner authorization.

## Observed release boundary (2026-10-25 closeout)

PR #227 tip is `b703c0bef831111db7d4726b5a489f337698986e` (security fail-closed
`5c05d8d` plus SBOM Undici dependency-ref hygiene). Remote main and the
installed source remain `1a3a12e`. Operator directed omission of a full
`npm test` suite on `5c05d8d`/`b703c0b`; reuse the prior complete suite on
`a16715b` (2,693 pass / 0 fail / 4 optional skips) plus targeted exact-head
suites (67 admission/boundary + 3 Undici security). Independent Security and
Bugbot reviews found no blocking findings after the sensitive-file staging
fix. Immutable stage: `~/.airodrom/activation/staged-b703c0b-no-cutover`.
Node rollback is isolated-qualified against Node 22.23.4 for install
`1a3a12e`; LaunchAgent/pins still record the missing `22.23.3_3` path and
were not mutated. Live four-stage ChatGPT canary remains blocked: Self-Repair
Acceptance lacks a matching standing Cursor grant and four-assignment ceiling.
Merge, managed cutover, grant issuance and live canary stay owner-gated.

## Observed release boundary (2026-10-25)

PR #227 remains the release vehicle; #228 is included. The earlier full suite on
`4a93202` passed 2,683 tests with six explicit skips, but final review reproduced
structured-negation, stage-order and duplicate-retarget defects. The corrective
source must have its own fixed-revision qualification; the earlier result does
not qualify those new bytes. Keep the exact revision, source fingerprint, runtime,
skip list and exit status with the PR evidence.
Review also found that requested stages could enlarge the enrolled assignment
ceiling. The correction rejects over-limit requests before workspace preparation
or planning and rejects historical envelopes above enrollment before approval or
execution. A request cannot authorize an increased budget; four original stages
require an explicit enrollment covering four, separately from repair allowance.
Regression also reproduced a conversation workspace UUID matching the payment-card
detector. Its scan-only coordinate view requires an exact canonical Mission,
durable task binding and real host-owned workspace path. It masks only the generated
UUID segment, retaining parent-path and prose scanning and original persisted bytes.
Template handoff request UUIDs use the same narrow treatment only after both
durable request records bind to the exact Mission. Principal text remains scanned;
standalone keys and mismatched bindings remain rejected, and replay identity stays exact.

Remote main and the installed source remain `1a3a12e`. Hosted candidate CI is
manually disabled and the remote branch currently requires no checks or reviews;
this configuration does not grant permission to merge or install. The running
service is healthy and idle, with released leases, but its recorded old Node
executable no longer exists on disk. Before stopping it, independently validate
the candidate runtime and an executable rollback route. Reusing the old service
configuration alone is insufficient.

The Self-Repair Acceptance policy has two assignments and one repair; no standing
Cursor grant matches it. Its historical request is awaiting authorization and has
no Mission ID. Do not transfer a handoff/source-development grant, increase policy
limits, replay that request, or claim a live correction from isolated tests. A
four-stage canary requires four original assignments plus the bounded corrective
invocation, an explicitly covered wrong-first-result task, current Cursor
qualification, and the actual ChatGPT connector as initiator.

The frozen route is USER → ChatGPT → Airodrom → OpenCode → Airodrom → ChatGPT → USER. Within Airodrom, OpenCode plans and evaluates; Cursor implements and corrects. Airodrom remains the sole authority for admission, exact repository/file binding, dispatch, leases, verification, Acceptance and Settlement. There is no automatic implementation fallback or second controller. The direct Codex handoff and legacy pending-transport boundaries enforce the same implementation policy as Mission dispatch. Historical unknown handoffs retain reconciliation and quarantined ownership; a policy change cannot authorize their replay or fallback. Routine work reuses existing finite standing authorization without subscription/account inspection or repeated approval. Missing or expired authority stays blocked.

## Dependency and runtime security

The npm peer dependency of `@slack/socket-mode@3.1.0` resolves to `undici@7.30.1` through its existing `^7.0.0 || ^8.0.0` range. A normal `npm update undici --package-lock-only --ignore-scripts` changes only that package resolution. No override or direct dependency is needed. Slack imports Undici WebSocket/Agent and can use its fetch implementation; `@slack/web-api` also uses fetch.

Node's global fetch is a separate copy. Node 22.23.3 embeds Undici 6.28.1; updating npm dependencies does not patch it. The supported minimum and CI pin are now Node 22.23.4, which embeds 6.29.1. Existing executable pins cannot be silently repointed. A managed runtime change requires qualification and applicable cutover authorization.

The upstream [Undici 7.30.1 release](https://github.com/nodejs/undici/releases/tag/v7.30.1) fixes the excessive-content-encoding process crash ([CVE-2026-109869](https://github.com/nodejs/undici/security/advisories/GHSA-xjj6-f33q-929c)), three other high-severity issues involving TLS renegotiation, custom TLS verification and redirect/cache origin binding, and medium-severity decompression, SRI, EventSource and WebSocket buffering defects. [Node 22.23.4](https://nodejs.org/en/blog/release/v22.23.4) includes the corresponding bundled-library update. Reachability varies; an unused interceptor is not a reason to retain a vulnerable package.

`tests/undici-security.test.js` exercises both bundled and npm fetch against a local malicious-response fixture in child processes. A caught fetch rejection must not be followed by an uncaught orphaned-stream error. It also rejects a mismatched integrity digest with an uppercase algorithm token. Run Slack integration regressions and locked installation/audit/license checks as well. Do not use a green npm audit result as proof about Node's built-in libraries.

## Stable source qualification

Authority qualification compares the bridge's captured fingerprint with current source and package manifests. Source edits or a lockfile update during a running suite correctly trigger `Source/live fingerprint mismatch`. A later successful rerun alone does not establish stability or identify the edited file.

Finish source/dependency edits before starting qualification. Record the exact commit, a clean status, runtime version and source fingerprint. Run lifecycle fixtures from that fixed candidate; do not edit `src`, `package.json` or `package-lock.json` while they run. Record the fingerprint again afterward and invalidate the run if it differs. Repeat a previously unstable case against the same bytes. `tests/qualification-source-stability.test.js` preserves the drift denial and demonstrates which inputs change the fingerprint; it does not weaken qualification or patch a global cache.

Literal structured phrases obey the same negation boundary as ordinary file
operations. Merge parsed stages by their source position before sealing; do not
prepend structured edits to earlier reads. An explicit `fix ... in PATH` is one
stage even when both direct parsing and refinement recognize it. Implicit
refinement may use only an unambiguous earlier exact target, never a future read.
Regression coverage must include planner rejection of unauthorized edits and
missing dependencies, as well as preservation of four distinct stage IDs.

## Legacy regression compatibility gate

Pre-ADR-0065 tests include positive OpenCode, Codex, Claude Code and native host implementation/fallback cases. The exclusive-worker guard intentionally rejects those routes, including direct handoff APIs. Current execution and correction tests use the canonical Cursor fixture. Scheduler, dependency and read-only web tests use authorized host reads. Explicit synthetic pre-upgrade completion fixtures retain downstream verification, memory, receipt, cancellation and Acceptance coverage: they assert that a current dispatch is denied, then arrange historical records without mocking the production guard. These fixtures are recovery evidence, not present-day implementation qualification. Keep the complete suite enabled and retain every failed result. Do not exempt a legacy test, disable a guard or represent a focused green run as whole-release verification. Baseline timing/termination failures must be recorded separately and investigated under controlled load.

Legacy V1 projectless work and non-cognitive template/standing intake cannot supply a sealed plan. They return `CURSOR_PLANNING_REQUIRED` before creating a Mission, consuming a grant, seeding result files or offering an ineffective approval. Reprepare under an existing enrollment covering OpenCode planning and Cursor execution; this path never creates or expands enrollment itself. Earlier checks can still report a disabled worker, absent scope or missing standing grant. Existing historical Missions and evidence remain available.

The Terminal recognizes the cognitive views `ACCEPTED`, `CANCELLED`, and final V3 `NEEDS_REWORK` as terminal. Intermediate repair transitions remain inside the controller transaction. Terminal and MCP inspection do not offer a generic confirmation when admission explicitly says it is unsupported. Queued historical continuations denied by the new worker policy are marked blocked individually so they cannot stop unrelated work in the scheduler.

Legacy corrective Mission creation preserves typed Cursor implementation/planning denials as permanent policy blockers. They must not become generic transient spawn failures that repeatedly retry a forbidden route.

An approval attempt cannot supply missing projectless file scope or verification. The host rejects it without rewriting the existing scope diagnosis or request identity. Historical ambiguous dispatch records retain their Mission identity without creating a new worker.

## Canonical lifecycle and correction evidence

Intake uses `planning`; Mission progression uses `ready → dispatching → running → verifying → awaiting_acceptance → completed`. A repairable result follows `verifying → needs_rework → ready` with a new specialist attempt. An evaluator failure can use `blocked`, then return to `ready` only under the existing recovery checks. Automatic Acceptance is an accepted record, and Settlement is a separate settled execution/program record. `CORRECTING` and `AUTOMATICALLY_ACCEPTED` are descriptions, not new persisted Mission states.

In isolated qualification, reuse the existing controlled Cursor fixture: initial `alpha` plus LF, first result `gamma` plus LF, separate corrective Cursor run yielding `beta` plus LF. Retain the initial failed host checks, distinct Cursor IDs, planner/evaluator IDs, current verification, Acceptance, settlement, verified termination, and zero held/quarantined leases. An evaluator retry reuses a completed Cursor result and must never be reported as implementation correction. Duplicate requests and interruption/reopen must preserve identity and avoid duplicate workers. Invalid scope, verifier tampering, revoked authority, unknown failures and unverified termination remain denials.

The legacy `.airodrom/controlled-verify-fail-once.json` marker is not execution authority. Its host mutation helper requires both test mode and the explicit fixture-worker option; it rejects read-only Missions, symlink/hard-link targets and unexpected baseline bytes. A repository marker cannot enable production injection. The old `live-self-repair-proof.cjs` OpenCode implementation route is historical and cannot qualify the current Cursor architecture. A real canary requires an authorized controlled Cursor assignment and must retain that worker's incorrect first result before correction.

## Staging, cutover and rollback

1. Reconcile current remote main, reviewed candidate and installed source SHA. Preserve dirty, unique, active, unmerged and rollback worktrees. Source, isolated proof, PR readiness, merge, installation and live canary are separate claims.
2. Validate a checksum-bound source archive with a fresh locked install, patched Node, declared checks, secret scan, package allowlist and reproducible archives. Prepare native artifacts against private staging directories only; do not register login items or start a second production controller.
3. Check repository-required CI, exact revision, conflicts, independent review and owner release authorization. A stale historical cutover request is not current authorization. A blocked required check keeps the PR in Draft.
4. Before an authorized managed cutover, recheck admission, active/uncertain Missions, writer ownership and leases. Create the standard private online SQLite recovery checkpoint and integrity/restore check, preserve the current installation and service configuration, and record the rollback SHA. Do not print discovery documents or credentials.
5. Drain and change only the managed service after its release gate is satisfied. Preserve identity, credentials, scopes and standing permissions. Qualify the patched Node/OpenCode executable pins and startup compatibility, then verify the service, MCP and installed source fingerprint.
6. Run a fresh canary from the actual ChatGPT connector only after installation is verified and an existing grant covers the disposable repository, exact file, controlled wrong-result capability and correction budget. Do not transfer a handoff grant to Self-Repair Acceptance or substitute an unrelated repository. If no eligible authorization exists, report live qualification as unproven.
7. Roll back by draining/stopping the candidate and restoring the preceding reviewed service configuration and installation. Keep SQLite history, reservations, grants, receipts and uncertain leases intact; never replay completed work. The preceding runtime may still have the security advisory, so rollback is recovery, not security clearance.

For the live canary, report exact Mission, initial/corrective Cursor and OpenCode run IDs; compare bytes and current host checks; verify automatic Acceptance and Settlement plus termination of every worker and release of every lease. A clean first attempt, an isolated fixture or an old installed SHA cannot satisfy this gate.
