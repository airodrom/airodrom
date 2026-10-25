# Architecture overview

Airodrom is a modular monolith with durable SQLite state machines. ChatGPT supplies strategy and outcome review; Airodrom owns operational reconciliation and typed local execution. Cursor is the exclusive implementation worker; OpenCode plans and independently evaluates. Pi is removed. Airodrom host primitives execute typed plans and verify evidence independently. Execution agents and reasoning providers are separate. Apps implement external protocols; the Kernel owns admission, authority and lifecycle policies.

Canonical local always-on identity: the managed supervisor (`local-service` / control plane) is Airodrom. Cursor implements within sealed Mission scope; OpenCode prepares and evaluates the work. Ollama is the local inference provider when configured. ChatGPT reaches Airodrom through the MCP stdio connector and managed tunnel. The MCP service id `pi_bridge` is a stable historical alias for the Airodrom control plane (label: “Airodrom control plane”); it is not a separate Pi Bridge process. macOS login start is owned by `local.airodrom.desktop-login`; post-reboot verification uses `local.airodrom.reboot-acceptance`. Service health reports verified PIDs (`bridge.lock` + signal probe) and must not claim “running” from a stale historical PID alone.

A Mission freezes scope, budget, runtime eligibility and verification criteria. Task/Run records capture attempts. Durable writer leases serialize workspace mutation; uncertain termination quarantines ownership. External effects use a transactional outbox with destination idempotency where supported. Unknown delivery remains pending reconciliation.

Results enter an untrusted Result Inbox. Independent evidence is correlated to the current attempt and workspace. Acceptance requires current authority, completed verification and verified termination; local Settlement follows. Scheduling advice and worker assertions cannot accept their own work. Slack Decisions record direction and do not satisfy protected Approvals.

Context Builder selects bounded, scoped references. PersonalMemory, task-scoped Project Memory V2, canonical repository decisions and retrieved conversation history have separate provenance. Optional Developer Memory V1 (disabled by default) may contribute untrusted repository-knowledge evidence through the same host ContextPack path; Hindsight never becomes an authority plane. Model proposals cannot become canonical memory without host review. Recall never broadens runtime, provider, privacy or permission policy. See [Developer Memory V1](DEVELOPER-MEMORY-V1.md).

Versioned core contracts (`Conversation`, `ModelRequest`, `WorkerAssignment`, `Mission`, `ExecutionEvent`, `VerificationEvidence`) stamp schema identity without rewriting durable rows. Model-provider contracts remain distinct from agent-runtime contracts. Runtime security properties are classified from host evidence as VERIFIED, UNVERIFIED, or UNSUPPORTED; worker self-reports cannot qualify an assignment. Installation compatibility observes daemon, CLI, Control Center, macOS menu, MCP, and contract surfaces and can block incompatible mutations while preserving diagnostics and recovery. See [ADR 0043](adr/0043-core-contracts-runtime-consistency.md).

Official WhatsApp Business inbound is a loopback HMAC webhook into a durable allowlisted inbox (never Mission auto-dispatch). Conversations V1 may queue allowlisted text into ConversationEngine on channel `whatsapp` with personal Memory retrieval off; outbound Cloud API send stays separately governed and hard OFF until owner authorization. Production Connection V1 records Meta prerequisites and keeps production messaging on policy HOLD until the owner clears eligibility; stable webhook-only HTTPS is required (no ephemeral trycloudflare for production). See [Conversations V1](WHATSAPP-CONVERSATIONS-V1.md), [Production Connection V1](WHATSAPP-PRODUCTION-CONNECTION-V1.md), [ADR 0041](adr/0041-whatsapp-conversations-v1.md), [ADR 0040](adr/0042-whatsapp-production-connection-v1.md).

See the [authority guide](governance/MISSION-AUTHORITY-GUIDE.md), [privacy contract](PRIVACY-ERASURE.md), [runtime matrix](RUNTIME-SUPPORT-MATRIX.md) and [threat model](THREAT-PRIVACY-SUMMARY.md).

Local [Reliability & Intelligence V1](AUTONOMOUS-RELIABILITY-V1.md) adds scenario measurement, memory-quality scoring, observing Goal Plans over Mission Programs, a metadata-only Flight Recorder and MCP catalog diagnostics. [Continuous Autonomous Execution V1](CONTINUOUS-AUTONOMOUS-EXECUTION-V1.md) optionally authorizes durable scheduling of those Goal Plans through existing `MissionService.dispatch` inside the always-on service; ChatGPT/Cursor are not execution owners. Planning and scheduling never grant Acceptance or Production mutation; admission, leases, independent verification and operator Acceptance remain required. [Unified Autonomous Development V1](UNIFIED-AUTONOMOUS-DEVELOPMENT-V1.md) ([ADR 0051](adr/0051-unified-autonomous-development.md)) adds the canonical Mission contract (deny-by-default permissions, immutable scope fingerprint distinct from per-Mission identity), one owner approval bound to that fingerprint, derived recovery phases, idempotent transactional corrective Missions, a trusted verifier baseline, the governed sandboxed headless Cursor worker and the ChatGPT coordinator tools. Airodrom remains the single scheduler and completion authority; ChatGPT prepares and reviews; workers execute inside host-enforced sandboxes and never verify their own work.

