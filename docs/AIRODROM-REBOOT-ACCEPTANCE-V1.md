# Airodrom Always-On & Full Mac Reboot Acceptance V1

Login-scoped always-on qualification for the managed desktop path. This document records pre-reboot preparation, post-reboot verification, and known limitations. Reboot verification is never claimed before an actual Mac restart.

## Classification legend

| Label | Meaning |
| --- | --- |
| VERIFIED AFTER REBOOT | Confirmed after a real login following Mac restart |
| VERIFIED BEFORE REBOOT | Confirmed on the live install before the reboot gate |
| BLOCKED | Failed with recorded evidence |
| NOT VERIFIED | Not yet demonstrated for this acceptance |

## macOS login vs system boot

Airodrom uses **user LaunchAgents** under `~/Library/LaunchAgents`. These start after the operator logs into a GUI session (`RunAtLoad`). They are **not** privileged LaunchDaemons and do **not** claim pre-login system boot availability.

| Component | Class | Scope |
| --- | --- | --- |
| `local.airodrom.desktop-login` | A / C | Login (user session); one-shot start then exits (`KeepAlive` false) |
| `local.airodrom.mcp-tunnel` | A / C | Login; KeepAlive |
| `local.airodrom.reboot-acceptance` | A / C | Login companion verifier for this acceptance; deferred until next login |
| Menu bar app | A / C | Opened by desktop-login after service attach |
| Ollama.app | A / C | Started by desktop-login if loopback API is down; also Login Items / app lifecycle |
| Managed `local-service` | A / C | Started by desktop-login via `local.start` attach-or-launch |
| Terminal CLI (`airodrom`) | D for PATH | Resolves from `~/.local/npm/bin` in interactive shells; LaunchAgent PATH pins Node only |

## Privacy hardening (pre-reboot)

Live operator report: a personal car fact was answered from conversation history after Memory V2 had no match and forget returned “No matching ordinary memory.”

Root cause: forget only targeted Memory V2 rows. History-only / model-asserted personal facts remained injectable on the next turn.

Fix (this branch):

- Deterministic forget selection parsing (`memory-correction.conversationalForgetTarget`)
- `ConversationEngine.suppressForgottenFact` clears matching turns, marks `content_state: erased`, bumps erasure generation via a scratch forget marker, aborts in-flight turns
- `assistant-service.forget` always runs history suppression; returns `forgotten` when Memory V2 **or** conversation context was cleared; routes sensitive hits to `/sensitive`
- Personal recall without Memory V2 gets an explicit host note not to invent personal facts

Regression coverage: history-only conversational forget, empty ordinary Memory, sensitive boundary, provider context isolation after suppress.

Operator real car data was **not** mutated during qualification.

| Check | Status |
| --- | --- |
| Conversational forget (history-only) | VERIFIED BEFORE REBOOT (synthetic) |
| Explicit `/forget` / no matching ordinary memory | VERIFIED BEFORE REBOOT (synthetic) |
| Sensitive boundary | VERIFIED BEFORE REBOOT (synthetic) |
| Fresh-session / provider isolation after forget | VERIFIED BEFORE REBOOT (synthetic) |
| Operator car fact | NOT VERIFIED (no mutation without authorization) |

## Pre-reboot baseline (live install)

Recorded during preparation on the operator machine. Values are non-secret identity/health only.

| Item | Observation | Status |
| --- | --- | --- |
| macOS | 27.0.1 (arm64) | VERIFIED BEFORE REBOOT |
| Installed service | `airodrom-memory-correction-adc7f1e` | VERIFIED BEFORE REBOOT |
| Supervisor count | Exactly one `local-service.cjs` | VERIFIED BEFORE REBOOT |
| Node runtime | Homebrew Node 22.23.3 pinned in LaunchAgent | VERIFIED BEFORE REBOOT |
| nvm / `~/.npmrc` prefix | Interactive warning only; LaunchAgent uses absolute Node path | VERIFIED BEFORE REBOOT |
| OpenCode | Ready · 2.0.25 | VERIFIED BEFORE REBOOT |
| Memory V2 | Ready · Local | VERIFIED BEFORE REBOOT |
| Provider / Ollama | Ready · `ollama/qwen3-coder:30b` present | VERIFIED BEFORE REBOOT |
| MCP tools (source) | 27 | VERIFIED BEFORE REBOOT |
| MCP tunnel LaunchAgent | Enabled / running | VERIFIED BEFORE REBOOT |
| ChatGPT connector end-to-end | NOT VERIFIED without operator connector refresh | NOT VERIFIED |
| Active Missions | 0 | VERIFIED BEFORE REBOOT |
| Menu bar process | Running against managed home | VERIFIED BEFORE REBOOT |
| CLI attach (noninteractive PATH with `~/.local/npm/bin`) | Attaches; no duplicate supervisor | VERIFIED BEFORE REBOOT |
| CLI on bare `/usr/bin:/bin` PATH | `airodrom` missing (expected) | VERIFIED BEFORE REBOOT |

## Acceptance tooling

| Path | Role |
| --- | --- |
| `src/reboot-acceptance.js` | prepare / verify / forget-test-memory / status |
| `scripts/macos/reboot-acceptance.cjs` | CLI entry |
| `scripts/macos/desktop-login.cjs` | Optional pending verify hook after install cutover |
| `local.airodrom.reboot-acceptance` | Companion LaunchAgent (deferred until next login) |
| `~/.airodrom/reboot-acceptance/pending.json` | Pre-reboot checkpoint (private) |
| `~/.airodrom/reboot-acceptance/post-reboot-receipt.json` | Post-login receipt |

