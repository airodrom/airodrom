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
| Live disposable Cursor Mission with grant | Accepted. Mission `073e3232-975c-4ade-9188-9e2603ba6055` settled after one Cursor execution and a local OpenCode evaluation. See B.3. Historical Missions stay blocked. |
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

Known limitation at B.1: live OpenCode evaluation of a passed Cursor packet failed closed before a recommendation. B.2 repairs that gate. The historical Missions stay blocked.

## B.2 evaluator repair (2026-10-19)

Milestone B is **ready for one final live acceptance**. It is not fully accepted. No additional Cursor execution was run. The architecture is unchanged.

### Sensitive-context root cause

`returnPayload` sends host verification twice: `host_verification` and `verification_results`. The evaluator scan projected digests only on `host_verification`. `verification_results` still carried sha256 evidence hashes. Some of those hashes contain 13–19 digit runs that pass the payment-card check in `containsSecret`, so `sourceContextSensitive` rejected the packet before OpenCode started. Mission `2fb49d9a-a08d-48db-9d17-dee3fdcb34f3` failed with `opencode_sensitive_context` for that reason. The file bytes were already exact.

The scan now projects the same host digest fields on `verification_results`, the before/after hash maps, the scope hash, and workspace identity. Delivered bytes are unchanged, so OpenCode still receives the real binding hash. `containsSecret` is unchanged. A bearer token, a secret in worker prose, or an absolute `/Users` path still fails the scan.

### Timeout root cause

Mission `b5d2ba09-836b-4f5f-ac41-3e914c321a71` blocked with `opencode_timeout` because its sealed wall clock was only the paid Cursor window (`execution_ms`, 120000 ms). Cursor and host verification consumed that window, leaving about 20 seconds for evaluation. Pull request 165 already reserves `execution_ms` for host verification and `planning_ms` for local evaluation on new v3 Missions. The Cursor grant stays capped at `execution_ms`. `evaluationAllowanceMs` fails closed with `gateway_evaluation_deadline` when that host slice is already gone. It does not classify the timeout as a Cursor execution failure. The historical contract was not rewritten.

### Local evaluator requalification

An isolated OpenCode run used the pinned local model and the stored return packet from Mission `2fb49d9a-a08d-48db-9d17-dee3fdcb34f3` (Cursor run `067a69da-75d4-4197-9d5f-9acc01126719`). The database was opened read-only. The historical evaluator run remains `e6ac92ee-b319-47ab-b8e2-cfc7eda2f430` (`gateway_evaluation_unavailable`).

| Field | Result |
|---|---|
| Requalification run | `669e289e-6a5b-4880-bead-1a0991e83f4d` (not a Mission run) |
| Recommendation | `ready` |
| Binding | Matched the stored host binding |
| Termination | Verified. No file changes. About 30 seconds. |
| Historical Mission | Still `blocked`. Reason unchanged. |

This is evaluator requalification, not Acceptance.

### Final live-acceptance prerequisite

One new Mission, under a new mission-scoped Cursor grant, must complete OpenCode planning, one Cursor execution, OpenCode evaluation, host exact-byte verification, and settlement. Repair budget stays zero unless a separate grant allows it. Historical Missions `b5d2ba09-836b-4f5f-ac41-3e914c321a71` and `2fb49d9a-a08d-48db-9d17-dee3fdcb34f3` stay blocked.

Rollback of the install that recorded B.1 is `airodrom-rollback-a92049ab87a2`. The protected checkout `~/code/airodrom` stays unmodified.

## B.3 live acceptance (2026-10-19)

Milestone B is **accepted** for one operator-origin Cursor Mission. The architecture is unchanged. The ask was submitted by the authenticated operator through `POST /api/assistant/input`, request `df5bb960-33ca-4d88-953d-2efec866c10b`. It was not a ChatGPT MCP caller.

Disposable workspace `833e08e6-cb05-4dbc-81a5-12a8eaf5c980` on `milestone-b1-fixture`. Authorized files remained `alpha.txt` and `beta.txt`. Final bytes are alpha `414c5048410a` and beta `424554410a`. No other paths were authorized.

| Step | Evidence |
|---|---|
| OpenCode planner | Successful run `111d1213-86c4-4783-b45a-7cafafcc1095`, termination verified. An earlier planner attempt `7fd397bd-2f92-4a29-979a-4e26b7b8e0cd` also completed. Sealed contract prefix `51a0a14fa423`. |
| Cursor grant | Mission-scoped, channel `control_center`, provider `cursor`, one invocation, 120000 ms, unknown cost acknowledged, repair budget zero. The grant does not authorize another invocation after expiry. |
| Cursor execution | Run `8a130898-c5ea-496d-ac2a-4f062976a104` on Mission `073e3232-975c-4ade-9188-9e2603ba6055`. Completed, termination verified. One settled subscription invocation, outcome `completed`. |
| Host verification | Status `passed`, including `task:exact-bytes`. |
| First OpenCode evaluation | Run `b7b5e97e-30a5-45ff-bcbf-25fc280fcac3` failed before the process started (`opencode_unavailable_or_unsupported`, no pid). The Mission blocked. Cursor was not run again. |
| Local evaluation retry | After pull requests 173–177, startup recovery evaluated the captured packet once admission was open. Run `b963a5b6-0c1b-45e4-b702-e5bef8c35232` returned recommendation `ready`, termination verified, about 32 seconds. Binding `abb4186968bb4693546eeadcd7f0621378b644164bbb0f748cf375edc8ee179b`. |
| Automatic Acceptance | Decision `accept`. State `completed`. Program `settled`. Settlement `settled`. |
| Termination and leases | Cursor and the successful evaluator are termination verified. Workspace leases for the Mission are released. |
| Control Center | Planning — OpenCode, Executing — Cursor, Evaluating — OpenCode, Verifying — Airodrom, and Settled are all done. The displayed state matches the durable Mission. |

The execution wall and the mission approval had expired before that local retry. The retry does not dispatch Cursor, does not extend the paid grant, and still fails closed on a revoked or scope-mismatched approval. A sensitive-context or interrupted evaluation is not retried. `UNKNOWN_SUBSCRIPTION` remains informational.

Historical Missions stay blocked: `b5d2ba09-836b-4f5f-ac41-3e914c321a71` (`opencode_timeout`) and `2fb49d9a-a08d-48db-9d17-dee3fdcb34f3` (`opencode_sensitive_context`). Milestone A `7050a853-4754-4cab-a357-ff882b3446f0` stays completed. The protected checkout `~/code/airodrom` stays at `a1f97c501e203d72e5e90d24fd36c2ebaeb24320`.

Standing ChatGPT Cursor enrollment is still not enabled. The next phase is Milestone C, Claude Code and Codex on this same architecture. It is not started.
