# Worker execution admission and projectless exact-result work

Canonical recovery guide for issue #142. Keep this document with the implementation;
read it before describing a qualified worker as execution-proven or rebuilding routing.

## Release status — do not infer activation

This repair was prepared against `fb17b8314c33024fb7d75550dc2a0cb13caba277`.
The validation recorded here is **source-level, isolated, synthetic-provider validation**.
It is not a live Cursor run, supported-runtime full integration, merge, installation,
or remote ChatGPT end-to-end acceptance receipt. Do not close the operational incident
until the closeout checklist below has actual receipts.

## Root cause and invariant

PR #140 required `readiness.spend === 'authorized_subscription'`, while production
Cursor readiness always returned `UNKNOWN_SUBSCRIPTION`. Fixture execution skipped
that check. A healthy qualified worker could therefore never pass real admission.

**Billing observability and execution permission are different facts.**

- `spend: UNKNOWN_SUBSCRIPTION` remains the honest statement about provider billing.
- A separate, explicitly authenticated operator grant may authorize finite Cursor
  invocations and runtime while acknowledging unknown per-run cost.
- Readiness, a WORK template, external-disclosure consent alone, a model's output,
  or a serializable `authorized: true` value is never a subscription grant.
- A requested actual dollar ceiling or Mission cost boundary cannot be guaranteed
  with this transport. Reject it instead of claiming a fake zero-cost or hard cap.
- No existing approval is upgraded or renewed automatically. Expired/revoked grants
  remain unusable. Global financial flags and authentication requirements stay intact.

The grant has a reachable success path without weakening the fail-closed default.

## Existing architecture — reuse, do not duplicate

The canonical Mission service already stages multiple declared files for OpenCode
and governed headless Cursor. It applies host-measured changes and runs independent
verification. Multi-file implementation did not need a second scheduler.

The new projectless shortcut was narrow: `fixture.txt`, alpha to beta, OpenCode.
That shortcut was not evidence that the underlying workers lacked multi-file support.
Historical successful runs are capability evidence, not permission for another run.
Likewise, `cursor_run_task` means a registered IDE process task, **not** Cursor Agent.

Flow: authenticated request -> bounded specification -> existing Mission contract ->
authorized selected worker -> host inventory/application -> independent verification ->
existing Acceptance policy. OpenCode can propose a later Cursor stage, but Airodrom
must admit that stage separately. A worker never grants another worker authority.

## Machine-readable projectless intake

An agent may supply the following **entire objective/instruction string** through
`prepare_mission` or `ask_airodrom`. The user need not register a Project or copy IDs.
This is an exact-result data format, not arbitrary multi-step development planning.

```text
AIRODROM_WORK_V1
{"version":1,"worker":"opencode","files":[{"path":"first.txt","content":"one\n"},{"path":"second.txt","content":"two\n"}]}
```

Only `version`, `worker` and `files` are accepted; each file has `path` and `content`.
There are 1–8 files, at most 2,048 UTF-8 bytes per content and 8,000 total; the existing
MCP instruction size limit still applies. The exact bytes, including final LF, are
preserved. Paths must be safe relative, distinct case-insensitively and non-overlapping.
Tests, verifier inputs, package files, secrets, hidden paths and parent traversal are
not writable. Commands, absolute workspaces, grants and permissions are not spec fields.
Malformed specs fail; ordinary/named-repository intake is not reinterpreted by this format.

The host creates a fresh private sandbox, seeds only the requested files with empty
baseline contents, and writes protected exact-content verification and diff-check tasks.
It then calls the existing Mission creation/dispatch APIs. No persistent Project or
user Goal is created. Every requested file receives its own exact-file criterion.

OpenCode uses existing local standing-admission and risk-Acceptance rules. Missing,
manual, expired or stopped remote standing policy leaves the request unexecuted.
Cursor-only work stays Cursor-only; it cannot silently fall back to OpenCode.

## Explicit Cursor grant

A Cursor spec prepares real files/criteria in its presentation but **does not** acquire
external disclosure or subscription permission merely by being requested.
The existing authenticated local operator approval endpoint
`POST /api/assistant/zero-setup/approve` accepts the additional field below for that
prepared Cursor spec. This is an API contract, not an instruction to the agent to
forge local-owner confirmation or call an operator-only endpoint through another route.

```json
{
  "request_id": "THE_EXISTING_PREPARED_REQUEST_ID",
  "confirmed": true,
  "channel": "control_center",
  "subscription_execution": {
    "provider": "cursor",
    "acknowledge_unknown_cost": true,
    "max_invocations": 1,
    "max_runtime_ms": 10000
  }
}
```

