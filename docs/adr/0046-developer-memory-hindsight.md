# ADR 0046: Governed Developer Memory with Hindsight

- Status: Proposed
- Date: 2026-10-12
- Owner: Airodrom maintainers
- Review: Pending
- Affected contracts and components: Context Engine / ContextPack, Capability Broker scopes, Personal Memory V2 (unchanged), OpenCode/Claude Code/Codex workers (consumers only)
- Related decisions: [0004 memory erasure](0004-memory-erasure-retention.md), [0005 OpenCode boundary](0005-opencode-execution-boundary.md), Memory V2 docs

## Context and problem

Coding Missions need durable repository knowledge (ADRs, verified commits, accepted fixes) without giving an external memory product authority over identity, authorization, or ContextPack assembly. Personal Memory V2 must remain the authoritative user memory plane. Agent-vendor Hindsight plugins auto-retain and auto-inject context, which violates Airodrom's authority model.

## Decision

Introduce **Developer Memory V1** as an Airodrom-owned adapter:

1. Stable host interface (`DeveloperMemory`) with health/search/retrieve/retain/suppress/delete/provenance and sync ContextPack contribution from a host prefetch cache.
2. Optional **Hindsight loopback HTTP** transport as a replaceable subordinate provider using API 0.10 paths (`/v1/default/banks/{bank_id}/…`) and retain `{ items: [...] }`. No hard npm dependency on Hindsight SDKs; no agent plugins; no automatic ingest, Git harvest, transcript retention, package updates, or cloud fallback.
3. Repository banks derived from trusted host `git-common-dir` + remote fingerprint (`airo-dev-{32hex}`) so linked worktrees share a bank. Model-/caller-supplied bank IDs denied when a host task resolver is bound.
4. Authorize before retain and retrieval using authenticated host task identity and capability scopes (absent scopes denied). Destructive suppress/delete require operator approval. Feature flags default all-off.
5. Host suppression tables exclude forgotten content bodies. Logical delete + best-effort provider delete; never claim forensic erasure. Prefetch caches invalidate on suppress/delete and revalidate policy before ContextPack contribution.
6. `MissionService` prefetches before ContextPack build; integration appends untrusted developer-memory refs last; `authority: false` always.

## Alternatives considered

- Install Hindsight OpenCode/Claude/Codex plugins: rejected (bypasses Context Engine, auto-retain/inject).
- Store repository knowledge only in Personal Memory: rejected (wrong plane; personal vs repo isolation).
- Hard-depend on `@vectorize-io/hindsight-client`: deferred; native HTTP transport matches pinned API shape without expanding the dependency closure until live activation.

## Authority, privacy and ownership

Hindsight responses are untrusted data. Retrieved text cannot grant tools, alter Mission contracts, or promote itself into Personal Memory. Secrets fail closed on retain. Cross-repository and external-host access fail closed. Personal Memory V2 schemas and APIs are untouched.

## Compatibility and migration

Additive config, modules, ContextPack contribution path, and retention-field registry rows. Disabled by default — no live install mutation. Separate operator authorization required to enable flags and run a local Hindsight instance.

## Consequences

Benefits: shared governed repo knowledge across Airodrom-managed workers. Costs: optional local Hindsight footprint when activated. Risks: provider outage (fail closed), injection via retrieved text (labeled untrusted, no authority). Follow-up: isolated-backend qualification, then owner-gated activation.

## Validation and evidence

`node scripts/run.cjs --test tests/developer-memory-v1.test.js` — **MOCKED CONTRACT PASS**. Disposable **REAL LOCAL HINDSIGHT PASS** recorded 2026-10-12 against loopback `hindsight:0.10.2` + Ollama; owner-install activation remains unauthorized.

## Rollback

Keep or restore default-false flags. Contribution path no-ops when disabled. Additive tables are inert metadata. No Personal Memory rewrite.

## Decision outcome

Proposed pending maintainer review.
