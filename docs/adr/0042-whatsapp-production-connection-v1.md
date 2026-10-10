# ADR 0042: WhatsApp Production Connection V1

- Status: Proposed
- Integration note: Numbered ADR 0042 on `integ/daily-candidate-v1-20261009`; feature branch `feat/whatsapp-inbound-v1` retains ADR 0042.
- Date: 2026-10-09
- Owner: Operator request
- Review: Pending
- Affected contracts and components: WhatsApp inbound environment slots, webhook ingress prep, Conversations/outbound activation gates, operator documentation
- Related decisions: [0038 inbound](0038-whatsapp-inbound-v1.md), [0039 conversations](0039-whatsapp-conversations-v1.md)

## Context and problem

Test-WABA Meta dashboard webhook delivery is verified. Production connectivity needs a governed preparation path that records Meta publication, phone registration, business verification, permissions, stable HTTPS routing, and AI-provider policy eligibility — without unauthorized production messaging or personal-number migration.

## Decision

Add preparation contract `config/whatsapp-production-connection-v1.json` and documentation that:

1. Preserves distinct production (`29094507813569086`) and test (`28756456347344989` / `1330971766772548`) slots  
2. Leaves `production_phone_number_id` unset until official Meta registration  
3. Places **production messaging on HOLD** under Meta’s AI Providers / general-purpose assistant restrictions until the owner records eligibility  
4. Forbids ephemeral `*.trycloudflare.com` hostnames for production callback plans (`--production` ingress prep)  
5. Keeps outbound send and Mission auto-dispatch OFF  
6. Does not register phones, switch App Live, or migrate personal WhatsApp numbers in this change  

## Alternatives considered

- Treat Conversations V1 as automatically production-eligible — rejected; Meta AI Providers terms create an unresolved eligibility gate.  
- Reuse trycloudflare for production — rejected; ephemeral hostnames are unsuitable for long-term operation.  
- Auto-register a production phone from Vault — rejected; requires owner number choice and Meta verification codes.

## Authority, privacy and ownership

No production messages are sent. Secrets remain Vault-backed. Public docs carry IDs only. Owner actions (Live toggle, verification, phone choice, HOLD lift) stay outside automation.

## Compatibility and migration

Additive config/docs/script flag. No Kernel bump. Test environment remains the verified path.

## Consequences

Operators have a single checklist for production readiness. Messaging stays blocked by HOLD until policy and phone/callback prerequisites clear.

## Validation and evidence

Focused tests for production HOLD config, test-slot preservation, and rejection of ephemeral production hostnames. Does not claim Live app mode or registered production phone without owner confirmation.

## Rollback

Revert the commit; HOLD config is inert.

## Decision outcome

Proposed pending maintainer review.
