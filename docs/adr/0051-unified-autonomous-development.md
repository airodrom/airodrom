# ADR 0051: Unified Autonomous Development V1

- Status: Proposed
- Date: 2026-10-12
- Owner: Airodrom maintainers
- Review: Pending owner review of PR `feat/unified-autonomous-development-v1`
- Affected contracts and components: `MissionService.create` envelope (`contract`, `approval_id`), `cp_mission_approvals`, CAE repair (`autonomous-repair`), Goal Planner projection, zero-setup Terminal, host verifier, OpenCode/Cursor sandbox profiles, MCP tool catalog, `/api/control-v2/health` and `/api/control-v2/components`
- Related decisions: ADR 0005 (OpenCode execution boundary), ADR 0037 (Cursor IDE task vs Agent), ADR 0047/0048 (Goal Planner, Continuous Autonomous Execution), ADR 0049/0050 (outcome-first Terminal, controlled self-repair fixture)

## Context and problem

The owner wants one durable workflow: ChatGPT prepares a bounded Mission, the owner approves it once, Airodrom dispatches a qualified coding worker, verifies independently, repairs failures within budget, and returns host evidence. Discovery on 2026-10-12 (origin/main `079eee9`, the installed service) found:

- The Terminal could stop observing a Goal when a parent Mission reached `needs_rework`, surfaced a bare `Blocked`, and cleared `zero-setup-active.json` before repair had genuinely stopped.
- Repair creation ran outside one transaction with random request ids; a crash between create and lineage write could create a second corrective Mission, and transient blocks (`workspace_writer`, name conflicts) became permanent.
- Missions carried no single contract for permissions, budgets, restrictions and audit; approval was a `y/N` that authorized a Goal Plan rather than an artifact bound to an immutable scope.
- Cursor was status-only (ADR 0037); the installed CLI (`cursor-agent 2026.09.28-64d2043`) supports governed headless runs but had no containment, tracing or qualification path.
- The verifier hashed `.vscode/tasks.json` only; test sources were not a trusted baseline and security scans were absent.
- ChatGPT lacked `prepare/inspect/status/events/evidence` tools and a durable final evidence package.

## Decision

1. **Derived recovery phases.** `src/recovery-phase.js` projects canonical Mission states plus the Goal Plan autonomous record into `INITIAL_EXECUTION … REPAIR_PENDING … REPAIR_VERIFIED … REPAIR_BLOCKED … QUARANTINED`. Nothing persists a second state machine. Terminal, Control Center and MCP treat only non-observing phases as terminal and always explain blockers from a fixed vocabulary.
2. **Idempotent transactional repair.** Corrective Mission identities are deterministic per `(plan, stage, parent)`; create, scope check, rebind, lineage, claim and dispatch commit together. Transient blocks become `REPAIR_PENDING` and are re-evaluated; permanent blocks are terminal. Chained corrective lineage is allowed inside the per-stage budget; a repeated failure signature stops before the budget is spent. `src/failure-classifier.js` maps failures to TRANSPORT / WORKER_START / WORKER_EXECUTION / WORKER_RESULT / VERIFICATION / AUTHORITY / WORKSPACE / SCHEDULER / BUDGET / UNKNOWN with a recovery policy; only VERIFICATION with proven termination may repair.
3. **One canonical Mission contract** (`src/mission-contract.js`) stored in `cp_missions.envelope.contract`: identity, objective, project, deny-by-default permissions, execution, immutable verification, budget, restrictions, audit. Unknown fields fail. The **immutable `scope_fingerprint`** covers permissions/scope/verification/budget/restrictions/execution and excludes per-Mission identity and objective text, so a corrective Mission shares it. External workers require explicit `external_disclosure` authorization and a known-host network allowlist.
4. **One owner approval** (`src/mission-approval.js`, `cp_mission_approvals`) bound to the scope fingerprint, permissions digest, window, repair budget and disclosure flag; idempotent on request id, replay with a different scope denied, expiry/revocation fail closed at dispatch; reused by corrective Missions in scope only. MCP never grants.
5. **Governed Cursor worker** (`src/cursor-worker.js`). Containment is enforced by the host, independent of `--force`: Seatbelt denies everything except the staged tree, literal allowed files, the CLI's bundled Node binary (no shells), a host CONNECT proxy to known Cursor hosts, and TLS trust services; the macOS Keychain is unreachable. A host-authored permission deny-list is staged and hash-checked. Tool events are tagged HOST_MEDIATED / WORKER_REPORTED / SANDBOX_OBSERVED and unobservable classes are declared. Host staging inventory is the only authority for changed files.
6. **Empirical containment** (`src/sandbox-containment.js`) runs a canary under the worker-shaped profiles and records each boundary PROVEN / FAILED / UNAVAILABLE / NOT_APPLICABLE. OpenCode keeps wide loopback because `run --standalone` needs its private server (verified); external network stays denied.
7. **Trusted verifier baseline** (`src/verifier-baseline.js`): hashes of verifier-owned inputs captured at creation, inherited by repairs, audited before any registered task runs; tampering, removed assertions and skips are classified; security scans are proportional and reported NEW / PRE_EXISTING / UNAVAILABLE / NOT_APPLICABLE.
8. **ChatGPT coordinator surface**: `prepare_mission`, `inspect_mission_proposal`, `get_mission_status`, `get_mission_events`, `get_mission_evidence`, `request_mission_correction` (WAIT), `cancel_mission`; `src/mission-evidence.js` builds the final package from host records only. Airodrom never wakes an inactive conversation.
9. **Component states** (`src/component-status.js`): READY / DEGRADED / UNAVAILABLE / BLOCKED / RECOVERING with worker tiers installed / authenticated / qualified / available / executing / verified.

