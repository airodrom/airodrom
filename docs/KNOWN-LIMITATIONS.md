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

## Notion documentation ownership

- Canonical Airodrom Notion hub is Projects → Airodrom (`3f4593eead74818bb339d302719256a4`). Historical Pi Bridge hub must not parent new Airodrom milestone pages.
- Publisher rules in `config/notion-documentation-v1.json` / `src/notion-documentation-routing.js` fail closed without the verified hub and refuse Pi Bridge parents.
- Documentation sync alone never means MERGED IN SOURCE, INSTALLED LOCALLY, LIVE VERIFIED, or PUBLIC ACTIVATION.

## Control Center UI recovery

- Premium atmosphere/theme/nav mounts were missing from `origin/main` HTML despite Product Experience V2 docs and local preimage assets (2026-10-08). Recovery lives on `feat/control-center-ui-recovery-v1` — **not merged**, **not SHIPPED on main**, **not ACTIVE** in the installed service until authorized cutover.
- Focused UI evidence: atmosphere + control-center-ui + connection-status + live-observatory **20/20**. Static browser proof is not authenticated live Activation.
- See [CONTROL-CENTER-UI-RECOVERY-V1.md](CONTROL-CENTER-UI-RECOVERY-V1.md).
