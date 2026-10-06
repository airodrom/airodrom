# Canonical decisions

Capability Broker, SafetyPolicy, immutable scopes and protected approvals authorize execution. Bounded reasoning admission authorizes inference only.

ChatGPT chooses strategy and reviews outcomes; it is not a runtime single point of failure. Pi owns durable operational reconciliation.

Pi Control Plane and Pi Worker have separate roles and access. Agents perform work; providers supply inference. Neither model selection nor agent text grants permissions.

Result Inbox is untrusted evidence. Pi verifies independently; Acceptance precedes Next Action. A historical completed Task or model assertion is insufficient.

Slack Decision records operator direction; it never satisfies a protected Approval.

Workspace writer leases survive restart. Expiry or requested cancellation does not prove writer termination; quarantine uncertainty.

Commit state and effect intents together. Claim delivery effectively-once only with destination idempotency. Preserve unknown external delivery for reconciliation.

Codex is handoff-first until a supported native transport exists. Cursor editor installation does not establish executable agent integration.

See [architecture](../ARCHITECTURE.md) and the [runtime matrix](../RUNTIME-SUPPORT-MATRIX.md).
