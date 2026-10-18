# ADR 0057 — Mission list cleanup

Status: Proposed

## Context

Existing presentation archiving preserves canonical records but separates archived results from searchable History and admits unfinished work into broad history organization. Active omits several actionable states. Automatic terminal housekeeping is absent.

## Decision

Extend the existing visibility table and preview protocol. Active exposes unfinished work and unresolved terminal obligations. History includes archived results. Automatic cleanup is restricted to settled completed or cancelled Missions after 24 hours and current safety checks, runs in the existing supervisor, and respects explicit restore. Bulk organization uses exact expiring previews and transactionally rechecks terminal and safety eligibility. All transitions append visibility events without changing lifecycle or evidence.

No new scheduler, destructive purge, authority mode, Acceptance or accounting path is introduced. ADR 0004's erasable-content requirements and ADR 0054's authenticated owner delegation remain authoritative. Narrowed automatic/bulk eligibility does not prohibit explicit safe archiving of obsolete nonterminal records.

## Alternatives and compatibility

Deleting old Missions would lose verification and recovery evidence and is rejected. A separate archive database would create competing retention/restore rules and is rejected. Existing schema and endpoint names remain; list projections are intentionally clarified. All now includes archived rows; History search covers them. The CLI defaults to Active with explicit History and All choices. Live execution counters remain distinct.

## Evidence

See [Mission List Cleanup V1](../MISSION-LIST-CLEANUP-V1.md) and its lifecycle, API, preservation, restart and browser fixtures. Release and activation remain subject to the existing release gates. Architectural acceptance is separate from Mission Acceptance and installation.
