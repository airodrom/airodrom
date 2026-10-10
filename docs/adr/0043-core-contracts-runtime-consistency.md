# ADR 0043 — Core contracts and runtime consistency

Status: Proposed; local daily-integration candidate evidence only until owner disposition.

## Decision

Airodrom strengthens sovereign control-plane consistency through additive, versioned
contracts without rewriting durable ConversationEngine, Mission, Memory, or ledger
state.

1. **Canonical contracts** (`config/core-contracts-v1.json`, `src/core-contracts.js`)
   define Conversation, ModelRequest, WorkerAssignment, Mission, ExecutionEvent, and
   VerificationEvidence with schema identity, version, ownership, authority flags,
   idempotency notes, and fail-closed validation. Validation reuses hand-rolled
   `control-plane-store` helpers (`object`, `text`, `identifier`). Historical records
   without contract stamps remain readable as `historical_unversioned`; silent
   migration is forbidden.

2. **Provider vs agent distinction** remains explicit. ModelRequest is a model-provider
   contract (inference / optional streaming only). WorkerAssignment is an agent-runtime
   contract. Model providers must not carry Mission, workspace, or tool authority.

3. **Runtime security conformance** (`config/runtime-security-conformance-v1.json`,
   `src/runtime-security-conformance.js`) classifies workspace confinement, tool
   mediation, credential isolation, cancellation, result publication, and recovery
   support from host evidence and existing `agent-runtime-profile` / qualification
   config. States are VERIFIED, UNVERIFIED, or UNSUPPORTED. Worker self-reports cannot
   establish VERIFIED. Assignments that require unproven properties fail closed.

4. **Installation compatibility** (`config/installation-compatibility-v1.json`,
   `src/installation-compatibility.js`) observes core daemon, CLI, Control Center,
   macOS menu, MCP contract, and model/agent contract surfaces. Identical Git SHAs are
   not required. Incompatible or missing-evidence installations block state-changing
   operations while preserving read-only diagnostics and recovery.

5. **Surfaces**: Control Center System Health and `/api/product/compatibility` expose
   component identity, contract compatibility, runtime security evidence, and upgrade
   guidance without credentials or private Memory. Interactive `/compat` reads the same
   report.

## Alternatives considered

- Introducing Ajv/Zod as a new validation stack — rejected; the repository already
  validates with host helpers and JSON Schema is used only in bounded-worker CLI
  envelopes.
- Migrating existing SQLite rows to stamped contracts — rejected; preserves historical
  evidence and avoids silent rewrite.
- Treating worker/runtime self-description as qualification — rejected by existing
  governance; host evidence remains authoritative.

## Compatibility

Additive modules and optional overview fields. No Mission Authority, Capability Broker,
Memory V2, or MCP tool schema rewrite. WhatsApp production HOLD is unchanged.

## Evidence

Focused tests in `tests/core-contracts-v1.test.js`. Authority and SDK typechecks remain
green on the daily candidate. No hosted CI dispatch and no production activation are
authorized by this ADR.
