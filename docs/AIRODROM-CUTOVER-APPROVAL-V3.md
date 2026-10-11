# Cutover approval gate V3 — CUTOVER HOLD

**This document is a request for authorization. It is not authorization.**
No LaunchAgent or installed-service change has been applied.

## Exact versions

| Role | Value |
| --- | --- |
| Current installed tip | `…/airodrom-menu-status-525458c` @ **`525458c`** |
| Current package | `1.0.1-rc.1` |
| Live Control Plane | pid **26414**, discovery port **60487** (not 3333) |
| Live MCP health | **ready: true** |
| Active writers | **0** runs, **0** quarantined leases, admission **open** |
| Local-service count | **1** |
| Candidate commit (PR #70) | **`3dc3e8c1c41d5a4321620a85838ee500ba2a9a07`** |
| Candidate install | `…/airodrom-master-completion/install/airodrom-master-completion-3dc3e8c` |
| Candidate MCP tools | **27** including `personal_memory_search`, `personal_memory_get` |

## Qualification evidence (candidate)

- Typechecks: authority + sdk **pass**
- Focused suite: **91 passed**, 1 skipped, 0 failed
- MCP catalog-only (not ChatGPT-originated): **toolCount 27**
- Offline suites cover memory, MCP auth, Mission Acceptance, always-on lifecycle, removed-runtime

## Backup & restore evidence

| Item | Result |
| --- | --- |
| Method | `node:sqlite.backup` (online) of `~/.airodrom/data/memory.sqlite` |
| Integrity | **ok** |
| Isolated restore rehearsal | synthetic remember/search/forget on **copy only**; production path untouched |
| LaunchAgent snapshot | saved under qualification backup dir |
| Old tip preserved | `airodrom-menu-status-525458c` left in place |

Backup root (local, private):  
`…/airodrom-master-completion/qualification/backup-20261011T210830Z`

## Expected interruption

- Brief Control Plane / menu / MCP unavailability during drain → stop → LaunchAgent repoint → start
- ChatGPT MCP may need connector refresh after start (human-only if ChatGPT UI requires it)
- No credential rotation, no tunnel re-key, no WhatsApp change

## Rollback

1. Drain/stop new tip  
2. Restore LaunchAgent WorkingDirectory + ProgramArguments to `airodrom-menu-status-525458c` (snapshot on file)  
3. Start prior tip; confirm MCP health ready  
4. Leave `~/.airodrom` data intact  

## Remaining risks

- ChatGPT-originated `tools/list` cannot be proven until after cutover + ChatGPT session  
- Tip menu binary may still need prepare against candidate root after cutover  
- Physical memory wipe remains unclaimed  

## Exact operator authorization required

Reply with an explicit statement equivalent to:

> **Authorize tip cutover on this Mac** from `525458c` / `airodrom-menu-status-525458c`  
> to candidate `3dc3e8c` / `airodrom-master-completion-3dc3e8c`,  
> preserving `~/.airodrom`, MCP token, and tunnel.

Until that message is received, status remains **CUTOVER HOLD**.
