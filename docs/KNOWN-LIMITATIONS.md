# Known limitations

## Developer Memory V1 / Hindsight (2026-10-12)

- Hosted `candidate.yml` remains `disabled_manually` (owner fast-track / local-first policy). Not a PR #74 change; enablement requires owner approval. Remote `main` currently has no required status checks/rulesets.
- PR #74 merged to `main` (`bc927eb`). Live owner installation cutover remains separately gated.
- Feature flags default **off**. Source implementation does not activate on the owner live install, LaunchAgents, or personal-memory stores.
- Evidence class for `tests/developer-memory-v1.test.js` is **MOCKED CONTRACT PASS** (HTTP shapes, worktree identity, host-bound auth, Mission prefetch, host-verified destructive approval, Control Center layer metrics).
- Disposable **REAL LOCAL HINDSIGHT PASS** completed against `ghcr.io/vectorize-io/hindsight:0.10.2` + local Ollama (`qwen2.5-coder:14b`) on loopback only; container torn down after smoke. **Not OWNER INSTALLATION VERIFIED**. No cloud fallback.
- Control Center Overview/Memory show animated layer usage bars against **reference soft** capacities; private memory text is never rendered in those meters.
- No Hindsight daemon is launched by Airodrom. Agent plugins remain disabled.
- Destructive suppress/delete require control-plane-authenticated minting of single-use `operatorApprovalId`. Caller `operatorApproved: true` is rejected. Stale prefetch cache cannot survive task repository identity change. Host task resolver binds repository identity; caller-supplied bank IDs cannot impersonate.
- Provider delete is best-effort; suppression remains authoritative until confirmed. Forensic erasure is never claimed.
- Retrieved developer-memory text is untrusted evidence (`authority: false`) and cannot grant tools or rewrite Personal Memory.

## Context & Personal Memory V2 contracts (2026-10-11)

- ChatGPT calls such as `personal_memory_search({query, limit})`, `personal_memory_recent({limit})`, and `memory_search({query, limit})` previously failed closed with `invalid_tool_arguments` because broker `validKeys` rejected optional `limit` and required `domain` for recent. Current source accepts those shapes with bounded `limit` (1–20) and default `domain=personal` for recent/search execution. Extra keys remain denied.
- `project_list({})` returning `items: []` on a task without `projectId` is expected scope behavior, not a Personal Memory outage.
- Synthetic fixture acceptance (`tests/context-memory-v2-acceptance.test.js`, `tests/memory-tool-contracts-v2.test.js`) is not live owner-store verification. Installed runtime may still predate this tip until authorized cutover.
- Worker ContextPacks remain host-assembled and bounded; OpenCode never receives unrestricted Personal Memory database access.
- Forgotten/superseded rows are logically suppressed from active retrieval and FTS; physical/forensic erasure is not claimed.

## Runtime identity / MCP package skew (2026-10-11)

- MCP `service_status` historically used the service id `pi_bridge` for the Airodrom control plane. That name is retained as a compatibility alias; the canonical id is `airodrom_control_plane` (label **Airodrom Control Service**). Default `service_health` inventory omits the duplicate alias. Seeing `pi_bridge` in ChatGPT does **not** mean a standalone Pi Bridge is running.
- `service_status` previously rejected LaunchAgent labels (`local.airodrom.*`) as invalid arguments. Current source accepts only the allowlisted Airodrom agents (status-only; no start/stop/restart).
- `process_list(filter="airodrom")` previously returned zero because the executable basename is `node`. Current source matches safe `product` tags.
- `process_status` may previously report `running: false` when a full `ps` table miss/truncation omitted a live PID. Current source uses targeted `ps -p` and a signal probe before claiming stopped.
- ChatGPT `capability_invoke` idempotent replay previously could return a settled `service_status` PID after restart. Current source re-probes `service_status` / `process_status` / `service_health` on replay.
- Local npm `airodrom` may still resolve to a prior install tree while LaunchAgent/desktop-login runs a newer install. Relink/cutover of the npm package is an owner-gated live activation step; it is not implied by a source merge.
- Post-reboot verifier can race owned-start admission resume (first receipt FAIL while `awaiting_owned_start_resume`, later PASS). Prefer timestamped receipts over an older canonical `post-reboot-receipt.json` when both exist.

## Local usable release (2026-10-10)

