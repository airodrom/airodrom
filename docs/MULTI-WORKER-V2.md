# Multi-Worker V2

Airodrom owns Mission authority, ContextPacks, routing, leases, file changes, independent verification, Acceptance and Settlement. OpenCode remains the default local runtime. Vendor CLIs are optional proposal workers; installation is not qualification.

## Current support

| Worker | Implemented boundary | Live admission |
| --- | --- | --- |
| OpenCode | Existing confined local Ollama runtime | Existing current qualification required |
| Codex | Confined no-tools CLI, structured bounded edit proposals | Opt-in synthetic qualification required; this Mac's confined live check failed |
| Claude Code | Confined no-tools headless CLI, structured bounded edit proposals | Opt-in synthetic qualification required; this Mac's confined live check failed |
| Cursor | Installation discovery and truthful status | Denied: no qualified tool/credential isolation interface |
| ChatGPT | Authenticated MCP V1/V2 request, status and cancellation | Host-approved template and current worker/model qualification required |

No GitHub agent is used. Qualification runs only a locally installed CLI with a disposable public fixture. Codex/Claude inference, if admitted, uses that vendor's service; it is external processing, not local inference. No GitHub Actions, release, publication, deployment or production activation is part of this workflow.

## Owner commands

- `/workers` or `/workers status`: installed, account observation, qualification, expiry, capability and failure reason.
- `/workers qualify codex <exact-model-id> --confirm-public-fixture`: explicitly consent to one public fixture, up to two minutes, in an interactive owner terminal.
- `/workers qualify claude_code <exact-model-id> --confirm-public-fixture`: the same boundary for Claude Code.
- `/workers revoke <id>`: invalidate qualification and abort qualifying/active work.
- `/worker auto|opencode|codex|claude_code`: restrict Work routing to an eligible worker. `/model` independently restricts the model. Vendor preferences apply to public Work; ordinary conversation stays local.
- `/workspace <template.json> --confirm-public-files`: register an explicitly public external-work template in the owner terminal. It fixes project/goal, canonical repository, at most eight existing files, protected verification tasks, worker allowlist and current authority.

The Workers view provides equivalent qualification/revocation controls, real availability and expiry. It never displays credentials, executable paths, fabricated completion percentages, inferred token counts or fabricated costs. Reported token usage is labeled vendor-reported; billing cost and unknown context limits remain unavailable.

## Handoff

`get_worker_catalog` is read-only. `submit_mission` accepts V1 local-only requests and V2 public Work requests. `get_mission_handoff` and `cancel_mission_handoff` remain bound to the originating authenticated MCP session. Packet text never grants authority. Replaying the same request returns the original receipt even after worker expiry/revocation; changing its payload or session cannot duplicate execution.

A V2 packet uses `version:2`, an opaque `request_id`, `mission_class:"WORK"`, `data_class:"public"`, `privacy:"approved_external"`, a public objective, named `project`/`workspace` template aliases and optional qualified worker/model preferences. Raw filesystem authority, credentials and unresolved Memory/reference handles cannot be supplied by a client.

The owner template requires `privacy:"approved_external"`, `data_class:"public"`, `workers:["codex"]` (or Claude Code), canonical project/goal IDs and repository path, `allowed_files`, criteria, registered `verification` tasks and `capability_scopes`. Explicit Mission `authority` must include internet, repository read/write, workspace write and the declared filesystem scope, and expire within fifteen minutes. Any optional Manifest must independently permit the operation. Template registration is signed; it does not bypass normal Mission validation, writer ownership or tests. Expiry is never refreshed by client text.

## Execution and privacy

Discovery reads installation metadata without executing vendor programs. An explicit qualification checks the CLI version inside the sandbox, disables user rules/configuration, hooks, tools, MCP, plugins and session persistence where supported, and validates a real structured alpha-to-beta proposal with the original file unchanged. Supported version pins are Codex 0.160.1 and Claude Code 2.1.286; other versions require a new reviewed policy. A qualified record binds binary hash, actual version, model, policy and a 24-hour maximum lifetime. Fixtures are explicitly synthetic and cannot become production qualification.

Every dispatch rechecks the signed qualification and executes a private hash-verified binary snapshot. Actual source files are never mounted into the vendor CLI workspace. Only declared public file contents (at most eight, 12 KB each), objective and constraints are supplied. Sensitive/path-like content is rejected; the input is bounded at 32 KB. Vendor ContextPacks contain zero personal/project/session Memory records, including when governed Memory is active. Credential-shaped model names and template content are rejected.

Codex may read its own existing private regular owner auth file through an isolated read-only alias; Airodrom never reads or copies its contents, and the sandbox denies writes/rotation. Missing, symlinked, hardlinked or permissively readable auth files are refused. No ambient API keys or other vendor tokens are inherited. Claude cannot fork a Keychain helper or read personal settings; if supported account authentication needs those operations, the adapter remains unavailable. Airodrom does not weaken that boundary to make login appear successful.

The sandbox denies forks, arbitrary child execution, original repository/user files and direct network access. A bounded local CONNECT proxy requires an exact vendor host, public pinned DNS address and matching TLS SNI; unknown hosts, encrypted/missing SNI and private destinations are denied. This constrains transport endpoints; it does not inspect encrypted application methods, paths or HTTP Host. CLI restrictions and successful qualification remain separate necessary controls. Limits: two minutes for qualification, ninety seconds for ordinary execution, sixteen connections, 16 MiB encrypted transport and 64 KB output. Qualification, authority and Manifest expiry abort the running process. Revocation and cancellation abort immediately; uncertain termination quarantines the writer and prevents application.

Only the host broker applies declared changes after current qualification, provenance, model, authority and file-preimage checks. Tools/unknown stream events, undeclared changes and model drift are denied. Tests remain protected. Worker claims never prove tests, Acceptance or Settlement. Failed qualification supersedes the previous session; dispatch failure invalidates it. Restore invalidates all worker qualifications/templates and requires fresh owner consent.

## Browser and research

[Universal Browser V2](UNIVERSAL-BROWSER-V2.md) remains the browser boundary. Qualified vendor Missions can receive separately consented host public-web preflight evidence; that evidence remains with the host and is not currently delivered to external workers. Dedicated browser reuse, owned separate-profile loopback CDP and regular Chrome human inspection remain separate modes. Ordinary Chrome attachment and external OAuth/passkeys remain unavailable; Chrome's default-profile debugging restrictions are respected. Search and PDF stay unavailable without real qualified providers/readers.

Monarch research must distinguish documented public features, observed UI, inference and inaccessible account features, and compare with a specific approved Arecibo revision. This implementation does not log into real Monarch or retrieve financial data. Recommendations are retained for owner review and never automatically implemented in Arecibo.

## Local validation

Run the focused Multi-Worker policy/lifecycle and changed UI tests, existing Mission/authority/OpenCode/Memory-restore/browser regressions, both typechecks, package check and source verification. Obtain two independent local runtime/authority and security/privacy reviews at the candidate commit. Live failure is evidence of unavailability; a passing synthetic suite is not live vendor qualification. Preserve unrelated pre-existing failures and report them separately with main-revision evidence.
