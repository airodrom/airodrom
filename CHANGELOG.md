## Unreleased — Master Personal AI Completion V1

- Synthetic TestBridge fixtures resume admission after recovery so Memory/Mission suites match managed closed-startup without weakening production gates.
- ChatGPT MCP adds read-only `personal_memory_search` / `personal_memory_get` (ordinary Personal Memory only; writes remain capability-scoped). Surface is 27 tools.
- Unify Mission lifecycle aliases into one authoritative vocabulary (`canonicalize` / `project`); persist canonical states in control-plane and authority stores; treat `paused` as a first-class transition.
- Document Personal Memory erasure layers (suppression, cache invalidation, retention, logical purge) and keep physical/forensic wipe unclaimed.
- Offline always-on qualification tests and bounded Mission Acceptance/restart fixtures; iPhone viewport emulation checks (not physical-device verification).
- Completion matrix and evidence: [MASTER-PERSONAL-AI-COMPLETION-V1.md](docs/MASTER-PERSONAL-AI-COMPLETION-V1.md). WhatsApp remains HOLD. Production tip unchanged.

## Unreleased — macOS Desktop Activation V1 (shipped locally)

## Unreleased — Menu Status & WhatsApp Connection Closeout V1

- Menu tone: historical Mission review backlog stays CONNECTED/healthy; gold ACTION REQUIRED reserved for pending protected Approvals.
- Document WhatsApp test-path status and Meta eligibility HOLD for general-purpose personal AI messaging. See [MENU-STATUS-WHATSAPP-CLOSEOUT-V1.md](docs/MENU-STATUS-WHATSAPP-CLOSEOUT-V1.md).


## Unreleased — Control Center & Premium macOS Experience V4 (shipped locally)

- Merged PR #67 to `origin/main` (`1105659`); installed `airodrom-ux-v4-1105659` with Menu CFBundleVersion **4** and Mission history / Needs review presentation. See [CONTROL-CENTER-MACOS-UX-V4.md](docs/CONTROL-CENTER-MACOS-UX-V4.md).

## Unreleased — Control Center & Premium macOS Experience V4

- Port Mission history + `mission_counts` so Control Center Missions / Overview show Active, Needs review, Failed, Completed, and Settled correctly.
- Menu bar uses full-logo status gradients (healthy / working / approval / degraded / disconnected) instead of a colored status disk; CFBundleVersion **4**.
- Review banner, humanized mission chips, and restrained CSS polish; Acceptance not blocked by transient transport failures.
- See [CONTROL-CENTER-MACOS-UX-V4.md](docs/CONTROL-CENTER-MACOS-UX-V4.md). Local branch only — not installed over Menu V3 tip.


