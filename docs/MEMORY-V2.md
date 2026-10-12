# Memory V2 and privacy

PersonalMemory is explicit scoped reference data. Project Memory V2 provides task-scoped checkpoints and reuse with provenance. Canonical architecture excerpts are validated against pinned public source documents. Conversation retrieval supplies reference context; it does not automatically import or promote history. Candidate proposals require host review.

Memory selection enforces domain/project/privacy and byte/top-k limits. Unknown scope, stale lifecycle disposition or incomplete propagation deny retrieval and dispatch. Neither stored content, embeddings, summaries nor model assertions can change authority, approve tools, choose a forbidden runtime or satisfy Acceptance.

New candidate, memory and ContextPack identities are random UUIDv4. Legacy content-derived identities migrate against independent opaque origins; retained aliases and recoverable old content fingerprints are forbidden. Unknown origins stay unavailable. Active dedupe is erasable payload comparison rather than a permanent reconstructive identity.

Remember, correction, forget, expiry and host erasure are distinct operations. Correction-family erasure validates connected scope and applies retryable dispositions. Covered audit/context, request, result, notification, provenance and replay representations are redacted; minimum non-content operation/order/scope/outcome metadata may remain. Supported restore requires independent current authority before constructing services. See [ADR 0004](adr/0004-memory-erasure-retention.md) and [privacy and erasure](PRIVACY-ERASURE.md).

## Correction identity (current fact)

Ordinary remember and `Correction:` statements share a deterministic fact key derived from the statement (for example `favorite test planet`), not from an LLM ranking choice. A correction supersedes every other active personal row with that fact key, stores a canonical current statement, and retains prior content as `superseded` provenance. Current `/memory` listings, conversation context assembly, and ContextPack selection collapse concurrent actives by fact key and keep only the newest winner.

Existing dual-active conflicts (legacy writes that stored a correction under a distinct subject) are never rewritten automatically. Operators may inspect a copy with:

`node scripts/reconcile-memory-corrections.cjs --db <sqlite>`

Apply is opt-in only (`--apply --confirm-apply`) and must not target the live operator home without explicit authorization. See [MEMORY-CORRECTION-V1.md](MEMORY-CORRECTION-V1.md).

## Worker / MCP read contracts (canonical)

Personal Memory and legacy checkpoint search share one broker validation surface. Unknown keys are rejected. Argument values are never written to diagnostics.

| Tool | Required | Optional | Notes |
| --- | --- | --- | --- |
| `personal_memory_get` | `memoryId` | — | Read one active ordinary record in task scope. |
| `personal_memory_search` | `query` | `domain`, `limit` | `domain` defaults to `personal` at execution. `limit` is an integer 1–20 (default 6). Alias `q` → `query` only. |
| `personal_memory_recent` | — | `domain`, `limit` | `domain` defaults to `personal`. `limit` 1–20 (default 6). |
| `memory_search` | `query` | `limit` | Legacy task/checkpoint search. `limit` 1–20 (default 4). Not a Personal Memory dump. |
| `project_list` | — | `status` | Empty `items` when the task has no `projectId` is expected, not a memory failure. |
| `project_get` / `project_summary` | `projectId` | — | Task must be linked to that project. |
| `project_next_action` | — | — | Suggestion-only; no dispatch authority. |
| `inspect_context_pack` | `context_pack_id` | — | MCP read-only inspector; does not grant authority. |

ChatGPT shapes `{ query, limit }` for search and `{ limit }` for recent are valid. Extra keys (paths, offsets, free-form filters) remain denied.

## Context assembly

Host-built ContextPacks select bounded authorized refs: current request, conversation continuity, ranked personal/project memory, architecture excerpts, and provenance. Workers receive the approved pack only. They do not mount the Personal Memory database, bypass broker scope checks, or promote model interpretation into durable memory without policy + approval.

Retrieval classes remain distinct: verified fact, current canonical memory, historical/superseded memory, user-provided unverified information, model interpretation, and unknown. Forgotten or superseded rows must not reappear through FTS, caches, ContextPack rebuild, or worker snapshots as current facts. Logical suppression is not claimed as forensic wipe.

## Acceptance evidence

Synthetic acceptance lives in `tests/memory-tool-contracts-v2.test.js` and `tests/context-memory-v2-acceptance.test.js`. Passing those suites proves **SOURCE FIXED** under disposable fixtures. It does not prove the owner installation already runs this tip — that requires an authorized cutover and read-only live checks. Never mutate the live personal-memory store for qualification.
