# AIRODROM — Complete Rails & Execution Architecture

**Status:** Architecture reference (canonical product narrative)  
**Product:** Airodrom 1.0.1-rc.1  
**Repository:** https://github.com/airodrom/airodrom  
**Companion overview:** [ARCHITECTURE.md](ARCHITECTURE.md)  
**Evidence note:** Live qualification must not be inferred from source-only tests or open PRs. Installed tip and `write_qualified` are separate claims.

### Evidence snapshot (2026-10-26)

| Claim | State |
| --- | --- |
| Installed tip | `96e30d2` (#243 Personal Assistant E2E + #244 retention hotfix) |
| Merge lineage | #243 `405aa3b` then hotfix #244 `96e30d2` (gmail_write_qualification retention) |
| Personal Assistant E2E | Live: `MEETING_FOLLOWUP_SEND` routes; empty calendar clarifies honestly; `/gmail confirm` required for send; chat “yes, send it” does not send |
| Gmail | Connected readonly; `write_qualified=false` until owner `/connect gmail send` + provider-confirmed test send |
| Calendar | Authorized read works (empty tomorrow verified host-true) |
| Developer Autonomy | Pending enrollment surfaced in Control Center; `confirmed:false` until owner enroll |
| Recovery | Checkpoint `recovery-checkpoint-pre-96e30d2-*`; rollback install `airodrom-install-405aa3b` |

---

## 1. Purpose

Airodrom is a local-first, governed personal AI and autonomous-work platform.

Its objective is to combine natural AI interaction with independently controlled tools, local system access, personal information, external integrations, and autonomous software development.

The fundamental design principle is:

**AI models interpret and propose. Airodrom authorizes and executes. Independent evidence determines success.**

The platform separates conversational intelligence from execution authority.

This prevents model-generated instructions, retrieved documents, emails, worker output, or prompt injections from granting permissions.

## 2. System components

| Component | Responsibility |
|---|---|
| Operator | Requests work and supplies protected approvals |
| Airo | Natural-language personal-assistant interface |
| ChatGPT | External strategic interaction, Mission coordination and review |
| Airodrom Control Plane | Authoritative runtime, identity, policy, scheduling and execution |
| Intent Router | Classifies requests and selects execution paths |
| Conversation Engine | Provides ordinary local-model conversations |
| Capability Broker | Evaluates authorized tool operations |
| SafetyPolicy | Enforces risk boundaries and approval requirements |
| Personal Memory V2 | Stores and retrieves authorized personal information |
| Google Connectors | Access Gmail, Calendar and future Google services |
| OpenCode | Local reasoning, Mission planning and independent evaluation |
| Cursor | Governed implementation worker under the Cursor-only development policy |
| Host Verifier | Independently checks execution results |
| Recovery System | Handles bounded retries, corrective Missions and uncertain outcomes |
| Acceptance & Settlement | Records verified completion under the applicable policy |
| Control Center | Operator administration, health, approvals and evidence |
| macOS Menu | Native system-status and control interface |

These components are related but do not share unlimited authority.

## 3. High-level request architecture

```text
USER
  |
  v
AIRO / CHATGPT / CONTROL CENTER
  |
  v
AIRODROM INTAKE
  |
  +-- Identity validation
  +-- Input validation
  +-- Privacy and secret screening
  +-- Conversation/session binding
  +-- Intent classification
  |
  v
ROUTE SELECTION
  |
  +-- Conversation Rail
  |
  +-- Memory Rail
  |
  +-- Connector Rail
  |
  +-- System Capability Rail
  |
  +-- Autonomous Mission Rail
  |
  v
AUTHORIZED EXECUTION
  |
  v
VERIFIED RESULT / EVIDENCE
  |
  v
AIRO RESPONSE
```

The actual execution and verification requirements differ by rail.

A read-only request to Google Calendar does not require the same Mission lifecycle as a repository modification.

## 4. Rail A — Conversation

### Purpose

Support ordinary natural-language discussions.

Examples:
- Explain quantum physics.
- Help me think through a business decision.
- What does this concept mean?
- Help me organize my ideas.

### Current execution flow

```text
User message
    ↓
Interactive CLI / API
    ↓
Assistant Intent Router
    ↓
CONVERSATION classification
    ↓
Conversation Engine
    ↓
Qualified local model
    ↓
Policy validation
    ↓
Response
```

Ordinary conversation is intentionally isolated from unrestricted tools and execution permissions.

### Current limitation

The conversation model does not automatically receive every available host capability or live fact.

If the intent router fails to recognize an actionable request, the model may generate a generic response.

Observed examples include:

- "What date today?" → model claimed it lacked real-time information.
- "Which ports are open?" → model suggested manual Terminal commands.
- "Help me manage my calendar" → previously returned a generic denial.

These are conversational routing gaps, not necessarily missing host capabilities.

**Integrated-source check (candidate tip):** calendar help now routes to `CALENDAR`; date and port questions still classify as `conversation`. Email “draft … company address” routes to local `EMAIL_COMPOSE` on the candidate tip (not yet installed).

**Source:** [src/conversation-engine.js](../src/conversation-engine.js)

## 5. Rail B — Personal Memory

### Purpose

Persist selected personal information for future retrieval and authorized reuse.

Example:

```text
/remember My company's business address is
123 Example Street, Vancouver, BC.
```

Retrieval:

```text
/memory company address
```

### Memory lifecycle

```text
Operator supplies information
    ↓
Classification and privacy screening
    ↓
Personal Memory V2
    ↓
Durable storage
    ↓
Search / retrieval
    ↓
Authorized context selection
    ↓
Airo response or prepared action
```

### Information categories

Ordinary Memory stores appropriate non-secret facts.

Sensitive Memory requires its separate operator-only handling.

Passwords, access tokens, API keys and other credentials belong in the Secret Vault rather than ordinary Memory.

### Corrections

Memory correction is designed to supersede outdated facts rather than treat conflicting old and new facts as simultaneously current.

### Intended improvement

Airo should retrieve current verified facts automatically when relevant to an authorized request.

Example:

"Draft an email and include my company's address."

Expected behavior:

1. Recognize email composition.
2. Retrieve the current authorized company address.
3. Request clarification if the address is missing or ambiguous.
4. Compose a local draft.
5. Avoid external disclosure without the required authority.

**Candidate source:** [MEMORY-GROUNDED-EMAIL-COMPOSE-V1.md](MEMORY-GROUNDED-EMAIL-COMPOSE-V1.md) (PR #239 / #240).  
**Installed behavior:** does not yet include that path until authorized cutover.

**Sources:**
- [MEMORY-V2.md](MEMORY-V2.md)
- [src/personal-memory.js](../src/personal-memory.js)

## 6. Rail C — External Connectors

### Purpose

Access external services through authenticated, bounded adapters.

### Gmail

Implemented and live-verified capabilities include read-only access and natural-language sender search (installed tip).

The current search architecture is:

```text
Natural-language search
    ↓
Gmail intent parser
    ↓
Structured CONNECTOR request
    ↓
Authenticated Gmail adapter
    ↓
Google Gmail API
    ↓
Bounded search results
    ↓
Host-verified response
```

The search implementation supports bounded pagination and conversation-bound continuation.

Gmail sending, external draft saving, archiving and other mailbox mutations are not automatically permitted by read-only authorization.

Stage A write adapters exist in candidate source ([GOOGLE-WORKSPACE-STAGE-A-V1.md](GOOGLE-WORKSPACE-STAGE-A-V1.md)); live `write_qualified` requires owner `/connect gmail send|manage` and provider-confirmed operations.

### Google Calendar

Implemented and live-verified read operations (when owner-connected) include:

- Calendar listing
- Event retrieval
- Bounded schedule queries
- Free/busy inspection

Calendar has separate read-only and manage-mode authorization.

Calendar create/update/cancel operations are governed separately from reads.

### Google Drive, Docs and Sheets

These are product expansion areas. Do not classify them as live-qualified until the relevant adapters, OAuth permissions and real provider acceptance have been demonstrated.

### Connector security

Every connector should preserve:

- Exact account identity
- Least-privilege OAuth scopes
- Private credential storage
- Bounded reads and pagination
- Separation between reads and writes
- Conversation isolation
- Approval requirements for protected operations
- Provider-confirmed outcomes
- Honest authorization and connection states

**Sources:**
- [src/assistant-connectors.js](../src/assistant-connectors.js)
- [src/calendar-service.js](../src/calendar-service.js)
- [src/gmail-search-intent.js](../src/gmail-search-intent.js)
- [GMAIL-NL-SEARCH-V1.md](GMAIL-NL-SEARCH-V1.md)
- [GOOGLE-CALENDAR-NL-CONTROL-V1.md](GOOGLE-CALENDAR-NL-CONTROL-V1.md)

## 7. Rail D — macOS System Capabilities

### Purpose

Perform controlled local system inspection and other authorized operations.

Examples:
- List listening TCP ports.
- Inspect processes.
- Check network interfaces.
- Inspect mounted volumes.
- Retrieve local system information.

### Example — Port inspection

```text
User: Which ports are open on my Mac?
    ↓
System inspection intent
    ↓
port_status capability
    ↓
Capability Broker + SafetyPolicy
    ↓
Bounded host execution
    ↓
macOS lsof
    ↓
Structured listener results
    ↓
Airo response
```

The existing `port_status` host capability uses macOS `lsof` to obtain TCP listeners.

The remaining conversational challenge is routing varied natural-language requests to existing approved capabilities.

### Important distinction

A port listening on `127.0.0.1` is not equivalent to a publicly internet-accessible port.

Airo must report the observed binding rather than speculate about exposure.

Read-only inspection must never automatically authorize stopping processes or changing firewall configuration.

**Source:** [src/capability-mac.js](../src/capability-mac.js)

## 8. Rail E — Autonomous Development Missions

This rail governs source modifications and other bounded autonomous development tasks.

### Canonical workflow

```text
USER
  ↓
CHATGPT / AIRO
  ↓
AIRODROM INTAKE
  ↓
PROJECT + ENROLLMENT RESOLUTION
  ↓
OPENCODE PLANNING
  ↓
MISSION CONTRACT VALIDATION
  ↓
AUTHORIZATION / APPROVAL GATES
  ↓
CURSOR IMPLEMENTATION
  ↓
INDEPENDENT HOST VERIFICATION
  ↓
OPENCODE EVALUATION
  ↓
PASS ──────────────── FAILURE
  ↓                       ↓
ACCEPTANCE          FAILURE CLASSIFIER
  ↓                       ↓
SETTLEMENT          REPAIR ELIGIBILITY
                          ↓
                   CORRECTIVE CURSOR RUN
                          ↓
                   HOST RE-VERIFICATION
                          ↓
                   EVALUATION / ACCEPTANCE
```

OpenCode planning and evaluation do not grant implementation authority.

Cursor cannot expand its own allowed paths or declare its output verified.

Airodrom remains the scheduler, execution authority and verifier.

## 9. Mission intake

A request enters through an authenticated operator or supported MCP interface.

Airodrom resolves:

- The intended operation
- Project and repository identity
- Current enrolled workspace
- Exact file scope
- Eligible worker
- Registered verification
- Budget
- Existing authority
- Required approval

An ambiguity or missing prerequisite must not be resolved by silently increasing permissions.

For example, a repo task must not be misrouted to an unrelated disposable fixture simply because its instruction contains a matching word.

**Source:** [COGNITIVE-MISSION-ROUTER-V1.md](COGNITIVE-MISSION-ROUTER-V1.md)

## 10. Planning

OpenCode proposes implementation stages against the authorized workspace.

Planning may include:

- Files to inspect
- Files to modify
- Requested operations
- Expected outcomes
- Test strategy
- Dependencies between stages
- Bounded repair strategy

The plan remains untrusted until Airodrom validates it against current authority.

The model cannot authorize new file access by mentioning a path.

## 11. Mission contracts

Every governed Mission has a bounded operational contract.

Major dimensions:

| Dimension | Controls |
|---|---|
| Identity | Request and Mission identity |
| Project | Repository, workspace and base commit |
| Permissions | Allowed reads and writes |
| Worker | Eligible implementation identity |
| Network | Network modes and external disclosure |
| Verification | Exact criteria, registered tests and security checks |
| Budget | Time, attempts, repairs and invocation limits |
| Restrictions | Prohibited deployment, Git and sensitive operations |
| Audit | Approval, lineage and evidence references |

The `scope_fingerprint` binds authorization-relevant contract details.

Corrective work cannot broaden the original contract merely because the initial attempt failed.

**Source:** [src/mission-contract.js](../src/mission-contract.js)

## 12. File enrollment

Enrollment defines which files and operations a worker may perform.

Example:

```text
Requested:
src/conversation-engine.js
tests/conversation-engine.test.js

Active enrollment:
docs/example.md
docs/guide.md
```

Result:

```text
requested_file_not_enrolled
```

This is an intentional refusal when requested paths fall outside the authorized scope.

### Desired recovery behavior

Airodrom should:

1. Diagnose the exact missing files.
2. Identify the correct enrolled project.
3. Prepare a minimal enrollment change.
4. Request local owner approval where required.
5. Preserve existing Mission identity where possible.
6. Resume Cursor only after valid authorization.

It must not use an unauthorized implementation worker simply to bypass enrollment.

**Operational note:** IDE Cursor edits in enrolled worktrees are distinct from Mission `cognitive.files` dispatch. Owner DA re-enroll requests remain `confirmed:false` until Control Center approval (see activation enrollment proposals under `~/.airodrom/activation/development-target-enrollment/`).

## 13. Worker roles

### Airo

Conversational interpretation and user-facing explanation.

### ChatGPT

Strategic coordination, proposals and evidence review through available connected tooling.

### OpenCode

Local planning and independent evaluation in the governed Mission workflow.

### Cursor

Authorized implementation and bounded corrective implementation.

### Airodrom

Project resolution, scheduling, worker dispatch, sandbox enforcement, authority checks, verification, recovery, Acceptance and Settlement.

These roles must not be silently substituted for one another.

**Source:** [operations/CURSOR-ONLY-AUTONOMY.md](operations/CURSOR-ONLY-AUTONOMY.md)

## 14. Capability Broker and policy

The Capability Broker evaluates typed host operations against central policy and current task authority.

A tool's existence does not imply that every caller can invoke it.

Checks can include:

- Capability active state
- Operator identity
- Task scope
- Resource boundaries
- Risk classification
- Approval requirements
- Existing safety stops
- Budget and execution constraints

Read-only capabilities may be permitted automatically when appropriately scoped.

Destructive, privileged, security-sensitive and financial operation classes retain stronger restrictions.

**Sources:**
- [src/capability-broker.js](../src/capability-broker.js)
- [config/capability-policy-v2.json](../config/capability-policy-v2.json)

## 15. Independent verification

Worker-generated claims are not trusted completion evidence.

The host verifier independently checks the actual result.

Possible checks include:

- Allowed files only
- Unexpected file changes
- Symlink safety
- Base commit stability
- Exact output bytes
- Registered tests
- Verifier baseline integrity
- Secret scanning
- Applicable security and type checks
- Actual worker termination

Unavailable checks must be reported as unavailable, not passed.

**Source:** [src/mission-verifier.js](../src/mission-verifier.js)

## 16. Recovery and bounded self-repair

When a Mission fails verification, Airodrom classifies the failure.

Recovery must verify:

1. Is the failure repairable?
2. Is the original scope still valid?
3. Has the previous worker terminated?
4. Is approval still valid?
5. Is the corrective budget available?
6. Is the verifier baseline unchanged?
7. Is retry safe?

When those conditions hold, an authorized corrective attempt may execute.

When execution effects are uncertain, the host must not blindly retry.

Historical attempts and evidence remain available.

### Example

A disposable file must end with:

```text
beta\n
```

First Cursor result:

```text
gamma\n
```

Host verification fails.

The failure is classified, repair eligibility is checked, and a permitted corrective Cursor attempt produces:

```text
beta\n
```

The host verifies again before the result can become eligible for Acceptance.

A first-attempt success does not count as proof of a working repair loop.

**Sources:**
- [src/recovery-phase.js](../src/recovery-phase.js)
- [UNIFIED-AUTONOMOUS-DEVELOPMENT-V1.md](UNIFIED-AUTONOMOUS-DEVELOPMENT-V1.md)

## 17. Acceptance and Settlement

Acceptance records that a result meets the applicable completion policy.

Settlement reconciles the execution lifecycle and remaining operational state.

Important distinctions:

- A model saying "done" is not Acceptance.
- Cursor producing a patch is not independent verification.
- Passing verification does not automatically authorize deployment.
- Automatic Acceptance applies only where an existing eligible policy permits it.
- An uncertain worker must not be treated as safely terminated.
- Git merge and installation remain distinct from Mission completion.

Final evidence should establish the actual terminal state and whether leases and dispatched runs are settled.

## 18. Error and status vocabulary

Airodrom should distinguish:

| Status | Meaning |
|---|---|
| PLANNING | Preparing a bounded plan |
| WAITING_OWNER | Owner authorization required |
| BLOCKED | Prerequisite unavailable or denied |
| RUNNING | Authorized execution underway |
| VERIFICATION_FAILED | Host check failed |
| REPAIR_PENDING | Correction being prepared |
| REPAIR_RUNNING | Corrective implementation executing |
| MISSION_VERIFIED | Host verification succeeded |
| AWAITING_ACCEPTANCE | Verification passed, acceptance remains |
| ACCEPTED | Completion accepted under applicable policy |
| SETTLED | Execution reconciliation completed |
| QUARANTINED | Uncertain effects require reconciliation |
| CANCELLED | Cancellation recorded, with termination proof handled separately |

Not every phase is a final state. The exact status derives from Airodrom's current Mission records.

## 19. Why Airo sometimes behaves incorrectly

The principal current product gap is the connection between natural-language interpretation and host capabilities.

Observed patterns:

### Current-date request

Airo incorrectly says it lacks real-time information instead of using the macOS clock.

### Port-inspection request

Airo suggests manual shell commands despite an existing governed `port_status` capability.

### Email drafting

Airo historically confused composing local email text with saving or sending Gmail messages. Candidate source (#239 / #240) separates local `EMAIL_COMPOSE` from governed Gmail writes; installed tip still requires cutover to exhibit that routing.

### Gmail search

Historically, sender-specific requests fell into tool-free conversation. A later Gmail NL search implementation addressed that routing gap (live on installed tip).

### Calendar

Calendar help, reads and free/busy now have dedicated host routing.

These examples demonstrate that successful individual connector features do not, by themselves, create a general-purpose conversational capability system.

## 20. Proposed Airo Semantic Capability Rail

**Status: Architectural direction, not an assertion that it is already implemented.**

The recommended future design:

```text
USER NATURAL LANGUAGE
          ↓
AIRO SEMANTIC INTERPRETATION
          ↓
CAPABILITY DISCOVERY
          ↓
STRUCTURED ACTION PROPOSAL
          ↓
AIRODROM POLICY BROKER
          ↓
AUTHORIZED HOST EXECUTION
          ↓
VERIFIED OBSERVATIONS
          ↓
AIRO NATURAL RESPONSE
```

Airo should be able to identify available capabilities without requiring the operator to memorize commands.

The model may propose which tool to use and which arguments appear relevant.

The host must validate every operation independently before execution.

### Safe default behavior

- Current date → local clock
- Open ports → existing read-only host capability
- GitHub emails → Gmail connector
- Calendar schedule → Calendar connector
- Company address → Personal Memory
- Draft an email → memory-grounded local composition
- Save/send email → separately authorized Gmail operations
- Fix source code → governed Mission rail

## 21. Suggested Conversational Intelligence V2 priorities

### Priority 1 — Basic local factual capabilities

**Implemented (PR #241):** current date, time, timezone, ports, Airodrom service inventory, and live health via the host-fact rail.

### Priority 2 — Semantic tool selection / contextual compositions

**Partial (this change):** allowlisted multi-source plans only — Memory + host date + local compose; Calendar tomorrow + follow-up draft; health + observed-issue explanation. Not unrestricted model tool selection.

### Priority 3 — Multi-turn verified context

Follow-up references bind to verified records, not model guesses. Conversation-routing regressions and ordinary chat body paths are covered in focused tests.

### Priority 4 — Memory-grounded composition

**Implemented for single-rail compose (PR #239/#240) and contextual Memory+date compose (this change).** Use authorized current facts to compose drafts; never claim Gmail persistence.

### Priority 5 — Governed external writes

Support authorized routine actions without confusing them with unrestricted model execution.

### Priority 6 — Failure recovery

Distinguish provider, tool, network, authorization, policy and execution failures.

### Priority 7 — Unified user experience

Consistent results across Terminal, Control Center, ChatGPT and the native macOS menu.

## 22. Non-negotiable design principles

1. Models do not grant authority.
2. Credentials remain outside ordinary model context.
3. Retrieved content is untrusted data.
4. File enrollment remains authoritative.
5. Cursor-only implementation policy is preserved unless explicitly changed through governance.
6. OpenCode planning and evaluation are distinct from implementation.
7. Host verification is independent of worker assertions.
8. Corrective execution remains bounded.
9. Unknown external effects are not blindly retried.
10. High-impact operations use their actual approval gates.
11. Read permissions do not imply write permissions.
12. Mission completion does not imply Git merge or installation.
13. Historical evidence is preserved.
14. Current live qualification must not be inferred from source-only tests.
15. Conversational convenience must not silently weaken execution controls.

## 23. Operational source index

| Area | Canonical source |
|---|---|
| Architecture | [ARCHITECTURE.md](ARCHITECTURE.md) |
| This rails reference | [COMPLETE-RAILS-AND-EXECUTION-ARCHITECTURE.md](COMPLETE-RAILS-AND-EXECUTION-ARCHITECTURE.md) |
| Unified acceptance (integration) | [UNIFIED-RECOVERY-WORKSPACE-ACCEPTANCE-V1.md](UNIFIED-RECOVERY-WORKSPACE-ACCEPTANCE-V1.md) |
| Intent router | [assistant-intent.js](../src/assistant-intent.js) |
| Assistant routing | [assistant-service.js](../src/assistant-service.js) |
| Conversation engine | [conversation-engine.js](../src/conversation-engine.js) |
| Capability policy | [capability-policy-v2.json](../config/capability-policy-v2.json) |
| Capability Broker | [capability-broker.js](../src/capability-broker.js) |
| macOS capabilities | [capability-mac.js](../src/capability-mac.js) |
| Memory V2 | [MEMORY-V2.md](MEMORY-V2.md) |
| Cognitive Mission Router | [COGNITIVE-MISSION-ROUTER-V1.md](COGNITIVE-MISSION-ROUTER-V1.md) |
| Mission contracts | [mission-contract.js](../src/mission-contract.js) |
| Mission approval | [mission-approval.js](../src/mission-approval.js) |
| Host verification | [mission-verifier.js](../src/mission-verifier.js) |
| Recovery phases | [recovery-phase.js](../src/recovery-phase.js) |
| Cursor-only policy | [CURSOR-ONLY-AUTONOMY.md](operations/CURSOR-ONLY-AUTONOMY.md) |
| Unified autonomous development | [UNIFIED-AUTONOMOUS-DEVELOPMENT-V1.md](UNIFIED-AUTONOMOUS-DEVELOPMENT-V1.md) |
| Gmail NL search | [GMAIL-NL-SEARCH-V1.md](GMAIL-NL-SEARCH-V1.md) |
| Calendar integration | [GOOGLE-CALENDAR-NL-CONTROL-V1.md](GOOGLE-CALENDAR-NL-CONTROL-V1.md) |
| Memory-grounded compose | [MEMORY-GROUNDED-EMAIL-COMPOSE-V1.md](MEMORY-GROUNDED-EMAIL-COMPOSE-V1.md) |
| Google Workspace Stage A | [GOOGLE-WORKSPACE-STAGE-A-V1.md](GOOGLE-WORKSPACE-STAGE-A-V1.md) |

---

## Final architecture principle

**Airo should behave like an intelligent conversational personal assistant. Airodrom should remain the independent system responsible for permissions, real-world execution, verification and recovery.**

The desired system is not unrestricted AI.

It is intelligent AI operating through governed, auditable and reliable capabilities.
