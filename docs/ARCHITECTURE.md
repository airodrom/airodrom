# Architecture overview

Airodrom is a modular monolith with durable SQLite state machines. ChatGPT supplies strategy and outcome review; Airodrom owns operational reconciliation and typed local execution. OpenCode is the default bounded execution runtime; Pi is removed. Airodrom host primitives execute typed plans and verify evidence independently. Execution agents and reasoning providers are separate. Apps implement external protocols; the Kernel owns admission, authority and lifecycle policies.

A Mission freezes scope, budget, runtime eligibility and verification criteria. Task/Run records capture attempts. Durable writer leases serialize workspace mutation; uncertain termination quarantines ownership. External effects use a transactional outbox with destination idempotency where supported. Unknown delivery remains pending reconciliation.

Results enter an untrusted Result Inbox. Independent evidence is correlated to the current attempt and workspace. Acceptance requires current authority, completed verification and verified termination; local Settlement follows. Scheduling advice and worker assertions cannot accept their own work. Slack Decisions record direction and do not satisfy protected Approvals.

Context Builder selects bounded, scoped references. PersonalMemory, task-scoped Project Memory V2, canonical repository decisions and retrieved conversation history have separate provenance. Model proposals cannot become canonical memory without host review. Recall never broadens runtime, provider, privacy or permission policy.

Official WhatsApp Business inbound is a loopback HMAC webhook into a durable allowlisted inbox (never Mission auto-dispatch). Conversations V1 may queue allowlisted text into ConversationEngine on channel `whatsapp` with personal Memory retrieval off; outbound Cloud API send stays separately governed and hard OFF until owner authorization. Production Connection V1 records Meta prerequisites and keeps production messaging on policy HOLD until the owner clears eligibility; stable webhook-only HTTPS is required (no ephemeral trycloudflare for production). See [Conversations V1](WHATSAPP-CONVERSATIONS-V1.md), [Production Connection V1](WHATSAPP-PRODUCTION-CONNECTION-V1.md), [ADR 0041](adr/0041-whatsapp-conversations-v1.md), [ADR 0040](adr/0042-whatsapp-production-connection-v1.md).

See the [authority guide](governance/MISSION-AUTHORITY-GUIDE.md), [privacy contract](PRIVACY-ERASURE.md), [runtime matrix](RUNTIME-SUPPORT-MATRIX.md) and [threat model](THREAT-PRIVACY-SUMMARY.md).