The operator must intentionally authorize disclosure of the declared public task files
and acknowledge unknown subscription cost. The finite limits cannot exceed the actual
contract. The example is not a standing global grant and never changes money controls.
Cursor remains subject to its existing owner Acceptance rules; the OpenCode-only
automatic-Acceptance preference must explicitly be disabled on Cursor Mission input.
Do not promise unattended Cursor Acceptance from this repair.

## Durable accounting, revocation and replay

`cp_subscription_invocations` records admission before provider execution. Every
reservation consumes an invocation, including failed or uncertain launches. There is
no automatic refund. Reusing a reservation request refuses a second execution.
Reopening the host does not restore consumed allowance.

Admission binds the live approval, Mission, scope fingerprint, workspace, time limit
and chosen worker. A module-private one-use ticket also binds the execute call's file
list, prompt hash, signal, model and provider-host list; request JSON cannot mint one.
The host rechecks immediately before launch, periodically during execution, and before
returning results. Expiry/revocation cancels the local worker and denies publication.
This does not claim to reverse a provider request already sent or prevent prior charges.

Prepared-work records retain the Mission ID before dispatch. An uncertain dispatch is
marked for reconciliation. Retry the same request to read its identity; never allocate
a second Mission blindly, reuse another principal, or revive an old approval.
An approved-but-not-dispatched crash window requires host reconciliation; it is not
reported as completed or automatically replayed by this change.

## Diagnosis table

| Symptom | Check / action |
| --- | --- |
| Qualified/available, but refused | Inspect the Mission grant and actual admission reason, not only readiness. |
| `BLOCKED_SPEND_AUTHORIZATION` | A valid scoped owner grant is missing; no provider call should occur. |
| `subscription_monetary_cap_unenforceable` | Requested monetary bounds cannot be enforced; do not substitute an unknown-cost acknowledgement. |
| `approval_expired` / `approval_revoked` | Do not reuse, renew, or bypass the grant. |
| `subscription_invocations_exhausted` | Include reserved and uncertain invocations in the count; no automatic refunds. |
| `subscription_invocation_replay_denied` | Recover the existing run/evidence, never issue a blind duplicate. |
| Scope/contract mismatch | Reject; inspect immutable contract and current host records. |
| Empty generic projectless proposal | It is not an executable multi-file Mission; use the bounded compiler only for exact-result work. |
| Fresh-session rejection | Inspect current MCP session lifecycle/header and expiry; do not disable freshness. |
| Worker says done | Inspect actual files, host verification, Acceptance and cleanup separately. |

## Focused regression commands and their limits

```sh
node --test tests/cursor-spend-admission.test.js tests/projectless-bounded-work.test.js
```

Recorded isolated result: **28 passed, 0 failed** on Node **22.16.0**. The repository
requires `>=22.23.3 <23`; this is not supported-runtime release qualification.
The tests load the actual modified modules and use real SQLite, temporary files/Git,
and the generated exact-byte verifier. Cursor provider processes/network/platform,
contract-validation dependencies and parts of host Mission plumbing are simulated.
The production admission tests do not set `fixtureExecutable` and do not replace the
real spend-check methods. They prove reachable/denied control flow, not live macOS
sandbox behavior, real vendor billing, full MissionService integration, or Acceptance.

Run only relevant existing Cursor/Mission approval/projectless/auth regressions on the
supported runtime plus repository-mandatory checks. Do not run unrelated browser/heavy
suites or paid workers just to create another green count. Preserve missing-evidence labels.

## Operational closeout checklist

Before marking **LIVE RESOLVED**, record:

1. Reviewed repair PR and exact tested/merged SHA; required checks passed.
2. Supported-runtime integration: canonical contract normalization, two-file Mission,
   independent failed/successful verification, original auth/fixture regressions.
3. Managed backup/checkpoint integrity, idle/drain, exact installation identity,
   one supervisor and healthy Memory/MCP/workers. No generic stop/kill substitution.
4. One genuine authorized two-file Cursor Mission: Run ID, host verifier ID,
   actual Acceptance state, termination, staging cleanup and lease release evidence.
5. Fresh ChatGPT session request and resulting Mission link, separately from local MCP.
6. Billing remains unknown unless independently observed; actual grant/consumption
   and any monetary limitation are recorded honestly.

Record installed SHA, date, Mission/Run/verifier/Acceptance IDs and remaining limitations
here or in a linked closeout receipt only after observing them. Until then, keep issue
#142 open. A draft/source fix is not an installed or execution-proven fix.

## Documentation and regression rule

Future changes to readiness, grants, intake, contracts or worker routing must preserve
both authorized and denied non-fixture admission tests. Keep this document authoritative
for the distinction between implemented, simulated, host-verified, accepted and installed.
Do not recreate multi-file workers, mislabel IDE tasks, claim all development is supported,
or repeatedly send the user through the same invalid approval proposal.