### Developer Autonomy V1

Standing per-repository owner enrollment issues short-lived Mission grants, prepares disposable local clones, and validates grants at dispatch. WORK templates remain available and mutually exclusive on a Mission. See [DEVELOPER-AUTONOMY-V1.md](DEVELOPER-AUTONOMY-V1.md) and ADR 0053.

### OpenCode result gateway

[Cognitive V2](adr/0058-opencode-result-gateway.md) adds a mandatory read-only
OpenCode evaluation return leg to explicitly enrolled Missions. Airodrom passes
actual worker result data and independent check outcomes to OpenCode, binds the
returned recommendation to immutable host evidence, and gates Acceptance on that
receipt. Optional local repair reuses the existing transactional corrective Mission
path and the signed finite grant. V1 policies are not silently expanded. One
execution adapter per Mission is supported; separate specialist task assignment
within one Mission remains an explicit limitation.

## Cognitive specialist gateway

Version 3 adds bounded assignments, worker result return to OpenCode, shared repair
limits and automatic completion under current enrolled policy. It reuses the
existing scheduler, Mission Program, accounting and verification. See
[Specialist Gateway V1](SPECIALIST-GATEWAY-V1.md) and
[ADR 0059](adr/0059-specialist-gateway.md) for contracts, recovery and rollback
compatibility. Earlier single-worker/version 2 descriptions remain historical.

### Canonical multi-agent path (Milestone B)

```text
USER → ChatGPT → AIRODROM → OPENCODE (planner) → CURSOR (implementation) → OPENCODE (evaluator) → AIRODROM (independent verifier) → ChatGPT → USER
```

Airodrom is the sole governing authority. OpenCode plans and evaluates. Cursor is
the mandated implementation specialist for ChatGPT-initiated development Missions
on this path. Airodrom owns authorization, dispatch, verification, Mission state,
and settlement. ChatGPT initiates Missions and retrieves progress/results; it
never substitutes Codex, Work, or an alternative coding agent, and never silently
falls back to disposable fixture workspaces.

**Repository binding invariants (regression prevention):**

1. Explicit project/repository targets resolve before OpenCode planning.
2. Selected repository identity is sealed into the Mission / cognitive envelope.
3. Negated names (`not chatgpt-handoff`, `not Arecibo`) never select a project.
4. Fixture / handoff standing grants never authorize `airodrom/airodrom` or
   `arecibo-inc/arecibo-core` source edits.
5. Unauthorized product requests fail closed with target-specific codes
   (`SOURCE_REPOSITORY_NOT_ENROLLED`, `ARECIBO_REPOSITORY_NOT_ENROLLED`) rather
   than guessing another workspace.
6. Planner paths outside the sealed repository are rejected before Cursor dispatch.
7. Standing Developer Autonomy grants never transfer across projects.
8. Authoritative targets live in `config/development-targets-v1.json`. Adding a
   third development repository means appending a catalog entry—not changing the
   ChatGPT → Airodrom → OpenCode → Cursor architecture.

**Automatic multi-project selection precedence:**

1. Explicit repository identifier (`airodrom/airodrom`, `arecibo-inc/arecibo-core`).
2. Explicit product/project name (`Airodrom`, `Arecibo Core`).
3. Instruction patterns for known product work (notifications, Command Center, …).
4. Otherwise fail closed and ask which authorized repository to use.

Use MCP `list_development_targets` / `resolve_development_target` to inspect live
enrollment readiness without starting a Mission.

**Engineering visibility:** durable ledger events (including Cursor `worker.trace`
with provenance tags) are retrievable via `get_mission_events` /
`get_mission_engineering_report`. Worker claims are labelled untrusted; host
verification remains authoritative.

**Terminal notifications:** Mission state transitions enqueue duplicate-safe
outbox notifications (`ACCEPTED` / `BLOCKED` / `FAILED` / `CANCELLED` /
`NEEDS_REWORK` / `OWNER_ACTION_REQUIRED`). Delivery does not poll and cannot
alter settlement. ChatGPT unsolicited push requires a configured trigger; otherwise
results remain inbox-retrievable via `list_mission_notifications`.

See [Milestone B Cursor readiness](MILESTONE-B-CURSOR-SPECIALIST-READINESS.md)
and [CURRENT-STATE.md](CURRENT-STATE.md).

Explicit requested file operations are host constraints throughout planning, dispatch,
recovery, verification, and acceptance. Enrollment cannot substitute a different
file. `bindings` are the unique operation/path permission set; `stages` are the
ordered execution graph and may repeat the same path. Descriptive prose does not
invent targets. Authorized execution targets remain distinct from planner-forwarded
context. See [ADR 0063](adr/0063-requested-file-scope.md) for the versioned request
constraint, literal syntax, diagnosis codes, evidence, and compatibility boundary.

Current implementation policy: [Cursor-only routine autonomy](adr/0065-cursor-only-routine-autonomy.md). Existing authorization is reused; no routine billing inspection or automatic worker fallback is added.
