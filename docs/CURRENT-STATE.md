# Current state (2026-10-10)

## Everyday Personal AI UX V1 (LOCAL FEATURE — NOT INSTALLED)

- Branch `feat/everyday-personal-ai-ux-v1` worktree under Documents/Codex; tip local until authorized checkpoint.
- Conversation: visible Qwen default model picker, persistent session continue/new, Memory consent status, honest activity/reconnect; ConversationEngine reused.
- Missions: active work, worker, verified activity, pending approval, Settlement, Open Observatory (no fabricated progress).
- Development Sessions: Continue action clarity (repo/branch/worktree/next action); no duplicate execution controls.
- macOS Menu V2: Open Conversation, Active Missions, Continue Development Session, Open System Health, Control Center deep links.
- Focused contracts: `tests/everyday-personal-ai-ux-v1.test.js`. Evidence: [EVERYDAY-PERSONAL-AI-UX-V1.md](EVERYDAY-PERSONAL-AI-UX-V1.md).
- **Installed release unchanged:** Continue DS `…/airodrom-ds-continue-c701289` (`origin/main` includes docs tip `674a8e3`). Live Qwen + DS resolve validated on that install.
- Operator checkout preserved. No push/merge for this Mission.

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

- **Root:** `/Users/andrew/Documents/Codex/2026-10-10/airodrom-coding-reliability/install/airodrom-coding-reliability-a6ee3e3`
- **Health:** Healthy — OpenCode 2.0.25, Memory Ready, admission `open`
- **Includes:** Coding reliability `sourceContextSensitive` fix (pending merge to `origin/main` until PR lands)
- **Prior lifecycle install:** `…/install/airodrom-lifecycle-f28e8ca` (retained on disk)
- **Manual patches required:** No

## Distinctions

| Claim | State |
| --- | --- |
| MERGED IN SOURCE (V1.0.1) | Yes |
| INSTALLED LOCALLY (V1.0.1) | Yes |
| LIVE VERIFIED (V1.0.1) | Yes |
| PRODUCTION HOLD | WhatsApp / Meta AI |

## Operator checkout

`/Users/andrew/code/airodrom` remains protected and dirty; it was not the install source.

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
