# Architecture Decision Records

Every Kernel change references an ADR. Compatible repairs may cite an accepted record; authority, lifecycle, boundary and public-contract changes require a new or superseding decision. Use the [template](TEMPLATE.md) or [supersession template](SUPERSESSION-TEMPLATE.md), describe alternatives, evidence, compatibility and migration, and keep decisions Proposed until maintainer review records disposition.

Status vocabulary: Proposed, Accepted, Rejected, Deprecated, Superseded. Architectural acceptance is distinct from Mission Acceptance, deployment and publication. Preserve previous private decision/evidence history separately.

- [0001 execution qualification](0001-execution-qualification.md): Proposed.
- [0002 Work execution port](0002-work-execution-adapter-v1.md): Proposed.
- [0003 runtime support](0003-runtime-support-freeze.md): Proposed.
- [0004 immutable metadata and erasable content](0004-memory-erasure-retention.md): Accepted; opaque migration and logical erasure implemented in candidate source.

See the [Kernel contract](../governance/KERNEL-CONTRACT.md) and [project governance](../../GOVERNANCE.md).

- [0005 OpenCode execution boundary](0005-opencode-execution-boundary.md): Accepted adapter contract.
- [0006 default execution runtime](0006-default-runtime-cutover.md): Proposed; preserves required Pi typed/control dependencies.
- [0007 local interactive Missions](0007-local-interactive-missions.md): Proposed; private bootstrap and signed bounded reasoning admission.
