# Airodrom Final Acceptance V2

Master finalization evidence for Personal AI readiness. Distinguishes live tip observations from offline/fixture verification. **Production tip was not cut over.**

## 1. Repository baseline

| Item | Value |
| --- | --- |
| Remote | `https://github.com/airodrom/airodrom.git` |
| `origin/main` | `525458c` |
| Feature branch | `feat/master-personal-ai-completion` |
| Operator checkout | `/Users/andrew/code/airodrom` — dirty / behind; **unchanged** |
| Worktree | `…/airodrom-master-completion/work/airodrom-completion` |
| Package version | `1.0.1-rc.1` |
| Open drafts preserved | #36 startup, #37 DeepSeek, #38 v1.8 ops — **not merged** |

## 2. Branch / commits / PR #70

| Item | Value |
| --- | --- |
| Prior commits | `3f81b57`, `fc38e27`, `305f03c`, `a4faf15` |
| This wave | (see tip after push) — legacy-identifier allowlist, removed-runtime fixture cleanup, cutover plan, this report |
| PR | https://github.com/airodrom/airodrom/pull/70 |
| Base | `main` |
| Mergeability | `MERGEABLE` / `CLEAN` (observed) |
| Draft | yes (until owner review) |
| AI attribution in PR body | removed |
| Required CI checks | `candidate-validation`, `secret-history`, `dependency-license` (docs/CI-BRANCH-PROTECTION.md); **no checks reported** on draft branch at last observation |

## 3. Classification legend

- **VERIFIED LIVE** — observed against the installed running tip / real local endpoints
- **VERIFIED OFFLINE** — fixtures, disposable Bridge, or branch stdio without ChatGPT
- **IMPLEMENTED BUT NOT VERIFIED** — code present; not exercised in this wave
- **BLOCKED** — requires operator auth or external session
- **NOT IMPLEMENTED** — absent by design or missing

## 4. Personal Memory V2

| Claim | Classification | Evidence |
| --- | --- | --- |
| Remember / search / retrieve / correct / update / forget | **VERIFIED OFFLINE** | `tests/personal-memory.test.js`, erasure lifecycle, MCP personal-memory fixtures |
| Persist / recover / scope isolation | **VERIFIED OFFLINE** | `tests/memory-erasure-lifecycle.test.js`, `tests/memory-erasure-layers.test.js` |
| Cross-runtime OpenCode context | **VERIFIED OFFLINE** | `tests/opencode-memory-v2.test.js` (with `NODE_ENV=test`) |
| Erasure layers suppression / cache / retention / logical purge | **VERIFIED OFFLINE** | `src/memory-erasure.js` `classifyAction` / `layerStatus`; `docs/PRIVACY-ERASURE.md` |
| Physical deletion | **NOT IMPLEMENTED** (unclaimed) | Product APIs set `physicalErasure: false`; WAL/SSD/forensic wipe not claimed |
| Live operator memory | **NOT** exercised | Synthetic records only |

## 5. MCP tool inventory

### Branch (feature)

Canonical 27-tool list (stdio catalog-only, **not** ChatGPT-originated):

`create_task`, `continue_task`, `get_task_status`, `approve_once`, `reject`, `cancel_task`, `get_task_events`, `acknowledge_task_event`, `native_tool_invoke`, `capability_invoke`, `capability_status`, `capability_inventory`, `agent_status`, `get_agent_results`, `get_agent_dispatches`, `claim_agent_dispatch`, `report_agent_dispatch`, `get_provider_status`, `get_reasoning_admissions`, `list_architecture_memories`, `inspect_context_pack`, **`personal_memory_search`**, **`personal_memory_get`**, `get_worker_catalog`, `submit_mission`, `get_mission_handoff`, `cancel_mission_handoff`

Command: `NODE_ENV=test node scripts/run.cjs tests/live-mcp.js --catalog-only` → `toolCount: 27`, `chatgptOriginated: false`.

Classification: **VERIFIED OFFLINE**

### Installed tip (`airodrom-menu-status-525458c` @ `525458c`)

| Observation | Result |
| --- | --- |
| Tip `src/mcp-tools.js` tool count | **25** |
| `personal_memory_*` in tip source | absent |
| MCP `/api/mcp/health` | `ready: true` (**VERIFIED LIVE**) |
| `agent_status` / `get_provider_status` / `get_worker_catalog` | HTTP 200 (**VERIFIED LIVE**) |
| `personal_memory_search` / `personal_memory_get` | **Tool is not exposed** (**VERIFIED LIVE**) |
| Cause of 25 vs 27 | **Older deployed code** (tip SHA), not registration alone |

ChatGPT-originated handshake: **BLOCKED** (requires tip cutover + ChatGPT session; not fabricated).

## 6. Missions / Acceptance

