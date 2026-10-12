# Installed tip cutover & rollback (V2)

**Status:** Prepared. **Not authorized.** Production tip remains `airodrom-menu-status-525458c` @ `525458c`.

## Observed live tip (2026-10-11)

| Fact | Observation |
| --- | --- |
| LaunchAgent | `local.airodrom.desktop-login` → install root `…/airodrom-menu-status-525458c` |
| Control Plane PID | `local-service.cjs` under that tip (example pid observed via MCP health) |
| MCP health | `ready: true` with MCP bearer |
| MCP tools on tip source | **25** (`src/mcp-tools.js`); no `personal_memory_*` |
| Live `personal_memory_search` / `get` | HTTP `/api/mcp/call` → **Tool is not exposed** |
| Feature branch | **27** tools (stdio catalog-only + source); includes personal-memory reads |
| Cause of 25 vs 27 | **Older deployed code** (tip SHA `525458c`), not connector cache alone |

## Prerequisites (operator)

1. Explicit cutover authorization for this machine.
2. Confirm no Active Mission writers / quarantined leases (`aiprodrom` / Control Center System Health).
3. Preserve MCP token / tunnel (ADR 0022); do not regenerate tunnel keys unless separately authorized.
4. Dirty operator checkout `~/code/airodrom` remains untouched; use a prepared install tree from PR #70 tip.

## Forward cutover (reversible)

1. `git checkout` / archive tip of `feat/master-personal-ai-completion` (or merged main) into a **new** install directory, e.g. `airodrom-master-completion-<sha>`.
2. Run package prepare / menu prepare against that install root only (do not overwrite the live tree in place).
3. Drain admission on the live service; wait until idle (no unverified runs / quarantined write leases).
4. Stop via owned desktop-login / product-control stop for the **current** tip.
5. Point `local.airodrom.desktop-login` ProgramArguments + WorkingDirectory at the **new** install root; leave KeepAlive policy unchanged unless PR #36 is separately approved.
6. Start owned service; verify `/api/mcp/health` ready and `tools/list` / call surface includes `personal_memory_search` and `personal_memory_get` (27 tools).
7. Confirm tunnel still authenticates; do not re-enroll.

## Rollback

1. Drain + stop new tip.
2. Restore LaunchAgent WorkingDirectory / ProgramArguments to `airodrom-menu-status-525458c`.
3. Start prior tip; verify MCP health ready and historical 25-tool surface.
4. Leave data dir (`~/.airodrom`) intact; no DB wipe.

## Explicitly out of scope without further auth

- Merging PR #36 KeepAlive supervision
- Credential rotation, tunnel re-key, ChatGPT connector re-registration
- Operator checkout replacement
- Public release / registry publish
