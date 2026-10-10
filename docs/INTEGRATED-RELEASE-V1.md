# Integrated Release V1 — daily candidate 2026-10-09

Local-first release candidate prepared from one verified source revision. This is not a new architecture milestone.

## Source identity

| Field | Value |
| --- | --- |
| Worktree | `/Users/andrew/Documents/Codex/2026-10-09/airodrom-daily-integration-v1/work/airodrom-daily-integration` |
| Branch | `integ/daily-candidate-v1-20261009` |
| Integration tip (preflight) | `2aac9c72d184fbae1754fcf43104e865ff4a4403` |
| Release source HEAD | `77724f83569eadae41727c86b201e433a801f910` |
| Merged on `origin/main` | `0e5f0a86da1a21526105ebda24984ec309f91897` (PR #45) |
| Package | `airodrom` `1.0.0-rc.1` (`private: true`) |
| Operator checkout | `/Users/andrew/code/airodrom` on `main` — preserved; not the install source |

Canonical package artifacts (outside Git):  
`/Users/andrew/Documents/Codex/2026-10-09/airodrom-daily-integration-v1/release-candidate-2aac9c7/`

- `airodrom-source-a.tar.gz` / `airodrom-source-b.tar.gz` — byte-identical allowlisted source archives  
- `SOURCE-MANIFEST.json` — exact file list and per-file SHA-256  
- `COMPATIBILITY-MANIFEST.json` — installation compatibility + contract inventory  
- `SHA256SUMS` — archive digests  
- `package-check.json` — npm pack dry-run allowlist result
- Authoritative archive digest: `SHA256SUMS` / `SOURCE-MANIFEST.json` in the artifacts directory above (not embedded here; the allowlisted doc is inside the archive).  

## Release contents (IMPLEMENTED LOCALLY)

| Area | Status | Notes |
| --- | --- | --- |
| Premium Control Center | MERGED IN SOURCE | Atmosphere, theme, Conversation, System Health, compatibility rows |
| Live Observatory | MERGED IN SOURCE | `src/live-observatory.js` |
| Menu Bar V2 | MERGED IN SOURCE | Conversation status + Open Conversation |
| Automatic Acceptance | MERGED IN SOURCE | Risk-based Acceptance + Cursor task bridge (feature PR #43 closed after inclusion) |
| Development Sessions | MERGED IN SOURCE | Local-first batch merge policy; no auto CI/merge |
| Personal AI Channels | MERGED IN SOURCE | Control Center / MCP / macOS ConversationEngine |
| Conversation provider API | MERGED IN SOURCE | `/api/assistant/provider` restored |
| Core Contracts V1 | MERGED IN SOURCE | ADR 0043 |
| Runtime Security Conformance | MERGED IN SOURCE | Host-evidence VERIFIED/UNVERIFIED/UNSUPPORTED |
| Installation Compatibility | MERGED IN SOURCE | `/compat`, `/api/product/compatibility` |
| WhatsApp source | MERGED IN SOURCE · PRODUCTION HOLD | Inbound + Conversations + credential routes; outbound/Mission auto OFF; Meta AI policy HOLD |
| OpenCode 2.0.25 + Qwen | QUALIFIED IN SOURCE | `config/agent-runtime-qualification-v1.json` |
| Memory V2 | PRESERVED | No silent migration |
| Gmail | PRESERVED | Existing OAuth/connector contracts |
| Mission authority / Settlement | PRESERVED | Host primitives unchanged |

### Publication states

| State | This candidate |
| --- | --- |
| IMPLEMENTED LOCALLY | Yes — daily integration worktree (historical) |
| MERGED IN SOURCE | Yes — PR #45 → `0e5f0a86da1a21526105ebda24984ec309f91897` |
| INSTALLED LOCALLY | No — operator service not replaced (separate authorization) |
| LIVE VERIFIED | Partial — focused fixture/typecheck evidence only; not a live production qualify |
| PRODUCTION HOLD | WhatsApp production messaging / Meta AI providers |

## Compatibility result

Installation compatibility overall: **compatible** (mutations allowed for compatible/outdated; diagnostics and recovery always available).

Components observed: core daemon, global CLI, Control Center, macOS menu, MCP contract, model provider contract, agent runtime contract.

OpenCode pin: runtime **2.0.25**, model `ollama/qwen3-coder:30b` (declared qualification record).

Ghost allowlist paths (`docs/adr/0039-whatsapp-conversations-v1.md`, `docs/adr/0040-whatsapp-production-connection-v1.md`) removed; WhatsApp ADRs **0041** / **0042** retained. Missing Personal AI / risk-acceptance modules added to `release-files.json` and `package.json` `files`.

## Focused validation (this pass)

| Check | Result |
| --- | --- |
| `tests/core-contracts-v1.test.js` | pass |
| `tests/conversation-provider.test.js` | pass (in focused batch) |
| `tests/whatsapp-conversations-v1.test.js` | pass |
| `tests/whatsapp-production-connection-v1.test.js` | pass (HOLD assertions) |
| `tests/whatsapp-inbound-v1.test.js` | pass after restoring credential API routes |
| `tests/control-server.test.js` | pass (in focused batch) |
| `tests/mission-service.test.js` via `scripts/run.cjs` | pass |
| `tests/public-release-policy.test.js` via `scripts/run.cjs` | pass |
| `npm run package:check` | pass — 0 forbidden |
| Dual `source-archive.cjs` | byte-identical |
| `typecheck:authority` / `typecheck:sdk` | pass |
| `node scripts/airodrom.cjs --help` | pass |
| Broad hosted CI | not run (workflow manually disabled; no push) |

Note: calling `node --test` on mission/interactive suites without `scripts/run.cjs` can yield `opencode_fixture_denied`; use the repo runner for those surfaces.

## Installation readiness (reversible — not executed)

Preserve before any install:

- `~/.airodrom/data` (Memory / control-plane SQLite)  
- Keychain / Vault references  
- `~/.airodrom/runtime-pins.json` (+ `.previous`)  
- Mission records and local approvals  
- Protected dirty operator checkout at `/Users/andrew/code/airodrom`  

Plan (owner-authorized only):

1. Stop owned service with existing graceful stop (do not force-kill).  
2. Extract verified archive into an empty private directory; verify `SHA256SUMS` and `SOURCE-MANIFEST.json`.  
3. `npm ci --ignore-scripts` in that directory.  
4. Optional: `npm run install:local` for global CLI link (undo: `npm unlink -g airodrom`).  
5. Requalify pins while stopped (`airodrom requalify`) before start.  
6. Start only after compatibility `/compat` reports mutations allowed.  

Rollback: restore prior source tree or previous archive; keep databases and Keychain untouched; re-link previous CLI if needed. **This candidate does not replace the active operator service.**

## Git / PR status

- Consolidated release PR [#45](https://github.com/airodrom/airodrom/pull/45) **merged** to `main` at `0e5f0a86da1a21526105ebda24984ec309f91897`.  
- Release source HEAD `77724f83569eadae41727c86b201e433a801f910` is an ancestor of `origin/main`.  
- Feature PRs #43 (Automatic Acceptance) and #44 (WhatsApp Inbound) closed after inclusion verification; feature branches retained. Drafts #38/#37/#36 unchanged.  
- Hosted candidate workflow remained idle (no checks required; no heavy suites).  
- **Local operator install / service cutover** still requires separate authorization.

## Known blockers

1. Not installed on the operator host (separate authorization).  
2. WhatsApp production HOLD (Meta AI policy).  
3. Live OpenCode/Qwen qualification on the operator machine is separate from fixture evidence.  
4. Operator checkout remains dirty/protected and is not the install source.
