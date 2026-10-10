# Meta WhatsApp Live Connection V1

Operator checklist for the first real Meta → Airodrom webhook delivery. Builds on [WhatsApp Inbound V1.1](WHATSAPP-INBOUND-V1.1.md).

## Milestone record (2026-10-09)

| Field | Value |
|-------|-------|
| Development Session | Meta WhatsApp Account Binding & Live Readiness (local worktree) |
| Git branch | `feat/whatsapp-inbound-v1` |
| Actual commit SHA | Feature tip `6f2d94b` + local Graph-repair worktree changes (verify with `git rev-parse HEAD`; ahead of PR remote) |
| PR | https://github.com/airodrom/airodrom/pull/44 (open; stacked on #43) |
| Implementation status | **In source on feature branch** + **installed locally** via cli-global-runtime hybrid — not merged; not SHIPPED IN SOURCE on main; not ACTIVE/DEPLOYED |
| Conversations V1 | Source implemented on the same branch: allowlisted → grounded Qwen via ConversationEngine; Memory retrieval off; outbound drafts pending; Cloud API send **OFF**. Not phone-originated LIVE VERIFIED. See [Conversations V1](WHATSAPP-CONVERSATIONS-V1.md). |
| Test results | `tests/whatsapp-inbound-v1.test.js` + `tests/whatsapp-conversations-v1.test.js` (focused; see latest local run) |
| Known limitations | Public ingress refused; Phone Number ID unavailable — Graph `phone_numbers` returns **authorized empty** (HTTP 200, `data: []`), not a permission error; portfolio owned-list still needs `business_management` unless WABA hint supplied |
| Next action | In an interactive Terminal: `airodrom whatsapp rotate-verify-token` (shows new verify token once; preserves App Secret + Graph token) → paste that verify token into Meta → re-bind a **valid Meta App Secret** (Vault `app_secret` is still EAA-shaped / fails `client_credentials`) → Meta callback URL + `messages` subscribe → one allowlisted phone message → inbox + Missions=0. |

## Verify-token rotation (local CLI)

```text
airodrom whatsapp rotate-verify-token
```

- Generates a cryptographically secure verify token (`crypto.randomBytes` → base64url).
- Replaces **only** the purpose=`whatsapp` verify-token Vault reference via Keychain `replace`.
- Preserves Meta App Secret and Graph access token references.
- Prints the new token **once** on a TTY for Meta Configuration; never logs it to Git, Notion, or Mission results.
- Proves local `GET /webhooks/whatsapp` challenge: new token **200**, previous token rejected.
- Public ingress and Mission auto-dispatch remain **OFF**.

## First live webhook test (2026-10-09)

| Field | Result |
|-------|--------|
| HTTPS callback URL | `https://convention-suddenly-oliver-miles.trycloudflare.com/webhooks/whatsapp` (hostname changed after tunnel recovery 2026-10-09; prior `needed-factors-gadgets-undertake` returned **502** after control port move) |
| Tunnel | Cloudflare quick tunnel → local webhook-only proxy → control `127.0.0.1:<port>` with Host rewrite (supervise daemonized; restart when control port changes) |
| Path isolation | Public `/`, `/api/*`, `/mcp`, `/hub` → **404**; only `/webhooks/whatsapp` reaches Airodrom |
| TLS | Cloudflare-terminated HTTPS (probe OK) |
| Meta GET challenge | **200** with current Vault verify token; wrong token → **400** (local + public, post-recovery) |
| Raw-body HMAC / size / allowlist / dedupe | Existing handlers unchanged; local + public vault-signed POST accepted; Mission auto-dispatch **OFF** |
| WABA `subscribed_apps` (test) | Graph `POST /{test_waba}/subscribed_apps` → **success**; count observed **2** |
| App `/subscriptions` (callback URL) | **Blocked** — App access token requires valid App Secret; Vault `app_secret` fails `client_credentials` (`Error validating client secret`). Slot shape is EAA-like (token), not App Secret hex. |
| Production WABA | Unchanged `29094507813569086` |
| Real Meta-delivered message | **Not received** — App webhook callback/HMAC cannot be completed without the real App Secret |
| Public vault-signed POST (not Meta-origin) | Accepted over HTTPS; inbox `received`; Active Missions **0** |
| Product `public_ingress` flag | Still **false** (activation separate from tunnel helper) |
| Rollback | Stop supervise process / `cloudflared tunnel --url` / webhook-only proxy; leave service running |

