# Airodrom final reconciliation (V4)

Evidence recorded 2026-10-12. Treat earlier operator reports as historical unless re-verified below.

## 1. Starting Git state

| Item | Value |
| --- | --- |
| Feature branch | `feat/master-personal-ai-completion` |
| Primary PR | [#70](https://github.com/airodrom/airodrom/pull/70) |
| Worktree | `/Users/andrew/Documents/Codex/2026-10-11/airodrom-master-completion/work/airodrom-completion` |
| Operator checkout | `/Users/andrew/code/airodrom` on `main` @ `a1f97c5`, **dirty**, behind `origin/main` (~98). **PROTECTED** — not reset. |
| Memory-correction tip (historical) | `adc7f1e` |
| Docs follow-up (historical) | `c072c8f` |

## 2. Final `origin/main` SHA

`525458c945b48f6341320600c081ea163fd5a14f` — merge of PR #69 (`feat/menu-status-whatsapp-closeout`).

Clean synchronized checkout (does not touch the dirty operator tree):

`/Users/andrew/Documents/Codex/2026-10-11/airodrom-master-completion/work/airodrom-main-clean` @ `525458c` (`handoff/main-clean-20261012`).

## 3. Merged PRs

None in this pass. PR #70 remains open.

## 4. Closed superseded PRs

None closed in this pass. No PR was closed merely for age or title.

## 5. Remaining open PRs

| PR | Branch | Class | Evidence |
| --- | --- | --- | --- |
| **#70** | `feat/master-personal-ai-completion` | **HOLD (merge)** / MERGEABLE draft | Head `19d88ff` (deadline fix `eaafe01` + this report). Clean mergeability. Hosted `candidate.yml` is **`disabled_manually`**. Local gates green on `eaafe01` (below). Draft retained until hosted CI can be verified or owner re-authorizes merge without it. |
| **#36** | `feat/automatic-startup-reconnection-v1` | **BLOCKED / PROTECTED** | Tip `81ddb3e` not in main (1 unique commit). `CONFLICTING`. Unique managed-login supervisor surface. |
| **#37** | `feat/deepseek-reserve-provider-v1` | **BLOCKED / PROTECTED** | Tip `c5902f3` not in main (2 unique commits). `CONFLICTING`. Unique DeepSeek reserve provider. |
| **#38** | `feat/v1.8-operations-recovery` | **BLOCKED / PROTECTED** | Tip `5ae2250` not in main (2 unique commits). `CONFLICTING`. Unique idle-run settlement / CLI / menu recovery. |

## 6. Exact CI results

| Gate | Result |
| --- | --- |
| Hosted `Public candidate gates` (`.github/workflows/candidate.yml`) | **Unavailable** — workflow state `disabled_manually`. No run list for this head. |
| Branch protection on `main` | **None** (API 404). |
| Local near-expiry regression | **5/5 pass** @ `eaafe01` (`signed near-expiry conversation…`) |
| Local suite: interactive-cli + memory-correction + personal-memory + CLI reliability + service-lifecycle | **56/56 pass** |
| Local focused mission suite | **14/14 pass** |
| Local MCP schema/integration | **pass**; repository tool surface **27** including `personal_memory_search` / `personal_memory_get` |
| Local `npm run verify` | **Fails on this branch tip** with many pre-existing `not_allowlisted` / private_reference findings outside this reconciliation doc (see `/tmp/recon-verify.log`). The reconciliation doc itself is allowlisted in `release-files.json`. |
| Local `npm run test:hardening` | Not completed in this pass after verify failure; targeted hardening suites above remain the exact-head evidence. |

## 7. Memory V2 status

Repository implementation includes remember / search / retrieve / correction / supersession / forget / cache invalidation / scope isolation / provenance / conversation context assembly.

Correction defect fix: `adc7f1e` — deterministic fact-key identity; presentation collapses superseded peers without requiring DB rewrite.

Live operator evidence (historical, preserved): Kepler → Proxima correction answered as Proxima in fresh chat. **Both historical rows remain `active` in the live DB.** No live reconciliation authorized or performed.

## 8. Correction regression results

Synthetic suites covering correction/supersession: included in the 56-test pass (`memory-correction-v1`, `personal-memory`).

`scripts/reconcile-memory-corrections.cjs`: default dry-run; `--apply` requires `--confirm-apply`. **Not run with `--apply` against production.**

## 9. CLI reliability results

Attach-first client (`2e3b528` lineage) verified via `cli-client-reliability-v1` and interactive-cli suites (part of 56/56).

Installed PATH CLI: `~/.local/npm/bin/airodrom` → package `scripts/airodrom.cjs`.

Live `AIRODROM_HOME=~/.airodrom airodrom status` (read-only): Control Ready · Memory V2 Ready · OpenCode Ready · Provider Ready · no duplicate `local-service.cjs` supervisors.

## 10. Mission verification

Focused mission/permission/qualification tests: 14/14.

Near-expiry product defect fixed in `eaafe01`: after supervisor authority expiry blocked a Mission, `processResult` attempted illegal `blocked → needs_rework`, rolled back dispatch settlement, and failed fixture shutdown with “Shutdown termination is unverified”. Fix settles durable dispatches when Mission is already `blocked`/`cancelled`/`completed`, and supervisor aborts OpenCode actives on expiry.

Worker output still cannot grant Acceptance (existing control-plane invariants; not re-qualified as a live Acceptance run in this pass).

## 11. MCP qualification

| Evidence class | Status |
| --- | --- |
| Repository MCP surface | **27 tools** including `personal_memory_search`, `personal_memory_get` |
| Installed-service MCP | Live status reports connectors configured; tool enumeration against the **running** install was not forced by service replacement. Installed tree is `…/install/airodrom-memory-correction-adc7f1e` @ PID **79806**. |
| ChatGPT connector session | **Not claimed.** No ChatGPT-side tool-list session in this pass. |

## 12. Installed-service status (read-only)

| Check | Observation |
| --- | --- |
| Supervisor | Exactly one `local-service.cjs`: PID **79806** |
| Install path | `/Users/andrew/Documents/Codex/2026-10-11/airodrom-master-completion/install/airodrom-memory-correction-adc7f1e` |
| Product status | Ready (OpenCode 2.0.25, Memory V2 Ready, Provider/Ollama Ready) |
| Service restarted/replaced this pass | **No** |
| Live memory mutated this pass | **No** |
| LaunchAgent / tunnels / credentials | **Unchanged** |
| Rollback kit | Present under `~/.airodrom/backups/memory-correction-adc7f1e-*` (protected) |

## 13. Protected work

- Dirty operator checkout `/Users/andrew/code/airodrom`
- Open draft PRs #36–#38 unique commits and worktrees
- Active install + rollback kit + `~/.airodrom` private state
- All other dirty/unique worktrees listed by `git worktree list` (not deleted)

## 14. Cleanup actions

| Action | Result |
| --- | --- |
| Delete remote/local branches for #36–#38 | **Not done** — unique unmerged commits |
| Reset operator `main` | **Not done** — dirty/protected |
| New clean main worktree | **Created** `work/airodrom-main-clean` @ `525458c` |
| Stashes | None removed |
| Temporary test logs | Under `/tmp/recon-*.log`, `/tmp/near-expiry-*.log` (ephemeral) |

## 15. Remaining limitations

- Hosted candidate CI cannot run while the workflow is manually disabled.
- PR #70 not merged; `main` does not yet contain memory-correction, attach-first CLI, or deadline-settlement fixes.
- Installed service tip (`adc7f1e` install) is **ahead of / divergent from** unmerged PR head for later commits; merging the repo does not update the install.
- Live dual-active historical memory rows remain until an explicitly approved reconcile.
- ChatGPT connector live 27-tool qualification not performed.
- PRs #36–#38 need separate conflict resolution and qualification.

## 16. Remaining operator approvals

1. Re-enable or otherwise authorize hosted `candidate.yml` (or explicitly waive hosted CI) before merging #70.
2. Merge #70 when gates are accepted.
3. Separately authorize any installed-service upgrade to a post-merge tip (no automatic cutover).
4. Separately authorize live memory reconciliation if dual-active history should be rewritten.
5. Disposition path for #36–#38 (rebase/qualify or preserve indefinitely).

## 17. Arecibo handoff readiness

| Topic | State |
| --- | --- |
| Airodrom repository | Feature work on #70 head `eaafe01`; `main` still `525458c` |
| Runtime availability | Local managed service healthy (PID 79806); Arecibo must not assume merge or install upgrade |
| Personal Memory V2 | Ready on installed service; correction behavior proven on that install; historical dual-active rows preserved |
| Mission execution | Control-plane ready; fixture lifecycle verified; no interference with live Missions |
| ChatGPT connector | Activation gap remains until a real connector session |
| Production approval gates | Hosted CI enablement, #70 merge, install cutover, live memory reconcile, #36–#38 disposition |

**Arecibo must remain independently operational.** Do not couple Arecibo releases to unfinished Airodrom PR merges or unapproved install cutovers.

---

### Near-expiry defect (resolved in `eaafe01`)

**Symptom:** `signed near-expiry conversation terminates…` failed in after-hooks with `Shutdown termination is unverified; writer lock retained` (often after body assertions passed).

**Cause:** Mission supervisor blocked the Mission on authority expiry (`Mission authority expired`) while the conversation result was still being processed. `processResult` settled the dispatch then attempted `blocked → needs_rework` (illegal), the transaction rolled back, and `cp_dispatches` stayed `running`, failing lifecycle idle checks at shutdown.

**Fix:** Treat already `blocked`/`cancelled`/`completed` Missions as settled for result processing after durable dispatch settlement; abort OpenCode actives on supervisor expiry; strengthen the regression assertions.
