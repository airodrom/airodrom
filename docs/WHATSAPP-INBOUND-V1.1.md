# WhatsApp Inbound V1.1 — Meta connection readiness

Builds on [WhatsApp Inbound V1](WHATSAPP-INBOUND-V1.md) and [ADR 0038](adr/0038-whatsapp-inbound-v1.md).

## Known Meta identifiers (non-secret)

| Field | Value |
|-------|-------|
| Meta App ID | `1625559252697626` |
| Business Portfolio ID | `1791528208560099` |
| WhatsApp Business Account ID | Operator/Meta console — not yet bound |
| Phone Number ID | Operator/Meta console — not yet bound |
| App publication status | `unknown` until Meta console / authorized Graph inspection |
| Webhook subscription | Forced `inactive` in product until owner authorization |

Required messaging permissions (Meta Cloud API): `whatsapp_business_messaging`, `whatsapp_business_management`.

Secrets (verify token, app secret) stay in Vault purpose `whatsapp`. Status APIs never return secret values.

## Callback path (prepared, inactive)

- Path: `GET|POST /webhooks/whatsapp`
- TLS required for any public delivery
- Host binding today: loopback `127.0.0.1` only
- Signature: `X-Hub-Signature-256` over raw body
- Verify token challenge on GET
- Max body: 512 KiB
- Durable allowlisted inbox; no Mission auto-dispatch
- `public_ingress` remains `false`; configure refuses enabling it

Public HTTPS URL, tunnel, and Meta webhook subscription require separate owner authorization after local readiness.

## Lifecycle (operator-visible)

Received → Verified → Stored → Available in Inbox

Rejected signatures emit `whatsapp.inbound.rejected` and leave the inbox empty for that payload. Unauthorized senders are stored as `unauthorized_sender` (not available). Duplicates are not re-inserted.

## Activation checklist (exact remaining)

1. Bind Vault verify token + app secret (`whatsapp` purpose).
2. Record WABA ID and Phone Number ID via configure (non-secret IDs).
3. Confirm Meta app publication / WhatsApp product subscription in Meta console.
4. Owner-authorize a TLS public URL that terminates at this host webhook path.
5. Subscribe Meta webhook to that URL with fields `messages` (and statuses as needed).
6. Keep Mission auto-dispatch off.
