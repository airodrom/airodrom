# ADR 0018: Qualified local CLI proposal workers

Status: Proposed. Supersedes only the unavailable native vendor-worker portions of ADR 0010; preserves its data boundaries and V1 handoff compatibility. Subject to two independent local boundary reviews and owner merge approval.

## Decision

Keep Airodrom as the sole authority and OpenCode as the default local runtime. Add a host-owned lifecycle registry for Codex, Claude Code and Cursor, distinguishing installation, unprobed account state, current qualification, busy, stale, unavailable and denied. Vendor CLIs propose bounded public-file changes with tools disabled inside a no-fork macOS sandbox; host primitives apply and verify changes. Cursor remains denied until its interface meets those same controls.

Qualification requires explicit owner consent and a real disposable public edit fixture. Signed records pin binary/version/model/policy and expire. Signed external-work templates fix public classification, worker allowlist, workspace/files, verification and explicit short-lived authority. V2 ChatGPT handoff chooses only named host templates, retains session-bound status/cancellation and durable idempotency, and cannot supply capabilities or Memory. Local-only and sensitive data never fall back to external inference.

All vendor ContextPacks are empty. Transport uses exact approved public vendor endpoints and matching TLS SNI, with bounded connections/bytes/time. Encrypted application traffic is not claimed to be inspected. Actual executable snapshots, no-fork containment, strict structured streams, current provenance checks before host writes, qualification/authority expiry and verified process-group termination form the admission boundary. Uncertain termination retains ownership quarantine. Template/qualification restore requires new owner consent.

## Alternatives and consequences

Unconfined subscription CLI wrappers and native IDE automation would expose user files, hooks, tools or ambient credentials; they remain inadmissible. Broad network access, copied tokens and default Chrome-profile debugging are excluded. A no-tools proposal boundary is narrower than a full coding agent, but leaves tools and verification with the existing broker. Installation or a version flag cannot prove authentication or execution. Confined live Codex/Claude checks on the implementation host failed, so those routes remain unavailable; that result must not be disguised by fixture success.

V1 requests and historical handoffs remain compatible. New SQLite tables are additive, explicitly classified in the existing retention registry, integrity sealed, and invalidated on restore. No dependencies, hosted CI, GitHub agents or production activation are introduced. Browser research remains host-owned under ADRs 0016–0017; external workers currently do not consume its evidence.

## Evidence and disposition

[Multi-Worker guide](../MULTI-WORKER-V2.md) defines boundaries and limits. Local tests cover broker application/independent verification, canonical empty context, both vendor stream contracts, executable/model/provenance drift, scopes, privacy, expiry/revocation, cancellation, SNI/network denial, no-fork containment, MCP session/idempotency and changed UI consent. Independent local review receipts belong to the focused PR; live unavailable modes must be reported separately. Merge does not authorize release, publication, deployment or private-account research.
