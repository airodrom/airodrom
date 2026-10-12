# Autonomous Reliability & Intelligence V1

This V1 adds local measurement and durable planning to the existing Authority Plane. It grants no execution authority. See [ADR 0047](adr/0047-autonomous-reliability-intelligence.md), the [Mission Authority Guide](governance/MISSION-AUTHORITY-GUIDE.md) and [privacy contract](PRIVACY-ERASURE.md).

## Evaluation and scoring

Run `npm run test:reliability`, `npm run evaluate:reliability`, `npm run benchmark:memory` and `npm run benchmark:reliability`. All use the official Node/SQLite launcher. The evaluation CLI accepts `--output=report.json`, a checkout `--root=...` for comparative baseline runs, and `--extended` to include new V1 integration boundaries. Only checked-in synthetic test selectors run; no arbitrary model/code supplied in a scenario is executed. Keep generated evidence outside source/package allowlists.

`config/reliability-scenarios-v1.json` defines ID/version, objective, category A–T, environment, required capabilities, authorized/prohibited operations, expected outcome, verifier criteria, duration, resource budget and security properties. Each child is bounded to 120 seconds and 1 MiB output. New scenarios need a reviewed synthetic fixture and independent assertions. Never point a fixture at owner repositories or memory.

The 20 baseline contracts cover normal and coding completion, tool selection, authorized execution, denied escalation, prompt/memory/repository poisoning boundaries, ContextPack/project isolation, termination, resumption, timeout, retry, duplicate prevention, verification, Acceptance, secret protection, tool-result shape and objectively false worker success claims. Some categories share existing fixtures; this is contract coverage, not 20 independent model benchmarks. The extended fixture exercises a malicious README and memory reference plus a denied broker write while separately authorized legitimate work completes.

Task success is passed positive-objective scenarios divided by all positive-objective scenarios. Verification pass is passed host assertions divided by passed/failed/cancelled assertions. Recovery reports passed/failed recovery contracts. Security contract failures, observed approval bypasses and unauthorized executions are separate and force HOLD; task success cannot offset them. Unknown unauthorized attempts, false denials, model invocations and approval compliance remain null unless an instrumented fixture supplies numeric observations. Observation coverage accompanies those counts. Durations include child startup and cleanup; do not interpret them as model latency. Fixed seed 1, source SHA, dirty-tree flag, scenario version, runtime, model identity, policy and platform travel with each report.

## Memory Intelligence

The disposable memory benchmark runs existing Personal Memory APIs against a new SQLite file. Fifteen queries measure relevance, irrelevant rejection, current/historical facts, correction precedence, supersession, forgetting, temporal expiry, restart consistency, project isolation, provenance, ranking, context budgeting, grounding-reference availability and missing evidence. Existing Authority Memory tests cover conflicting claims; Project Memory V2, Architecture Memory, ContextPack and disabled Developer Memory regressions remain required.

Precision, recall, nDCG, duplicate/forbidden hits, provenance coverage, unsupported-claim count and budget compliance are independently inspectable. Empty evidence is explicit. Grounding-reference coverage is not proof of a generated model answer. No suppressed record is queried for recall improvement. Production retrieval is unchanged: exact subjects, FTS5 relevance, current corrections, scope/erasure filters and source hierarchy remain authoritative. The initial fixture exposes one extra related result; no new ranking algorithm is claimed to improve it. No embeddings, graph database or Hindsight activation is needed.

## Durable Goal Planning

Authenticated Control Center API operations:

- `create-goal-plan`: existing `goal_id`, idempotent `request_id`, `max_runtime_hours` (0–24), `max_attempts` (1–10), 1–40 `stages`.
- Each stage: `id`, `depends_on`, `objective`, nonempty `acceptance_criteria` and `verification_requirements`, optional existing bounded `mission_id`, optional `human_checkpoint`.
- `bind-goal-mission`: `id`, `stage_id`, same-Goal `mission_id`, `request_id`. One-time binding. Admit later shared-workspace Missions against the current workspace, with exact file ownership, after previous changes.
- `continue-goal-plan`: `id`, `request_id`. Re-read canonical state, check authority/dependencies, prepare fresh ContextPacks and return eligible Missions. No dispatch.
- `confirm-goal-checkpoint`: `id`, `stage_id`, `request_id`. Authenticated operator direction only; no capability grant or Mission Acceptance.
- `cancel-goal-plan`: `id`, `request_id`. Stops future eligibility and requests existing Mission cancellation. Uncertain termination retains leases.
- GET `goal-plans` and `goal-plan?id=...` return bounded metadata views under `/api/control-v2/`.

Plans persist in existing Mission Program tables, referencing existing Project/Goal/Mission/Task/Run records. A nullable `goal_plan` field is erasable. No conversation transcript is executable state. Parallel independent stages can be ready together; existing writer leases still serialize conflicting workspace work. Cycles, unknown dependencies, duplicate IDs, cross-project bindings and arbitrary authority fields fail closed. A terminal state alone cannot unlock a dependency: correlated host verification, terminated run, operator Acceptance and settlement are required.

