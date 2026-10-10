# Risk Acceptance activation V1

Status: Activation prep for PR #43. No installed-service restart or merge is authorized by this document alone.

## Operator preference (does not enable silently)

- Control Center Overview: **Automatic Acceptance** card, or Settings & About.
- API: `GET /api/assistant/risk-acceptance` · `POST /api/assistant/risk-acceptance` with `{ "enabled": true, "confirmed": true }`.
- When enabled, **new** eligible local-only public OpenCode WORK Missions receive a host risk mark at create time.
- Historical `awaiting_acceptance` Missions (for example `d7cef62b-…`) stay waiting until `POST /api/assistant/risk-acceptance/authorize` with `{ "mission_id", "request_id", "confirmed": true }` runs a fresh eligibility evaluation.

## Installed-service graft (operator checkout dirty)

Do **not** replace whole dirty files. Operator hashes differ from PR for:

| Path | Note |
| --- | --- |
| `src/control-server.js` | Operator has Gmail/observatory grafts; apply only the risk-acceptance GET/POST route hunks |
| `src/product-observability.js` | Merge `acceptance_config` / acceptance mode fields into operator Observatory build |
| `public/control-hub.js` | Merge Automatic Acceptance card, authorize button, wait classes; keep Live Observatory / Menu V2 |
| `src/mission-service.js` | Add `riskAcceptance` construct/attempt/reconcile + create allowlist keys only |
| `src/gmail-oauth.js` | **Leave operator copy** — PR does not change Gmail |

Copy whole from PR when operator file matches `origin/main`:

- `src/risk-acceptance.js` (new)
- `src/wait-presentation.js` (new)
- `config/wait-presentation-v1.json` (new)
- `config/capability-policy-v2.json` IDE task status/cancel entries
- `config/memory-retention-fields.json` `cp_risk_acceptance*` rows
- `src/capability-devtools.js`, `src/capability-host.js`, `src/apps/capability-connectors.js` when operator equals main

Backup before install: timestamped copies under an operator-chosen backup root; record SHA-256 of each replaced/grafted file; keep rollback list.

## Real OpenCode acceptance proof (authorization required)

1. Enable preference (or per-Mission `risk_auto_acceptance: true`).
2. Create disposable WORK workspace with registered exact_file criteria + verification tasks.
3. Dispatch with OpenCode 2.0.25 / Qwen3 Coder 30B.
4. Expected: running → verifying → automatically accepted → settled → completed.
5. Do not bypass approvals; do not fake Settlement.

## Wait classes

`config/wait-presentation-v1.json` separates execution timeout, worker heartbeat, and acceptance review **presentation**. Approval expiry remains SafetyPolicy-owned and is not extended by this config.
