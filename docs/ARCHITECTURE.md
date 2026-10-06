# Architecture overview

Airodrom is a modular monolith with durable SQLite state machines. ChatGPT supplies strategy and outcome review; Pi owns operational reconciliation and typed local execution. Execution agents and reasoning providers are separate. Apps implement external protocols; the Kernel owns admission, authority and lifecycle policies.

A Mission freezes scope, budget, runtime eligibility and verification criteria. Task/Run records capture attempts. Durable writer leases serialize workspace mutation; uncertain termination quarantines ownership. External effects use a transactional outbox with destination idempotency where supported. Unknown delivery remains pending reconciliation.

Results enter an untrusted Result Inbox. Independent evidence is correlated to the current attempt and workspace. Acceptance requires current authority, completed verification and verified termination; local Settlement follows. Scheduling advice and worker assertions cannot accept their own work. Slack Decisions record direction and do not satisfy protected Approvals.

Context Builder selects bounded, scoped references. PersonalMemory, task-scoped Project Memory V2, canonical repository decisions and retrieved conversation history have separate provenance. Model proposals cannot become canonical memory without host review. Recall never broadens runtime, provider, privacy or permission policy.

See the [authority guide](governance/MISSION-AUTHORITY-GUIDE.md), [privacy contract](PRIVACY-ERASURE.md), [runtime matrix](RUNTIME-SUPPORT-MATRIX.md) and [threat model](THREAT-PRIVACY-SUMMARY.md).
