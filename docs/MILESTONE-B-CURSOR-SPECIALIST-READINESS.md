# Milestone B — OpenCode ↔ specialist gateway ↔ Cursor readiness

Read-only audit against installed `5ff3b68…` (2026-10-18). No Cursor spend, no paid execution, no production mutations.

## Target architecture

```text
OpenCode (plan / evaluate / repair)
        ↕
Airodrom governed specialist gateway
        ↕
Cursor (bounded edit assignments under subscription grant)
```

## Proven / already present

| Capability | Evidence |
|---|---|
| Specialist assignment graph (cognitive v3) | ADR 0059, `src/specialist-gateway.js`, fixture tests |
| OpenCode planner + read-only evaluator | `src/opencode-gateway.js`, live host v11 |
| Host inventory, exact-byte / registered checks | Mission verifier; handoff-proof |
| Cursor sandboxed adapter + fixture path | `src/cursor-worker.js`, `tests/cursor-worker.test.js`, specialist mixed-worker fixtures |
| Subscription invocation accounting | `cp_subscription_invocations`; settlement events |
| Explicit worker selection (no silent fallback) | Cognitive router + specialist planner validators |
| Cancellation / quarantine on uncertain termination | Gateway + Mission Service recovery paths |
| Automatic Acceptance after final host pass | Specialist `autoAccept` |

## Integration gaps (do not claim done)

1. **Live Cursor qualification on this install** — Product UI reports Cursor Agent `available` / `governed_sandboxed_headless`, but Unified Autonomous docs still record `cursor_credential_file_unavailable` for Keychain-bound CLI logins. Confirm `~/.cursor/auth.json` (file store) or approved API-key file before any live spend.
2. **Owner subscription grant UX** — Cognitive path requires explicit `subscription_execution` acknowledgement (unknown cost, max invocations, max runtime). Milestone B needs a single standing grant recipe for ChatGPT/Control Center that cannot exceed enrolled ceilings.
3. **End-to-end live proof** — Fixture coverage exists; a disposable Mission with Cursor edit + OpenCode review + host verify + Acceptance has not been run on this install in this closeout.
4. **Repair with Cursor** — Policy must include `repair` workflow and non-zero `repair_attempts` / `max_repairs` when Cursor is the editor; chatgpt-handoff today is OpenCode-only with `repair_attempts: 0`.
5. **Concurrency** — Host still serializes writers (one workspace lease). “Three concurrent workers” remains a feature ceiling, not authorized overlapping writes.

## Prioritized implementation plan

1. **Qualify Cursor file credentials** (owner): `AGENT_CLI_CREDENTIAL_STORE=file agent login`; run `npm run qualify:cursor`; record digest/reason without printing secrets.
2. **Enroll a disposable Milestone-B policy**: OpenCode + Cursor, `repair` enabled, `max_repairs` ≥ 1, single allowlisted file, automatic Acceptance, delegated ChatGPT caller optional.
3. **Host fixture rehearsal** (no spend): keep existing specialist mixed-worker tests green on tip.
4. **One live paid Mission** (owner-approved spend): Cursor edit assignment → OpenCode evaluation → host verify → Acceptance; capture Mission/run ids and subscription invocation row.
5. **Document spend limits and STOP/revoke** in Control Center before any standing ChatGPT Cursor path.
6. **Only then** expose Cursor as an eligible ChatGPT worker for named enrollments.

## Explicit non-goals for this phase

- Launching Cursor agent sessions.
- Spending subscription credits.
- Broadening chatgpt-handoff beyond OpenCode.
- Parallel orchestration stacks outside Mission Service + specialist gateway.
