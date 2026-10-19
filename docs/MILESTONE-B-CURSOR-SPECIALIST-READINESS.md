# Milestone B — Canonical multi-agent path (OpenCode ↔ Cursor)

Milestone A (genuine ChatGPT ↔ OpenCode handoff) is **COMPLETE**. This document is the Milestone B contract for the Cursor specialist path. No architecture redesign. Paid Cursor spend remains subject to existing host-enforced mission-scoped grants.

## Canonical architecture (mandatory)

```text
USER
  ↓
ChatGPT
  ↓
AIRODROM          (governing authority: authorize, dispatch, evidence, recover, verify, settle)
  ↓
OPENCODE          (cognitive hub: plan)
  ↓
CURSOR            (specialist worker)
  ↓
OPENCODE          (same hub: evaluate)
  ↓
AIRODROM          (same system: independent verification + settlement)
  ↓
ChatGPT
  ↓
USER
```

The two OpenCode appearances are one cognitive hub (plan then evaluate). The two Airodrom appearances are one governing system (initial governance then final verification). Airodrom’s specialist gateway may securely transport results; it must not replace OpenCode evaluation or insert a second cognitive planner between OpenCode and Cursor.

Future specialists (Claude Code, Codex) use the same return-to-OpenCode shape under the same host governance.

## Roles

| Role | Owner |
|---|---|
| Conversational interface | ChatGPT |
| Sole governing authority | Airodrom |
| Central cognitive hub (plan / evaluate / repair recommend) | OpenCode |
| Specialized workers | Cursor (Milestone B); Claude Code / Codex (compatible later) |
| Independent final verification and Acceptance | Airodrom host evidence |

## Proven / already present

| Capability | Evidence |
|---|---|
| Specialist assignment graph (cognitive v3) | ADR 0059, `src/specialist-gateway.js`, fixture tests |
| OpenCode planner + read-only evaluator | `src/opencode-gateway.js` |
| Host inventory, exact-byte / registered checks | Mission verifier |
| Cursor sandboxed adapter + fixture path | `src/cursor-worker.js`, `tests/cursor-worker.test.js` |
| Cursor → OpenCode evidence packet | `returnPayload` (mission/assignment/worker/run/dispatch/hashes/verification/repair budget) |
| Subscription invocation accounting | `cp_subscription_invocations`; settlement events |
| Explicit worker selection (no silent fallback) | Cognitive router + specialist planner validators |
| Cancellation / quarantine on uncertain termination | Gateway + Mission Service recovery |
| Automatic Acceptance after final host pass | Specialist `autoAccept` |
| Control Center lifecycle rail | Planning — OpenCode → Executing — Cursor → Evaluating — OpenCode → Verifying — Airodrom → Settled |

## Mission intake (false-positive repair)

Work instructions are screened by `operatorSecretLike` before planning. Display redaction treats a bare English noun (`authorization`, `session`, `cookie`, `secret`) plus the following word as a credential assignment. That rejected legitimate enrolled-workspace Cursor requests as `SECRET_DETECTED_IN_WORK_INSTRUCTION` before the subscription gate. Separately, `isWorkRequest` required the edit verb at the start of the string, so “Use OpenCode … Use Cursor to change fixture.txt” was classified as ordinary conversation (`WORK_INTENT_NOT_RECOGNIZED`).

The repair neutralizes the lowercase noun “authorization” when the next word is ordinary English and not an assignment (`=` / `:`) or Bearer/Basic. Session, cookie, token, and password values, including `session <opaque>`, stay credential-shaped. `containsSecret` still rejects API keys, bearer tokens, private-key blocks, and `KEY=value` forms. Bounded file-change sentences that name a work target are work requests. How-to questions stay conversation. No security control was disabled.

## Authorization and spending

- Cursor CLI installed ≠ authorized paid execution.
- Spend class remains `UNKNOWN_SUBSCRIPTION`; authorization is `mission_scoped_owner_grant_required`.
- Cognitive Cursor paths require explicit `subscription_execution` (acknowledge unknown cost, max invocations, max runtime) on Control Center / terminal approve.
- Missing grant fails closed (`BLOCKED_SPEND_AUTHORIZATION` / subscription required). No automatic merge, deploy, or uncontrolled spending.