Prepare creates one synthetic ordinary memory (`Airodrom-Orbit-2026`), a `VACUUM INTO` backup under `~/.airodrom/backups/reboot-acceptance-*`, copies LaunchAgent plists beside the backup, and enables the deferred verifier agent **without** bootstrapping it before reboot.

## Post-reboot verification checklist

After login, the companion agent runs `reboot-acceptance.cjs verify` with bounded retries. Manual continuation (session-independent):

```bash
cd ~/Documents/Codex/2026-10-11/airodrom-master-completion/work/airodrom-reboot-acceptance
NODE_ENV=test node --experimental-sqlite scripts/macos/reboot-acceptance.cjs status
NODE_ENV=test node --experimental-sqlite scripts/macos/reboot-acceptance.cjs verify
AIRODROM_HOME=$HOME/.airodrom PATH=$HOME/.local/npm/bin:/opt/homebrew/opt/node@22/bin:/usr/bin:/bin airodrom status
```

Required proof after reboot:

1. One healthy managed service  
2. Correct install identity  
3. CLI attach without duplicate supervisor  
4. Control Center / menu discovery  
5. Memory V2 ready + synthetic memory retrievable  
6. OpenCode ready  
7. Ollama/Qwen ready or reconnects  
8. MCP ready  
9. Tunnel healthy where configured  
10. Mission state preserved  
11. No unauthorized config mutation  

Then: `reboot-acceptance.cjs forget-test-memory` to remove only the synthetic checkpoint.

## Reboot gate

Physical Mac restart is **operator-authorized only**. This acceptance does not reboot, log out, or cut over the production install.

## Remaining limitations

- Installed tree may lag tip/`main` until an authorized cutover.  
- ChatGPT connector may need a human connector refresh; local MCP readiness is not sufficient proof.  
- Bare LaunchAgent PATH does not include `~/.local/npm/bin` (doctor “CLI install: missing” under that PATH).  
- WhatsApp remains configured but must not be activated by this acceptance.  
- Protected PRs #36–#38 preserved; no automatic merge.

## Prepare receipt (private home)

| Field | Value |
| --- | --- |
| Stamp | `20261012T022148Z` |
| Backup | `~/.airodrom/backups/reboot-acceptance-20261012T022148Z` (integrity ok) |
| Pending | `~/.airodrom/reboot-acceptance/pending.json` |
| Baseline | `~/.airodrom/reboot-acceptance/pre-reboot-baseline.json` |
| Verifier plist | enabled, not loaded until next login |
| Synthetic memory | retrievable by subject hint before reboot |

## Post-reboot incident (20261012T022148Z)

| Observation | Evidence |
| --- | --- |
| Desktop-login exit 1 | `~/.airodrom/desktop-login.stderr.log`: `Local service did not become ready` (15s spawn wait) |
| Supervisor survived | Exactly one `local-service.cjs` (PID observed at verify time) |
| Admission | `booting` with `prior_state=stopping`, `reconciled=true`, `idle=true`, blockers 0 |
| Memory | Live + backup integrity ok; retrieval/product rejected only because admission closed |
| Verifier exit 0 | Must not be read as acceptance; receipt `ok:false` with memory/provider checks failed |

Root cause: macOS shutdown SIGTERM runs owned stop → durable `stopping`. Next writer sets `autoOpen=false`. Cold post-reboot spawn exceeded the 15s ready wait, so `local.start` never reached owned resume; attach-only recovery also skipped resume. Healthy HTTP ≠ open admission.

Repository fix (this branch): longer owned-start ready window, `ownedStartResume` waits for reconcile and retries when idle, attach-during-start recovers orphaned `booting`, lifecycle `hold_reason`, verifier distinguishes `admission_closed`, timestamped receipts preserve history.

Live recovery still requires explicit operator approval to call authenticated admission resume on the installed service (no force-open, no memory rewrite, no LaunchAgent mutation in the recovery step).

## Manual recovery (20261012T024949Z)

Operator-authorized authenticated `local.admission(home, 'resume')` reopened admission on PID 1154 without restart. Independent checks passed 13/13. New receipt:

`~/.airodrom/reboot-acceptance/post-reboot-receipt-20261012T024949Z.json`

Original failed receipt preserved:

`~/.airodrom/reboot-acceptance/post-reboot-receipt.json`

Manual resume proves data integrity; it does **not** prove automatic post-reboot owned-start resume. That requires install cutover of this branch plus a real Mac restart.

## Installation cutover preflight (not executed)

| Item | Value |
| --- | --- |
| Active install | `…/install/airodrom-memory-correction-adc7f1e` |
| Active source fingerprint | matches running supervisor |
| Target | fresh tree from this PR tip under `…/install/airodrom-reboot-acceptance-<shortsha>` |
| Persistent home | `~/.airodrom` (unchanged) |
| Rollback | keep `airodrom-memory-correction-adc7f1e`; restore `local.json` source + LaunchAgent ProgramArguments WorkingDirectory |
| Memory / credentials / tunnels | not copied, not rewritten |
| Required transition | drain → stop → retarget source → `local.start` (opens admission via ownedStartResume) |
| Desktop-login / reboot verifier | rewrite plists to new install paths after cutover |

Prepared cutover must verify target tree contains `ownedStartResume`, `hold_reason`, and `scripts/macos/desktop-login.cjs` admission checks before any service stop.

## Final status

**HOLD — MERGE / INSTALL / RESTART / REBOOT AUTHORIZATION REQUIRED** — repository fixes and offline validation are complete on PR #71; live install still runs the pre-fix build. Automatic post-reboot admission reopen remains **NOT VERIFIED** until approved cutover + real Mac restart produce a passing timestamped receipt without manual resume.
