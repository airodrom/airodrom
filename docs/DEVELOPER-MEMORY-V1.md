# Developer Memory V1

Governed, local-first **repository knowledge** for coding Missions. Hindsight (when present) is a subordinate provider. Airodrom remains authoritative for identity, authorization, context assembly, corrections, suppression, and agent execution.

## Roles

| Plane | Role |
| --- | --- |
| **Personal Memory V2** | Authoritative user memory. Unchanged. Never migrated into Hindsight. |
| **Developer Memory V1** | Repository-scoped engineering evidence via a replaceable adapter. |
| **Context Engine** | Authoritative retrieval and ContextPack authorization. |
| **Workers** (OpenCode, Claude Code, Codex, Cursor when qualified) | Consumers of authorized ContextPack refs only. No direct Hindsight access. |

```
                  AIRODROM
                     |
              Authority Plane
                     |
          Identity / Authorization
                     |
               Context Engine
                     |
        +------------+-------------+
        |                          |
  Personal Memory V2       Developer Memory V1
        |                          |
  Canonical Airodrom       Hindsight adapter (optional)
  personal records                 |
        |                   Repository banks
        +------------+-------------+
                     |
             ContextPack Builder
                     |
          Provenance / Trust Labels
                     |
           Authorized Context Only
                     |
             Agent Runtime Layer
```

## Feature flags

Config file: [`config/developer-memory-v1.json`](../config/developer-memory-v1.json).

| Flag | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Master switch. When false, behavior matches pre-feature main. |
| `provider` | `hindsight` | Only `hindsight` or effectively none when disabled. |
| `allow_ingest` | `false` | Explicit retain of approved source kinds. |
| `allow_retrieval` | `false` | Prefetch / ContextPack contribution. |
| `allow_external` | `false` | Non-loopback Hindsight hosts. Never auto-enabled. |
| `require_operator_approval_for_destructive` | `true` | Suppress/delete require host-minted single-use approval. |
| `allowed_repositories` | `[]` | Explicit `{repository_id,bank_id}` allowlist. Empty fails closed while enabled. |

Live owner installation must stay disabled until explicit activation authorization. Global enable/retrieval flags never grant access to repositories absent from `allowed_repositories`.

## Adapter interface

Stable host API (`src/developer-memory.js`):

- `health()` — availability; never claims authority
- `search()` / `retrieve()` — authorized recall
- `retain()` — authorized ingest of allowlisted source kinds
- `suppress()` / `delete()` — logical suppression; provider delete best-effort
- `getProvenance()` — host metadata only (no forgotten content)
- `prefetchContext()` / `contextContribution()` — async prefetch cache + sync ContextPack read

Vendor transport: `src/developer-memory-hindsight.js` (loopback HTTP). No agent plugins, no auto-retain, no cloud fallback.

Pinned API shape: Hindsight **0.10.x** (`/v1/default/banks/{bank_id}/…`). Retain body is `{ items: [{ content, document_id, … }], async: false }`. The npm package is **not** a hard runtime dependency; the host uses a native HTTP transport.

## Repository identity and isolation

Host-derived identity from realpath + `git rev-parse --git-common-dir` + optional `remote.origin.url` hash:

- `repositoryId` = SHA-256 of `{ git_common_dir, remote }`
- `bankId` = `airo-dev-{first 32 hex of repositoryId}`

Subdirectories and linked Git worktrees share the same bank via `git-common-dir`. Model-supplied bank IDs are denied. When a host task resolver is bound, caller-supplied `repositoryId`/`bankId` cannot override host identity. After host identity is derived, it must match an entry in `allowed_repositories` (`repository_id` + `bank_id`); otherwise search/retain/prefetch/ContextPack contribution fail closed with `repository_not_allowlisted`. Capability scopes must be present (`repo` or `developer_environment`). Destructive suppress/delete require a **host-minted single-use** `operatorApprovalId`. Minting is only allowed through the authenticated operator control-plane action `developer-memory-mint-approval` (Symbol-gated `mintOperatorApproval`). Models, workers, MCP, and bare in-process callers cannot manufacture consent. A caller-supplied `operatorApproved: true` boolean is rejected. ContextPack contributions revalidate host repository identity and allowlist membership and drop stale cache on identity change/revocation. Cross-repository retrieval fails closed.

## Authorization

Authorize **before** retain and retrieval against task identity, repository identity, capability scopes (`repo` or `developer_environment`), operation, source kind, suppression rules, context budgets, and active policy version. Memory content never grants permissions. Fail closed when identity is missing.

