# Expanded Autonomy Mode V1

Owner-controlled operating modes for unattended work inside durable standing permissions.

## Modes

| Mode | Behavior |
|------|----------|
| **Manual** (default) | Ordinary owner approvals. New automated Acceptance decisions are blocked. |
| **Routine Auto** | Eligible verified local OpenCode work may auto-accept through Risk Acceptance and Deterministic Acceptance. |
| **Expanded Auto** | Routine Auto plus enrolled standing policies for credentials, financial, production, destructive cleanup, and broad resource access. |

## Rules

- Standing authorization never exceeds configured resource, financial, security, or operational limits.
- Historical Missions are never retroactively accepted when a mode is enabled.
- Switching to Manual immediately prevents new automated decisions.
- Settings persist across managed restarts in control-plane SQLite.
- Financial and production execution stay disabled until independently qualified adapters exist.
- Credentials remain opaque to the model; purpose-bound Vault references only.
- Emergency STOP returns to Manual, revokes expanded domain policies, and stops Global Autopilot when on.

## Control Center

Automation & Permissions → Expanded Autonomy Mode.

## Related

- [ADR 0056](adr/0056-expanded-autonomy-mode.md)
- Risk Acceptance, Deterministic Acceptance, Developer Autonomy, Global Autopilot, Capability Broker, SafetyPolicy