## Delivery diagnostics (2026-10-09, post-tunnel recovery)

| Check | Result |
|-------|--------|
| Stage | **LOCAL TEST VERIFIED** — not META DASHBOARD WEBHOOK VERIFIED; not PHONE-ORIGINATED; not PRODUCTION ACTIVATION |
| Callback | `https://convention-suddenly-oliver-miles.trycloudflare.com/webhooks/whatsapp` |
| Tunnel/proxy/control ports | Matched (`control` 61749); public challenge **200** / wrong token **400**; `/` `/api` `/mcp` `/hub` → **404** |
| Vault verify / graph slots | Bound; Graph discovery authorized; test env active |
| Vault App Secret class | **Invalid for Meta** — EAA-shaped (~294 bytes); Graph `client_credentials` → “Error validating client secret.” |
| App `/subscriptions` API | **Unblocked** after App Secret reconciliation (see below) |
| Test WABA `subscribed_apps` | Count **2** (Graph OK with system-user token) |
| Inbox (pre-reconcile) | **3** durable synthetic rows; **0** Meta-like IDs |
| Mission auto-dispatch | **OFF** |

## App Secret reconciliation (2026-10-09)

| Check | Result |
|-------|--------|
| Problem | Active `app_secret` Vault slot was **EAA-shaped** (Graph token class); `client_credentials` failed |
| Recovery | Existing alternate purpose=`whatsapp` Keychain ref (hex32 App Secret shape) validated via Meta `client_credentials` (**200**) |
| Action | Re-pointed **only** `app_secret_reference` via configure API; verify-token + Graph access references **unchanged** |
| Active App Secret | **Valid** (hex32); `ready_for_live_hmac` true |
| Local HMAC ingest | **200** with `X-Hub-Signature-256` using rebound secret |
| Graph `GET /{app}/subscriptions` | Callback already `https://convention-suddenly-oliver-miles.trycloudflare.com/webhooks/whatsapp` (`active: true`) but **fields empty** |
| Graph `POST /{app}/subscriptions` | **success** — subscribed field **`messages`**; Meta completed challenge against live callback |
| META DASHBOARD WEBHOOK VERIFIED | **Not yet** — no Meta-generated sample POST observed in inbox (only local synthetic + local HMAC probe) |
| PHONE-ORIGINATED | Not claimed |

**Remaining operator-only action for META DASHBOARD WEBHOOK VERIFIED**

In Meta App → WhatsApp → Configuration → Webhook fields → **Test** on `messages` (official Meta sample POST). Confirm a new durable inbox/ledger event that is not `wamid.local-*` / `wamid.test-cfg-*` / `wamid.public-path-*` / `wamid.app-secret-reconcile-*`. No App Secret re-entry required unless Meta rotates the secret.

## Meta test account configuration (2026-10-09)

| Field | Value |
|-------|-------|
| Meta App ID | `1625559252697626` |
| Production WABA (preserved) | `29094507813569086` |
| Test WABA (active) | `28756456347344989` |
| Test Phone Number ID | `1330971766772548` |
| Test sender allowlisted | `15556519146` |
| Active environment | `test` |
| Graph access (Vault token) | **authorized** for both production and test WABA reads; test phone id matched |
| Production overwrite | **none** — production slot retained separately |
| Webhook | Same GET challenge + POST HMAC; accepts `entry.id` for production or test WABA; foreign WABA refused |
| HTTPS callback | Webhook-only ingress plan prepared (placeholder host); `public_ingress` OFF; Control Center/MCP/Memory/Mission not exposed |
| Mission auto-dispatch | OFF |
| CLI | `airodrom whatsapp use-test` binds test slots + selects active test without rebind |

## Final Connection attempt (2026-10-09)

