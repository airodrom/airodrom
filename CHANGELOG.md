# Changelog

## October 9, 2026 — operations and recovery

Version unchanged (1.0.0-rc.1).

- Settled host turns (`process_state='idle'` with verified termination) no longer hold maintenance admission closed. Ambiguous runs still block it ([ADR 0033](docs/adr/0033-host-idle-run-settlement.md)).
- Readable `status`, `start`, `stop`, `doctor` and `admission status`, with a single next action; `--json` output is unchanged.
- Menu bar shows the mark with a status dot, adds Service, MCP and Last recovery rows, and adds Run Diagnostics and Review Maintenance.
- Claude Code job results persist, sanitized and owner-scoped, and appear in Control Center → Workers.

## 1.0.0-rc.1 — October 5, 2026 — private candidate

- Include opaque candidate/ContextPack identity migration, scoped erasure and current-authority restore/replay safeguards from the qualified private source.
- Prepare history-free source distribution, explicit package allowlists, dependency/license/SBOM review and deterministic archive checksums.
- Add public security/privacy, installation, development, runtime, governance and contribution documentation; issue/PR forms and pinned CI gates.
- Keep operator state and historical private evidence excluded. Keep `private: true`, production unactivated and publication owner-controlled.
- Preserve SDK 1.0.0, Kernel 1.2.0 and legacy MCP identity. Record optional/unqualified external runtime and physical/provider-retention limits.

Fresh candidate evidence is in [FRESH-VALIDATION.md](docs/FRESH-VALIDATION.md). No public stable release is implied by the preceding private package version.
