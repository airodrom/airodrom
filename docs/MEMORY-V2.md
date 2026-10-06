# Memory V2 and privacy

PersonalMemory is explicit scoped reference data. Project Memory V2 provides task-scoped checkpoints and reuse with provenance. Canonical architecture excerpts are validated against pinned public source documents. Conversation retrieval supplies reference context; it does not automatically import or promote history. Candidate proposals require host review.

Memory selection enforces domain/project/privacy and byte/top-k limits. Unknown scope, stale lifecycle disposition or incomplete propagation deny retrieval and dispatch. Neither stored content, embeddings, summaries nor model assertions can change authority, approve tools, choose a forbidden runtime or satisfy Acceptance.

New candidate, memory and ContextPack identities are random UUIDv4. Legacy content-derived identities migrate against independent opaque origins; retained aliases and recoverable old content fingerprints are forbidden. Unknown origins stay unavailable. Active dedupe is erasable payload comparison rather than a permanent reconstructive identity.

Remember, correction, forget, expiry and host erasure are distinct operations. Correction-family erasure validates connected scope and applies retryable dispositions. Covered audit/context, request, result, notification, provenance and replay representations are redacted; minimum non-content operation/order/scope/outcome metadata may remain. Supported restore requires independent current authority before constructing services. See [ADR 0004](adr/0004-memory-erasure-retention.md) and [privacy and erasure](PRIVACY-ERASURE.md).