- Record Premium Menu V3 + `local.airodrom.desktop-login` installed on tip `airodrom-menu-v3-1cff95d` (merge `1cff95d` / PR #65). Login rehearsal verified. See [MACOS-DESKTOP-ACTIVATION-V1.md](docs/MACOS-DESKTOP-ACTIVATION-V1.md).

## Unreleased — Premium macOS Menu V3

- Refine the native menu-bar mark (18pt optically padded template A) and replace pale-yellow status wash with a compact warm-gold ACTION REQUIRED indicator.
- Clarify menu hierarchy (System Status / Active Mission / Workers / Memory / Model / Connectors / Actions) and status vocabulary: CONNECTED, DEGRADED, DISCONNECTED, ACTION REQUIRED.
- Feature only live Missions in the Active Mission row; `awaiting_acceptance` / `waiting_for_operator` report as NEEDS REVIEW and never as active work.
- Preserve Everyday UX deep links, service controls and security boundaries. See [PRODUCT-EXPERIENCE-V2.md](docs/PRODUCT-EXPERIENCE-V2.md).
- Optional `local.airodrom.desktop-login` LaunchAgent starts Ollama, the owned Control Plane and the native menu at login without enabling legacy `pi-chatgpt` agents or merging startup PR #36.

## Unreleased — Final Product Consolidation V1

- Document local usable release stop line: installed tip meets daily-use criteria; no essential blockers; optional draft PRs #36–#38 and packaging/Claude remain future work. Protect dirty operator checkout. See [FINAL-PRODUCT-CONSOLIDATION-V1.md](docs/FINAL-PRODUCT-CONSOLIDATION-V1.md).

## Unreleased — WhatsApp verify-token staged rotation

- Staged verify-token recovery: new Vault candidate while current remains valid; webhook GET never finalizes; owner `commit-verify-token` after Meta success; `rollback-verify-token` and TTL discard the candidate. App Secret and Graph token references preserved. Production HOLD / public ingress / outbound unchanged.
- Shipped on `origin/main` via PR #62 (`879daa3`); installed locally as `airodrom-whatsapp-verify-safe-879daa3`. Meta test callback Verify/Save remains owner-controlled. See [WHATSAPP-VERIFY-TOKEN-STAGED-ROTATION-SHIPPED.md](docs/WHATSAPP-VERIFY-TOKEN-STAGED-ROTATION-SHIPPED.md).

## Unreleased — Conversation UX Bugfix V1 shipped and installed

- Merged PR #60 to `origin/main` (`52e1003`); installed `airodrom-conversation-ux-bugfix-52e1003`; live Control Center verifies Start new / pending-new refresh / Continue previous and Claude unavailable→Qwen fallback.

## Unreleased — Conversation UX Bugfix V1

- Start new conversation clears the browser display and skips auto-restoring the latest host browser session across refresh; Continue previous restores the prior session; first send creates a fresh identity.
- Claude is labeled unavailable until qualified; selection keeps Qwen as the working provider with explicit fallback messaging (no activation or subscription workaround).

## Unreleased — Git Repository Cleanup V1

- Delete fully merged unused remote branches and remove clean merged disposable worktrees; retain open draft PRs #36–#38, active Development Session branch, operator checkout, and unique/dirty review worktrees.

## Unreleased — Grounded Assistant Accuracy V1 shipped and installed

- Merged PRs #56/#57 to `origin/main` (`fe918cc`); installed `airodrom-grounded-accuracy-fe918cc`; live Qwen Control Center conversation preserved host-verified active/current Mission distinction and authorized Development Session metadata; credentials stay on the Vault path.

## Unreleased — Grounded Assistant Accuracy V1

- Inject host-verified Mission counts into Conversation and ground delivery text when the model mislabels current as active.
- Permit authorized Development Session id/branch/worktree metadata through operator screening; keep Cookie/assignment session secrets fail-closed for local private conversation.

## Unreleased — Everyday Personal AI UX V1 shipped and installed

- Merged PR #54 to `origin/main` (`5e23731`); installed `airodrom-everyday-ux-5e23731`; live Control Center serves Conversation model/continue/Memory consent, Mission Observatory links, Development Session Continue clarity, and macOS menu deep links.

## Unreleased — Everyday Personal AI UX V1

- Conversation: visible Qwen-default model selection, persistent session continue/new, Memory consent status, honest activity/reconnect; reuse ConversationEngine.
- Missions: clearer active work, worker, verified activity, pending approval, Settlement, Open Observatory.
- Development Sessions: Continue clarity for repository, branch, worktree and next permitted action (no duplicate execution controls).
- macOS Menu V2: Active Missions, Continue Development Session and Open System Health deep links alongside Open Conversation and Control Center.

## Unreleased — Continue Development Session V1 shipped and installed

- Merged PR #52 to `origin/main` (`c701289`); installed `airodrom-ds-continue-c701289`; live Control Center serves Continue Development Session using host `resolve` / `observe-git` / `native-status` (no invented `/continue` route).

## Unreleased — Continue Development Session V1

- Add Continue Development Session action to the Control Center Development Sessions panel: session identity, authorized repository/worktree, last Mission, next permitted action, Observatory execution state; reuse existing session via host resolve; block duplicate active execution.
- OpenCode/Qwen draft Mission `79a170b2-…`; host coding-plan settlement Mission `a286ca1d-…` accepted and settled. Focused contract `development-session-continue-v1`.

## Unreleased — Self-Development Reliability V1.1 shipped and installed

- Merged PRs #49/#50 to `origin/main` (`61d0b0d`); installed `airodrom-self-dev-af5fce8`; live Control Center serves Development Sessions panel; coding admission and 120s timeout active.

## Unreleased — Self-Development Reliability V1.1

- Admit authorized OpenCode coding source for Control Hub JS: host-owned Authorization+identifier neutralization, credential-filename rules that ignore UI prose, 256 KiB staged-file bound; keep real secrets and sensitive paths fail-closed.
- Raise default local OpenCode coding Mission timeout to the existing 120000 ms ceiling (no unlimited timeouts).
- Extend Development Sessions summary and source-context focused contracts; document Mission `d55695c4-…` timeout evidence.

## Unreleased — Autonomous Self-Development V1

- Control Center Development Sessions view shows an evidence-backed Active Session Summary (missions, worker, repository/branch, local changes, focused verification, pending integration, last activity, next permitted action) via `public/development-sessions-panel.js`.

# Changelog

## Unreleased — Coding Reliability & Auto-Acceptance V1

- Stop using display `redactValue` mutation as the OpenCode coding-context sensitivity gate; admit ordinary JS comments/regex while keeping secret and sensitive-path fail-closed checks.
- Prove host-owned risk Automatic Acceptance on one disposable local OpenCode Mission after explicit operator preference opt-in.
- Reconcile live `local.json` source from the temporary proof worktree to a canonical install archive of the fix tip; preserve Mission and Memory evidence.

## Unreleased — Lifecycle closeout shipped and installed

- Merged PR #47 (`f28e8ca`); installed corrected package; reconciled durable `stopping` to admission `open` with preserved Memory/Missions.

## Unreleased — Lifecycle & Package Closeout V1

- Ship service lifecycle admission and run-settlement helpers in the canonical package; reconcile orphaned durable `stopping` on new writer ownership without restarting the healthy installed service.

## Unreleased — V1.0.1 hotfix shipped and installed

- Merged PR #46 (`14ee5ab`); installed canonical `1.0.1-rc.1` package at `install/airodrom-1.0.1-rc.1` with Memory/Mission preservation and WhatsApp production HOLD unchanged.

## Unreleased — Installation Hotfix V1.0.1

- Accept optional Gmail OAuth `clientSecretReference` in ControlServer without weakening unknown-key rejection.
- Allowlist `wait-presentation` runtime module/config so clean package installs need no manual overlays.
- Raise installation compatibility minimum to `1.0.1-rc.1`; document reversible upgrade while leaving the healthy V1 install running.

## Unreleased — Integrated Release V1 local activation

- Activated verified package install at `install/airodrom-77724f8`; preserved Memory/Missions; WhatsApp production HOLD unchanged.
- Local install hotfixes: Gmail `clientSecretReference` acceptance; restore `wait-presentation` omitted from package allowlist.

## Unreleased — Integrated Release V1 shipped

- Merged consolidated daily candidate via PR #45 to `origin/main` (`0e5f0a86da1a21526105ebda24984ec309f91897`); release source `77724f83569eadae41727c86b201e433a801f910`.
- Closed superseded feature PRs #43/#44 after inclusion verification. Operator install remains separately authorized; WhatsApp production HOLD unchanged.

## Unreleased — Integrated Release V1 (daily candidate 2026-10-09)

- Prepare one local-first release candidate from `integ/daily-candidate-v1-20261009` with allowlisted source archives, SOURCE/COMPATIBILITY manifests, and reversible install plan (service not replaced).
- Restore WhatsApp inbound credential API routes dropped during daily merge (`validate-credentials`, `bind-credentials`, and related).
- Complete package allowlists for Conversation provider, risk Acceptance, and WhatsApp ADRs 0041/0042; remove ghost ADR paths that broke archive generation.

## Unreleased — Core Contracts & Runtime Consistency V1

- Add versioned core contracts, host-evidence runtime security conformance, and installation compatibility observation without rewriting durable state.
- Expose `/api/product/compatibility`, Control Center System Health rows, and interactive `/compat`.

## Unreleased — Personal AI Channels V1

- Restore `/api/assistant/provider` + ConversationEngine provider revision binding; Control Center Conversation refresh fails soft if provider is unavailable.
- Unify first-party ConversationEngine reliability across Control Center, ChatGPT MCP and the macOS menu.
- Control Center: persistent browser session, scoped history, Memory consent, local-ollama/model identity and Thinking activity.
- macOS menu: Conversation status row and Open Conversation deep-link (`?view=Conversation`).
- Preserve WhatsApp production outbound and automatic Mission execution OFF under Meta policy HOLD.


## 1.0.0-rc.1 — October 5, 2026 — private candidate

- Include opaque candidate/ContextPack identity migration, scoped erasure and current-authority restore/replay safeguards from the qualified private source.
- Prepare history-free source distribution, explicit package allowlists, dependency/license/SBOM review and deterministic archive checksums.
- Add public security/privacy, installation, development, runtime, governance and contribution documentation; issue/PR forms and pinned CI gates.
- Keep operator state and historical private evidence excluded. Keep `private: true`, production unactivated and publication owner-controlled.
- Preserve SDK 1.0.0, Kernel 1.2.0 and legacy MCP identity. Record optional/unqualified external runtime and physical/provider-retention limits.

Fresh candidate evidence is in [FRESH-VALIDATION.md](docs/FRESH-VALIDATION.md). No public stable release is implied by the preceding private package version.