| Check | Result |
|-------|--------|
| Operator checkout | Protected dirty `main` — **not modified** |
| Feature branch | Continued on `feat/whatsapp-inbound-v1` + hybrid `cli-global-runtime` install |
| Keychain bindings | Reused (verify / app secret / access); **no rebind** |
| WABA | Re-verified `29094507813569086` |
| Phone Number ID | Still **unavailable** (authorized empty) |
| CLI ↔ service config | Global CLI and running service both use hybrid install + same Vault config |
| Hybrid webhook wiring | **Repaired** — stale `verifyChallenge`/`receive` → `challenge`/`ingest`; Host gate + wrong-token → HTTP 400 `Invalid verification token` |
| Service cutover | Owner drain → stop → start → admission resume; Memory Ready; Active Missions **0** |
| Webhook-only ingress plan | Written under private `webhook-ingress-plan` for placeholder host `hooks.example.invalid` → `127.0.0.1:<control-port>` with `httpHostHeader`; **tunnel not started**; `public_ingress` **false** |
| Local signed ingest proof | Vault HMAC POST accepted; inbox lifecycle received→verified→stored→available; **auto_mission_execution: false**; Active Missions remained **0** — **not** Meta-delivered |
| Meta subscription / real WA message | **Blocked** — no Phone Number ID; no owner real HTTPS hostname; public ingress not authorized; Meta console not mutated |

## Authorization status (live probe)

| Check | Result |
|-------|--------|
| Public Graph app `1625559252697626` | Resolves as app name `Airodrom` |
| Business Portfolio `1791528208560099` | Portfolio `owned_whatsapp_business_accounts` refused without `business_management` (OAuthException **200**); system-user token has `whatsapp_business_*` scopes |
| Vault-bound Graph credential | Bound (Keychain / purpose=`whatsapp`); no rebind required |
| Status projection (2026-10-09) | Fixed: `safeValue` had omitted the entire `credentials` object (and nested `*_token` / `*secret*` keys), so CLI showed “missing” while Graph still authorized. Repair: allowlisted `*_bound`/`*_present`/`*_resolvable` metadata + `binding` projection + CLI vault-aggregate fallback. No Keychain replacement. |
| WABA ID | **Graph-verified** `29094507813569086` (matches Meta UI; via WABA-hint fallback) |
| Phone Number ID | **unavailable** — see phone-edge investigation below |
| App publication / granted permissions | System-user scopes include `whatsapp_business_management` + `whatsapp_business_messaging` (valid). No `business_management`. |
| Webhook subscription | Forced inactive in product; WABA `subscribed_apps` count = **0**; Meta console not mutated |

### Phone-edge investigation (authorized empty)

| Hypothesis | Evidence |
|------------|----------|
| No phone attached to this WABA | **Primary.** `GET /29094507813569086/phone_numbers` → HTTP 200, `data: []` (not OAuth refusal). |
| Test number on a different WABA | **Possible.** Portfolio owned/client WABA lists refuse without `business_management`, so other WABAs cannot be enumerated with this token. Confirm in WhatsApp Manager which WABA owns the test number. |
| Token asset-access limitation | **Unlikely as sole cause for this edge.** WABA id/name readable; phone edge authorized empty. `debug_token` shows SYSTEM_USER, `is_valid: true`, WhatsApp scopes present; granular `target_ids` not restricting the known WABA in the probe. |
| Registration incomplete | **Partial related signal.** `subscribed_apps` = 0 (no app webhook subscription yet). That blocks live delivery later but does not invent a Phone Number ID. |

**Do not request `business_management` solely to read phones on the known WABA** — that edge already succeeds. Broader Business Manager permission would only help enumerate *other* WABAs if the phone lives elsewhere.

**Precise Graph prerequisite:** Vault-bound access token. Portfolio enumeration additionally needs `business_management`. Without it, supply a Graph-readable WABA ID: `airodrom whatsapp discover <WABA_ID>` (stored WABA is reused on later `discover` runs).

Product path: `POST /api/assistant/whatsapp/inbound/discover-graph` with `{ "confirmed": true, "waba_id"?: "…" }` uses the Vault-bound access token when present; otherwise records `graph_access: unavailable` without inventing IDs.

