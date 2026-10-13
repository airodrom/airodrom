# MCP Catalog Integrity & Release Verification V1

## Purpose and authority

This is a **read-only**, install-aware MCP tool-discovery gate. It NEVER calls `tools/call`, dispatches a Mission, rotates credentials, starts/stops the control plane, changes Memory V2, or reconnects ChatGPT. A successful local discovery does not demonstrate an authorized/working Mission.

Airodrom's MCP CLI is `airodrom mcp`, a local stdio MCP process. The configured ChatGPT working directory does **not** select the executable: the effective PATH or explicit command does. The npm-linked `scripts/airodrom.cjs` locates its own `src/mcp.js` relative to the executable's **real path**. The control-plane service may be healthy while the ChatGPT tool registry is old.

## Run the gate

From a clean release checkout or installed build:

```sh
node scripts/mcp-catalog-verify.cjs
node scripts/mcp-catalog-verify.cjs --installed /absolute/verified/install/scripts/airodrom.cjs
node scripts/mcp-catalog-verify.cjs --client /absolute/path/to/client-public-catalog.json --require-client
```

The script resolves the CLI using its own process PATH (or the explicit absolute executable), checks the realpath and install layout, loads the source and installed *public* tool schemas, and starts a fresh `airodrom mcp` child. The child receives only MCP `initialize`, `notifications/initialized`, and `tools/list`. The script never sends `tools/call`. Child output has timeout/size limits. An unrelated executable is refused. Nothing is installed or changed.

Client input is an optional **manually supplied** JSON array of MCP tool definitions, or `{"tools":[...]}` or `{"names":[...]}`. Supply only public tool metadata, never credentials, message payloads, private memory, or MCP sessions. Names-only lists permit comparison of names but do not prove schema equality.

The result is structured JSON with stage counts, sorted tool names, name and inputSchema digests, per-boundary missing/extra tools, precise schema-changed names, source and installed Git SHA when available, and first observed mismatch. Paths are hidden by default and represented by a path digest; use `--show-paths` **only** for local operator debugging. Do not publish private paths. No permanent hardcoded 43-tool requirement exists: each release is measured against its pinned source and installed catalog.

### Status semantics

| Field | Meaning |
| --- | --- |
| `local_status=PASS` | Source, installed definitions, and **fresh** MCP response all match (and any available validated SHA matches). |
| `local_status=MISMATCH` | A known version or catalog difference exists. |
| `local_status=UNVERIFIED` | One or more required local observations were unavailable. |
| `client_status=PASS` | Supplied client names **and input schemas** match fresh advertised schemas. |
| `client_status=MISMATCH` | Supplied client evidence shows missing/extra names or changed schemas. |
| `client_status=UNVERIFIED` | No client catalog or only name-level evidence. |
| `status=UNVERIFIED` | Not all four layers have independent, schema-complete evidence. This does NOT mean broken. |
| `gate=PASS` | Local verification succeeded; client is optional unless `--require-client` was requested. |

Exit code 0 means the selected gate passed, **not necessarily complete end-to-end proof**. Exit code 2 means blocked/error. Collect the JSON receipt without modifying live processes.

## Troubleshooting decision tree

1. `source -> installed` differs: confirm the **actual realpath** and npm link under the **MCP process PATH**, rather than the operator's shell only. An old checkout used as working directory is not itself proof that the executable is old. Confirm the release checkout/installed SHA; never relink to a dirty checkout.
2. `installed -> advertised` differs: a process may have a stale tool snapshot, the wrong launcher may be invoked, or the executable may be incomplete. Inspect its invocation and MCP protocol output before considering a controlled reconnect. Do **not** restart the control plane or OpenCode by default.
3. `advertised -> client` differs: ChatGPT may have stale metadata, the connection may be targeting another install, or tool filtering may apply. This tool cannot distinguish those causes from catalog evidence alone. First **start a new ChatGPT conversation** and recheck. If still mismatched, use **Settings → Plugins → Airodrom → Refresh** when available, then a new conversation. Do not delete credentials or reinstall by default. See [official ChatGPT plugin refresh guidance](https://developers.openai.com/plugins/deploy/connect-chatgpt#refresh-metadata).
4. `client=NOT_OBSERVED`: never assert the ChatGPT catalog is healthy from the server's perspective. Verify the tools in an independent new client session or supply its public catalog receipt.
5. After an authorized, normal release cutover, check the fresh CLI and client again. Do not cut over an installation solely to satisfy this diagnostic.

## Release acceptance

- Record clean source and installed SHA and executable realpath in **private** operator evidence.
- Run `node --test tests/mcp-catalog-integrity.test.js` and existing MCP regression tests using the repo's normal runner.
- Run the fresh release gate at the **deployed install**; compare hashes and names. No permanent count constant.
- Start a new ChatGPT conversation and verify coordinator tools including `prepare_mission`, `get_mission_evidence`, `ask_airodrom`, and `get_mission_status`. A read-only tool call is optional and must not execute a Mission.
- Attach the client public-catalog receipt where available; otherwise mark **CHATGPT UNVERIFIED**, not PASS.
- Keep source tests, live install evidence, and client-registration observations distinct. Human Acceptance and Mission authorization are separate.

## Connector description

If ChatGPT's Airodrom plugin description still says “25 tools,” that metadata is a **ChatGPT-managed local plugin setting**; changing the GitHub source does not rewrite it. Replace the owner-visible description, when editable, with:

> Airodrom provides governed local AI Missions, personal memory references, agent orchestration, host capabilities, and independently verifiable results through MCP.

Never hardcode a mutable tool count in the connector description. No connector uninstall or reauthentication is needed for this wording change.

## Safety limitations

This release check starts a disposable **read-only MCP stdio process** but never restarts or mutates the running service. It does not infer a caching root cause from one mismatch, does not prove remote-client execution ability, and cannot independently inspect ChatGPT's registered tools. Keep Mission state and live production untouched. After review, release and installation require separate authorization.
