# Control Center Connectivity V1

## Disconnected root cause

1. **Control Center** treated any failed secondary fetch inside `refresh()` (events, history, observatory) as a full **Disconnected · stale** state, even when `/api/product/overview` succeeded.
2. **External client / MCP** product field is often `Unavailable` (“not checked”) and must never drive service connectivity.
3. **Operator dirty menu** (not this branch) mapped `state != connected || product == nil || lastError` to the title **Disconnected**, which falsely reported disconnect when the service was healthy.

## Fix

- Authoritative states: `CONNECTED`, `RECONNECTING`, `DEGRADED`, `DISCONNECTED`, `MAINTENANCE`, `AUTHORIZATION_REQUIRED` (`src/connection-status.js`).
- Overview success establishes reachability; secondary failures become notices, not disconnect.
- Provider / OpenCode / MCP remain separate health rows.
- Menu Bar V2 uses semantic status tones and never equates optional gaps with disconnect.