Failure propagates through dependency readiness without blocking independent branches. A recovery candidate is identified only when the existing Mission has been explicitly returned to ready and attempt/authority checks pass. Provider failures, revoked grants, quarantined leases, uncertain dispatches and unverified side effects never retry automatically. Completed accepted milestones survive a fresh bridge session. Plans expire at their execution bound; create a new authorized plan/Mission when a bound must change. Existing `dispatch-mission` is the only manual execution entry and remains governed.

## Flight Recorder and MCP

GET `/api/control-v2/flight-recorder?id=MISSION&after=SEQUENCE&limit=100` projects the canonical ledger in order (maximum 200/page). It reports Mission/Run/trace/span correlation, event type, time/duration, enumerated policy/verification/error state and opaque evidence references. Unsupported event types and arbitrary metadata/payloads are omitted. Pagination indicates incomplete history. Current Mission state drives the explanation and next safe action. Known runtime failures come from canonical run metadata; unknown causes stay unknown.

Coding ContextPack delivery is recorded only after the private worker stdin write completes. This is transport evidence. Synthetic live tests independently verify that the model used the current fact. OpenInference-compatible span kinds aid future export; no OpenTelemetry backend or prompt logging is installed.

GET `/api/control-v2/mcp-discovery` reports the process source/installed catalog and unknown external advertised/client observations. `mcp-discovery.diagnose` accepts separately obtained public snapshots and source identities, reports the package version, compares names/canonical schema fingerprints and rejects private tool names. `advertisedCatalog()` performs a real in-process MCP initialize/list handshake without invoking tools. The static server advertises `listChanged:false`; there is no catalog mutation requiring a notification. Reconnect/restart is a separately authorized operation.

## Control Center and operations

Existing navigation and glass components provide Reliability (including Memory Intelligence, relevant/irrelevant counts and correction/forgetting results), Autonomous Goals, MCP Diagnostics and a Flight Recorder section inside Missions. No private goal objective, memory contents or prompt is included in these views. GETs remain authenticated. The summary import action `record-evaluation-summary` accepts only bounded counts, ratios, known evidence classes and source SHA, records them in the existing ledger and labels them operator-imported. It does not run a test, qualify a runtime, or approve work. The initial UI stays empty until evidence is explicitly imported; nothing reads arbitrary report files or owner memory in the background.

Comparison of imported summaries is an aggregate hint; use the complete CLI reports for exact scenario-level comparisons. Missing metrics remain “Not measured”. The UI shows the first 100 flight events; API cursors expose further pages. Goal creation/binding/checkpoints use the authenticated typed API in this V1; the UI is an operator observation surface.

Safe activation: review source and evidence, merge separately, authorize installation maintenance, qualify the local runtime, then explicitly register plans and dispatch bounded Missions under current operator policy. No automatic goal dispatcher exists. Developer Memory stays disabled, Hindsight stays unactivated, hosted candidate CI stays manually disabled, and installation/LaunchAgent work remains separate.

Evidence classes are distinct: MOCKED CONTRACT PASS, DISPOSABLE FIXTURE PASS, REAL LOCAL MODEL PASS, OWNER INSTALLATION VERIFIED and CHATGPT CONNECTOR VERIFIED. A fixture does not prove owner activation, and a connector tool listing does not prove a missing tool was called. V1 adds no paid service or recurring inference cost. Worker peak memory and model token cost require separate supported telemetry; unknown values are not zero.

## Initial comparative measurements

At the starting main revision `7efebfb2730a2ededdb1bbb42b11ca15e07f319a`, all 20 selected baseline contracts passed. The first candidate run also passed all 20. Positive-objective success and independent assertion pass rates were 100% within that selected fixture suite; four recovery contracts passed. Baseline unauthorized execution, false-denial and approval counters were unmeasured. The new instrumented injection fixture separately observed one denied unauthorized write and one successful authorized Mission. These are bounded fixture counts, not deployment or general model guarantees.

The 15-query baseline and candidate memory runs both produced 14 exact retrievals, mean precision 96.67%, recall 100%, zero forbidden hits, complete observed provenance and all context budgets respected. One exact-subject query also retrieved a related record. Retrieval ordering is therefore retained. Initial candidate retrieval p50/p95 was 0.74/1.52 ms versus 0.81/2.05 ms baseline; this small sample does not establish a speedup.

An initial 20-sample disposable host benchmark measured Goal creation at 10.19 ms, Goal inspection p50/p95 2.30/5.32 ms, ContextPack assembly 23.73/27.09 ms and trace projection 1.48/7.27 ms. One hundred synthetic trace events added approximately 614 bytes/event; the fixture database was 1.98 MB and host process RSS 374 MB. Worker peak memory was not measured. Final exact-revision reports and test results belong with the PR evidence; these initial values are contextual measurements, not performance limits.
