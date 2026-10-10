# Daily Integration — WhatsApp Gate (2026-10-09)

Local integration checkpoint notes. Not a main merge. Not production activation.

## Exact integration identity

| Field | Value |
| --- | --- |
| Branch | `integ/daily-candidate-v1-20261009` |
| Prior tip | `eb6e7ee` |
| WhatsApp tip merged | `0ad82f1` (`feat/whatsapp-inbound-v1`) |
| Also present | Automatic Acceptance (`b6b522d` ancestry), Development Sessions (`7846bfc`), Control Center UI recovery (`5e9aa9f`) |
| Operator checkout | Protected (`main` dirty; not used for this work) |
| Push / GitHub Actions | Not triggered by this Mission |

## Status distinctions

| Layer | State |
| --- | --- |
| Source integration (this branch) | WhatsApp tip reconciled into daily candidate |
| Local service activation | Operator-controlled; not claimed by this doc |
| Meta dashboard webhook proof | Prior test-WABA verification preserved (not re-proven here) |
| Production readiness | **Not ready** — policy HOLD / prohibited |

## WhatsApp source completeness

Included from WhatsApp tip:

- Inbound webhook, Vault onboarding, Meta binding/readiness docs  
- Conversations V1 (allowlisted → ConversationEngine/Qwen; Memory off; outbound drafts; send OFF)  
- Production Connection V1 prerequisites + stable HTTPS `--production` ingress prep  

ADR numbering on this integ branch: Conversations **0041**, Production Connection **0042** (feature branch retains 0039/0040; collision with local-first ADR 0039).

## Meta policy eligibility verdict

**PROHIBITED** (default) for the exact proposed production use:

> Use an authorized WhatsApp Business number as the **primary** channel for Airodrom’s **general-purpose personal AI** conversation (grounded Qwen replies).

Under Meta’s published AI Providers terms / pricing docs (2026), general-purpose AI assistants as primary WhatsApp Business Platform functionality are only permitted where Meta is legally required to permit that use.  

**Production messaging remains HOLD.**  
Written Meta/legal clarification is required before treating any exemption as available.  
Do **not** bypass via branding, routing, alternate phone numbers, or account arrangements.

## Pending production requirements (owner-only)

1. Accept or challenge the prohibited verdict with written clarification if claiming an exemption  
2. Confirm App Dashboard Development/Live mode  
3. Confirm Business Manager verification status  
4. Register a **dedicated** production phone via official Meta process (no personal migration without approval)  
5. Provision stable DNS + named tunnel (`whatsapp-webhook-ingress-prep.cjs --production`); forbid trycloudflare  
6. Keep outbound OFF; keep Mission auto-dispatch OFF  
7. Only after eligibility clears: one allowlisted production phone test  

## Outbound / Missions

Both remain disabled.

## Related PRs (unchanged; not merged by this Mission)

- #43 Automatic Acceptance  
- #44 WhatsApp Inbound (remote tip may lag local `0ad82f1`)  
