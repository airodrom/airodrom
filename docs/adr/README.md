# Architecture Decision Records

- [0013 governed browser product research](0013-governed-browser-product-research.md): Proposed; replaces ADR 0012's unavailable browser gate with a scoped host research capability, preserving its Vault boundaries.

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
- [0034 OpenCode pin replacement requalify](0034-opencode-pin-replacement-requalify.md): Proposed; fail-closed requalification when the pinned OpenCode executable was removed by a package upgrade.
- [0035 OpenCode 2.0.25 qualification](0035-opencode-2.0.25-qualification.md): Proposed; confined live qualification and package evidence cutover for OpenCode 2.0.25.
- [0036 Live Agent Observatory V1](0036-live-agent-observatory-v1.md): Proposed; Mission-scoped live telemetry, SSE/poll transport and Control Center observatory UI on the canonical ledger.
- [0037 Cursor IDE task vs Agent](0037-cursor-ide-task-vs-agent.md): Proposed; classified IDE tasks.json dispatch is not Cursor Agent execution; OpenCode remains the Mission coding worker.
- [0010 personal assistant and qualified routing](0010-personal-assistant-and-qualified-routing.md): Proposed; host-owned intent, data boundaries, handoff and read-only connector foundation.
- [0011 Conversation Engine and intent routing](0011-conversation-engine-and-intent-routing.md): Proposed; replaces ordinary authenticated chat/Mission semantics of ADRs 0007 and 0010 only, preserving governed work and explicit Mission contracts.

- [0012 named private identifiers and research gate](0012-natural-private-vault-and-research-gate.md): Accepted after two independent boundary reviews and owner approval of PR #20; deterministic terminal-only identifiers and unavailable browser research.

- [0014 conversational private storage](0014-conversational-private-storage.md): Accepted after independent privacy/security and runtime/authority reviews and owner approval of PR #22; greeting-safe host routing, confirmed native storage choice and name-bound operator reveal.
- [0015 authenticated browser session handoff](0015-authenticated-browser-session-handoff.md): Accepted after independent runtime/authority and privacy/security reviews and owner approval of PR #26; explicit dedicated-profile login, sanitized navigation evidence and canonical operator hand-back.

- [0016 universal Mission web](0016-universal-mission-web.md): Accepted under the owner implementation request; signed per-Mission public web grants and narrowly consented Monarch login network repair.

- [0017 Universal Browser V2](0017-universal-browser-v2.md): Accepted under the owner implementation request; truthful connection modes, owned CDP and temporary permission controls, subject to exact local boundary reviews.

- [0018 qualified Multi-Worker V2](0018-qualified-multi-worker-v2.md): Proposed; public no-tools vendor proposals, signed owner qualification/templates and V2 handoff.

- [0019 Codex live qualification](0019-codex-live-qualification.md): Signed bundle snapshot, supported no-child host setting, pinned public TLS roots and truthful local MCP qualification.
