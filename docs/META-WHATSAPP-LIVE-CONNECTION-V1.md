# Meta WhatsApp Live Connection V1

Operator checklist for the first real Meta → Airodrom webhook delivery. Builds on [WhatsApp Inbound V1.1](WHATSAPP-INBOUND-V1.1.md).

## Milestone record (2026-10-09)

| Field | Value |
|-------|-------|
| Development Session | Meta WhatsApp Account Binding & Live Readiness (local worktree) |
| Git branch | `feat/whatsapp-inbound-v1` |
| Actual commit SHA | Feature impl `5e2574bd0ca340e5f56bdda11a608553e61c36b0`; binding readiness is a later local commit on the same branch (verify with `git rev-parse HEAD`; ahead of PR remote) |
| PR | https://github.com/airodrom/airodrom/pull/44 (open; stacked on #43) |
| Implementation status | **In source on feature branch** — not merged; not SHIPPED IN SOURCE on main; not ACTIVE/DEPLOYED |
| Test results | `tests/whatsapp-inbound-v1.test.js` **13/13** |
| Known limitations | Public ingress refused; Vault `whatsapp` refs = 0; WABA/Phone Number ID unknown without Graph token |
| Next action | Operator binds Vault secrets → Graph discovery → owner-authorize HTTPS callback → one allowlisted live message |

## Authorization status (live probe)

| Check | Result |
|-------|--------|
| Public Graph app `1625559252697626` | Resolves as app name `Airodrom` (`graph_access: public_app_only`) |
| Business Portfolio `1791528208560099` | Protected — OAuthException **104** without access token |
| Owned WABA / phone numbers | Not readable until Vault-bound Graph credential |
| App publication / granted permissions | Not readable without token or Meta console |
| Webhook subscription | Forced inactive in product; Meta console not mutated |

**Precise Graph prerequisite:** an authorized Graph credential (app/user/system-user) that can read the Business Portfolio, owned WhatsApp Business Accounts, phone numbers, and app subscriptions. Public app `id`/`name` alone is insufficient.

Product path: `POST /api/assistant/whatsapp/inbound/discover-graph` with `{ "confirmed": true }` uses the Vault-bound access token when present; otherwise records `graph_access: unavailable` without inventing IDs.

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
airodrom whatsapp discover          # only when access token is bound
airodrom whatsapp prepare-callback https://<host>/webhooks/whatsapp
```

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