Allowed ingest source kinds (explicit only): architecture decision records, approved technical documentation, verified Git commits, accepted implementation results, confirmed bug fixes, approved engineering notes. Secrets denied via `looksSecret`. No automatic conversation harvest, Git walk, or package updates.

## ContextPack integration

`MissionService` calls `prefetchForMission` before OpenCode/Claude ContextPack assembly. `ControlContext` then appends developer-memory refs only when:

1. Feature + retrieval are enabled
2. A fresh host prefetch exists for the task
3. Contribution revalidates policy, scopes, and suppressions
4. Contribution status is `ok`

Refs are labeled `UNVERIFIED_RETRIEVED_CONTENT` (or host retain trust labels), `authority: false`, and cannot grant execution. Prefetch is async; pack assembly remains synchronous. Suppress/delete invalidate affected caches immediately.

Trust vocabulary: `CANONICAL_PROJECT_FACT`, `VERIFIED_ENGINEERING_EVIDENCE`, `HISTORICAL_DECISION`, `SUPERSEDED_DECISION`, `UNVERIFIED_RETRIEVED_CONTENT`, `MODEL_INTERPRETATION`, `UNKNOWN`.

## Correction, suppression, deletion

Host SQLite tables (metadata only — **no forgotten content body**):

- `developer_memory_items` — ids, hashes, provenance, status
- `developer_memory_suppressions` — content_hash / document / provider refs
- `developer_memory_meta` — schema version

Suppressed items are excluded from search, ContextPack cache, and summaries. Delete: suppress immediately → invalidate cache → request Hindsight document delete when supported → keep suppression until confirmed. Forensic erasure is never claimed (`forensic_erasure_claimed: false`).

## Local-first Hindsight

Prefer loopback (`http://127.0.0.1:8888`) with local inference (Ollama) when the operator later installs a disposable Hindsight server. This PR does **not** launch daemons, install LaunchAgents, or mutate the live Airodrom service.

If local inference is unavailable: keep flags false; mocked contract tests still pass. Never silently route to cloud.

### Runtime cost (when activated later)

| Item | Expectation |
| --- | --- |
| Disk | Hindsight bank storage + embeddings (operator-sized) |
| RAM / CPU | Separate from Airodrom; not started by this feature |
| Network | Loopback only unless `allow_external` authorized |
| Airodrom overhead | Negligible when disabled; bounded HTTP + budgets when enabled |

## Multi-agent

OpenCode / Claude Code / Codex adapters do not import Hindsight. They receive ContextPack refs from the host. Standalone coding sessions outside Airodrom are **not** covered by this policy. Cursor governed execution remains separately qualified.

## Failure modes

| Condition | Behavior |
| --- | --- |
| Feature disabled | Empty contribution; Personal Memory unchanged |
| Provider down / circuit open | `unavailable`; no fabricated context |
| External URL without flag | Transport policy error |
| Bank mismatch / model spoof | Deny |
| Oversized response | Truncate / drop under budgets |

## Rollback

Set `enabled`, `allow_ingest`, and `allow_retrieval` to `false` (defaults). Remove optional transport config. Host tables are additive metadata; Personal Memory V2 is untouched. No live cutover in this PR.

## Control Center observability

Overview and Memory views render live **memory layers** (Personal V2, Project V2, Architecture/canonical, ContextPack 1h, Developer Memory V1) with usage percent bars and retained counts. Capacities are **reference soft** observability ceilings (not hard enforcement quotas), labeled in UI/API as `capacity_kind: "reference_soft"`. Layer states use evidence: `Disabled`, `Configured`, `Ready`, `Degraded`, `Unavailable`. `product-observability.memoryStatus` exposes `layers[]` and never includes memory content. Developer Memory stays **Disabled** until operator flags allow it.

## Test evidence class

- `tests/developer-memory-v1.test.js` — **MOCKED CONTRACT PASS** (HTTP shapes, worktree identity, host-bound auth, Mission prefetch, host-verified destructive approval negatives, Control Center layer metrics).
- Disposable **REAL LOCAL HINDSIGHT PASS** (2026-10-12): `ghcr.io/vectorize-io/hindsight:0.10.2` on loopback `:8888` with host Ollama (`qwen2.5-coder:14b`); transport health + ensureBank + retain + recall succeeded. Container removed after the smoke. Image retained locally for reuse. No cloud fallback. **Not owner-installation verified**; feature flags remain off.

See [ADR 0046](adr/0046-developer-memory-hindsight.md) and [KNOWN-LIMITATIONS](KNOWN-LIMITATIONS.md).
