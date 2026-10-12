# Zero-Setup Autonomous Work V1

## Product flow

### Terminal (ordinary local execution)

1. Owner runs `airodrom` and types one natural-language instruction.
2. Airodrom resolves an authorized Project/workspace (or asks one short clarification).
3. Terminal shows the exact project, files, worker and permissions.
4. Owner confirms with explicit local `y` / `yes` (model/chat text is never consent).
5. Host registers the WORK scope, binds one Mission + Goal Plan, authorizes CAE, and dispatches OpenCode once.
6. Terminal reports independent verification. Acceptance remains a separate owner decision.

### ChatGPT MCP

1. ChatGPT calls `ask_airodrom` with a natural-language instruction.
2. Airodrom resolves an authorized Project/workspace (or asks one short clarification).
3. Airodrom prepares a bounded WORK template proposal and Goal Plan request.
4. Control Center shows one readable approval card (no UUID form), or Terminal can authorize the same prepared request.
5. Owner confirms **Approve this task** (or Terminal `y/N`).
6. Host registers the WORK template, binds one Mission, authorizes CAE, and dispatches OpenCode.
7. Host verifies independently; Acceptance remains a separate owner decision.

Preparation is never permission. ChatGPT text never grants execution.

## MCP catalog refresh

Local stdio advertises `tools.listChanged=true` and a `catalog: zero-setup-v1` serverInfo marker.
ChatGPT may still keep a conversation-scoped snapshot of an older tool list.

If `ask_airodrom` is missing after install:

1. Confirm the connector points at the current npm-linked `airodrom` / install tip.
2. Restart the MCP tunnel from Control Center diagnostics guidance.
3. Start a **new** ChatGPT conversation (in-place catalog refresh is not guaranteed).

## Focused validation

`node scripts/run.cjs --test tests/zero-setup-work.test.js tests/zero-setup-terminal.test.js tests/mcp-schema.test.js`

Fixture success does not grant live Acceptance.
