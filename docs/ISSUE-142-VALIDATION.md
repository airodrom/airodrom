# Issue #142 — reviewed source validation receipt

Status: **SOURCE REPAIR CHECKED ON THE SUPPORTED RUNTIME; NATIVE AND LIVE INSTALLATION GATES OPEN**.
Review date: 2026-10-18.
Baseline: `fb17b8314c33024fb7d75550dc2a0cb13caba277`.
Original repair head: `0f8eb714074ba0b827f88be87b106ae264f61f4b`.
The reviewed follow-up is versioned in [PR #143](https://github.com/airodrom/airodrom/pull/143).
Canonical behavior and managed cutover: [Worker execution recovery](WORKER-EXECUTION-RECOVERY-V1.md).

## What the review repaired

The original repair separates Cursor subscription permission from unknown billing
visibility and compiles bounded projectless file specifications into existing Missions.
Review exposed additional failures that focused admission tests alone did not cover:

- The accounting table was missing from the retention schema. Real Memory identity
  checks rejected ordinary Mission reads. Its nullable settlement outcomes also needed
  explicit non-content classification for erasure. The repair preserves consumed
  reservations across erasure and database reopen while rejecting unknown schema/values.
- Host Git and generated verification require reads at the fresh sandbox root. The
  original file-only host ceiling denied them. Host reads now cover that sandbox;
  writes and worker disclosure remain declared-file-only.
- A settlement database error could mask an uncertain spawn or termination error and
  lose its Mission quarantine classification. Original errors now survive accounting
  failure; uncertain outcomes stay unknown and reservations are never refunded.
- The source archive and npm manifests omitted runtime modules and recovery documents.
  Explicit entries now cover the runtime; an actual-package regression rejects an
  omitted worker and checks the extracted source against the reviewed bytes.
- Cursor preparation and resumed status pointed to ordinary approval buttons that
  cannot send a subscription grant. They now identify the authenticated local operator
  API. This does not add a grant form to Terminal or Control Center.

The Cursor diagnostic redactor also removes the complete user-home prefix from output.
No dependency version, workflow trigger, money control, provider qualification bypass,
or production service configuration was changed.

## Runtime and source identity

Review tests used **Node 22.23.3**, within the repository's `>=22.23.3 <23` requirement,
in an isolated Linux checkout. Dependencies came from the unchanged lockfile through
`npm ci --ignore-scripts --no-audit --no-fund`. The official Linux Node archive was
checked against its published SHA-256 manifest:

```text
node-v22.23.3-linux-x64.tar.xz
df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de
```

Reviewed runtime fingerprint from `src/runtime-fingerprint.js`:

```text
331174d2a2a1d25cad6ec0d3deae40eeaeb8cb2be736132613129677db041500
```

That existing fingerprint covers runtime source and package manifests; it is not an
all-file digest. Git blob comparisons and archive-byte checks cover the separately
published configuration, tests and documentation. An installed-host fingerprint has
not been observed for this repair.

## Targeted proof and evidence boundaries

| Check | Result | What is exercised |
| --- | --- | --- |
| Cursor spend admission | 18 passed | Actual non-fixture admission, real SQLite reservation/replay/limits, revocation, settlement-error behavior; synthetic provider/platform dependencies. |
| Subscription retention | 8 passed | Real canonical contracts, Memory identity, erasure, durable accounting and physical SQLite reopen. |
| Bounded projectless work | 14 passed | Strict intake, real task files/Git/generated exact-byte verifier, routing and approval guidance; isolated surrounding services. |
| Canonical projectless Mission integration | 4 passed | Real Mission/approval/contract/router/staging/host application/verification/cleanup with a synthetic Cursor executable. |
| Source archive and actual npm selection | 1 passed | Extraction/fingerprint equality, offline locked dependencies, eight runtime imports without starting services, and omission rejection. |
| Authority typecheck | Passed | `npm run typecheck:authority`. |
| SDK typecheck | Passed | `npm run typecheck:sdk`. |
| Public-source verification | Passed | Release surface, syntax/JSON/local links, private-reference and canonical-source checks. |
| Package selection | Passed | Actual npm selection includes the complete runtime and no forbidden entries. |

The first four suites total **44 passed, 0 failed**. The archive regression is a
separate test. Do not add these counts to the wider selection below: it includes the
same focused suites.

```sh
node scripts/run.cjs --test tests/cursor-spend-admission.test.js tests/cursor-subscription-retention.test.js tests/projectless-bounded-work.test.js tests/projectless-mission-integration.test.js
node scripts/run.cjs --test tests/worker-release-closure.test.js
npm run typecheck:authority
npm run typecheck:sdk
npm run verify
npm run package:check
```

The archive test uses an existing npm cache and disables network resolution and
lifecycle scripts in its extracted checkout. Populate the cache with the reviewed
locked dependency installation first.

The production admission suite does not enable `fixtureExecutable` or replace real
reservation methods. Its provider/platform dependencies are simulated. The separate
canonical integration suite uses a synthetic Cursor executable and controlled host
test plumbing. Correct two-file output reaches `awaiting_acceptance`; an incorrect
second file fails the exact criterion and generated test and reaches `needs_rework`.
Both check termination, staging removal and released leases. They do not grant actual
owner Acceptance, qualify macOS Seatbelt, read credentials or contact a paid provider.

## Wider regression selection and native failures

The wider selection covers 288 tests across Cursor, Mission, approval, handoff,
projectless work, Memory identity/erasure, authority and sandbox boundaries. On this
Linux host, 279 passed, 6 failed and 3 retained their existing skip conditions.
**This is not an all-passing test run.** The remaining failures are native host gates;
they were not converted into skips or hidden behind mocks:

| Existing failing case | Missing host capability |
| --- | --- |
| Cursor profile generation | The real profile renderer canonicalizes the macOS `/System` read root, absent on Linux. |
| Cursor governed Mission | Qualified macOS process sandbox for host Git verification. |
| MCP Mission coordinator proposal lifecycle | Qualified macOS process sandbox for host Git verification. |
| Mission contract approval/repair lifecycle | Qualified macOS process sandbox for host Git verification. |
| Zero-setup Terminal consent lifecycle | Qualified macOS process sandbox for host Git verification. |
| Zero-setup work automatic completion | Qualified macOS process sandbox for host Git verification. |

The five execution cases reach `git_status` and report
`Mission process sandbox is unqualified`. `src/host-exec.js` deliberately requires the
real macOS process boundary for Mission-authorized commands. The baseline contract
suite reproduces this native limitation without the feature repair. No platform was
spoofed and no positive sandbox qualification was manufactured.

Initial attempts also encountered absent `/private/tmp` fixture parents. An empty
parent was supplied for those existing fixtures; their assertions were retained.
Reproduce the wider selection on a properly prepared supported-runtime host:

```sh
node scripts/run.cjs --test --test-concurrency=4 \
  tests/cursor-spend-admission.test.js tests/cursor-subscription-retention.test.js \
  tests/projectless-bounded-work.test.js tests/projectless-mission-integration.test.js \
  tests/cursor-worker.test.js tests/cursor-fixtures.test.js tests/cursor-runtime-status.test.js \
  tests/mission-contract-approval.test.js tests/mission-service.test.js \
  tests/mcp-mission-coordinator.test.js tests/mcp-handoff-session.test.js \
  tests/zero-setup-work.test.js tests/zero-setup-terminal.test.js \
  tests/projectless-work.test.js tests/projectless-execution.test.js \
  tests/memory-retention-live-compat.test.js tests/memory-content-erasure.test.js \
  tests/memory-identity.test.js tests/memory-restore-authority-freshness.test.js \
  tests/authority-plane.test.js tests/authority-integration.test.js tests/mission-authority.test.js \
  tests/authority-secrets-projection.test.js tests/trusted-boundary-adversarial.test.js \
  tests/sandbox-containment.test.js tests/secret-diagnostic-boundaries.test.js
```

## Pinned schema-compatible recovery source

Recovery branch: `recovery/issue-142-schema-compatible-base`.
Pinned recovery commit:
[`b7be37af36ef0f1593143d1aab0714b3cbad618d`](https://github.com/airodrom/airodrom/commit/b7be37af36ef0f1593143d1aab0714b3cbad618d).

This commit has the baseline as its parent and changes exactly two files: the
subscription-table retention registry and finite nullable outcome classification.
The baseline worker, Mission service, approval API and dependencies retain their
original bytes. No subscription admission feature was backported.

The reproducible [rollback fixture](../tests/fixtures/cursor-rollback-proof.cjs) checks
two detached baseline worktrees: one pristine and one with exactly that two-file diff.
Its comments give the three commands and source/evidence-directory arguments. Install
the unchanged locked dependencies in each source first. It uses one new synthetic
SQLite database, never a live database, and refuses an existing seed directory or an
incorrect synthetic marker before database access.

| Recovery proof | Observed result |
| --- | --- |
| Current source creates one reserved and four differently settled invocations and completes an initial erasure | 2 of 2 checks passed. |
| Pristine baseline rejects the migrated schema and a real Mission read without changing retained state | 4 of 4 expected-denial checks passed. |
| Compatibility source preserves accounting, approval/event identities, prior erasure, additional erasures and SQLite reopen | 9 of 9 checks passed. |
| Existing baseline identity and restore-freshness regressions | 51 passed. |
| Existing baseline contract/approval regressions | 4 passed; 1 failed at the same unqualified native process sandbox. |
| Proof input guards | Existing-directory and wrong-marker refusal verified; the existing fixture database remained unchanged. |

This is a compatibility proof, **not a known-good installation or live rollback
receipt**. Keep the recovery source available through operational closeout. Use a
source checkout and validate against current host state; do not assume the older
baseline's archive contains the later packaging repairs. Never discard new accounting
or rewind current erasure authority to accommodate old code.

## GitHub and operational holds

Review observed no hosted checks on the original exact PR head, no submitted PR
reviews or review threads, no merge conflicts, and no required remote check contexts
on the branch metadata. The detailed branch-protection endpoint was unavailable to
the connector; that is not evidence of passing checks. The repository's
[CI policy](CI-BRANCH-PROTECTION.md) records its owner-controlled disabled broad
workflow. Local results do not become hosted CI results; re-read the exact head and
current merge policy before merging. No workflow or protection setting was changed.

Remaining operational gates are native macOS qualification, managed checkpoint/drain/
installation and installed-source verification, a real scoped Cursor disclosure and
subscription grant through the authenticated local operator path, one live two-file
Mission with host verification and actual Acceptance/cleanup evidence, and a fresh
remote ChatGPT handoff. The available connector cannot perform the managed source
cutover or mint that local-owner grant. This is an execution/access limitation, not
a request for another blanket approval from the user.

Keep issue #142 open until those receipts exist. No live installation, service restart,
real Cursor/OpenCode execution, paid provider request or live Acceptance is established
by this receipt.

## Historical evidence

The initial repair recorded 28 focused tests passing on Node 22.16.0 plus syntax checks
of four modified runtime modules. That older runtime was outside the declared support
range. Its synthetic tests were useful source evidence, but did not establish canonical
Mission integration or installation. The supported-runtime review above supersedes
that limitation without erasing the remaining native and live proof requirements.