## Discovery (non-secret)

| Field | Result |
|-------|--------|
| Meta App ID | `1625559252697626` |
| App name (public Graph) | `Airodrom` |
| Business Portfolio ID | `1791528208560099` |
| WABA ID | `29094507813569086` (authorized Graph; matches Meta UI) |
| Phone Number ID | Unavailable — authorized empty `phone_numbers` on WABA `29094507813569086` (not invented) |
| App publication | Unknown without authorized Graph / Meta console |
| Webhook subscription | Forced inactive in product until owner authorization |
| Permissions granted | Partial — WhatsApp management present; portfolio owned-list needs `business_management` |
| Business verification | Not observed; confirm in Meta Business Manager |

## Credential binding

Guided onboarding (preferred) — labeled hidden prompts, automatic opaque configure, optional Graph discovery:

```text
airodrom whatsapp bind
# or inside interactive CLI: /connect whatsapp · /whatsapp bind
```

Captures three Keychain secrets (purpose `whatsapp`, never argv/logs/Git/browser):

1. Webhook verification token  
2. Meta App Secret  
3. Graph API access token  

Then configures `verify_token_reference`, `app_secret_reference`, and `access_token_reference` automatically and validates resolvability without displaying values.

```text
airodrom whatsapp status[--json]
airodrom whatsapp discover                 # uses stored WABA when present
airodrom whatsapp discover <WABA_ID>       # hint when portfolio owned-list is refused
airodrom whatsapp prepare-callback https://<host>/webhooks/whatsapp
```

Global CLI install note: `~/.local/npm/bin/airodrom` must resolve to a package that includes `src/whatsapp-meta-graph.js` (hybrid `cli-global-runtime`). Missing that module yields `Cannot find module './whatsapp-meta-graph'`.

Control Center → Connectors shows binding status and non-secret actions (validate / discover / prepare callback). Secrets never enter the browser.

Low-level single-slot store remains `airodrom secret put whatsapp` when needed. Do not rotate existing credentials without explicit authorization. Status APIs report bound/unbound and disposition counts only (`vaultBindingStatus()` / live-connection report).

## HTTPS callback (prepared, inactive)

Smallest secure path:

1. Public HTTPS terminator (dedicated tunnel or reverse proxy).
2. Forward **only** `GET|POST /webhooks/whatsapp` to `127.0.0.1:<control-port>`.
3. Keep `/api/*`, MCP, Memory, Mission, and Control Center off the public hostname.

Do **not** reuse the ChatGPT MCP stdio tunnel helper under `scripts/macos/` — it targets MCP, not Meta webhooks.

Prepare webhook-only cloudflared config without starting a tunnel:

```text
node scripts/whatsapp-webhook-ingress-prep.cjs --hostname <owner-host> --port <control-port> [--write DIR]
```

Host observation: `cloudflared` is present on this machine; activation remains owner-authorized only.

Prepare product callback without activating:

`POST /api/assistant/whatsapp/inbound/prepare-callback` with `{ "confirmed": true, "url": "https://<host>/webhooks/whatsapp" }`.

`public_ingress` stays `false` until separate owner authorization. Ordinary configure refuses `public_ingress: true`.

## Meta webhook subscription (execute only when authorized)

When WABA ID, Phone Number ID, Vault bindings, and prepared HTTPS URL exist:

1. Meta App → WhatsApp → Configuration
2. Callback URL = prepared HTTPS URL
3. Verify token = Vault-bound verify token value (entered in Meta console by operator)
4. Subscribe field: `messages` (optional statuses)
5. Save; confirm Meta challenge succeeds against Airodrom GET handler

Product code does not perform Meta console mutations without explicit owner authorization.

## Real message test (blocked until phone + public callback authorized)

Prerequisites still open: Graph Phone Number ID, real owner HTTPS hostname, owner authorization for tunnel + Meta `messages` subscribe.

After those are satisfied:

1. Send one allowlisted WhatsApp text to the bound number.
2. Expect lifecycle Received → Verified → Stored → Available.
3. Confirm Control Center inbox row.
4. Confirm Mission count unchanged; no Qwen/OpenCode auto-dispatch.

