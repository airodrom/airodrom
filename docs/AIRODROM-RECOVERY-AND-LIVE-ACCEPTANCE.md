# Airodrom Recovery and Live Acceptance

Emergency recovery evidence for the reported “Airodrom is not working” incident. Distinguishes live tip observations from offline/fixture verification. Does not authorize tip cutover.

## 1. Exact failure symptoms

| Symptom | Observation |
| --- | --- |
| Operator report | Product “not working” |
| Wrong health probe pattern | `:3333/healthz` is not the Control Plane contract |
| Menu control drift | `~/.airodrom/menu/Airodrom.app` `AirodromControl` pointed at `airodrom-menu-icon-size` while `local-service` ran from `airodrom-menu-status-525458c` |
| Menu status MCP field | `product-control` hard-coded `mcp.ready:false` even when `/api/mcp/health` was ready |
| Tip MCP surface | Live tip exposes **25** tools; `personal_memory_search` / `personal_memory_get` return `Tool is not exposed` |
| Browser tab without private link | Control Center HTML loads, then shows “Authorization required” until opened via the menu private link |

## 2. Root cause

**Primary class: K / UI reconnect + presentation defect (not service down).**

Evidence shows the Control Plane tip remained healthy. Operator-facing failure combined:

1. **Menu/control path mismatch** — native menu invoked `product-control` from a different install tree than the running tip (`airodrom-menu-icon-size` vs `airodrom-menu-status-525458c`).
2. **False MCP-not-ready presentation** — `scripts/macos/product-control.cjs` always serialized `mcp.ready:false` on Connected status, contradicting live `/api/mcp/health`.
3. **Capability expectation gap (pre-cutover)** — tip `525458c` has 25 MCP tools; Personal Memory MCP tools (27-tool surface) exist only on qualified candidate `3dc3e8c` and remain **CUTOVER HOLD**.

Not observed as root cause: failed cutover, LaunchAgent path corruption, Node version mismatch, database integrity failure, duplicate supervisors, or MCP health false.

## 3. Evidence (live)

| Check | Result |
| --- | --- |
| Process | Single `local-service.cjs` PID **26414**, Node **22.23.3**, tip `…/airodrom-menu-status-525458c` |
| Discovery port | **60487** (`~/.airodrom/data/ui.json`) |
| `/api/status` | `healthy: true` |
| `/api/mcp/health` | `ready: true`, pid matches service |
| `/api/product/native-status` | Control / Runtime / Memory / Provider **Ready**; connection **CONNECTED**; model `ollama/qwen3-coder:30b` |
| LaunchAgent `local.airodrom.desktop-login` | One-shot exited 0 (KeepAlive false); ProgramArguments still tip `desktop-login.cjs` |
| `memory.sqlite` | `PRAGMA integrity_check` = **ok** |
| Active runs / quarantined leases | **0 / 0** |
| Tunnel client | Present (not rotated) |
| Qualification backup | `qualification/backup-20261011T210830Z` retained; cutover still HOLD |

## 4. Recovery actions (authorized scope)

Performed without tip cutover or credential/tunnel rotation:

1. Confirmed backup/data directory ownership preserved; no lock deletion; no second supervisor.
2. Cleared orphaned `product-control.cjs status` polls.
3. Re-prepared native menu from the **running tip** (`prepare-local-menu.cjs`) so `AirodromControl` matches tip `product-control.cjs`. Relunched menu only; service PID unchanged.
4. Patched tip + branch `product-control.cjs` to probe `/api/mcp/health` for `mcp.ready` (presentation repair).
5. Added menu control-path alignment helpers + regression test on the feature branch.
6. Did **not** switch LaunchAgent to candidate `3dc3e8c` (requires explicit cutover authorization).

## 5. Current running version