## Repair behavior

OpenCode may recommend `ready` / `needs_rework` (via `repair`) / `blocked`. Airodrom re-validates authorization before each repair dispatch. Finite `repair_attempts`, no scope expansion, no duplicate dispatch, durable repair history, lease and worktree release on terminal states.

## Supported versus unverified

| Item | Status |
|---|---|
| Deterministic OpenCode → Cursor → OpenCode → host verify (fixtures) | Supported — `tests/milestone-b-cursor-return.test.js`, `tests/specialist-gateway.test.js` |
| Live Cursor file credentials + qualification tiers | Operator-local; confirm before spend |
| Live disposable Cursor Mission with grant | Two operator-origin runs executed. Host exact-byte checks passed on the second. OpenCode evaluation did not complete, so Acceptance is not granted. See B.1 closeout. |
| Standing ChatGPT Cursor enrollment | Not enabled until live proof + documented spend limits |
| Concurrent overlapping writers | Not authorized (serial workspace lease) |

## Explicit non-goals

- Redesigning the canonical architecture above.
- Inserting a second Mission service, scheduler, or cognitive planner.
- Treating Cursor prose (“I fixed everything”) as Acceptance evidence.
- Silently extending subscription grants.
- Broadening chatgpt-handoff beyond enrolled workers without owner authorization.

## B.1 closeout (2026-10-19)

Milestone B is **not fully accepted**. The mandatory architecture is unchanged. These runs were submitted by the authenticated operator through `/api/assistant/input`, not by a ChatGPT MCP caller.

Disposable repository: `milestone-b1-fixture` (`alpha.txt`, `beta.txt` only). Required bytes: alpha `414c5048410a`, beta `424554410a`.

| Step | Evidence |
|---|---|
| OpenCode planner | Run `0140c12a-db44-4765-bd7c-84b074cdd198` reached the spend gate. An earlier planner `adf2f40c-b5b3-4ef4-9b71-c60b6bc85a9c` did the same for the first dispatch. |
| Cursor grant | Mission-scoped, provider `cursor`, one invocation, 120000 ms, unknown cost acknowledged, no repair. Channel `control_center`. |
| Cursor execution | Run `067a69da-75d4-4197-9d5f-9acc01126719` on Mission `2fb49d9a-a08d-48db-9d17-dee3fdcb34f3`. Completed, termination verified. Changed `alpha.txt` and `beta.txt` only. |
| Host verification | Status `passed`, including `task:exact-bytes`. |
| OpenCode evaluation | Run `e6ac92ee-b319-47ab-b8e2-cfc7eda2f430` failed `gateway_evaluation_unavailable` / `opencode_sensitive_context`. No recommendation. |
| Acceptance | Not granted. Mission remains `blocked`. A Cursor result and passed host checks do not settle it. |
| Leases | No held or quarantined lease after settlement of the failure. Admission open and idle. |
| Subscription | One settled invocation on this Mission, outcome `completed`. |

An earlier Mission `b5d2ba09-836b-4f5f-ac41-3e914c321a71` (Cursor run `e6d491e4-0a32-4853-875d-d64dc049e2d2`, planner `adf2f40c-b5b3-4ef4-9b71-c60b6bc85a9c`) also wrote the exact bytes, then blocked with `EVALUATION_UNAVAILABLE: opencode_timeout`. That wall clock was only the paid Cursor window. Pull request 165 reserves host verification and local evaluation time without raising the Cursor grant. The timed-out evaluator was later reconciled as interrupted, termination verified, resolution `gateway_evaluation_timed_out`. That Mission stays blocked.

Installed source and `origin/main` at this closeout are `a92049ab87a2a247b19ccc1c92512ed6fcce953b`. Rollback checkpoint for the previous install is `airodrom-rollback-0b4b99a4637e`. The protected checkout `~/code/airodrom` was not modified.

Known limitation: live OpenCode evaluation of a passed Cursor packet can still fail closed before a recommendation. Until that evaluation completes, Milestone B stays short of Acceptance.
