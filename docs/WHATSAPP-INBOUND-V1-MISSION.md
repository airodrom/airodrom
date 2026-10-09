# WhatsApp Inbound V1 — Mission status

## Status (2026-10-09)

| Field | Value |
|-------|-------|
| Branch | `feat/whatsapp-inbound-v1` |
| Feature impl SHA | `5e2574bd0ca340e5f56bdda11a608553e61c36b0` |
| Docs sync | Later local commit on same branch; verify with `git rev-parse HEAD` |
| PR | [#44](https://github.com/airodrom/airodrom/pull/44) open, stacked on `feat/cursor-exec-auto-acceptance-v1` (#43) |
| State | **Implementation in source (feature branch)** — not merged to `main`, not SHIPPED IN SOURCE on main, not ACTIVE/DEPLOYED |
| Focused tests | `tests/whatsapp-inbound-v1.test.js` **10/10** |
| Public ingress | Inactive |

Remote PR head may lag local commits until an authorized push. Do not treat PR head alone as the latest local evidence.

## Boundary

- Official WhatsApp Business Cloud API inbound only; personal WhatsApp history unsupported.
- Capabilities declared: `whatsapp_read`, `whatsapp_send`, `whatsapp_reply` (send/reply gated; not live-qualified).
- Loopback `GET`/`POST /webhooks/whatsapp` with verify-token challenge and raw-body HMAC.
- Durable allowlisted inbox; lifecycle Received → Verified → Stored → Available.
- **No** Mission auto-dispatch; **no** public webhook activation without separate owner authorization.

## Operational docs

- [WHATSAPP-INBOUND-V1.md](WHATSAPP-INBOUND-V1.md)
- [WHATSAPP-INBOUND-V1.1.md](WHATSAPP-INBOUND-V1.1.md)
- [META-WHATSAPP-LIVE-CONNECTION-V1.md](META-WHATSAPP-LIVE-CONNECTION-V1.md)
- [ADR 0038](adr/0038-whatsapp-inbound-v1.md)
- Limitations: [KNOWN-LIMITATIONS.md](KNOWN-LIMITATIONS.md)

## Next action

1. Bind Vault `whatsapp` secrets (verify token, app secret, Graph credential).
2. Record WABA ID and Phone Number ID from Meta console / authorized Graph.
3. Owner-authorize dedicated HTTPS callback for `/webhooks/whatsapp` only.
4. Subscribe Meta `messages`; run one allowlisted live message test.
5. Merge only under daily-integration / standing-merge rules (currently inactive).
