# ADR 0047 — Autonomous reliability and intelligence V1

Status: Proposed. Implements the owner's bounded V1 engineering request; does not authorize installation, automatic dispatch, merge, cloud activation or personal-memory mutation. Extends accepted ADRs 0004, 0005 and 0008.

## Decision

Reuse SQLite Goals, Mission Programs, Mission authority, Capability Broker, ContextPack, independent verification, Acceptance/Settlement and Event Ledger. Add a deterministic evaluation runner, pure memory-quality metrics, an observing Goal Planner, a metadata-only Flight Recorder and public MCP discovery diagnostics. No dependency or permanent service is added.

Plans use `cp_mission_programs.goal_plan` (nullable erasable content) and existing program nodes. They are proposals with state `goal_observing`, excluded from the existing dispatching scheduler. Milestones bind existing same-Goal bounded Missions. `MissionProgram.assert` enforces dependency/checkpoint/cancellation boundaries even when another host path dispatches a bound Mission. Continuation only assembles fresh authorized ContextPacks. It cannot grant, queue, approve or accept work. Existing authenticated Mission dispatch remains required.

Dependency completion requires canonical completed state, host verification, matching revision and run, verified termination, explicit operator Acceptance and settlement. Legacy lifecycle revisions advance once at completion; authority-plane contract revisions remain stable. No model-supplied state is trusted. A rejected/uncertain attempt requires existing reconciliation; the planner never retries it.

Evaluations run allowlisted synthetic fixtures through `scripts/run.cjs` in bounded child process groups. They reuse actual broker/verification paths and label mocked OpenCode adapters honestly. Metrics do not collapse security into task success. Unobserved values remain null. Imported aggregate observations are operator-supplied evidence, never independent qualification or Acceptance.

Flight Recorder projects allowlisted metadata from the existing ledger, omitting all payloads and arbitrary text. Coding-worker context delivery now records the successful stdin-write boundary with Mission/Run/ContextPack correlation. Delivery does not prove a model used the context; the separate live fixture establishes that with an exact-file result. OpenInference span-kind vocabulary is a portability hint, not an OpenTelemetry exporter.

MCP remains a fixed process-snapshot catalog. It advertises `listChanged:false` truthfully. There is no dynamic registration path needing notifications. Source, installed, advertised and client snapshots remain distinct; missing observations are unknown. Native broker and protected operations do not become public tools.

## Current reference audit

Reviewed upstream repository documentation, licenses and selected source contracts on 2026-10-12. These are design references; no upstream code was copied or framework installed. Links pin inspected revisions.

| Reference / revision | Observed terms | Adopted pattern / integration rejected |
| --- | --- | --- |
| [Inspect Evals](https://github.com/UKGovernmentBEIS/inspect_evals/tree/d2a1b5f8574d29e7a80e4dd5a6c46eff143a2550) | MIT; individual datasets may have additional terms | Versioned task/dataset/scorer separation and explicit evidence. No Python evaluation stack or benchmark dataset installed. |
| [Promptfoo assertions](https://github.com/promptfoo/promptfoo/blob/6c3ffc571102d0c7e3bfbc5f37cb98b597b8398b/src/assertions/index.ts) | MIT core | Declarative assertions; separate objective checks from model grading. No external red-team providers or paid graders. |
| [Hindsight](https://github.com/vectorize-io/hindsight/tree/f10529cb5526ae5b006e24c34bfb84da4bf64f0e) | MIT | Distinct retain/recall evidence; existing subordinate adapter remains disabled. No service activation or second canonical memory authority. |
| [Graphiti temporal edges](https://github.com/getzep/graphiti/blob/0a3b1711b018e5590cf5c44a3ee3e67d6733ee13/graphiti_core/edges.py) | Apache-2.0 | Distinguish validity, invalidation and historical facts. Existing correction/expiry/erasure contracts suffice; no graph database or embeddings. |
| [Beads](https://github.com/gastownhall/beads/tree/b630f96f5bd231ff7aea78af0d47b6038f228d00) | MIT | Durable dependency graph and ready-work projection. The requested steveyegge URL redirects here; current implementation uses Dolt. Reuse SQLite Mission Programs instead of adding an issue database. |
| [Cloudflare AgentWorkflow](https://github.com/cloudflare/agents/blob/80719a5943a4a5ee63e11acd719091a70d388119/packages/agents/src/workflows.ts) | MIT | Structured durable steps and explicit retry boundaries. No Cloudflare deployment, Durable Objects runtime or competing orchestration framework. |
| [OpenInference conventions](https://github.com/Arize-ai/openinference/blob/1198ec9584961640cb8fd78439e643bdb072e01d/spec/semantic_conventions.md) | Apache-2.0 | Span kinds and correlation. Omit prompt/completion values, secrets, exporters and a monitoring service. |
| [MCP schema](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/1f520964b295d58494d944f2aea8a5ab51c79f77/schema/2025-11-25/schema.ts) | Transition notice: Apache-2.0 new code/specs, MIT for unconsented legacy contributions, CC-BY-4.0 documentation | Respect `tools/list`, negotiated lifecycle and declared `listChanged` capability. Do not synthesize client visibility or claim notification support for a static catalog. |

## Alternatives and compatibility

A new scheduler, memory graph, telemetry store or hosted evaluation platform would duplicate authorities and increase operating costs. Rejected. Changing retrieval ranking without comparative evidence would risk regression; retained current FTS/exact-subject ordering. Proposed future rankers must improve measured relevance without forbidden retrievals or unsupported provenance.

No public MCP schema, authority permission, automatic-acceptance policy, runtime route, service, LaunchAgent or cloud setting changes. Existing Mission Programs retain their behavior. New nullable schema metadata uses the retention classifier; legacy rows remain valid. Roll back source only after draining through existing lifecycle controls; preserve durable records and current memory erasure authority. Do not replace a live database with an old backup.
