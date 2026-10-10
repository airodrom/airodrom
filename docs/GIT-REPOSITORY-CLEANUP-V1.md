# Git Repository Cleanup V1

Safe consolidation of obsolete Airodrom Git refs and disposable worktrees after the #45–#58 shipment stack. No feature work; no force-push; no service restart; operator checkout preserved.

## Preflight (2026-10-10)

- **`origin/main`:** `c2482bb517c0f08c386523227f5179615282caee`
- **Installed runtime:** `…/airodrom-grounded-accuracy/install/airodrom-grounded-accuracy-fe918cc` (Healthy; not modified)
- **Active Development Session:** `2eb98c6a-…` · branch `feat/ds-continue-session-v1` · worktree `…/airodrom-ds-continue/work/airodrom-ds-continue` (**PROTECTED**)
- **Operator checkout:** `/Users/andrew/code/airodrom` dirty / behind main (**PROTECTED**; not reset, cleaned, stashed, or overwritten)

## PR review classification

| PR | Topic | Class | Notes |
| --- | --- | --- | --- |
| [#36](https://github.com/airodrom/airodrom/pull/36) | Automatic startup | **KEEP ACTIVE** | Draft; 1 unique commit; 14 files vs main |
| [#37](https://github.com/airodrom/airodrom/pull/37) | DeepSeek reserve | **KEEP ACTIVE** | Draft; 2 unique commits |
| [#38](https://github.com/airodrom/airodrom/pull/38) | Operations recovery | **KEEP ACTIVE** | Draft; 2 unique commits |
| [#39](https://github.com/airodrom/airodrom/pull/39) | OpenCode requalify | **REVIEW REQUIRED** | Closed unmerged; tip `34aab44` still 1 commit ahead of main (preserve branch/worktree). Related ADR 0034 content exists on main via later qualification tips; tip is not ancestral—do not discard. |
| [#43](https://github.com/airodrom/airodrom/pull/43) | Cursor + Automatic Acceptance | **SAFE TO CLEAN** (remote) | Closed into Integrated Release path; tip ancestral to main |
| [#44](https://github.com/airodrom/airodrom/pull/44) | WhatsApp Inbound | **SAFE TO CLEAN** (remote tip) / **REVIEW REQUIRED** (local worktree) | Remote tip ancestral; local worktree holds unique `581a30f` Meta AI HOLD verdict commit |

PRs #45–#58 already shipped Everyday UX, Continue DS, Grounded Accuracy, lifecycle, and related closeouts. Obsolete draft PRs were **not** closed: unique work remains.

## Actions taken

### Remote branches deleted (49)

Fully merged tips only (`git merge-base --is-ancestor` + zero commits ahead of main + no open PR). Includes merged shipment heads such as `feat/grounded-assistant-accuracy-v1`, `feat/everyday-personal-ai-ux-v1`, `integ/daily-candidate-v1-20261009`, `feat/whatsapp-inbound-v1` (remote tip only), and historical feature/fix branches ancestral to main.

Evidence: private `airodrom-git-cleanup/evidence/remote-deletes.json`.

### Remote branches retained

| Branch | Reason |
| --- | --- |
| `main` | Canonical |
| `feat/automatic-startup-reconnection-v1` | Open PR #36 |
| `feat/deepseek-reserve-provider-v1` | Open PR #37 |
| `feat/v1.8-operations-recovery` | Open PR #38 |
| `feat/ds-continue-session-v1` | Active Development Session |
| `fix/opencode-pin-replacement-requalify` | Unique tip vs main |

### Worktrees removed (34)

Clean, tip-in-main, unused by DS/runtime/operator. Historical Codex referenced worktrees from 2026-10-06/07 and merged shipment worktrees (lifecycle, v101, coding-reliability, everyday-ux feature/docs, grounded-accuracy docs, etc.).

Evidence: private `airodrom-git-cleanup/evidence/worktree-removes.json`.

### Worktrees / trees protected or retained for review

- Operator checkout + nested `work/airodrom-v2`
- Active DS worktree `…/airodrom-ds-continue/work/airodrom-ds-continue`
- Open-PR worktrees: startup (#36), DeepSeek (#37), v1.8 ops (#38)
- Unique-commit / dirty review set: WhatsApp local tip, OpenCode requalify, gmail-actions, dotted-wave, v1.6/v1.7.1 RCs, UI recovery (dirty), daily integration (dirty), docs-only tips ahead of main, etc.
- This cleanup worktree `…/airodrom-git-cleanup/work/airodrom-git-cleanup`

### PRs closed this Mission

None. Historical closed PRs (#39, #43, #44) left closed; discussion preserved.

## Non-actions

- No force-push, no GitHub Actions dispatch, no release, no install/source change, no service restart, no WhatsApp production change, no AI/editor attribution.

## Remaining cleanup candidates

- Triage **REVIEW REQUIRED** worktrees (unique commits or dirty trees) for cherry-pick, archive tag, or explicit discard authorization.
- Decide whether `fix/opencode-pin-replacement-requalify` tip is obsolete vs main’s later OpenCode 2.0.25 qualification (content overlap, not ancestry).
- Optional local-branch prune on non-operator machines only; never rewrite the protected operator checkout.
