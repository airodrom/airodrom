# Meta WhatsApp Live Connection V1

Operator checklist for the first real Meta → Airodrom webhook delivery. Builds on [WhatsApp Inbound V1.1](WHATSAPP-INBOUND-V1.1.md).

## Discovery (non-secret)

| Field | Result |
|-------|--------|
| Meta App ID | `1625559252697626` |
| App name (public Graph) | `Airodrom` |
| Business Portfolio ID | `1791528208560099` |
| WABA ID | Unknown — Graph returns OAuthException 104 without access token |
| Phone Number ID | Unknown — same prerequisite |
| App publication | Unknown without authorized Graph / Meta console |
| Webhook subscription | Forced inactive in product until owner authorization |
| Permissions granted | Not readable without token |
| Business verification | Not observed; confirm in Meta Business Manager |

**Precise Graph prerequisite:** OAuthException 104 — an authorized Graph credential (app/user/system-user) that can read the Business Portfolio, owned WhatsApp Business Accounts, phone numbers, and app subscriptions. Public app `id`/`name` alone is insufficient.

Vault disposition check (operator machine): `whatsapp` purpose active references = **0**. Bind secrets before Graph discovery or live webhook verification can proceed.

## Credential binding

Use existing Keychain Vault purpose `whatsapp` (never arguments, logs, Git, or docs):

```text
airodrom secret put whatsapp   # verify token
airodrom secret put whatsapp   # app secret
airodrom secret put whatsapp   # Graph / system-user access token
```

Then bind opaque references via `POST /api/assistant/whatsapp/inbound/configure` fields:

- `verify_token_reference`
- `app_secret_reference`
- `access_token_reference`

Do not rotate existing credentials without explicit authorization. Status APIs report bound/unbound only.

## HTTPS callback (prepared, inactive)

Smallest secure path:

1. Public HTTPS terminator (dedicated tunnel or reverse proxy).
2. Forward **only** `GET|POST /webhooks/whatsapp` to `127.0.0.1:<control-port>`.
3. Keep `/api/*`, MCP, Memory, Mission, and Control Center off the public hostname.

Do **not** reuse the ChatGPT MCP tunnel (`scripts/macos/mcp-tunnel.cjs`) — it targets MCP stdio, not Meta webhooks.

Prepare without activating:

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

## Real message test (blocked until public callback authorized)

After owner-authorized public ingress:

1. Send one allowlisted WhatsApp text to the bound number.
2. Expect lifecycle Received → Verified → Stored → Available.
3. Confirm Control Center inbox row.
4. Confirm Mission count unchanged; no Qwen/OpenCode auto-dispatch.

## APIs

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/assistant/whatsapp/live-connection` | Full readiness report (no secrets) |
| POST | `/api/assistant/whatsapp/inbound/discovery` | Record non-secret discovery |
| POST | `/api/assistant/whatsapp/inbound/prepare-callback` | Store candidate HTTPS URL |
| POST | `/api/assistant/whatsapp/inbound/configure` | Bind refs / Meta IDs |