Airodrom remains the single execution orchestrator; ChatGPT coordinates and reviews; Cursor/OpenCode are workers; the host verifier decides technical success; Acceptance, merge, installation and production stay owner-only.

## Alternatives considered

- Persisting a new repair state machine: rejected; a derived projection avoids inconsistency with canonical lifecycle states.
- Granting Keychain access to the Cursor sandbox so the existing login works: rejected; it would expose Keychain material. The file credential store or an API-key file is required instead.
- Narrowing OpenCode loopback to the Ollama port: attempted and reverted after the live runtime failed; capability retained via `loopbackPorts`.
- Separate schema for contracts: rejected in favor of extending the existing envelope.

## Authority, privacy and ownership

Contracts and approvals are ceilings; they never satisfy Acceptance. Personal Memory and vault access are never exposed to coding workers (`permissions.personal_memory.mode = 'none'`, `vault_access.mode = 'none'`). External disclosure is explicit, operator-only and provider-named. Workers cannot modify their own contract (fingerprint checked at dispatch and verification). Cancellation, leases, quarantine and settlement are unchanged host responsibilities.

## Compatibility and migration

Legacy Missions without a contract keep their existing authority/manifest/dispatch-policy ceilings and are labelled `absent (legacy)` in evidence. New table `cp_mission_approvals` is classified in `config/memory-retention-fields.json`. Corrective claim ids now use `cae-repair-dispatch:<32 hex>`; the erasure validator accepts both forms. `agent-dispatch` accepts provider `cursor_runtime`. MCP catalog grows from 36 to 43 tools; an existing ChatGPT conversation may hold a stale catalog and must be restarted after install. Live qualification of Cursor execution is separate and currently blocked (see below).

## Consequences

- Terminal never ends observation prematurely and never answers a bare "Blocked".
- Exactly one corrective Mission per failed parent under concurrency and restart.
- Cursor can run only under a contract with disclosure, an approval and a READY worker. On this machine the worker is honestly `CURSOR_UNQUALIFIED` with blocker `cursor_credential_file_unavailable`.
- Zero new recurring infrastructure; Cursor spend remains `UNKNOWN_SUBSCRIPTION` with invocation/time ceilings.

## Validation and evidence

- `npm run test:unified` (42 tests): recovery phases, contract/approval, Cursor worker, sandbox containment (real `sandbox-exec`), MCP coordinator, component status, 25 adversarial scenarios, unified end-to-end.
- `npm run test:cae`, `tests/zero-setup-*.test.js`, `tests/mission-service.test.js`, `tests/mcp-schema.test.js`, typechecks, `npm run verify`, `npm run package:check`.
- Live OpenCode proof (`npm run test:unified:live`, 2026-10-12): parent `3d44a1df` → corrective `3eb871e9` (`repair_of`), bytes `626574610a`, verification passed, no Acceptance.
- Cursor qualification (`npm run qualify:cursor`): `CURSOR_UNQUALIFIED`; containment PROVEN; blocker `cursor_credential_file_unavailable`; zero real runs consumed.

## Rollback

Revert the PR; durable additions (`cp_mission_approvals`, `contract`/`approval_id` envelope fields, `cae-repair-dispatch` claim ids) are additive and ignored by the previous source. Installed service stays at `079eee9` until the owner performs a controlled cutover.

## Decision outcome

Pending owner review. Engineering verdict: PASS WITH KNOWN LIMITATIONS (Cursor live execution UNQUALIFIED pending the file-store credential; live local-model repair variance).
