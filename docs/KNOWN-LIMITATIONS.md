# Known limitations

This candidate is source-only and unactivated. macOS arm64 is the freshly tested host. Installed runtime qualification requires private operator pins and exact dependency closure; other operating systems are unqualified. No production provider, service lifecycle or external Work port was exercised for public release.

Work is optional and live-unqualified. Claude Code needs host qualification. Cursor governed execution is experimental and denied. Generic Cloud is unsupported. DeepSeek stays disabled/auth_required. An agent CLI wrapper does not establish a vendor or OS sandbox guarantee, exclusive network egress or universal hard cancellation.

Logical erasure does not prove forensic deletion of physical media, WAL/free pages, backups, swap, unmanaged exports or provider copies. Unknown legacy origins and unclassified stores remain unavailable. Source installation does not automatically migrate real user data. Restore needs independently current authority; raw old-backup substitution is unsupported.

Secret patterns and dependency advisory databases cannot prove the absence of every unknown secret or vulnerability. License inventory describes observed upstream terms and preserves notices; it is not a legal ownership opinion. GitHub Private Vulnerability Reporting is the sole confidential vulnerability channel; the owner must enable/verify it immediately upon public visibility switch. If unavailable, reporters wait and keep sensitive details private. This publication step is not a pre-publication hardening blocker.

## Live Agent Observatory V1

- Continuous filesystem watching is unavailable; file create/modify/delete evidence is host-measured after the worker turn.
- OpenCode mid-run streams expose tool names only — not arguments, file contents, or model reasoning.
- Diff panels are Mission-scoped and size-capped; out-of-scope paths never appear.
- Empty activity panes show "Detailed activity unavailable." instead of synthetic progress.
- Installing Observatory into a running service requires an owner-authorized restart; `live_cutover_authorized` remains false until then.

## WhatsApp
- Meta dashboard webhook tests can succeed (HMAC-verified HTTP 200) and still be stored as `unauthorized_sender` when the sample sender is outside the allowlist. That preserves sender authorization; it is not a webhook failure. Normal phone-originated allowlisted delivery remains separately pending.
- WhatsApp Connectors status reflects inbound readiness separately from outbound. Outbound remains unavailable. Inbound Meta delivery stays **Not yet verified** until a Meta-origin allowlisted message is confirmed; local/HMAC probes do not count as Meta delivery.
 Inbound V1 / Meta live connection

- Source implementation exists on `feat/whatsapp-inbound-v1` (tip includes credential onboarding + Graph WABA-hint fallback; verify with `git rev-parse HEAD`). PR [#44](https://github.com/airodrom/airodrom/pull/44) remains open and stacked on PR #43; **not merged**, **not SHIPPED IN SOURCE on main**, **not ACTIVE/DEPLOYED**.
- Webhook remains loopback-bound (`127.0.0.1`). `public_ingress` is forced false; ordinary configure cannot enable it. Webhook-only ingress prep (`scripts/whatsapp-webhook-ingress-prep.cjs`) writes cloudflared plans (path-only + `httpHostHeader`) without starting tunnels; ChatGPT MCP stdio tunnel is unsuitable. Final Connection wrote a placeholder-host plan only; Control Center / Memory / MCP / Mission stay off the public hostname by design.
- Hybrid install defect repaired (2026-10-09): running `cli-global-runtime` webhook handlers must call inbound `challenge`/`ingest` (not stale `verifyChallenge`/`receive`). After authorized service cutover, wrong verify token returns HTTP 400. Local Vault-HMAC ingest reaches inbox with Mission auto-dispatch off — still not Meta-delivered live proof.
- Focused fixture evidence: `tests/whatsapp-inbound-v1.test.js` **18/18** (challenge, HMAC, dedupe, allowlist, lifecycle, readiness, Graph discovery mocks, credential onboarding, WABA-hint fallback, ingress prep, test-environment preservation, preferred test phone). Fixture / local signed ingest success is not live Meta delivery proof.
- Meta App ID `1625559252697626` publicly resolves as app name `Airodrom`. Production and test WABA/phone are distinct slots (`active_environment`). Production WABA `29094507813569086` is preserved; Meta test WABA `28756456347344989` / Phone Number ID `1330971766772548` is selected via `airodrom whatsapp use-test` without overwriting production. Vault Graph token currently reads both. Portfolio `owned_whatsapp_business_accounts` may still refuse without `business_management`; use `airodrom whatsapp discover <WABA_ID>`.
- App Secret reconciliation (2026-10-09): active `app_secret` slot had been EAA-shaped; a previously stored hex32 purpose=`whatsapp` Vault ref validated via Meta `client_credentials` and was rebound as the sole app-secret reference (verify + Graph tokens preserved). Graph app callback registration + `messages` field subscription succeeded against the live trycloudflare callback. META DASHBOARD WEBHOOK VERIFIED still needs the owner to click Meta’s **Test** on `messages` (no Meta sample POST observed yet).
- Webhook verify-token rotation: `airodrom whatsapp rotate-verify-token` (interactive TTY) generates a new token, replaces only that Vault slot, prints it once for Meta Configuration, and preserves App Secret + Graph access token. Do not log or commit the displayed value.
- Credential onboarding: `airodrom whatsapp bind` (labeled hidden Vault capture + automatic opaque configure). Live install reports Vault `whatsapp` refs active and Graph-ready; no rebind required for discovery. Public ingress remains OFF.
- Status display: control-plane `safeValue` omits parent key `credentials`; WhatsApp status uses `binding` + `*_bound` metadata (and vault readiness fallback) so bound slots are not misreported as missing while Graph remains authorized.
- Inbound text never auto-dispatches Missions and never grants authority. Send/reply capabilities remain inactive policy categories.
- Conversations V1 (source): allowlisted inbox messages may queue into ConversationEngine (`whatsapp` channel, Memory retrieval off). Replies create **pending** outbound drafts only. Cloud API `send` remains hard OFF. Phone-originated delivery and production activation are still pending. See [Conversations V1](WHATSAPP-CONVERSATIONS-V1.md) and [ADR 0039](adr/0039-whatsapp-conversations-v1.md).
- See [WhatsApp Inbound V1](WHATSAPP-INBOUND-V1.md), [V1.1](WHATSAPP-INBOUND-V1.1.md), [Meta live connection](META-WHATSAPP-LIVE-CONNECTION-V1.md) and [ADR 0038](adr/0038-whatsapp-inbound-v1.md).
- Global CLI WhatsApp shell commands require `npm run install:local` from a package that includes WhatsApp routing **and** `src/whatsapp-meta-graph.js`. Incomplete hybrid installs that omit the Graph module fail with `Cannot find module './whatsapp-meta-graph'`. Linking only an older checkout yields `Unknown command` even when the feature branch exists in another worktree.
