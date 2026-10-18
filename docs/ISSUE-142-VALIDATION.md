# Issue #142 — source validation receipt

Status: **SOURCE REPAIR TESTED; HOST RELEASE GATES OPEN**.
Baseline: `fb17b8314c33024fb7d75550dc2a0cb13caba277`.
Canonical behavior and recovery: [Worker execution recovery](WORKER-EXECUTION-RECOVERY-V1.md).

Changed runtime modules: `src/mission-approval.js`, `src/cursor-worker.js`,
`src/projectless-sandbox.js`, `src/zero-setup-work.js`.

Focused command:
`node --test tests/cursor-spend-admission.test.js tests/projectless-bounded-work.test.js`

Observed: **28 tests passed, 0 failed**. All four changed runtime modules passed
`node --check`. The tests ran on Node 22.16.0 in an isolated Linux working container,
not the user's Mac and not the repository-required Node >=22.23.3 runtime.
No real Cursor/OpenCode execution, external subscription request, credential access,
user workspace mutation, merge, installation, or live Acceptance was performed by
these tests.

Evidence boundary:
- Real modified admission code and SQLite reservations, with production
  `fixtureExecutable` absent.
- Real private task files, Git baseline and generated two-file byte verifier.
- Simulated provider transport/platform; simulated unrelated host plumbing and
  contract-validation dependency in focused admission tests.
- No claim of full host integration or macOS sandbox requalification.

Release holds: supported-runtime regression, canonical contract integration,
real scoped Cursor spending/disclosure authorization, managed installation and one
live Mission with host verification/Acceptance/cleanup receipts. Do not erase these
holds merely because focused tests are green.
