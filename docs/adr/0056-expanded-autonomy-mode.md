# ADR 0056 — Expanded Autonomy Mode V1

Status: Proposed

## Context

Owners want Airodrom to operate unattended inside durable standing permissions, without repeated Acceptance prompts for every successful local task, while retaining an immediate return to manual approvals and a reliable emergency stop.

The product already has Risk Acceptance, Deterministic Acceptance, Developer Autonomy, Global Autopilot, Capability Broker, SafetyPolicy, and purpose-bound Secret Vault. A parallel permission engine would duplicate authority and create bypass risk.

## Decision

Introduce **Expanded Autonomy Mode** as an owner-controlled operating mode that composes existing mechanisms:

1. **MANUAL** — default. New automated Acceptance decisions are blocked. Explicit operator Accept remains available.
2. **ROUTINE AUTO** — eligible verified local OpenCode work may auto-accept through Risk Acceptance and Deterministic Acceptance. Historical Missions are never retroactively authorized.
3. **EXPANDED AUTO** — ROUTINE AUTO plus enrolled standing domain policies for credentials, financial, production, destructive cleanup, and broad resource access.

High-impact domains remain **off and unqualified** until the owner enrolls a standing policy and the domain’s adapter/provider is independently qualified. Financial and production execution cannot be marked qualified in V1.

Emergency STOP returns to MANUAL, disables Risk Acceptance preference, stops Global Autopilot when on, and revokes active expanded domain policies so queued work cannot reuse old authority.

Credentials stay opaque to the model. Standing credential policies bind reference, application, purpose, and operations.

## Consequences

- Control Center surfaces the effective mode, domain scopes, and emergency controls under Automation & Permissions.
- Settings persist in control-plane SQLite across managed restarts.
- No merge, deploy, financial transfer, or destructive live qualification is activated by this ADR alone.
- Owner enrollment is required before any newly implemented high-impact permission becomes runnable.