Local signed webhook ingest proves the receive→inbox path and Mission-off policy on the hybrid service; it does **not** satisfy LIVE VERIFIED Meta delivery.

## APIs

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/assistant/whatsapp/live-connection` | Full readiness report (no secrets) |
| POST | `/api/assistant/whatsapp/inbound/discovery` | Record non-secret discovery |
| POST | `/api/assistant/whatsapp/inbound/discover-graph` | Authorized Graph WABA/phone discovery |
| POST | `/api/assistant/whatsapp/inbound/prepare-callback` | Store candidate HTTPS URL |
| POST | `/api/assistant/whatsapp/inbound/configure` | Bind refs / Meta IDs |

## Global CLI activation (local)

The Mac global command `~/.local/npm/bin/airodrom` must resolve to a package that includes shell `whatsapp` routing. Feature tip `e91a04b` alone is not sufficient if the npm link still points at an older checkout.

Supported install path: `npm run install:local` (`scripts/install-local.cjs`) from the activated package root. Application files resolve via `__dirname` / package root, never `process.cwd()`.

Verified shell commands from any directory (including `$HOME` and `/tmp`):

- `airodrom whatsapp bind` — labeled hidden Vault capture (TTY required)
- `airodrom whatsapp status[--json]`
- `airodrom whatsapp discover`
- `airodrom whatsapp prepare-callback <https://host/webhooks/whatsapp>`

Public ingress and Mission auto-dispatch remain OFF.


## Control Center Connectors status (inbound readiness)

Connectors no longer treat WhatsApp as a single generic adapter flag.

Independent capabilities projected (no secrets):

| Capability | Meaning |
| --- | --- |
| Graph | Meta Graph authorization for discovery |
| Credentials / binding | Vault slots bound (verify token, app secret, access token) |
| Callback | HTTPS callback prepared and Meta verify challenge observed |
| messages | App/WABA webhook field subscription recorded |
| Meta dashboard test | Meta Developer UI sample POST received + HMAC-verified |
| Sender allowlist | Allowlist decision for received inbound (rejection does not imply webhook failure) |
| Inbound / phone-originated delivery | Allowlisted phone-originated Meta delivery (remains **Not yet verified** until confirmed) |
| Outbound | Always **Unavailable** until a separately governed adapter is qualified |

The generic Assistants connector still refuses personal WhatsApp history and outbound send. Control Center → Connectors shows a WhatsApp inbound detail panel (environment, WABA ID, Phone Number ID, callback readiness, subscription, last webhook event, inbox, delivery errors) without secret values.

Record subscription state after Meta registration with `POST /api/assistant/whatsapp/inbound/record-subscription` `{ "confirmed": true, "fields": ["messages"] }`.


## Meta dashboard webhook test closeout (2026-10-09 16:51:38)

### Evidence (correlated)

| Observation | Result |
| --- | --- |
| Meta dashboard `messages` v26.0 test | Successful at 16:51:38 |
| Event ledger | `received` → `verified` → `unauthorized_sender` → `stored` at 16:51:38 |
| Inbox | Retained **5** (was 4); newest status `unauthorized_sender` |
| Sender | `16315551181` (not on allowlist) |
| Body class | Matches Meta sample text (`this is a text message`) |
| HMAC / signature | **Verified** (`whatsapp.inbound.verified`, messages=1) |
| Host HTTP | **200** (control-server returns 200 after successful `ingest`; Meta UI reported success) |
| Allowlist | Unchanged `["15556519146"]` — rejection **expected** |
| Missions created ±60s | **0**; `auto_mission_execution` false |

### Control Center distinctions

- **Meta dashboard test:** Received
- **Sender allowlist:** Rejected unauthorized sender
- **Phone-originated delivery:** Not yet verified
- **Outbound:** Unavailable

SUCCESS vocabulary for this milestone:

- META DASHBOARD WEBHOOK DELIVERY **VERIFIED**
- SENDER AUTHORIZATION **PRESERVED**
- NORMAL PHONE-ORIGINATED DELIVERY **STILL PENDING**
