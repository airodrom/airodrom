# WhatsApp Production Connection V1

Preparation for authorized production WhatsApp Cloud API connectivity. Reuses inbound webhook and Conversations V1. Does **not** activate production messaging.

## Status (2026-10-09)

| Item | State |
| --- | --- |
| Source preparation | **Complete** on `feat/whatsapp-inbound-v1` |
| Test environment | **Preserved** (WABA `28756456347344989`, phone `1330971766772548`) |
| Meta dashboard webhook (test) | **Verified** (prior milestone) |
| Production WABA ID | `29094507813569086` (bound in config; phone ID still null) |
| Production phone registered | **No** |
| App publication (Live vs Development) | **Owner must confirm** in App Dashboard (`unknown_owner_confirm_in_dashboard`) |
| AI assistant policy eligibility | **HOLD** — see below |
| Outbound send | **OFF** |
| Mission auto-dispatch | **OFF** |
| Production messaging | **HOLD** — unauthorized production messaging forbidden |

Canonical config: [`config/whatsapp-production-connection-v1.json`](../config/whatsapp-production-connection-v1.json).

## Meta accounts (public IDs only)

| Asset | ID |
| --- | --- |
| Meta App | `1625559252697626` |
| Business portfolio | `1791528208560099` |
| Production WABA | `29094507813569086` |
| Test WABA | `28756456347344989` |
| Test Phone Number ID | `1330971766772548` |
| Production Phone Number ID | *unset — register via official process* |

## 1. App publication

- New apps start in **Development** mode; **Live** is an owner dashboard toggle after development is complete ([App Modes](https://developers.facebook.com/docs/development/build-and-test/app-modes/)).
- For a **direct developer using an owned WABA**, Meta documents that **Standard Access** covers own assets and **Advanced Access / App Review is not required** solely to message on your own WABA ([WhatsApp app review](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/app-review)).
- Advanced Access + App Review **are** required if the app manages **other businesses’** WABAs (Tech Provider / Embedded Signup).
- **Owner-only:** open App Dashboard → confirm current mode (Development/Live) and record it with `app_publication_status` (`development` or `live`). This Mission does not switch Live.

## 2. Production WABA

- Production WABA `29094507813569086` is the preserved production slot; test WABA remains distinct.
- Ownership/status must be confirmed in WhatsApp Manager / Business Manager (Graph may show empty `phone_numbers` until a production number is added).
- Switching Airodrom `active_environment` between `production` and `test` must never overwrite the other slot’s IDs.

## 3. Phone onboarding (official)

Production Cloud API use requires a registered business phone ([registration](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/registration)):

1. Add number to production WABA in WhatsApp Manager  
2. Verify ownership (SMS/voice)  
3. `POST /{PHONE_NUMBER_ID}/register` with `messaging_product=whatsapp` and a 6-digit two-step PIN  
4. Store `production_phone_number_id` in Airodrom  

**Do not** register or migrate an existing personal WhatsApp number without explicit owner approval. Numbers already on consumer WhatsApp generally require deletion/migration paths that can destroy history.

## 4. Business verification

- Not strictly required for own-WABA Standard Access messaging start.  
- Required / strongly coupled to Advanced Access, higher limits, and Official Business Account paths.  
- **Owner-only:** confirm verification status in Business Manager.

## 5. Permissions

Required (already declared): `whatsapp_business_messaging`, `whatsapp_business_management`.  
Webhook: subscribe `messages`; verify with challenge token; POST bodies require `X-Hub-Signature-256`.

## 6–7. AI assistant policy → PRODUCTION HOLD

Official Meta AI Providers documentation (updated Sep 1, 2026) states that “AI Providers” offering **general-purpose AI assistants** are **only permitted** on the WhatsApp Business Platform **where Meta is legally required to permit this use case**, with related Terms updates (Jan 15 / Sep 23, 2026) and pricing category `general_purpose_ai` / `AI_BOT`.

Airodrom’s Conversations V1 goal (personal AI conversation as the WhatsApp experience) is treated as **policy-unresolved / HOLD** for production messaging.  
**Do not bypass.** Owner must record an explicit eligibility determination before any production allowlisted test that delivers AI replies over WhatsApp.

Incidental AI inside a non-AI primary business workflow is a different fact pattern; that is **not** claimed here.

## 8–10. Phone / test preservation

- Prepare production phone onboarding through Meta’s official steps only.  
- Personal-number migration: **blocked** without owner approval.  
- Test WABA/phone and verified dashboard webhook evidence remain the active qualification path until HOLD lifts.

## 11–14. Stable HTTPS callback

Ephemeral `*.trycloudflare.com` hostnames are **forbidden for production** long-term operation.

```bash
node scripts/whatsapp-webhook-ingress-prep.cjs \
  --production \
  --hostname hooks.example.com \
  --port <control-port> \
  --write /path/to/private-plan-dir
```

Requirements:

- Named DNS + durable tunnel/proxy (not quick tunnels)  
- Path-only `/webhooks/whatsapp`  
- `httpHostHeader: 127.0.0.1:<port>` loopback Host gate  
- No `/api`, `/mcp`, `/hub`, `/workspace` on the public hostname  
- Vault-backed verify token + app secret; HMAC on POST  
- `public_ingress` remains false until separate owner authorization  

## 15–16. Outbound and Missions

- Outbound Cloud API send remains **hard OFF** until policy eligibility **and** operator authorization.  
- Mission auto-dispatch remains **OFF**.

## 17. Qwen readiness (local, no external messaging)

Pinned conversation model: `ollama/qwen3-coder:30b` (see `model-worker-router`).  
Owner checks `/status` or Control Center Models for **READY** before relying on grounded replies. Fixture suites do not prove live Ollama availability.

## 18. Allowlisted production test procedure

**Not prepared for execution** while AI policy HOLD is active.

When HOLD is lifted by the owner:

1. Production phone registered; sender allowlisted  
2. Stable callback subscribed on production WABA  
3. One phone-originated allowlisted text  
4. Expect: inbox received → conversation turn (if enabled) → Missions unchanged → outbound still OFF unless separately authorized  

## Exact owner-only actions

1. Confirm App Dashboard mode (Development/Live) and record it  
2. Confirm Business Manager verification status for portfolio `1791528208560099`  
3. Record AI policy determination (lift HOLD only if use is permitted)  
4. Choose/approve a **dedicated** production business number (or explicitly approve any migration)  
5. Complete Meta phone add → verify → Cloud API register  
6. Provision **stable** DNS + named tunnel; run ingress prep with `--production`  
7. Point Meta webhook callback at the stable URL; subscribe `messages`  
8. Separately authorize outbound send if ever required  
9. Only then run the single allowlisted production phone test  

## Related

- [ADR 0040](adr/0040-whatsapp-production-connection-v1.md)  
- [Conversations V1](WHATSAPP-CONVERSATIONS-V1.md)  
- [Meta live connection](META-WHATSAPP-LIVE-CONNECTION-V1.md)  
- [Inbound V1](WHATSAPP-INBOUND-V1.md)  
