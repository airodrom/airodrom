# Control Center & Premium macOS Experience V4

Local-first UX audit and modernization of Control Center and the native menu helper. Mission authority, Acceptance, Settlement, Vault, and provider qualification are unchanged.

**Status:** SHIPPED + INSTALLED (2026-10-10)

- **PR:** [#67](https://github.com/airodrom/airodrom/pull/67) **MERGED**
- **Merge on `origin/main`:** `11056596024b7f8847bbc509bbb33f6f764fd58f`
- **Feature tip:** `2e7ed21380a3462c66614ab027a023ee4ba76f3f`
- **Installed:** `…/airodrom-ux-v4/install/airodrom-ux-v4-1105659` (`1.0.1-rc.1`) · CFBundleVersion **4**
- **Backup/rollback:** `~/.airodrom/backups/macos-ux-v4-20261010T233213Z` (prior tip `airodrom-menu-v3-1cff95d`)
- **Startup:** `local.airodrom.desktop-login` preserved (WorkingDirectory → V4 tip)
- **Live:** Control / OpenCode / Memory / Provider Ready · Active **0** · Needs review **45** · Failed **20** · Automatic Acceptance OFF · WhatsApp HOLD

## Design decisions

| Decision | Rationale |
| --- | --- |
| Full-logo status gradients (no status dot) | Operator preference: the entire A mark changes color by state; removes misaligned corner disk |
| Symmetric 18pt mark inset (1.5pt) | Keeps Retina silhouette balanced in the menu bar |
| Non-template colored mark | Required so light/dark menu chrome does not desaturate status color |
| Section header `Mission` | Avoids labeling NEEDS REVIEW under “Active Mission” |
| Port `missionHistory` / `mission_counts` | UI already expected the API; without it Missions showed Unavailable / “predates history” |
| Overview “Needs review” tile | Separates live Active from retained Acceptance / Decision queues |
| Review banner + humanized chips | Makes the 45 historical review records understandable without implying execution |
| Restrained CSS motion | Short hover/focus transitions; `prefers-reduced-motion` disables them |

## Defects corrected

1. Missions dashboard unusable without `mission_counts` / `/api/product/missions`.
2. Overview treated “current” non-terminal Missions as Live and omitted review counts.
3. Overview failure filter included non-existent `failed` state.
4. Review Acceptance disabled on transient transport failures.
5. Menu status disk optically misaligned vs mark / badge reflow — replaced by full-logo gradients.
6. Busy animation now animates the gradient mark itself (no separate disk).
7. Section naming implied review work was active.

## Authoritative Mission buckets

| Bucket | States |
| --- | --- |
| Active | `dispatching`, `running`, `verifying` |
| Needs review | `awaiting_acceptance`, `waiting_for_operator` |
| Failed | `blocked`, `needs_rework` |
| Completed | `completed` |
| Settled | row in `cp_mission_settlements` with `state='settled'` |

Installed classification at audit time (not hardcoded in product): Active **0**, Awaiting Acceptance **44**, Waiting for operator **1**, Failed **20**, Completed **4**, Settled **4**.

## Accessibility

- Mission chips use human-readable labels.
- Review banner and Missions summary use `role="status"` where applicable.
- Menu VoiceOver label remains “Airodrom”; status value includes approvals/review.
- Atmosphere, track, lifecycle, and V4 hover transitions honor reduced motion.

## Evidence

- Focused tests: `tests/mission-activity.test.js`, `npm run macos:test-helper`, `npm run test:product`
- Icon exports: `evidence/macos-ux-v4/` (light/dark · connected / action-required / working / degraded / disconnected)

## Out of scope

- Mass accept/cancel/settle of historical Missions
- Startup PR #36, WhatsApp production, Automatic Acceptance
- New frontend framework or dependency

## Follow-on: menu tone closeout

Historical Mission review backlog no longer forces the gold menu mark. See [MENU-STATUS-WHATSAPP-CLOSEOUT-V1.md](MENU-STATUS-WHATSAPP-CLOSEOUT-V1.md).
