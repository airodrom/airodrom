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
| Live disposable Cursor Mission with grant | Unverified until one mission-scoped grant Mission completes on the install |
| Standing ChatGPT Cursor enrollment | Not enabled until live proof + documented spend limits |
| Concurrent overlapping writers | Not authorized (serial workspace lease) |

## Explicit non-goals

- Redesigning the canonical architecture above.
- Inserting a second Mission service, scheduler, or cognitive planner.
- Treating Cursor prose (“I fixed everything”) as Acceptance evidence.
- Silently extending subscription grants.
- Broadening chatgpt-handoff beyond enrolled workers without owner authorization.
