# Unified Recovery & Google Workspace Acceptance V1

## Scope

Integrates three source workstreams on top of `origin/main` (`78b2d341…`):

1. PR #238 — Control Center / conversation recovery  
2. PR #239 — Memory-grounded local email composition  
3. PR #237 — Google Workspace Stage A (Gmail write + Calendar manage)

## Merge order (verified)

`#238` → `#239` → `#237`, then a small awareness pattern fix for “How can you **safely** save …”.

Routing reconciliation: local `EMAIL_COMPOSE` remains ahead of governed `GMAIL_WRITE`, which remains ahead of Gmail search. Compose never requires Gmail write OAuth.

## Source vs live

| Claim | Status |
| --- | --- |
| Integrated source branch | `integrate/unified-recovery-workspace-v1` |
| Merged to `main` | Not performed — owner merge authorization required |
| Managed install / cutover | Not performed — owner release authorization required |
| Installed tip | Remains `b182fa4` until authorized cutover |
| Gmail/Calendar `write_qualified` | Remains false until owner `/connect` + provider-confirmed live ops |

## Focused verification (synthetic)

Ran on the integration worktree with installed `NODE_PATH` reuse:

- memory-awareness, conversation-engine, email-compose, gmail NL search, gmail write Stage A, calendar NL, menu-control alignment, connection-status, gmail OAuth token exchange  
- **115 / 115 passed**, 0 failed

## Owner gates (exact)

1. Developer Autonomy re-enroll cognitive files for Mission lineage (docs-only today).  
2. Merge authorization for #238, #239, #237 (or this integration PR).  
3. Managed install authorization (checkpoint + rollback).  
4. Optional: `/connect gmail send|manage` and `/connect calendar manage` for live write qualification.

Prepared request: `~/.airodrom/activation/development-target-enrollment/unified-acceptance-owner-approvals-20261026.json` (`confirmed: false`).
