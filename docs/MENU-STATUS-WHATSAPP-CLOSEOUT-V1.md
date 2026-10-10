# Menu Status & WhatsApp Connection Closeout V1

Presentation-only menu tone correction plus WhatsApp eligibility assessment. No Mission state changes, no mass settlement, no production WhatsApp activation.

**Status:** LOCAL IMPLEMENTATION (branch `feat/menu-status-whatsapp-closeout`) — not pushed, not installed over V4 tip.

## Menu status policy

| Condition | Menu tone | Label |
| --- | --- | --- |
| Pending protected Approvals | `approval` (gold) | ACTION REQUIRED |
| Active execution (`dispatching`/`running`/`verifying`) | `working` | CONNECTED |
| Historical review backlog only | `healthy` | CONNECTED |
| Degraded / unavailable product | `degraded` | DEGRADED |
| Error / stopped | `disconnected` / `stopped` | DISCONNECTED |

Control Center Mission review counts and NEEDS REVIEW menu rows are unchanged. Canonical Mission states are unchanged.

## WhatsApp (installed tip, redacted)

| Check | Observation |
| --- | --- |
| Active environment | test |
| Credentials bound | verify token / app secret / access token bound |
| Messages subscription | active (`messages`) |
| Durable inbox | yes (received + unauthorized_sender retained) |
| Sender allowlist | configured (count observed; values not printed) |
| Meta dashboard test | Received historically |
| Public ingress | off (`public_url` null); prepared trycloudflare callback exists |
| MCP tunnel LaunchAgent | running (not restarted) |
| Outbound | OFF |
| Auto Mission / auto outbound | OFF |
| Production messaging | HOLD |
| Production phone registered | no |
| Host AI policy eligibility | `prohibited` |

## Meta eligibility (official terms)

Intended use — general-purpose personal AI assistant via a Canadian WhatsApp number — is **not** established as permitted:

1. WhatsApp Business Platform Terms require **business/commercial** use, not personal use ([WhatsApp Terms for WhatsApp Business Platform](https://www.whatsapp.com/legal/WhatsApp-Terms-for-WhatsApp-Business-Platform)).
2. Meta AI Provider rules restrict general-purpose AI assistants on the WhatsApp Business Platform except where Meta is legally required to permit that use; Canada is not treated here as such an exception ([AI Providers pricing / terms](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/ai-providers)).
3. Technical test-webhook connectivity ≠ permission for production AI messaging.

**Retain production HOLD.** Prefer authorized channels already in product: Control Center Conversation, native menu Conversation, and (where configured) Slack — not WhatsApp personal-number production activation.

## Evidence

- Focused tests: `tests/connection-status.test.js`, `tests/mission-activity.test.js`, `npm run macos:test-helper`
- Icon exports: `evidence/menu-status-closeout/` (local worktree)

## Out of scope

Push / merge / install · credential rotation · Meta dashboard changes · personal-number registration · Cloudflare tunnel restart · mass Mission accept/cancel/settle
