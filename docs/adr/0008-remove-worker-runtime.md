# ADR 0008 — Remove Pi execution and compatibility

Status: Accepted by explicit owner decision, 2026-10-06. Supersedes the Pi execution/required-runtime portions of ADRs 0003, 0005, 0006 and 0007. Other authority, memory and privacy invariants remain binding.

The owner requires complete removal rather than a retained rollback worker. General Missions resolve qualified OpenCode; unsupported scope or unavailable dependencies stop for review. Existing optional Claude/Work/Cursor classifications remain. Deterministic typed plans, broker operations and independent verification are Airodrom host primitives, not model runtime responsibilities. Keeping Pi or transferring authority to OpenCode are rejected alternatives.

Airodrom remains authoritative for Mission, capability policy, memory, context, verification, Acceptance, Settlement, provenance, erasure, approvals, leases and audit. OpenCode is a replaceable worker and cannot accept its own output. Local Ollama non-agent reasoning is a provider capability. The optional old Active Chat smoke is retired; signed Level 1 broker reads stay deterministic.

Historical records retain their original identity. Missing pre-runtime task identity means historical removed runtime. No runtime identity migration or user-data deletion occurs; removed tasks/envelopes cannot resume, dispatch, replay context, invoke capabilities or publish new results. Old signed typed plans require fresh registration. Kernel and SDK host authority contracts do not change; PiSDK is only a source-compatible type alias. Exact legacy identifier exceptions are documented in [migration](../PI-REMOVAL.md).

Validation requires architecture scanning, runtime-neutral lifecycle and host security tests, deterministic/live OpenCode Memory V2, restore/erasure, host verification/Acceptance/Settlement, CLI/bootstrap, hardening/full suites, both typechecks, package/source checks, dependency/license/secret gates and exact-head hosted CI. Test fixtures do not imply live qualification. No publication or production activation follows this decision.

Source reversal can preserve historical evidence, but no Pi rollback runtime remains in this implementation. Local installation reconciliation uses the existing private installer after merge and green main.
