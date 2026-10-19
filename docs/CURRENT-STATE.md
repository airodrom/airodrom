# Current state (2026-10-10)

## ChatGPT handoff remote v8 verification closeout (2026-10-18)

- Genuine Mission `chatgpt_handoff_remote_20261018_v8` / `42272706-…` remains historical: worker claimed an edit, host observed **no** filesystem mutation (`PENDING\n`), then evaluator JSON failed (`gateway_json_required`). Extra-LF and wrong-worktree hypotheses are disproven for v8.
- Source repair: extract embedded evaluator JSON; when host verification already failed, do not mask settlement as `EVALUATION_UNAVAILABLE`; skip evaluator for empty edit mutations after host `expected_changes` failure.
- Exact-byte contract and diagnostics: [CHATGPT-HANDOFF-V8-VERIFICATION.md](CHATGPT-HANDOFF-V8-VERIFICATION.md). Fresh ChatGPT request id required for genuine remote Acceptance; host OpenCode acceptance is tracked separately after merge/install.
- Protected operator checkout `~/code/airodrom` and draft PR #148 remain untouched.

## Cognitive Mission Router V1 — SOURCE IMPLEMENTATION, RELEASE HOLD (2026-10-18)

- Implemented over ZeroSetupWork, Developer Autonomy, OpenCode and existing Mission machinery; [ADR 0057](adr/0057-cognitive-mission-router.md).
- Four strict contracts, scoped read-only planning, content integrity, deterministic routing, standing caller delegation, bounded Cursor approval and durable evidence.
- Real local OpenCode/Qwen planning plus bounded execution verified in an isolated disposable fixture; host checks and termination passed, Acceptance pending. Cursor fixture coverage is not paid-worker acceptance.
- Not merged or installed. Required regression/security gates and independent authority review remain release gates; pristine-main regressions must not be presented as passing.
- PR #150 includes #149's diagnostic changes without commit ancestry; preserve #148 independently. Merge #150 first only when its gates pass, then the router; no duplicate merge of #149 is needed once superseded.
- Operator instructions and limitations: [COGNITIVE-MISSION-ROUTER-V1.md](COGNITIVE-MISSION-ROUTER-V1.md). Older entries below are historical and do not establish today's installed state.

## Unified Autonomous Development V1 — SOURCE IMPLEMENTATION, PR PENDING (2026-10-12)

- **Branch:** `feat/unified-autonomous-development-v1` (fresh worktree from `origin/main` `079eee9`, which is also the installed service)
- **Engineering verdict:** PASS WITH KNOWN LIMITATIONS — IMPLEMENTED + TESTED (`npm run test:unified` 42/42, hardening/typecheck/verify/package gates local); OpenCode path LIVE VERIFIED (self-repair proof: parent `3d44a1df` → corrective `3eb871e9`, bytes `626574610a`); Cursor LIVE UNQUALIFIED (`cursor_credential_file_unavailable`, containment PROVEN, zero paid runs)
- **Not merged / not installed / not restarted:** live service unchanged; merge + controlled cutover remain owner actions; rollback `079eee9`
- **Owner acceptance:** HOLD until install and the fresh disposable Self-Repair Acceptance run
- Evidence: [UNIFIED-AUTONOMOUS-DEVELOPMENT-V1.md](UNIFIED-AUTONOMOUS-DEVELOPMENT-V1.md), [ADR 0051](adr/0051-unified-autonomous-development.md)

## Continuous Autonomous Execution V1 — SOURCE IMPLEMENTATION (2026-10-12)

