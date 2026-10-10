# Changelog

## Unreleased — Installation Hotfix V1.0.1

- Accept optional Gmail OAuth `clientSecretReference` in ControlServer without weakening unknown-key rejection.
- Allowlist `wait-presentation` runtime module/config so clean package installs need no manual overlays.
- Raise installation compatibility minimum to `1.0.1-rc.1`; document reversible upgrade while leaving the healthy V1 install running.

## Unreleased — Integrated Release V1 local activation

- Activated verified package install at `install/airodrom-77724f8`; preserved Memory/Missions; WhatsApp production HOLD unchanged.
- Local install hotfixes: Gmail `clientSecretReference` acceptance; restore `wait-presentation` omitted from package allowlist.

## Unreleased — Integrated Release V1 shipped

- Merged consolidated daily candidate via PR #45 to `origin/main` (`0e5f0a86da1a21526105ebda24984ec309f91897`); release source `77724f83569eadae41727c86b201e433a801f910`.
- Closed superseded feature PRs #43/#44 after inclusion verification. Operator install remains separately authorized; WhatsApp production HOLD unchanged.

## Unreleased — Integrated Release V1 (daily candidate 2026-10-09)

- Prepare one local-first release candidate from `integ/daily-candidate-v1-20261009` with allowlisted source archives, SOURCE/COMPATIBILITY manifests, and reversible install plan (service not replaced).
- Restore WhatsApp inbound credential API routes dropped during daily merge (`validate-credentials`, `bind-credentials`, and related).
- Complete package allowlists for Conversation provider, risk Acceptance, and WhatsApp ADRs 0041/0042; remove ghost ADR paths that broke archive generation.

## Unreleased — Core Contracts & Runtime Consistency V1

- Add versioned core contracts, host-evidence runtime security conformance, and installation compatibility observation without rewriting durable state.
- Expose `/api/product/compatibility`, Control Center System Health rows, and interactive `/compat`.

## Unreleased — Personal AI Channels V1

- Restore `/api/assistant/provider` + ConversationEngine provider revision binding; Control Center Conversation refresh fails soft if provider is unavailable.
- Unify first-party ConversationEngine reliability across Control Center, ChatGPT MCP and the macOS menu.
- Control Center: persistent browser session, scoped history, Memory consent, local-ollama/model identity and Thinking activity.
- macOS menu: Conversation status row and Open Conversation deep-link (`?view=Conversation`).
- Preserve WhatsApp production outbound and automatic Mission execution OFF under Meta policy HOLD.


## 1.0.0-rc.1 — October 5, 2026 — private candidate

- Include opaque candidate/ContextPack identity migration, scoped erasure and current-authority restore/replay safeguards from the qualified private source.
- Prepare history-free source distribution, explicit package allowlists, dependency/license/SBOM review and deterministic archive checksums.
- Add public security/privacy, installation, development, runtime, governance and contribution documentation; issue/PR forms and pinned CI gates.
- Keep operator state and historical private evidence excluded. Keep `private: true`, production unactivated and publication owner-controlled.
- Preserve SDK 1.0.0, Kernel 1.2.0 and legacy MCP identity. Record optional/unqualified external runtime and physical/provider-retention limits.

Fresh candidate evidence is in [FRESH-VALIDATION.md](docs/FRESH-VALIDATION.md). No public stable release is implied by the preceding private package version.
