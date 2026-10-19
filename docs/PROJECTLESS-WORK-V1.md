# Projectless work

Ordinary conversation, operator settings, and development requests do not require a registered Project.

When a request does not name an authorized repository, Airodrom prepares a new private task sandbox. That directory is not a checkout of an enrolled project and grants no access to other files.

An enrolled repository is used only when the request names that Project or its authorized path. An unrecognized path is refused. Existing Projects remain available for organization and for work that names them.

The original exact `fixture.txt` alpha-to-beta shortcut dispatches OpenCode. Its successful execution is not proof that arbitrary projectless development or automatic Git merge/installation is supported.

## Bounded multi-file exact-result work

The `AIRODROM_WORK_V1` data format compiles 1–8 explicitly declared files and exact expected bytes into the existing Mission contract and worker launcher, without a persistent Project or user Goal. Local OpenCode follows existing standing-admission and independent-verification/Acceptance rules. Explicit Cursor requests never silently fall back to OpenCode.

Independent host verification may read the fresh sandbox root, including its protected Git and test definitions. The worker still receives only declared files in separate staging, and both worker and host write permissions remain bounded to those outputs. Supported-runtime synthetic Mission tests cover successful two-file verification, rejection of an incorrect second file, and staging/lease cleanup; live macOS and provider acceptance remain separate evidence.

Cursor billing observability remains `UNKNOWN_SUBSCRIPTION`; execution requires a separate explicit, scoped operator subscription grant with finite invocation/runtime limits. Unknown cost is not an authorization, and an unenforceable monetary ceiling is not presented as a guarantee. Cursor Acceptance remains separate from the OpenCode-only automatic-Acceptance preference.

See [Worker execution recovery](WORKER-EXECUTION-RECOVERY-V1.md) for the canonical schema, authority boundaries, regression command, diagnostic guide and operational closeout checklist. The [source-validation receipt](ISSUE-142-VALIDATION.md) separates tested source from live installation evidence. Do not claim activation or close the operational issue from source tests alone.

Host verification, worker qualification, sandbox isolation, and high-impact fail-closed controls remain mandatory.

## Natural-language two-file Cursor intake

`prepare_mission.objective` and `ask_airodrom.instruction` now also accept this
bounded natural-language form, without an `AIRODROM_WORK_V1` packet:

```text
Use Cursor only in a new disposable workspace to create exactly two files:
alpha.txt: "alpha\n"
beta.txt: "beta\n"
```

The alternative header is `Create exactly two files in a new disposable workspace
using Cursor only:`. `write`, `2`, and `sandbox` are accepted alternatives;
`new`, `only`, and `exactly` are optional. File clauses may use `:`, `containing`,
or `with content`, separated by a newline, semicolon, or `and`. Paths may be wrapped
in backticks and lines may start with `-`. Contents must be JSON string literals:
`"beta\n"` includes a final LF; `"beta"` does not. No newline is inferred.

