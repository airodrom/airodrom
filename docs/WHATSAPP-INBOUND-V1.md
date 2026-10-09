# WhatsApp Inbound V1

Host-owned official WhatsApp Business Cloud inbound for Airodrom. Messages are untrusted data. They never grant authority or auto-dispatch Missions.

## Surfaces

| Path | Auth | Purpose |
|------|------|---------|
| `GET /webhooks/whatsapp` | `hub.verify_token` | Meta subscription challenge (loopback Host only) |
| `POST /webhooks/whatsapp` | `X-Hub-Signature-256` over raw body | Inbound text + delivery statuses |
| `GET /api/assistant/whatsapp/inbound` | Operator bearer | Status (no secret values) |
| `GET /api/assistant/whatsapp/inbox` | Operator bearer | Durable inbox page |
| `GET /api/assistant/whatsapp/statuses` | Operator bearer | Observed message statuses |
| `POST /api/assistant/whatsapp/inbound/configure` | Operator bearer | Enable/allowlist/Vault refs |

Public ingress, tunnels and production Meta webhook activation require separate owner authorization. `public_ingress` remains `false`.

## Configuration

Operator confirmation required. Prefer Vault references (`verify_token_reference`, `app_secret_reference`, purpose `whatsapp`). Optional allowlist of numeric sender IDs (empty allowlist accepts any verified sender). Default state is disabled.

## Boundaries

- Text messages only; non-text ignored
- Message-id deduplication
- Unauthorized senders retained as `unauthorized_sender`
- Control Center Connectors shows inbound state and recent retained excerpts
- Future WhatsApp-to-Airodrom actions require approved bounded Mission templates

See [ADR 0038](adr/0038-whatsapp-inbound-v1.md).