- **Branch:** `feat/continuous-autonomous-execution-v1` (isolated worktree from post-#78 `origin/main` `d0f3ee6`)
- **Extends:** Goal Planner (ADR 0047) with durable authorize/pause/resume/stop, claims, and Mission-path scheduler (ADR 0048)
- **Not merged / not installed / not activated:** live service, LaunchAgents, credentials and Production mutation unchanged
- Evidence: [CONTINUOUS-AUTONOMOUS-EXECUTION-V1.md](CONTINUOUS-AUTONOMOUS-EXECUTION-V1.md), [ADR 0048](adr/0048-continuous-autonomous-execution.md)

## Autonomous Reliability & Intelligence V1 — MERGED SOURCE (2026-10-12)

- **PR:** [#78](https://github.com/airodrom/airodrom/pull/78) **MERGED** @ `d0f3ee660e88639f282b3aea14c9f59239dda8f6` after Repository Health Qualification V1 ([#79](https://github.com/airodrom/airodrom/pull/79))
- **Preserved health invariants:** Mission tick busy-gate while admission closed; durable-wait settlement; synthetic fixture disposal ≠ real termination; fail-closed production shutdown
- **Not installed / not activated:** Developer Memory off; Hindsight unactivated by that PR; live installation unchanged until separate cutover
- Evidence: [AUTONOMOUS-RELIABILITY-V1.md](AUTONOMOUS-RELIABILITY-V1.md), [ADR 0047](adr/0047-autonomous-reliability-intelligence.md)

## Menu Status & WhatsApp Connection Closeout V1 — LOCAL IMPLEMENTATION (2026-10-10)

- **Branch:** `feat/menu-status-whatsapp-closeout` (isolated worktree from `origin/main` `f6e13ca`)
- **Menu:** historical Mission review backlog no longer forces gold icon; only pending protected Approvals do
- **WhatsApp:** test WABA path remains; production HOLD; host eligibility `prohibited` for general-purpose personal AI assistant use
- **Not** pushed / merged / installed over tip `airodrom-ux-v4-1105659`
- Evidence: [MENU-STATUS-WHATSAPP-CLOSEOUT-V1.md](MENU-STATUS-WHATSAPP-CLOSEOUT-V1.md). Operator checkout preserved.

## Control Center & Premium macOS Experience V4 — SHIPPED + INSTALLED (2026-10-10)

- **PR:** [#67](https://github.com/airodrom/airodrom/pull/67) **MERGED**
- **Merge on `origin/main`:** `11056596024b7f8847bbc509bbb33f6f764fd58f`
- **Feature tip:** `2e7ed21380a3462c66614ab027a023ee4ba76f3f`
- **Installed:** `…/airodrom-ux-v4/install/airodrom-ux-v4-1105659` (`1.0.1-rc.1`) — Control / OpenCode 2.0.25 / Memory / Provider Ready
- **Menu V4:** CFBundleVersion **4** · full-logo status gradients (no status disk) · section header `Mission`
- **Startup:** `local.airodrom.desktop-login` (WorkingDirectory → V4 tip); legacy `local.pi-chatgpt-bridge*` remain disabled
- **Live Mission presentation:** Active **0** · Needs review **45** · Failed **20** (historical review not shown as active)
- **Backup/rollback:** `~/.airodrom/backups/macos-ux-v4-20261010T233213Z` (prior `airodrom-menu-v3-1cff95d`)
- **Authority:** Automatic Acceptance OFF · WhatsApp HOLD · operator checkout preserved
- Evidence: [CONTROL-CENTER-MACOS-UX-V4.md](CONTROL-CENTER-MACOS-UX-V4.md).

## macOS Desktop Activation V1 — SHIPPED + INSTALLED (2026-10-10)

- **PR:** [#65](https://github.com/airodrom/airodrom/pull/65) **MERGED**
- **Merge on `origin/main`:** `1cff95d478838ad9b088ae27b1a67b22ff941ec1`
- **Installed:** `…/airodrom-menu-v3/install/airodrom-menu-v3-1cff95d` (`1.0.1-rc.1`) — Control / OpenCode 2.0.25 / Memory / Provider Ready
- **Menu V3:** CFBundleVersion **3** · live-only Active Mission · historical review Missions not shown as active
- **Startup:** `local.airodrom.desktop-login` (RunAtLoad, no KeepAlive) starts Ollama, owned Control Plane, then menu; legacy `local.pi-chatgpt-bridge*` remain disabled; PR #36 not merged
- **Backup/rollback:** `~/.airodrom/backups/macos-desktop-activation-v1-20261010T225226Z` (prior source `…/airodrom-whatsapp-verify-safe-879daa3`)
- **Acceptance:** login rehearsal (drain/stop → desktop-login start) · single local-service · Control Center opens · Qwen probe OK · Memory Ready · Automatic Acceptance OFF · WhatsApp HOLD
- Evidence: [MACOS-DESKTOP-ACTIVATION-V1.md](MACOS-DESKTOP-ACTIVATION-V1.md). Operator checkout preserved.

## Final Product Consolidation V1 — RELEASE CRITERIA MET (2026-10-10)

Local daily-use Airodrom is **finished** against the consolidation stop line. See [FINAL-PRODUCT-CONSOLIDATION-V1.md](FINAL-PRODUCT-CONSOLIDATION-V1.md).

- **`origin/main` (docs consolidation):** `21db75b624fb84cef947544f7f121a75c6a7c170` · desktop activation follow-on `1cff95d`
- **Installed:** `airodrom-menu-v3-1cff95d` (`1.0.1-rc.1`) — Control / OpenCode 2.0.25 / Memory / Provider Ready · Menu V3
- **Menu helper:** Premium Menu V3 with Conversation + Development Session + System Health deep links
- **Automatic Acceptance:** OFF · **WhatsApp production:** HOLD · **Public activation:** OFF
- **Operator checkout** `~/code/airodrom`: protected dirty; not the release source
- **Essential blockers for local use:** none · optional future: draft PRs #36–#38 (do not merge #38 wholesale), Claude WAIT, packaging roadmap

No new feature milestone was invented for this consolidation. Live status observation only; unchanged focused suites were not re-executed.

## WhatsApp Verify Token Staged Rotation — SHIPPED + INSTALLED (2026-10-10)

- **PR:** [#62](https://github.com/airodrom/airodrom/pull/62) **MERGED**
- **Feature tip:** `02067eba651b74abe057a13b801da6217a327afd` · security tip `e31d1c9` (explicit owner commit only; GET never finalizes)
- **Merge on `origin/main`:** `879daa38e759b3e7c616d6575f04fae8f60a148e`
- **Installed:** `…/airodrom-whatsapp-verify-token-safe-rotation/install/airodrom-whatsapp-verify-safe-879daa3` (runtime from main `879daa3`; docs ship adds shipped-status pack file — see PR for allowlist)
- **Backup/rollback:** `…/airodrom-whatsapp-verify-token-safe-rotation/backup/pre-whatsapp-verify-safe-20261010T205019Z` (prior source `…/airodrom-conversation-ux-bugfix-52e1003`)
- **Migration:** `staged_verify_token_reference` / `staged_verify_expires_at` present; staging idle; verify/app-secret/access Keychain refs bound and resolvable
- **Live:** Control Healthy · admission open · test tunnel retargeted · prepared callback refreshed · public ingress OFF · outbound OFF · auto-Mission OFF · production HOLD · Meta Verify **owner-pending** (no token staged by installer)
- Evidence: [WHATSAPP-VERIFY-TOKEN-STAGED-ROTATION-SHIPPED.md](WHATSAPP-VERIFY-TOKEN-STAGED-ROTATION-SHIPPED.md), ADR 0045. Operator checkout preserved.

## Conversation UX Bugfix V1 — SHIPPED + INSTALLED (2026-10-10)

- **PR:** [#60](https://github.com/airodrom/airodrom/pull/60) **MERGED**
- **Feature tip:** `3a37c40898251b060a5390ca52f2db79ad5188f0`
- **Merge on `origin/main`:** `52e1003caa64b6f7f2660b7650006c324ce1ccbc`
- **Installed:** `…/airodrom-conversation-ux-bugfix/install/airodrom-conversation-ux-bugfix-52e1003` (npm pack 372 files; tarball SHA-256 `8d0d3a9e932ba1866edda9ca5679f49e4e9bc135d58adba04a77f74bd7255743`)
- **Backup/rollback:** `…/airodrom-conversation-ux-bugfix/backup/pre-conversation-ux-bugfix-20261010T193433Z` (prior source `…/airodrom-grounded-accuracy-fe918cc`)
- **Live:** Control/OpenCode/Memory/Provider Ready · Start new / pending-new refresh / distinct send / Continue previous / Claude unavailable→Qwen verified · missions **71** · personal_memories **6** · Automatic Acceptance OFF · WhatsApp HOLD
- Evidence: [CONVERSATION-UX-BUGFIX-V1.md](CONVERSATION-UX-BUGFIX-V1.md). Operator checkout preserved.

## Git Repository Cleanup V1 (2026-10-10)

- Deleted **49** remote branches whose tips were fully ancestral to `origin/main` with no open PR.
- Removed **34** clean, merged, unused Git worktrees.
- **Retained open drafts:** [#36](https://github.com/airodrom/airodrom/pull/36), [#37](https://github.com/airodrom/airodrom/pull/37), [#38](https://github.com/airodrom/airodrom/pull/38).
- **Protected:** operator checkout `~/code/airodrom`; active DS `feat/ds-continue-session-v1`; install `airodrom-grounded-accuracy-fe918cc` (unchanged, Healthy).
- **Review required (preserved):** `fix/opencode-pin-replacement-requalify`, WhatsApp local tip `581a30f`, and other unique/dirty worktrees listed in [GIT-REPOSITORY-CLEANUP-V1.md](GIT-REPOSITORY-CLEANUP-V1.md).
- No PRs closed this Mission; no force-push; no CI dispatch; no service restart.

## Grounded Assistant Accuracy V1 — SHIPPED + INSTALLED (2026-10-10)

- **PRs:** [#56](https://github.com/airodrom/airodrom/pull/56) (feature) · [#57](https://github.com/airodrom/airodrom/pull/57) (release package allowlist) **MERGED**
- **Feature tip:** `2ef5ba8418cdc8a66e4322e85407064b9e2e504d` (same tree as expected `2e18107`; commit message cleaned of editor attribution)
- **Merge on `origin/main`:** `fe918ccae9053c70bf9b6c9dfedfe5f9027590b1` (allowlist; includes feature merge `350a8e5`)
- **Installed:** `…/airodrom-grounded-accuracy/install/airodrom-grounded-accuracy-fe918cc` (npm pack 371 files; tarball SHA-256 `0296c83012bf2df46e931e679d648c1dabae5913cc48971eac92b5ed7d66697b`)
- **Backup/rollback:** `…/airodrom-grounded-accuracy/backup/pre-grounded-accuracy-20261010T185313Z` (prior source `…/airodrom-everyday-ux-5e23731`)
- **Live:** Control/OpenCode/Memory/Provider Ready · Qwen `ollama/qwen3-coder:30b` reported host-verified **active=0** / **current=62** distinctly · Development Session metadata `feat/ds-continue-session-v1` / `PR_OPEN` · credential chat → Vault (not model) · personal Memory consent (`memory_id_count≥1`) · Mission activity unchanged · Automatic Acceptance OFF · WhatsApp HOLD
- Evidence: [GROUNDED-ASSISTANT-ACCURACY-V1.md](GROUNDED-ASSISTANT-ACCURACY-V1.md), ADR 0044. Operator checkout preserved.

## Everyday Personal AI UX V1 — SHIPPED + INSTALLED (2026-10-10)

- **PR:** [#54](https://github.com/airodrom/airodrom/pull/54) **MERGED**
- **Feature tip:** `0142ab9066eed974ece96eeb0eb228d21395a6d1`
- **Merge on `origin/main`:** `5e23731121d95822255dbef0c257b34d77afb24f`
- **Installed:** `…/airodrom-everyday-ux/install/airodrom-everyday-ux-5e23731` (npm pack 367 files; archive SHA-256 `82df832e9d09365d871db9e899a6bb45cd6f53cf0a9c2d28c45a1fd1f3a145bd`)
- **Backup/rollback:** `~/.airodrom/backups/everyday-ux-v1-20261010T181626Z` (prior source `…/airodrom-ds-continue-c701289`)
- **Live:** Control/OpenCode/Memory/Provider Ready · Conversation model/continue/Memory consent markers served · atmosphere 200 · menu helper rebuilt with deep links · Qwen marker `everyday-ux-ship-ok` · Automatic Acceptance OFF · WhatsApp HOLD
- Evidence: [EVERYDAY-PERSONAL-AI-UX-V1.md](EVERYDAY-PERSONAL-AI-UX-V1.md). Operator checkout preserved.

## Coding Reliability & Auto-Acceptance V1 (COMPLETED + RUNTIME RECONCILED)

- OpenCode `safeText` no longer treats display path/URL redaction mutation as `opencode_sensitive_context`; ordinary JS comments/regex admitted; secrets and sensitive absolute paths remain denied.
- Live Mission `2c57a4e7-c906-4b5f-9590-61242e6b6f82` completed via host risk Automatic Acceptance (operator preference opt-in, then restored OFF).
- Branch `fix/coding-reliability-auto-acceptance` @ `a6ee3e3` (+ closeout commit). Evidence: [CODING-RELIABILITY-AUTO-ACCEPTANCE-V1.md](CODING-RELIABILITY-AUTO-ACCEPTANCE-V1.md).
- **Runtime source:** canonical install `…/install/airodrom-coding-reliability-a6ee3e3` (not the proof worktree). Healthy · admission open.
- Historical failed Mission `668a177e-…` preserved. Operator checkout untouched. Memories/Missions preserved.

## Shipped source

- **PR:** [#46](https://github.com/airodrom/airodrom/pull/46) **MERGED**
- **Hotfix source:** `1c6fb24308998ea28ec07c91db764f10ceafb3bc`
- **`origin/main` merge:** `14ee5ab21ea348982bfc762cc57d5d6bd1b4620f`
- **Package:** `1.0.1-rc.1` — [INSTALL-HOTFIX-V1.0.1.md](INSTALL-HOTFIX-V1.0.1.md)

## Installed release (running)

- **Root:** `~/Documents/Codex/2026-10-10/airodrom-menu-v3/install/airodrom-menu-v3-1cff95d`
- **Health:** Ready — managed local service healthy; admission open
- **Includes:** Premium Menu V3 + desktop-login startup on `1cff95d` (ancestry includes WhatsApp verify-token `879daa3`)
- **Prior WhatsApp verify install:** `…/airodrom-whatsapp-verify-token-safe-rotation/install/airodrom-whatsapp-verify-safe-879daa3` (retained; backup `macos-desktop-activation-v1-20261010T225226Z`)
- **Manual patches required:** No

## Distinctions

| Claim | State |
| --- | --- |
| MERGED IN SOURCE (V1.0.1) | Yes |
| INSTALLED LOCALLY (V1.0.1) | Yes |
| LIVE VERIFIED (V1.0.1) | Yes |
| PRODUCTION HOLD | WhatsApp / Meta AI |

## Operator checkout

`~/code/airodrom` remains protected and dirty; it was not the install source.

## Lifecycle & Package Closeout V1 (2026-10-10)

- Root cause: shipped package omitted lifecycle admission module, so durable `stopping` survived upgrade.
- Fix on branch `fix/lifecycle-package-closeout` (local): ship `service-lifecycle.js` + `run-settlement.js`, reconcile orphaned stopping on new writer ownership, complete package allowlist.
- Live `1.0.1-rc.1` service not restarted; remains Healthy. Evidence: [LIFECYCLE-PACKAGE-CLOSEOUT-V1.md](LIFECYCLE-PACKAGE-CLOSEOUT-V1.md).

## Lifecycle closeout — SHIPPED + INSTALLED (2026-10-10)

- **PR:** [#47](https://github.com/airodrom/airodrom/pull/47) **MERGED**
- **`origin/main`:** `f28e8ca17e26297d49bfe6dcb25d6f232e3c93a3`
- **Installed:** `…/install/airodrom-lifecycle-f28e8ca` · admission **open** · prior_state **stopping** reconciled to epoch `4d5e0893…`
- **Preservation:** missions 62 · personal_memories 6 · pins unchanged
- **Backup:** `~/.airodrom/backups/lifecycle-closeout-20261010T163020Z`

## Autonomous Self-Development V1 (LOCAL)

- Development Sessions Control Center summary panel: `public/development-sessions-panel.js` (OpenCode Mission `eea8d18d-…` draft + host independent verification repair).
- Branch `feat/dev-sessions-summary-v1` worktree under Documents/Codex (operator checkout untouched).
- Focused contract: `tests/development-session-summary-v1.test.js` via registered task `development-session-summary-v1`.
- Local-first: no push / no per-Mission PR / Automatic Acceptance OFF.

## Continue Development Session V1 — SHIPPED + INSTALLED (2026-10-10)

- **PR:** [#52](https://github.com/airodrom/airodrom/pull/52) **MERGED**
- **Feature tip:** `06e80cff21e694546224d629ed0f7101ffcaf772`
- **Merge on `origin/main`:** `c7012899ed5e5be43d5708cd01f5311d3225bb3c`
- **Installed:** `…/airodrom-ds-continue/install/airodrom-ds-continue-c701289` (npm pack 366 files; dual archive SHA-256 `8761d2b00bb11840e84098c5524ed322bdc7410de05f9ce48136311c98c8afac`)
- **Backup/rollback:** `~/.airodrom/backups/ds-continue-v1-20261010T180123Z` (prior source `…/airodrom-self-dev-v1/install/airodrom-self-dev-af5fce8`)
- **Live:** Control/OpenCode/Memory/Provider Ready · `/development-sessions-panel.js` HTTP 200 with Continue Development Session · host APIs `resolve` / `observe-git` / `native-status` · no invented `/continue` · Automatic Acceptance OFF · WhatsApp HOLD
- OpenCode draft Mission `79a170b2-…` (cancelled) · host settlement `a286ca1d-…` settled · Development Session `2eb98c6a-…`
- Operator checkout preserved.

## Self-Development Reliability V1.1 — SHIPPED + INSTALLED (2026-10-10)

- **PRs:** [#49](https://github.com/airodrom/airodrom/pull/49) (feature) · [#50](https://github.com/airodrom/airodrom/pull/50) (package allowlist `connection-status.js`)
- **Merge on `origin/main`:** `61d0b0d8fbabfed70532751f7ca713d3d082c17d` (contains tip `af5fce8021b52038c7ee18c99c6f02d4069fdd1b`)
- **Installed:** `…/airodrom-self-dev-v1/install/airodrom-self-dev-af5fce8` from npm pack (366 files; archive SHA-256 `753227615d5c942312b25c8e091d98bb25de5fa530ca694365ea896bb0c604cd`)
- **Backup/rollback:** `~/.airodrom/backups/self-dev-v11-20261010T174215Z` (prior source `…/airodrom-coding-reliability-a6ee3e3`)
- **Live:** Control/OpenCode/Memory/Provider Ready · panel `/development-sessions-panel.js` HTTP 200 · hub coding admission `sourceContextSensitive=false` · timeout 120000 · Automatic Acceptance OFF · WhatsApp HOLD
- Evidence: [SELF-DEVELOPMENT-RELIABILITY-V1.1.md](SELF-DEVELOPMENT-RELIABILITY-V1.1.md). Operator checkout preserved.

## WhatsApp verify-token staged rotation — see SHIPPED + INSTALLED above

Owner Meta test callback verification remains pending: stage in owner TTY → Meta Verify/Save → explicit `commit-verify-token` (or `rollback-verify-token`).

## Developer Autonomy V1 (in progress on feature branch)

Standing per-repository enrollment and short-lived Mission grants are implemented on `feat/developer-autonomy-v1`. Not installed on the live service until an owner-accepted revision.
