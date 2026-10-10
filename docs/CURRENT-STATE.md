# Current state (2026-10-10)

## Coding Reliability & Auto-Acceptance V1 (COMPLETED)

- OpenCode `safeText` no longer treats display path/URL redaction mutation as `opencode_sensitive_context`; ordinary JS comments/regex admitted; secrets and sensitive absolute paths remain denied.
- Live Mission `2c57a4e7-c906-4b5f-9590-61242e6b6f82` completed via host risk Automatic Acceptance (operator preference opt-in, then restored OFF).
- Branch `fix/coding-reliability-auto-acceptance` (local; not pushed). Evidence: [CODING-RELIABILITY-AUTO-ACCEPTANCE-V1.md](CODING-RELIABILITY-AUTO-ACCEPTANCE-V1.md).
- Historical failed Mission `668a177e-…` preserved. Operator checkout untouched.

## Shipped source

- **PR:** [#46](https://github.com/airodrom/airodrom/pull/46) **MERGED**
- **Hotfix source:** `1c6fb24308998ea28ec07c91db764f10ceafb3bc`
- **`origin/main` merge:** `14ee5ab21ea348982bfc762cc57d5d6bd1b4620f`
- **Package:** `1.0.1-rc.1` — [INSTALL-HOTFIX-V1.0.1.md](INSTALL-HOTFIX-V1.0.1.md)

## Installed release (running)

- **Root:** `/Users/andrew/Documents/Codex/2026-10-09/airodrom-v101-install-hotfix/install/airodrom-1.0.1-rc.1`
- **Health:** Healthy — OpenCode 2.0.25, Memory Ready, Gmail configured
- **Backup / rollback:** `~/.airodrom/backups/v101-upgrade-20261010T160704Z`
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