The installed local application on macOS arm64 meets [Final Product Consolidation V1](FINAL-PRODUCT-CONSOLIDATION-V1.md) daily-use criteria. That does **not** authorize public binary distribution, WhatsApp production messaging, Automatic Acceptance, or Claude external conversation.

Remaining items are **optional or owner-gated**, not daily-use blockers: login service supervision (draft #36), DeepSeek reserve (draft #37), selective operations-recovery cherry-picks from draft #38 (whole tip would regress Everyday menu UX), Calendar/Drive API enablement, approved web search, native packaging foundation, and clean-machine notarized distribution.

## Distribution / publication baseline

This candidate remains without a notarized public application package. macOS arm64 is the freshly tested host. Installed runtime qualification requires private operator pins and exact dependency closure; other operating systems are unqualified. No production provider activation or public Work port was exercised for public release.

Work is optional and live-unqualified. Claude Code needs host qualification. Cursor governed execution is experimental and denied. Generic Cloud is unsupported. DeepSeek stays disabled/auth_required. An agent CLI wrapper does not establish a vendor or OS sandbox guarantee, exclusive network egress or universal hard cancellation.

Logical erasure does not prove forensic deletion of physical media, WAL/free pages, backups, swap, unmanaged exports or provider copies. Unknown legacy origins and unclassified stores remain unavailable. Source installation does not automatically migrate real user data. Restore needs independently current authority; raw old-backup substitution is unsupported.

Secret patterns and dependency advisory databases cannot prove the absence of every unknown secret or vulnerability. License inventory describes observed upstream terms and preserves notices; it is not a legal ownership opinion. GitHub Private Vulnerability Reporting is the sole confidential vulnerability channel; the owner must enable/verify it immediately upon public visibility switch. If unavailable, reporters wait and keep sensitive details private. This publication step is not a pre-publication hardening blocker.

## Live Agent Observatory V1

- Continuous filesystem watching is unavailable; file create/modify/delete evidence is host-measured after the worker turn.
- OpenCode mid-run streams expose tool names only — not arguments, file contents, or model reasoning.
- Diff panels are Mission-scoped and size-capped; out-of-scope paths never appear.
- Empty activity panes show "Detailed activity unavailable." instead of synthetic progress.
- Installing Observatory into a running service requires an owner-authorized restart; `live_cutover_authorized` remains false until then.

## WhatsApp Inbound V1 / Meta live connection

- Source implementation exists on `feat/whatsapp-inbound-v1` (feature impl `5e2574bd0ca340e5f56bdda11a608553e61c36b0` as of 2026-10-09; later binding-readiness commits may tip the branch). PR [#44](https://github.com/airodrom/airodrom/pull/44) remains open and stacked on PR #43; **not merged**, **not SHIPPED IN SOURCE on main**, **not ACTIVE/DEPLOYED**.
- Webhook remains loopback-bound (`127.0.0.1`). `public_ingress` is forced false; ordinary configure cannot enable it. Webhook-only ingress prep (`scripts/whatsapp-webhook-ingress-prep.cjs`) writes cloudflared plans without starting tunnels; ChatGPT MCP stdio tunnel is unsuitable.
- Focused fixture evidence: `tests/whatsapp-inbound-v1.test.js` **13/13** (challenge, HMAC, dedupe, allowlist, lifecycle, readiness, Graph discovery mocks, ingress prep). Fixture success is not live Meta delivery proof.
- Meta App ID `1625559252697626` publicly resolves as app name `Airodrom`. Business Portfolio, WABA ID, Phone Number ID, publication status, webhook subscription and granted permissions are **unknown** without an authorized Graph credential (OAuthException 104 on protected reads). Do not invent those identifiers.
- Operator Vault currently has **zero** active `whatsapp`-purpose references. Binding interface ready (`airodrom secret put whatsapp` ×3 + configure refs); plaintext values were not available to store in the binding session.
- Inbound text never auto-dispatches Missions and never grants authority. Send/reply capabilities remain inactive policy categories.
- See [WhatsApp Inbound V1](WHATSAPP-INBOUND-V1.md), [V1.1](WHATSAPP-INBOUND-V1.1.md), [Meta live connection](META-WHATSAPP-LIVE-CONNECTION-V1.md) and [ADR 0038](adr/0038-whatsapp-inbound-v1.md).

## Development Sessions / local-first batch merge

- Source on `feat/local-first-batch-merge-v1` (feature impl `7c2217e127140e3d25fd3511e59cc4bab4e978c7` as of 2026-10-09; later docs-sync commits may tip the branch). **Not pushed**, **not merged**, **not SHIPPED IN SOURCE on main**, **not ACTIVE** as the default operator workflow until installed from main.
- Focused evidence: `tests/development-session-v1.test.js` **9/9**. Fixture success is not live multi-Mission qualification on a production checkout.
- Auto push, auto merge and hosted CI auto-dispatch remain fail-closed. Prepare Daily Integration never pushes or merges.
- Feature-branch hosted CI remains gated to `main` + `workflow_dispatch` in `candidate.yml`; repository-required checks are not bypassed.
- Standing merge authorization remains **INACTIVE**.
- See [LOCAL-FIRST-BATCH-MERGE-V1.md](LOCAL-FIRST-BATCH-MERGE-V1.md) and [ADR 0039](adr/0039-local-first-batch-merge.md).

## Grounded Assistant Accuracy V1

- **SHIPPED + INSTALLED** on `airodrom-grounded-accuracy-fe918cc` (main ancestry through `fe918cc`). Host Mission count grounding covers active/current/completed/historical/retained vocabulary only; it does not invent Settled/Failed filters in Conversation prose.
- Operator screening permits authorized Development Session metadata shapes; unknown `session <token>` forms and Cookie/assignment secrets remain denied.

## Conversation UX Bugfix V1

- **SHIPPED + INSTALLED** on `airodrom-conversation-ux-bugfix-52e1003` (main merge `52e1003`). Start-new / Continue / refresh session isolation and Claude-unavailable Qwen fallback are Control Center UX only; ConversationEngine session `{new:true}` behavior is unchanged.
- Claude conversation remains WAIT / OFF until independently qualified. No API-key or subscription workaround.
- See [CONVERSATION-UX-BUGFIX-V1.md](CONVERSATION-UX-BUGFIX-V1.md).

## Notion documentation ownership

- Canonical Airodrom Notion hub is Projects → Airodrom (`3f4593eead74818bb339d302719256a4`). Historical Pi Bridge hub must not parent new Airodrom milestone pages.
- Publisher rules in `config/notion-documentation-v1.json` / `src/notion-documentation-routing.js` fail closed without the verified hub and refuse Pi Bridge parents.
- Documentation sync alone never means MERGED IN SOURCE, INSTALLED LOCALLY, LIVE VERIFIED, or PUBLIC ACTIVATION.

## Control Center UI recovery

- Premium atmosphere/theme/nav mounts were missing from `origin/main` HTML despite Product Experience V2 docs and local preimage assets (2026-10-08). Recovery lives on `feat/control-center-ui-recovery-v1` — **not merged**, **not SHIPPED on main**, **not ACTIVE** in the installed service until authorized cutover.
- Focused UI evidence: atmosphere + control-center-ui + connection-status + live-observatory **20/20**. Static browser proof is not authenticated live Activation.
- See [CONTROL-CENTER-UI-RECOVERY-V1.md](CONTROL-CENTER-UI-RECOVERY-V1.md).

## WhatsApp (daily integration reconcile)

- Source tip reconciled from `feat/whatsapp-inbound-v1` @ `0ad82f1` into this daily candidate: inbound, Conversations V1, production-connection HOLD.
- Meta dashboard webhook evidence (test) remains the verified live proof; phone-originated delivery still pending.
- Conversations V1: allowlisted → ConversationEngine/Qwen; Memory retrieval off; outbound drafts pending; Cloud API send hard OFF. See [Conversations V1](WHATSAPP-CONVERSATIONS-V1.md), [ADR 0041](adr/0041-whatsapp-conversations-v1.md).
- Production Connection V1 / Meta policy gate: exact proposed production use (WhatsApp as the primary channel for Airodrom’s general-purpose personal AI) is **prohibited** under Meta’s published AI Providers terms except where Meta is legally required to permit it. **Production messaging remains HOLD.** Do not bypass via branding, routing, alternate numbers, or account arrangements. See [Production Connection V1](WHATSAPP-PRODUCTION-CONNECTION-V1.md), [ADR 0042](adr/0042-whatsapp-production-connection-v1.md).
- Outbound sending and WhatsApp-triggered Mission execution remain disabled.
- Distinctions: source integration on this branch ≠ local service activation ≠ Meta dashboard proof ≠ production readiness.
