# Architecture Decision Records

Every Kernel change references an ADR. Compatible repairs may cite an accepted record; authority, lifecycle, boundary and public-contract changes require a new or superseding decision. Use the [template](TEMPLATE.md) or [supersession template](SUPERSESSION-TEMPLATE.md), describe alternatives, evidence, compatibility and migration, and keep decisions Proposed until maintainer review records disposition.

Status vocabulary: Proposed, Accepted, Rejected, Deprecated, Superseded. Architectural acceptance is distinct from Mission Acceptance, deployment and publication. Preserve previous private decision/evidence history separately.

- [0001 execution qualification](0001-execution-qualification.md): Proposed.
- [0002 Work execution port](0002-work-execution-adapter-v1.md): Proposed.
- [0003 runtime support](0003-runtime-support-freeze.md): Proposed.
- [0004 immutable metadata and erasable content](0004-memory-erasure-retention.md): Accepted; opaque migration and logical erasure implemented in candidate source.

See the [Kernel contract](../governance/KERNEL-CONTRACT.md) and [project governance](../../GOVERNANCE.md).

- [0005 OpenCode execution boundary](0005-opencode-execution-boundary.md): Accepted adapter contract.
- [0006 default execution runtime](0006-default-runtime-cutover.md): Historical runtime cutover; superseded by ADR 0008 for complete removal.
- [0007 local interactive Missions](0007-local-interactive-missions.md): Proposed; private bootstrap and signed bounded reasoning admission.

- [0008 complete runtime removal](0008-remove-worker-runtime.md): Accepted owner decision; host primitives retain authority and OpenCode remains primary.

- [0009 product observability](0009-product-observability-and-runtime-requalification.md): Proposed; bounded runtime qualification and safe product status.
- [0010 personal assistant and qualified routing](0010-personal-assistant-and-qualified-routing.md): Proposed; host-owned intent, data boundaries, handoff and read-only connector foundation.
- [0011 Conversation Engine and intent routing](0011-conversation-engine-and-intent-routing.md): Proposed; replaces ordinary authenticated chat/Mission semantics of ADRs 0007 and 0010 only, preserving governed work and explicit Mission contracts.

- [0012 named private identifiers and research gate](0012-natural-private-vault-and-research-gate.md): Accepted after two independent boundary reviews and owner approval of PR #20; deterministic terminal-only identifiers and unavailable browser research.

- [0013 conversational private storage](0013-conversational-private-storage.md): Proposed; greeting-safe host routing, confirmed native storage choice and name-bound operator reveal.
