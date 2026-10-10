# WhatsApp Conversations V1

Allowlisted personal AI over the verified WhatsApp Business inbound path. Reuses webhook, Vault, ConversationEngine (Qwen), Memory retention boundaries, and Control Center. Does not rebuild inbound.

## Status matrix (truthful)

| Layer | State |
| --- | --- |
| Source implemented | **Yes** on `feat/whatsapp-inbound-v1` (Conversations V1 modules + tests) |
| Meta dashboard webhook verified | **Yes** (prior milestone; HMAC + allowlist rejection of sample sender) |
| Phone-originated delivery | **Not yet verified** — test WABA must not be assumed to prove production phone delivery |
| Outbound Cloud API send | **OFF** until separate operator authorization |
| Production activation / App Review | **Not authorized** in this Mission |

## Flow

```
WhatsApp sender (allowlisted)
  → POST /webhooks/whatsapp (HMAC)
  → durable inbox (ADR 0038)
  → WhatsAppConversations queue
  → ConversationEngine channel=whatsapp, include_memory=false
  → grounded Qwen reply (when local model READY)
  → outbound draft state=pending (never auto-sent)
```

Unauthorized senders remain stored as `unauthorized_sender` and never enter conversation.

## Governed AI limits

Allowed initially:

- Simple conversational replies
- Read-only Airodrom/WhatsApp status questions (untrusted status snapshot only)
- Grounded summaries of authorized conversation context

Refused from WhatsApp text:

- Shell / repository mutation / credentials / deploy / merge / PR operations
- Unrestricted Memory retrieval
- Mission dispatch or authority bypass

## Outbound

`WhatsAppOutbound` provides allowlisted drafts, operator authorize/cancel, rate limits, idempotency keys, and audit events. `send()` always throws until a future authorized activation flips the hard OFF path. Auto-outbound is false.

## Memory separation

| Store | Role |
| --- | --- |
| `cp_whatsapp_inbox` / conversation turns | WhatsApp message + reply history |
| Personal / governed Memory V2 | Not retrieved for WhatsApp turns (`include_memory: false`) |
| Missions | Never created from inbound |
| Outbound drafts | Separate approval queue; not delivery |

Engine conversation turns remain subject to existing erasure/content controls.

## Control Center

View **WhatsApp Conversations** shows authorized senders, recent turns (state, intent, worker identity, errors), pending outbound approvals, and delivery/activation status. Connectors continues to show inbound Meta evidence.

## Meta platform prerequisites (not performed here)

- App publication / Live + App Review for production-scale messaging
- Production phone registration (distinct from test WABA phone)
- Business verification where Advanced Access requires it
- Permissions: `whatsapp_business_messaging`, `whatsapp_business_management`
- 24-hour customer service window; template messages outside the window
- Meta AI assistant / messaging policy compliance for the chosen product use
- Do not publish the app or register a production number without owner authorization

## Activation steps remaining

1. Confirm allowlisted personal number(s) on the active WABA environment
2. Verify phone-originated webhook delivery (not only Meta dashboard test)
3. Ensure local Qwen conversation qualification is READY (`/status` / Models)
4. Operator-authorize outbound send capability (separate change) before any Cloud API delivery
5. Comply with Meta conversation-window and template rules before production traffic

## Tests

`node --test tests/whatsapp-conversations-v1.test.js` — authorization, isolation, grounded reply, Memory off, outbound approval/send-off, idempotency, status context.

## Related

- [ADR 0039](adr/0039-whatsapp-conversations-v1.md)
- [WhatsApp Inbound V1](WHATSAPP-INBOUND-V1.md)
- [Meta live connection](META-WHATSAPP-LIVE-CONNECTION-V1.md)