| Item | Value |
| --- | --- |
| Running commit / install | `525458c` / `airodrom-menu-status-525458c` |
| Service identity | `local-service.cjs` PID 26414 |
| Discovered port | **60487** |
| Menu control path | tip `…/525458c/scripts/macos/product-control.cjs` |
| Candidate (not installed) | `install/airodrom-master-completion-3dc3e8c` @ `3dc3e8c` |
| Feature branch | `feat/master-personal-ai-completion` on PR #70 (recovery landed in `552266d`) |
| PR | [#70](https://github.com/airodrom/airodrom/pull/70) |

## 6. Service health

| Claim | Classification |
| --- | --- |
| Exactly one authoritative service | **VERIFIED LIVE** |
| Healthy dynamic discovery | **VERIFIED LIVE** |
| MCP HTTP ready | **VERIFIED LIVE** |
| OpenCode runtime Ready | **VERIFIED LIVE** |
| Local Qwen / Ollama Ready | **VERIFIED LIVE** |
| Control Center HTML serves | **VERIFIED LIVE** |
| Control Center authorized session in automation browser without private link | **BLOCKED** (by design; reopen via menu) |
| Always-on LaunchAgent one-shot semantics | **VERIFIED LIVE** |

## 7. MCP inventory

| Surface | Count | Classification |
| --- | --- | --- |
| Live tip tool catalog | **25** | **VERIFIED LIVE** |
| `personal_memory_search` / `personal_memory_get` on tip | absent (`Tool is not exposed`) | **VERIFIED LIVE** |
| Candidate catalog | **27** including personal memory tools | **VERIFIED OFFLINE** (install tree / prior qualification) |
| MCP session create | HTTP 200 | **VERIFIED LIVE** |
| ChatGPT connector end-to-end refresh | not claimed from local-only probes | **BLOCKED** (human ChatGPT client refresh if needed after cutover) |

## 8. Memory test results (synthetic only)

Exercised against live tip APIs; no real personal memories deleted.

| Step | Result | Classification |
| --- | --- | --- |
| Remember | `/api/interactive/remember` 201 | **VERIFIED LIVE** |
| Retrieve / search | `/api/interactive/memory` found synthetic fact | **VERIFIED LIVE** |
| Correct / update | `/api/personal-memory/:id/update` active with corrected content | **VERIFIED LIVE** |
| Fresh conversation with memory | local Qwen turn completed (`summary` present) | **VERIFIED LIVE** |
| Forget | `/api/personal-memory/:id/forget` → `forgotten`; search empty | **VERIFIED LIVE** |
| Logical purge only | `contentRemoved` / forgotten status; no physical wipe claim | **VERIFIED LIVE** / **NOT IMPLEMENTED** (physical) |
| MCP personal memory tools | not on tip 25-tool surface | **BLOCKED** until authorized cutover |

Note: `/api/product/correct-memory` supersedes with a **new** id; forget must target the current id. Product forget against a superseded id returns authority refusal — use personal-memory update/forget paths for identity-accurate lifecycle.

## 9. Mission test results

| Step | Result | Classification |
| --- | --- | --- |
| Create bounded reasoning task (`create_task`, isolated, `reasoning_only`) | accepted, unique `task_id` | **VERIFIED LIVE** |
| Worker / provider execution | local Ollama `qwen3-coder:30b`, `result_ready` | **VERIFIED LIVE** |
| Duplicate execution | not observed (`duplicate:false` on create) | **VERIFIED LIVE** |
| Host Acceptance | `accepted:false` on reasoning admission path (expected; not auto-Acceptance) | **VERIFIED LIVE** |
| No interruption of existing user Missions | active_missions 0 during probe | **VERIFIED LIVE** |

## 10. Web Chat / Control Center

| Claim | Classification |
| --- | --- |
| App/HTML opens on discovered port | **VERIFIED LIVE** |
| Authenticated conversation via `/api/assistant/input` → completed with local Qwen (`PONG`) | **VERIFIED LIVE** |
| Memory controls via product/personal-memory APIs | **VERIFIED LIVE** |
| Desktop browser automation without private hash | shows Authorization required | **VERIFIED LIVE** (expected) |
| Physical iPhone | **NOT IMPLEMENTED** / not claimed |

## 11. Always-on status

| Claim | Classification |
| --- | --- |
| Tip LaunchAgent registration retained | **VERIFIED LIVE** |
| No duplicate local-service | **VERIFIED LIVE** |
| Graceful stop not forced during recovery | **VERIFIED LIVE** |
| Rollback / candidate install retained offline | **VERIFIED OFFLINE** |
| Intentional production crash injection | not performed | **NOT IMPLEMENTED** (by policy) |

## 12. Regression tests

| Change | Location |
| --- | --- |
| Menu `AirodromControl` alignment helpers | `scripts/macos/prepare-local-menu.cjs` |
| Alignment unit test | `tests/menu-control-alignment.test.js` |
| `product-control` MCP ready probe | `scripts/macos/product-control.cjs` |

## 13. Git and PR status

| Item | Status |
| --- | --- |
| Operator checkout `/Users/andrew/code/airodrom` | Preserved dirty / not used for mutation |
| Worktree branch | `feat/master-personal-ai-completion` |
| PR #70 | Updated with this recovery evidence |
| PRs #36–#38 | Untouched |
| Merge | **not** performed |
| Tip cutover | **CUTOVER HOLD** — still requires explicit operator sentence from [AIRODROM-CUTOVER-APPROVAL-V3.md](AIRODROM-CUTOVER-APPROVAL-V3.md) |

## 14. Production changes

| Change | Scope |
| --- | --- |
| Menu re-prepare against tip | `~/.airodrom/menu/Airodrom.app` only |
| Tip `product-control.cjs` MCP ready probe | presentation repair on running install tree |
| Service process / LaunchAgent / DB / credentials / tunnel | **unchanged** |
| Candidate promotion | **not performed** |

## 15. Remaining blockers

1. **CUTOVER HOLD** — promote `3dc3e8c` for 27-tool MCP (personal memory tools) only after explicit authorization.
2. **ChatGPT-side connector refresh** — local MCP readiness ≠ ChatGPT UI verification; human refresh may still be required after cutover.
3. **Authorized Control Center browser session** — automation without the private menu link remains unauthorized by design.
4. WhatsApp production ingress remains **HOLD** per prior policy.
5. **PATH `airodrom` still stale** — points at `airodrom-menu-v3` while tip is `525458c`. Client-attach fix is on PR #70 and verified via `node …/scripts/airodrom.cjs`. Replacing the global command needs explicit `npm unlink -g airodrom` + `npm run install:local` authorization ([CLI-CLIENT-RELIABILITY-V1.md](CLI-CLIENT-RELIABILITY-V1.md)).

## Classification summary

| Area | Result |
| --- | --- |
| Service healthy | **VERIFIED LIVE** |
| Control Center connected (menu → tip control) | **VERIFIED LIVE** |
| Personal Memory (Control Center / personal-memory APIs) | **VERIFIED LIVE** |
| Personal Memory MCP tools on tip | **BLOCKED** (25-tool tip) |
| MCP ready | **VERIFIED LIVE** |
| Missions (bounded synthetic) | **VERIFIED LIVE** |
| Local model available | **VERIFIED LIVE** |
| Always-on stable | **VERIFIED LIVE** |
| PR #70 updated | **VERIFIED LIVE** (after push of this commit) |