This is intentionally a finite grammar for two public exact-result files, not a
general prose planner. The entire instruction must match. Extra files, commands,
money ceilings, fallback instructions, claimed approvals, and appended constraints
are rejected rather than silently dropped. Existing path/content limits apply,
including screening decoded contents. Ambiguous explicit Cursor prose that does **not** name an enrolled Project returns
`projectless_exact_two_file_syntax_required` and cannot enter the historical
OpenCode fixture shortcut. Enrolled-project Cursor requests are handled by
[Zero-setup autonomous work](ZERO-SETUP-AUTONOMOUS-WORK-V1.md#enrolled-project-routing-autonomous-development-unblocking-v1)
and must never be forced through this two-file grammar. Invalid literals and unparsed constraints have distinct
blockers. Reusing a request ID with changed instructions is denied; correct a request
using a new ID. Replay of identical input returns the existing identity and blockers.

The compiler feeds the existing #143/#145 `work_spec` path. Preparation records
both files and measurable criteria in a fresh sandbox, with `worker: cursor` and
`execution_authorized: false`. It creates no Mission, output file, subscription grant
or dispatch. The authenticated local approval API described in
[Worker execution recovery](WORKER-EXECUTION-RECOVERY-V1.md#explicit-cursor-grant)
is the sole existing transition to contract creation, grant binding and dispatch.
An ordinary approval still fails with `BLOCKED_SPEND_AUTHORIZATION`; MCP credentials
cannot call that operator endpoint. The immutable contract hashes each file's exact
bytes and permits Cursor alone, no fallback, one invocation and no repair attempts.
The grant must match that contract and workspace and remain active and unspent.

This extends ADR 0051's intake within existing authority semantics. It incorporates
#149's scope/approval diagnostics; #148's Mission list changes are independent.
No scheduler, standing grant, migration or new approval channel is introduced.
Rollback is a source revert to the current main baseline, retaining prepared requests,
Mission records and all subscription accounting. Do not rewind the database or drop
consumed reservations. No managed installation or live paid run follows from these
source changes.

Targeted checks (Node 22.23.3 or later in 22.x):

```sh
node scripts/run.cjs --test tests/projectless-bounded-work.test.js tests/projectless-mission-integration.test.js tests/cursor-spend-admission.test.js tests/cursor-subscription-retention.test.js
node scripts/run.cjs --test --test-name-pattern='natural Cursor intake' tests/mcp-handoff-session.test.js
```

The HTTP test exercises real MCP authentication, fresh/expired/resumed sessions,
changed-input replay, credential separation and a missing grant with zero dispatches.
Canonical Mission tests cover MCP intake through real contract/grant creation,
synthetic Cursor staging, host application and exact-byte verification. A wrong second
file fails verification even when the worker reports success; correct files reach
`awaiting_acceptance`, never owner Acceptance. Separate production-admission fixtures
exercise real subscription accounting with synthetic provider transport. These are
safe local integration proofs, not live provider or managed-host qualification.

Validation against main `57df3d8739028a3342420c718d35f000f3f5a63b`:

- 71 checks passed across bounded/projectless work, canonical Mission integration,
  Cursor spend admission/retention and MCP catalog integrity. Seven focused checks
  also passed, including the authenticated HTTP intake and #149 MCP diagnostic;
  five of those overlap the 71-check selection.
- Both authority/SDK type checks, actual npm package selection (456 files, all 281
  runtime files), dependency/license audit and diff checks passed.
- Checksum-verified Gitleaks 8.30.1 found no findings in the eight changed files,
  the directory scan, or the reachable Git history scan. The additional provider/key
  classifier still flags the unchanged `tests/opencode-process-failure.test.js:29`
  fixture and existing history object `eb178a4b78461d87c47de0ed341bc7280af8448c`.
- Public-source verification fails solely on the existing missing allowlist entry
  for `docs/LIVE-EXECUTION-MONITOR-V1.md`; pristine main reproduces the same failure.
- The broader six-file regression selection did not finish on either candidate or
  pristine main during the review window, including with `--test-force-exit`.
  Both were interrupted; no complete broader-suite pass is claimed. Full regression
  and independent review remain required before release.

## Why a prepared request may not dispatch

`PREPARED` (initial intake) and `WAIT` (inspection/replay) do not prove that an
executable Mission exists. Inspect `blockers`, `next_action`, and
`admission.standard_approval_supported`. Preparation and read-only inspection grant no
authority. Diagnostics also apply to existing durable proposals without changing
their state or retrying execution.

The boolean describes whether ordinary approval supports this intake shape; it
does not promise successful dispatch or waive downstream policy, qualification,
budget, or sandbox checks. The pending-list approval UI is unchanged.

| Request | Admission and next action |
| --- | --- |
| General projectless prose, with no declared files or exact-result specification | `projectless_scope_required` and `measurable_success_criteria_required`; define bounded work. Owner approval alone cannot compile this request. |
| Validated local OpenCode exact-result packet | Existing authenticated owner intake, or UUID MCP handoff with effective non-manual standing mode and no STOP/expiry/manual-Acceptance flag, may dispatch within the existing finite compiler bounds. |
| Exact `fixture.txt` alpha-to-beta shortcut | Existing narrow local standing-admission path; this is not arbitrary development authorization. |
| Repository proposal from MCP with a standing Developer Autonomy policy | `standing_policy_requires_authenticated_owner_intake`; owner intake or explicit owner approval is still required. |
| Explicit bounded Cursor packet | Scoped external-disclosure and subscription authorization through the authenticated local operator API. Ordinary approval buttons cannot issue that grant. |

Global Autopilot creates repository policies only through authenticated owner
intake. Routine Auto/Expanded Auto govern eligible Acceptance and the existing
narrow local projectless admission; neither fills missing scope nor grants paid
external execution. A Git capability's `auto_allow` decision is separate from
Mission admission. Cursor readiness is also separate: its subscription grant
must match the immutable contract, workspace, expiry, and remaining invocation
and runtime budget. Never infer one from the other.

These diagnostics do not enable general MCP auto-dispatch. Supporting that would
require a separately designed, owner-enrolled delegation binding authenticated
caller, repository, files, verifier, allowed workers, budget, expiry, revocation
and replay identity. A generic Autopilot flag is insufficient authority.
