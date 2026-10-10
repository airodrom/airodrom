# ADR 0039: WhatsApp Conversations V1

- Status: Proposed
- Date: 2026-10-09
- Owner: Operator request
- Review: Pending
- Affected contracts and components: ConversationEngine channel `whatsapp`, WhatsApp inbound ingest hook, Control Center Conversations view, Memory retention registry, outbound draft queue
- Related decisions: [0038 WhatsApp inbound](0038-whatsapp-inbound-v1.md), [0011 Conversation Engine](0011-conversation-engine-and-intent-routing.md)

## Context and problem

Inbound WhatsApp Business webhooks are verified (Meta dashboard HMAC path) but do not yet produce a governed personal AI conversation. Operators need allowlisted senders to receive grounded Qwen replies without Mission dispatch, unrestricted Memory, or automatic outbound sends.

## Decision

Extend verified inbound with host-owned `WhatsAppConversations` and `WhatsAppOutbound`:

- Allowlisted accepted inbox messages queue into ConversationEngine on channel `whatsapp`
- `include_memory: false` always; WhatsApp thread history may be included separately via `include_history`
- Intents limited to conversation, read-only status, grounded summary; sensitive action language is refused without model call
- Replies draft into `cp_whatsapp_outbound` as `pending` for Control Center approval
- Outbound Cloud API `send` remains hard OFF until separate operator authorization
- Control Center adds **WhatsApp Conversations** for senders, turns, worker identity, pending outbound, errors
- No Mission auto-dispatch; no shell/credential/deploy/merge authority from WhatsApp text

## Alternatives considered

- Auto-send Cloud API replies inside the 24h window — rejected; outbound remains separately governed.
- Route WhatsApp through full personal Memory retrieval — rejected; Memory stays off for this channel in V1.
- Create Missions from inbound text — rejected; preserved from ADR 0038.

## Authority, privacy and ownership

Inbound text remains untrusted. ConversationEngine still has no tools. Outbound credentials stay Vault-backed and unused until send is authorized. Retention registers conversation, turn and outbound tables. Correction/erasure continue through existing Memory and conversation erasure controls for engine turns.

## Compatibility and migration

Additive SQLite tables. ConversationEngine gains `whatsapp` session channel and optional `include_history` independent of Memory. No Kernel version bump. No Meta app publication or production phone registration in this change.

## Consequences

Allowlisted personal conversation is available in source once a qualified local Qwen conversation model is READY. Meta phone-originated delivery and outbound send remain separately gated. Control Center can show pending drafts without delivering them.

## Validation and evidence

Focused fixture suite `tests/whatsapp-conversations-v1.test.js`: sender authorization, sensitive refusal, grounded reply with Memory off, outbound pending/authorize/send-off, idempotency, status context, API boundaries. Does not claim live phone-originated delivery or production outbound.

## Rollback

Revert the branch; tables are inert when conversations remain unused and outbound send stays denied.

## Decision outcome

Proposed pending maintainer review.
