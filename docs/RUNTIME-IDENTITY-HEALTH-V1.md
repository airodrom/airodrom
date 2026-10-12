# Runtime Identity and Health Reporting V1

## Purpose

Clarify Airodrom’s live identity for operators and ChatGPT MCP consumers, and make process/service health reporting verify PIDs instead of trusting stale values.

## Canonical architecture

| Role | Authority |
| --- | --- |
| Control plane / supervisor | Airodrom `local-service` (managed install) |
| Primary execution runtime | OpenCode |
| Local inference | Ollama (when configured) |
| ChatGPT connector | MCP stdio via managed tunnel → Airodrom MCP client → control plane |
| Login auto-start | LaunchAgent `local.airodrom.desktop-login` |
| Post-reboot verifier | LaunchAgent `local.airodrom.reboot-acceptance` |

There is no separate active Pi Bridge LaunchAgent or worker. Historical storage/path names under `Library/Application Support/Pi Bridge` (when present) are stable macOS integration identities documented in [PI-REMOVAL.md](PI-REMOVAL.md).

## Service naming

- Canonical MCP/service id: `airodrom_control_plane`
- Compatibility alias: `pi_bridge` (same handlers; label remains “Airodrom control plane”)
- Status fields include `identity`, `legacy_service_id`, `pid_source`, and `verification`

## Health probes

1. Prefer a live `bridge.lock` supervisor PID when `kill(pid, 0)` succeeds.
2. Otherwise report the capability-host PID only when that probe succeeds.
3. Never report `running: true` from an unverified historical PID.
4. `process_status` uses the process table, then targeted `ps -p`, then a signal probe before `running: false`.
5. Orchestrator idempotent replay for `service_status`, `process_status`, and `service_health` **re-probes** live state (`refreshed: true`) instead of returning a settled PID snapshot after restart. Mutation capabilities remain once-only.

## Auto-start and admission

Owned-start cold readiness resumes admission after safe reconciliation (`prior_state=stopping` → open when idle). Closed startup (`AIRODROM_START_CLOSED=1`) remains enforced. Reboot acceptance receipts under `~/.airodrom/reboot-acceptance/` are evidence; a failed early verifier receipt must not be overwritten by assumptions.

## Activation

Source merge does not automatically relink the operator npm `airodrom` package or restart the live service. Those remain owner-gated cutover steps.