| Claim | Classification | Evidence |
| --- | --- | --- |
| Canonical lifecycle + aliases | **VERIFIED OFFLINE** | `src/mission-lifecycle.js`; `tests/mission-lifecycle-unify.test.js` |
| Bounded Mission + independent Acceptance | **VERIFIED OFFLINE** | `tests/bounded-mission-completion.test.js` |
| Restart preserves awaiting_acceptance | **VERIFIED OFFLINE** | same |
| Agents cannot self-accept | **VERIFIED OFFLINE** | evidence required on accept |
| Live external dispatch | **BLOCKED** / not authorized | fixtures use allowlisted synthetic workers |

## 7. Runtimes / providers

| Runtime | Classification | Notes |
| --- | --- | --- |
| OpenCode | **VERIFIED OFFLINE** (primary) | Default; tip also exposes via `agent_status` |
| Pi | **VERIFIED OFFLINE** removed | ADR 0008; `removed-runtime` gate; legacy identifiers allowlisted |
| Cursor / Codex / Claude Code / Ollama | **IMPLEMENTED BUT NOT VERIFIED** live | Status keys present on tip `agent_status`; no paid enablement |
| Privacy / no unauthorized memory egress | **VERIFIED OFFLINE** (policy) | Memory tools ordinary-only; writes capability-scoped |

## 8. Always-on

| Claim | Classification | Evidence |
| --- | --- | --- |
| LaunchAgent identity | **VERIFIED LIVE** | `local.airodrom.desktop-login` → tip `525458c` install |
| MCP tunnel process present | **VERIFIED LIVE** | process observed; credentials not printed |
| Disposable lifecycle drain/recovery | **VERIFIED OFFLINE** | `tests/always-on-offline-qualification.test.js`, `tests/service-lifecycle-v1.test.js` |
| Installed cutover | **BLOCKED** | Plan: `docs/INSTALLED-TIP-CUTOVER-V2.md` — requires explicit auth |

## 9. Web Chat

| Claim | Classification | Evidence |
| --- | --- | --- |
| Responsive / Conversation / auth-loss paths | **VERIFIED OFFLINE** | `tests/product-browser.cjs` (Playwright when available); `tests/web-chat-iphone-emulation.test.js` |
| iPhone physical device | **NOT IMPLEMENTED** / not claimed | Emulation only (320 / 390) |
| Public exposure | none | Private Control Center |

## 10. Capabilities / security

| Claim | Classification | Evidence |
| --- | --- | --- |
| Capability Broker scopes | **VERIFIED OFFLINE** (existing suites) | `tests/personal-assistant-v1.test.js`, hardening bundle |
| WhatsApp | **BLOCKED** HOLD | Canada GP AI not supported |
| Unauthorized MCP memory on tip | fail closed | **VERIFIED LIVE** “Tool is not exposed” |
| Prompt injection / isolation | **VERIFIED OFFLINE** | memory privacy / erasure suites |
| Public secret leakage via this PR | not introduced | no credentials committed |

## 11. Tests

Focused acceptance command (representative):

```bash
NODE_ENV=test node --test --test-timeout=120000 \
  tests/mission-lifecycle-unify.test.js \
  tests/memory-erasure-layers.test.js \
  tests/web-chat-iphone-emulation.test.js \
  tests/always-on-offline-qualification.test.js \
  tests/bounded-mission-completion.test.js \
  tests/mcp-personal-memory.test.js \
  tests/mcp-schema.test.js \
  tests/personal-memory.test.js \
  tests/personal-memory-worker-tools.test.js \
  tests/personal-memory-bridge.test.js \
  tests/orchestrator-mcp.test.js \
  tests/mcp-integration.test.js \
  tests/opencode-memory-v2.test.js \
  tests/service-lifecycle-v1.test.js \
  tests/removed-runtime.test.js
```

Also: `npm run typecheck:authority`, `npm run typecheck:sdk` (pass observed).

Historical tip debt in `removed-runtime` legacy allowlist addressed in this wave; fixture shutdown cleanup for intentional quarantine documented in test.

## 12. CI

Draft PR #70 showed **no checks reported** at last poll. Required protected-branch checks remain as documented; owner should ensure candidate workflow runs before merge. Expensive full `npm test` not duplicated here when focused + typecheck evidence suffices for this wave.

## 13. Production state

**UNCHANGED.** Tip `airodrom-menu-status-525458c` still serves MCP. Feature branch not installed. Credentials / tunnels / connector registrations not modified.

## 14. Remaining limitations

1. Tip cutover required for live 27-tool ChatGPT surface.
2. ChatGPT-originated MCP session not exercised from Cursor.
3. Physical iPhone soak not done.
4. WhatsApp HOLD.
5. Draft PRs #36–#38 independent.
6. Physical memory wipe unclaimed by design.

## 15. Exact operator actions

1. Review draft PR #70 (human review; do not auto-merge).
2. Authorize tip cutover per `docs/INSTALLED-TIP-CUTOVER-V2.md` if desired.
3. After cutover: ChatGPT MCP `tools/list` must show 27 tools including `personal_memory_search` / `personal_memory_get`.
4. Keep WhatsApp HOLD; leave operator checkout alone.
5. Do not merge #36–#38 as part of this acceptance.
