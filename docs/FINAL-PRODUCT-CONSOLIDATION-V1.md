# Final Product Consolidation V1

**Date:** 2026-10-10  
**Verdict:** Local usable Airodrom **release criteria met**. Stop inventing further feature milestones for daily use.  
**Public activation:** OFF · **WhatsApp production:** HOLD · **Automatic Acceptance:** OFF

## Canonical tip

| Surface | Value |
|---------|--------|
| `origin/main` | `7bae01d91636762f3a78a1ddba474ee2dd9ad589` (PR #63 merge) |
| Installed package | `1.0.1-rc.1` at `…/airodrom-whatsapp-verify-token-safe-rotation/install/airodrom-whatsapp-verify-safe-879daa3` |
| Feature merge base for install | `879daa3` (WhatsApp verify-token staged rotation) |
| Native menu helper | `~/.airodrom/menu/Airodrom.app` — includes Open Conversation, Continue Development Session, Open System Health |
| Operator checkout | `~/code/airodrom` — **protected dirty**, ~86 commits behind main; **do not** use as release source |

## Release criteria (observed)

| Criterion | Result |
|-----------|--------|
| Control / OpenCode / Memory / Provider Ready | Pass |
| OpenCode pin | 2.0.25 Ready · Primary |
| Local model | `ollama/qwen3-coder:30b` Ready |
| Conversation separate from Missions | Pass (menu + product status) |
| Readable `airodrom status` | Pass (human report, not raw JSON) |
| Personal Memory / Missions preserved | Pass (no wipe; Memory Ready) |
| Automatic Acceptance | OFF (`enabled: false`) |
| WhatsApp production messaging | HOLD · public ingress OFF · outbound OFF |
| Native menu deep links | Present in helper binary |
| Dirty operator checkout | Untouched |

No additional focused test suite was re-run for unchanged code. Live product-control status and shell `airodrom status` were the consolidation observations.

## What was consolidated (already shipped)

These landed on main through prior reviewed PRs and the single install lineage ending at `879daa3`:

- Integrated Release V1 + V1.0.1 install hotfixes + lifecycle package closeout  
- Coding reliability / Development Sessions / Continue Development Session  
- Everyday Personal AI UX + Conversation UX bugfix  
- Grounded assistant accuracy  
- Menu Bar V2 + Everyday menu deep links  
- WhatsApp verify-token staged rotation (**test / HOLD**, not production messaging)

## Essential blockers — none for local daily use

No essential code blocker remains for the installed local application. Operator actions that are not product defects:

- Clear or Accept/Settle historical Missions awaiting review (menu may show an old paused Mission).  
- Owner Meta App Dashboard steps for test WhatsApp (staging commit) — separate from production HOLD.  
- Private discovery / Control Center open requires the managed service (already Connected).

## Optional future improvements (do not block “finished”)

| Item | Disposition |
|------|-------------|
| PR [#36](https://github.com/airodrom/airodrom/pull/36) login service supervision | Optional reliability; keep draft until owner wants reboot-proof start |
| PR [#37](https://github.com/airodrom/airodrom/pull/37) DeepSeek reserve | Optional paid reserve; never automatic |
| PR [#38](https://github.com/airodrom/airodrom/pull/38) operations recovery | **Do not merge whole tip** — menu diff would regress Everyday UX. Idle host settlement already on main via lifecycle work. Cherry-pick only if a remaining CLI/menu gap is proven against current main |
| Claude external conversation | WAIT — credentials/transport/billing qualification |
| Calendar / Drive reads | Owner API enablement |
| Web search / live weather | No approved provider |
| Native Packaging Foundation → Public Release | Roadmap only; see [KNOWN-LIMITATIONS.md](KNOWN-LIMITATIONS.md) |
| Dirty checkout unique WIP | Preserve; rebase or discard later per owner — never overwrite |

## Protected assets

- Personal Memory V2, Missions, credentials/Keychain, development sessions, MCP tunnel, rollback backups under `~/.airodrom/backups/`  
- Operator dirty tree and unique worktrees  
- WhatsApp production WABA / production phone unset policy  

## Install policy going forward

Use **one** install root (current `airodrom-whatsapp-verify-safe-879daa3` or a single successor cut from `origin/main`). Do not run a separate install cycle per small correction. Rebuild the native menu helper from that install when menu source on the install tip changes.

## Stop condition

This document is the consolidation stop line for daily-use product finish work. Further engineering requires an explicit new owner request scoped to an optional item above.
