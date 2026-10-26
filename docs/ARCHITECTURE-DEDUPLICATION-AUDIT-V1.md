# Airodrom Architecture Deduplication Audit V1

Status: draft source audit and behavior-preserving consolidation. Snapshot: 2026-10-26 (America/Vancouver). This is not a runtime qualification, installation, approval, migration or release receipt.

## Result

Keep Airodrom as the single control plane. Ollama supplies inference; OpenCode supplies bounded planning and evaluation; current development policy assigns implementation to Cursor. These are intentional boundaries, not three competing owners of the application. Removing either dependency would remove capabilities and require a separately designed replacement. A single Airodrom operator interface is compatible with these separate internal roles; packaging consolidation is a separate decision from deleting them.

The implemented consolidation removes four byte-identical lexical normalizers. It does not combine routers, memory stores, approvals, workers or schedulers. Existing contracts from [accepted ADR 0011](adr/0011-conversation-engine-and-intent-routing.md), [ADR 0043](adr/0043-core-contracts-runtime-consistency.md) and the current source policy [ADR 0065](adr/0065-cursor-only-routine-autonomy.md) remain unchanged. ADR 0065 still labels itself a proposed source candidate; its code presence is not proof of live worker qualification.

## Verified baseline and preservation

| Surface | Observation | Evidence / limit |
| --- | --- | --- |
| GitHub `main` | `cc75a8bd97f2310d65f60496d711f550c03d068a`, merge of #245 | Fresh remote clone; GitHub branch API independently returned the same SHA. [Commit](https://github.com/airodrom/airodrom/commit/cc75a8bd97f2310d65f60496d711f550c03d068a). |
| Installed source | `96e30d25eebf131929b0b4c6d0fc4a42b8645749`; package `1.0.1-rc.1` | Allowlisted source pointer plus installed `INSTALLED_SHA.txt` and package metadata; the healthy daemon's working directory matches that source root. Version marker is not a byte-for-byte attestation of every installed file. |
| Main versus installed revision | Only `docs/COMPLETE-RAILS-AND-EXECUTION-ARCHITECTURE.md` differs between the two committed revisions | `git diff --stat 96e30d2..cc75a8b`; source history comparison, not an assumption that live configuration matches source defaults. |
| Native app metadata | `1.0.1-rc.1`, build `5` | Read only the two version fields from the app metadata. |
| Managed Node / OpenCode | Node `22.23.4`; managed OpenCode `2.0.25` | Binary `--version`; SHA-256 of all three recorded executable pins (Node, sandbox, OpenCode) matched. |
| Other OpenCode on PATH | `2.1.4` | Separate Homebrew binary `--version`; it is not the managed 2.0.25 pin. No replacement or requalification attempted. |
| Cursor app metadata | `3.25.9` | Read-only app version fields; does not establish headless-worker qualification or subscription authorization. |
| Ollama | Running service reports `0.40.2` | Read-only loopback `GET /api/version`; no inference, model pull or model removal. |
| Managed health | Healthy, MCP ready; zero pending approvals, decisions, quarantined leases and pending outbox entries | Existing `scripts/harness-safe-status.cjs`, against the managed data root; no discovery document or token exported. |
| Writer ownership | Zero held/quarantined `cp_leases`; zero `cp_runs` with no end timestamp | Read-only aggregate SQL in the actual `memory.sqlite`, where `BridgeController` constructs `ControlPlaneStore` ([src/bridge-controller.js](../src/bridge-controller.js#L356)). The separately named empty `control-plane.sqlite` is not the authoritative live store. |
| Registered worktrees | 196 available; 11 with tracked changes; 48 with tracked or untracked changes; zero Git lock flags | Primary repository's `git worktree list --porcelain` and read-only status for every registered path. Counts exclude unrelated clones and do not establish ownership of every external editor process. |
| Protected operator checkout | `a1f97c501e203d72e5e90d24fd36c2ebaeb24320`; 73 changed tracked entries and 84 untracked entries | Preserved without checkout, stash, reset, cleanup, fetch or edits. Lack of a Git lock never makes it disposable. Exact local path inventory stays private. |
| GitHub controls | `main.protected=false`, required check contexts empty; Actions disabled | Read-only branch and Actions-permissions APIs. No protections, settings or workflow runs changed. |
| Audit workspace | Independent clone; branch `audit/architecture-deduplication-v1` based on the verified `main` | Own Git object/index/worktree state, outside installed and operator checkouts. Existing dependencies copied into this clone after exact lockfile comparison; no package installation. |

All local values above are time-bounded observations, not standing permission. Live user content, credential values, private manifests, worktree paths and raw process arguments are excluded from this report and PR.

### Existing open PRs at intake

| PR | State / head | Relevant overlap and disposition |
| --- | --- | --- |
| [#148 Mission List Cleanup V1](https://github.com/airodrom/airodrom/pull/148) | Draft; `513e13781e11394aae00b60448042c289c40a301` | Mission visibility, supervisor, UI, docs and manifests. Do not replace its archive state machine or count it as another scheduler. This audit only overlaps documentation/package allowlists; retain both sets of entries when rebasing. |
| [#37 DeepSeek reserve](https://github.com/airodrom/airodrom/pull/37) | Draft; `c5902f3c346494d2a38ab618e9a3f362e1136d13` | Provider routing, privacy and per-request paid authorization. No provider/approval consolidation here; additive manifest conflicts require review. Open proposal is not installed functionality. |

## Responsibility ownership matrix

“Owner” means the implementation responsible for the behavior, not a new permission grant. Paths below refer to the audited source; unchanged-path line anchors remain valid on this branch. The baseline is the exact `main` SHA above.

| Responsibility | Canonical owner and code evidence | Boundary / consumer |
| --- | --- | --- |
| Authenticated request classification | [src/assistant-intent.js](../src/assistant-intent.js#L127), [src/assistant-service.js](../src/assistant-service.js#L55) | Host selects deterministic routes before ordinary inference. A classification describes intent; downstream services still validate authority. |
| Shared parser lexical cleanup | [src/assistant-intent-text.js](../src/assistant-intent-text.js), consumed by Gmail search/write, Calendar and email-compose intent modules | NFKC, quote and whitespace cleanup only. No classification, authentication, context binding, I/O or approval. |
| Ordinary conversation | [src/conversation-engine.js](../src/conversation-engine.js#L29), [src/conversation-provider.js](../src/conversation-provider.js) | Owns operator/channel sessions, bounded history, turn cancellation and revalidation. `complete` invokes text-only inference and rejects tools. It does not create execution Missions. |
| Inference transport | [src/apps/openai-compatible-provider.js](../src/apps/openai-compatible-provider.js#L24), [src/provider-gateway.js](../src/provider-gateway.js), [src/local-ollama-broker.js](../src/local-ollama-broker.js#L130) | Providers return model output. Gateway owns routing/budget policy; the local broker validates a bounded streaming protocol. Neither provider nor Ollama can approve a host action. |
| Conversation model eligibility | [src/model-worker-router.js](../src/model-worker-router.js), [src/conversation-engine.js](../src/conversation-engine.js#L206) | Qualification checked before dispatch and delivery. Model identity is distinct from worker identity. |
| Personal, project and session reference memory | [src/personal-memory.js](../src/personal-memory.js#L106), [src/memory-store.js](../src/memory-store.js#L78), [src/project-memory-v2.js](../src/project-memory-v2.js#L288) | PersonalMemory uses scoped durable facts; MemoryStore has task-scoped context; ProjectMemoryV2 has structured checkpoints/resume packets. Similar storage vocabulary does not imply identical schemas or retention. |
| Governed memory and context selection | [src/authority-memory.js](../src/authority-memory.js#L29), [src/authority-integration.js](../src/authority-integration.js#L28), [src/control-context.js](../src/control-context.js#L26) | Promotion, provenance, current eligibility and bounded ContextPacks are host-owned. Active governed-memory routing supersedes selected legacy paths; compatibility paths still exist. No store migration in this audit. |
| Repository architecture knowledge | [src/architecture-memory.js](../src/architecture-memory.js), [config/architecture-memory-sources-v1.json](../config/architecture-memory-sources-v1.json) | Hash-pinned sources and provenance, not worker assertions. Canonical knowledge cannot change Mission authority. |
| Optional developer recall | [src/developer-memory.js](../src/developer-memory.js), [src/developer-memory-hindsight.js](../src/developer-memory-hindsight.js), [src/control-context.js](../src/control-context.js#L45) | Optional subordinate repository evidence through the host ContextPack. No independent memory-authority or scheduling plane; no enablement performed. |
| Tool schema, policy and execution | [src/capability-host.js](../src/capability-host.js), [src/capability-policy.js](../src/capability-policy.js), [src/capability-broker.js](../src/capability-broker.js#L404) | Host registers typed implementations; policy assesses; broker validates task binding and mediates execution. The entry surfaces [src/mcp-tools.js](../src/mcp-tools.js) and [src/control-plane-api.js](../src/control-plane-api.js) expose operations, not permission grants. |
| Exact action approvals | [src/safety-policy.js](../src/safety-policy.js#L282) | Tool/task/input fingerprint, expiry, one-shot consumption. An approved Mission does not erase an action-level denial. |
| Mission approval / finite external invocation authority | [src/mission-contract.js](../src/mission-contract.js#L86), [src/mission-approval.js](../src/mission-approval.js#L48), [src/host-execution-policy.js](../src/host-execution-policy.js) | Frozen scope, budget, workspace, disclosure and bound invocation reservations. Distinct from exact tool approval and ordinary conversational consent. |
| Mission orchestration and scheduling | [src/mission-service.js](../src/mission-service.js#L16), [src/mission-program.js](../src/mission-program.js), [src/autonomous-execution.js](../src/autonomous-execution.js) | Host schedules authorized work and durable attempts. Programs and Goal Plans compose this lifecycle; [src/autonomous-supervisor.js](../src/autonomous-supervisor.js) projects state/admission and is not a second scheduler. Worker runtimes do not own it. |
| Planning and evaluation | [src/cognitive-router.js](../src/cognitive-router.js#L91), [src/opencode-gateway.js](../src/opencode-gateway.js#L414), [src/apps/opencode-adapter.js](../src/apps/opencode-adapter.js#L317) | OpenCode plans/evaluates under bounded contracts. Evaluator receipts bind worker result, verification and workspace. Recommendation is not Acceptance. |
| Development implementation | [src/cognitive-router.js](../src/cognitive-router.js#L397), [src/cursor-worker.js](../src/cursor-worker.js), [ADR 0065](adr/0065-cursor-only-routine-autonomy.md) | Current governed edit path requires Cursor. A generic OpenCode adapter still exists for planning/read-only and compatibility paths; its existence is not permission to select it for current edits. |
| Independent verification, Acceptance and Settlement | [src/mission-verifier.js](../src/mission-verifier.js#L94), [src/mission-service.js](../src/mission-service.js), [src/control-plane-store.js](../src/control-plane-store.js#L120) | Host checks protected files, scope and tests; current evidence plus verified termination gate completion. Model evaluation cannot replace deterministic host checks. |
| Erasure and retained-content governance | [src/memory-content-erasure.js](../src/memory-content-erasure.js), [src/memory-erasure.js](../src/memory-erasure.js), [config/memory-retention-fields.json](../config/memory-retention-fields.json) | Shared identity/erasure barriers apply across stores and derived conversation/context records. Combining stores without migration would risk resurrection or loss. |

### Traced request paths

1. **Conversation:** host ingress → `assistant-intent.parse` → `assistant-service.submit` → `ConversationEngine.start/complete` → `OpenAICompatibleProvider.execute` → fixed loopback Ollama endpoint → qualification, generation and content checks → turn result. See [src/conversation-engine.js:206](../src/conversation-engine.js#L206). Tool requests are rejected even when returned by the model.
2. **Connector request:** host ingress → a domain parser → `assistant-service` → connector service's bound preview/confirmation and provider scopes. “Draft locally,” “search mail,” and “send mail” remain different operations. Shared normalization does not combine their authority. See [src/gmail-write-service.js](../src/gmail-write-service.js) and [src/calendar-service.js](../src/calendar-service.js).
3. **Development Mission:** cognitive request → repository/enrollment binding → OpenCode plan → validated/sealed contract and existing approval/grant → host dispatch of Cursor assignment → Result Inbox → independent host verification → OpenCode evaluation receipt → host Acceptance/Settlement. See [src/cognitive-router.js](../src/cognitive-router.js), [src/specialist-gateway.js](../src/specialist-gateway.js), [src/opencode-gateway.js](../src/opencode-gateway.js), [src/mission-verifier.js](../src/mission-verifier.js). The audit itself is direct, user-requested repository work; no Airodrom Mission or grant was created or self-approved.
4. **Reasoning-only compatibility paths:** [src/reasoning-admission.js](../src/reasoning-admission.js) binds a local streaming broker request; [src/host-reasoning-admission.js](../src/host-reasoning-admission.js) binds policy-routed provider requests, replay protection and budgets. Both deny execution authority, but their durable rows and admission contracts differ. Merging them requires explicit migration/replay design.

## Real duplication versus intentional boundaries

| Finding | Evidence | Decision |
| --- | --- | --- |
| Exact duplicate lexical helper in four parsers | Baseline `normalize`: [gmail-search-intent.js:22](https://github.com/airodrom/airodrom/blob/cc75a8bd97f2310d65f60496d711f550c03d068a/src/gmail-search-intent.js#L22), [gmail-write-intent.js:5](https://github.com/airodrom/airodrom/blob/cc75a8bd97f2310d65f60496d711f550c03d068a/src/gmail-write-intent.js#L5), [calendar-intent.js:5](https://github.com/airodrom/airodrom/blob/cc75a8bd97f2310d65f60496d711f550c03d068a/src/calendar-intent.js#L5), [email-compose-intent.js:4](https://github.com/airodrom/airodrom/blob/cc75a8bd97f2310d65f60496d711f550c03d068a/src/email-compose-intent.js#L4) | Consolidated byte-identical body in `assistant-intent-text.js`; four existing `normalize` exports preserved. |
| Repeated OAuth and uncertain-write mechanics | `exchangeError`, `phaseOf`, `parseScopes`, `scopesEqual`, `parseProviderError` in [src/gmail-oauth.js](../src/gmail-oauth.js) / [src/calendar-oauth.js](../src/calendar-oauth.js); `isUncertainWriteError` in [src/gmail-write-service.js:102](../src/gmail-write-service.js#L102) / [src/calendar-service.js:128](../src/calendar-service.js#L128) | Real duplication, deferred. Credential lifecycle, scopes and ambiguous delivery are higher-risk than lexical cleanup. A shared transport primitive must preserve both domain contracts. |
| Repeated containment / policy helpers | `contained` in [src/capability-broker.js:36](../src/capability-broker.js#L36), [src/safety-policy.js:34](../src/safety-policy.js#L34), [src/trusted-dev-runner.js:19](../src/trusted-dev-runner.js#L19); `inside` in [src/js-verification-runtime.js:35](../src/js-verification-runtime.js#L35) | Exact code overlap, deferred. Validation belongs at each trust boundary; sharing implementation could be considered only with traversal/symlink/cross-platform adversarial coverage. Do not remove checks. |
| Similar memory validators and serializers | [src/memory-store.js](../src/memory-store.js), [src/personal-memory.js](../src/personal-memory.js), [src/project-memory-v2.js](../src/project-memory-v2.js), [src/authority-memory.js](../src/authority-memory.js) | Some exact helper overlap, but byte versus character bounds, prototypes, accepted fields, hashes and provenance differ elsewhere. No blanket utility or schema unification. |
| Root/App file pairs | [src/opencode-adapter.js](../src/opencode-adapter.js), [src/capability-git.js](../src/capability-git.js), [src/provider-secrets.js](../src/provider-secrets.js) forward to `src/apps/` | Intentional compatibility exports, already one implementation. Deleting shims would break callers/package paths without reducing behavior duplication. |
| Conversation versus reasoning Missions | [ADR 0011](adr/0011-conversation-engine-and-intent-routing.md), `ConversationEngine`, two reasoning-admission modules | Different lifecycle/authority contracts. Ordinary chat must not regain Mission overhead or tools. |
| Tool policy, Mission approvals and standing grants | `capability-policy`, `safety-policy`, `mission-approval`, `host-execution-policy`, `developer-autonomy` | Layered scope checks with different lifetimes and subjects; not redundant approval dialogs to remove wholesale. |
| OpenCode evaluation versus host verifier | `opencode-gateway` receipt binding and `mission-verifier` protected input/tests | Intentional independent evidence. A model recommendation cannot prove file scope, test integrity or termination. |
| Ollama versus OpenCode versus Airodrom | `apps/openai-compatible-provider`, `apps/opencode-adapter`, `mission-service` | Inference, bounded agent protocol and governing host respectively. Retain all three roles; actual implementation policy also includes Cursor. |
| Two OpenCode installations | Managed hash-pinned 2.0.25 and separate PATH 2.1.4 | Version drift/retained artifacts, not duplicate control planes. No cleanup without a separate pin, rollback and ownership review. |
| Architecture narratives and state snapshots | `docs/ARCHITECTURE.md`, `docs/COMPLETE-RAILS-AND-EXECUTION-ARCHITECTURE.md`, `docs/CURRENT-STATE.md`, `docs/adr/README.md` | Real documentation drift. Added a dated audit pointer instead of rewriting historical receipts or changing accepted authority semantics. |

The duplicate scan was bounded source inspection (exact standalone function bodies plus call-path review), not a proof that all semantic duplication has been found. No module was declared dead merely because a name looks historical.

## Documentation drift and unresolved choices

- `CURRENT-STATE.md`'s first installed section names `b182fa4`, while the current installed marker is `96e30d2`. Preserve the former as historical evidence; the dated audit pointer disambiguates it.
- The rails narrative's Conversation limitation still says date/port questions classify as ordinary conversation. `src/host-fact-intent.js`, `src/assistant-intent.js:127` and `src/assistant-service.js:121` now route supported phrases to host facts. These descriptions need a separate evidence-backed editorial reconciliation, not a change to permissions.
- `docs/adr/README.md` describes ADR 0011 as Proposed although the ADR says Accepted. It also summarizes ADR 0060's older OpenCode-default choice; ADR 0065 supersedes that worker choice. Keep ADR acceptance status and implementation status as separate claims. The index now points at the audit/current policy rather than silently treating all historical descriptions as current.
- `config/architecture-memory-sources-v1.json` pins only `docs/harness/agent-model.md`, `architecture.md` and `decisions.md`. Updating a prose overview does not automatically update canonical architecture memory. No hash/source bootstrap or live memory promotion was done.
- Owners still need to decide whether to retire legacy reasoning-admission and memory compatibility paths, consolidate Google transport helpers, and reconcile ADR statuses. Any durable-store consolidation needs reader/writer inventory, export/import and erasure tests, versioned migration, rollback and independent authority/privacy review.
- Hosted Actions are disabled and `main` is unprotected. This report records the state; it does not turn local test results into merge permission. Existing PRs remain drafts and need their own rebase/release decisions.

## Implemented change and migration / rollback

The new helper is the original function body with its coercion semantics unchanged, including falsy values, NFKC, curly quotes and whitespace. Each parser keeps its existing exports, route order, limits, validators, regexes and domain-specific follow-ups. No schemas, canonical hashes, API contracts, credentials, model settings, grants or retained data change. The source and npm file allowlists include the helper; the source allowlist includes the audit and targeted test.

No data migration is required. Review and test the branch, then merge only through the owner's normal process. Deployment is a separate explicit action: distribute the shared helper atomically with all four importing modules; copying individual changed parsers without the helper would fail module loading. An installed-file smoke check should resolve all four imports before any separately authorized cutover. Fixture results do not qualify live providers or workers.

Before merge, rollback is closing the draft or discarding this isolated branch. After merge, revert the whole audit commit through a reviewed PR, including the four parser imports, helper and manifests together. If later installed, use the established authorized source rollback procedure; preserve databases, approvals, erasure records and runtime pins. This audit does not run that procedure or instruct a service restart.

## Validation evidence

Validation results are recorded below after execution. The test environment uses Node 22.23.4, existing dependencies copied from the installed source with an identical `package-lock.json`, and synthetic disposable fixtures. Locked dependency installation and live worker/model qualification are deliberately not performed.

| Check | Result |
| --- | --- |
| Targeted parser / Gmail / Calendar / local-compose suite | 76/76 passed (six test files, including three new regression tests). |
| Baseline differential check | 636 equality assertions passed against untouched `cc75a8b`: all four existing `normalize` and `parse` APIs, input variants and bound-session options. |
| Authority and SDK type checks | Passed. |
| Source/syntax/docs/canonical hashes | Passed: 993 allowlisted files, 716 syntax checks, 42 JSON files; local references resolved. |
| npm package inspection | Passed: 534 files, all 319 runtime files included, no forbidden entries. No registry publication. |
| Dependency and license audit | Zero reported vulnerabilities; 39 locked packages, MIT/Apache-2.0, zero install scripts or blocked licenses. 20 platform-present copied packages match locked versions; remaining entries are optional. |
| Secret and history scans | Passed: recognized directory/history scans and additional provider/private-key classes have zero findings. Output contains metadata only. |
| Native compilation and helper fixtures | Passed with the existing matching Xcode compiler/SDK; binary and cache built only in this checkout's ignored `work/` tree. No installer or service command. |
| CLI help / SBOM | Passed; SBOM generated locally. |
| Full deterministic suite | Completed: 2,855 tests; 2,836 passed, 13 failed, 6 skipped, zero cancelled. All 13 failing tests independently reproduce on untouched `cc75a8b`. Full gate remains failing. |
| Reproducible source archives | Two final allowlisted archives are compared byte-for-byte; final SHA-256 is recorded in the PR evidence. |
| Clean dependency installation / live runtime qualification | Not run: installation and live runtime changes are outside this audit. |

Reproduce the targeted check with:

```sh
node scripts/run.cjs --test tests/assistant-intent-text.test.js tests/gmail-nl-search-pagination.test.js tests/gmail-write-stage-a.test.js tests/gmail-write-durability-v1.test.js tests/calendar-nl-control-v1.test.js tests/email-compose-memory-v1.test.js
```

The full run uses `node scripts/run.cjs --test --test-concurrency=4 tests/*.test.js`. Concurrency is bounded for local resource usage; the test glob matches `npm test`. Hosted CI was not enabled or dispatched.

All failures listed below were independently reproduced in a clean detached checkout of `cc75a8b`, using the unchanged tests and the same installed dependencies. The baseline checkout remained clean. This establishes pre-existence, not harmlessness: the conversation-policy failure needs priority investigation before release. No existing assertion was weakened or skipped to make this audit pass.

| Baseline test | Observed failure |
| --- | --- |
| [tests/autonomous-task-routing.test.js:47](../tests/autonomous-task-routing.test.js#L47) | Operator-control expectation receives `host_fact`. |
| [tests/conversation-cli.test.js:85](../tests/conversation-cli.test.js#L85) | Bracketed multiline paste is collapsed to spaces. |
| [tests/cursor-admission-closeout.test.js:77](../tests/cursor-admission-closeout.test.js#L77) | Disabled-Cursor admission expects `BLOCKED`, receives `CLARIFY`. |
| [tests/cursor-roundtrip-reliability.test.js:55](../tests/cursor-roundtrip-reliability.test.js#L55) | Standing enrollment disabled-Cursor expectation has the same mismatch. |
| [tests/orchestrator-mcp.test.js:408](../tests/orchestrator-mcp.test.js#L408) | Capability inventory count is 188 versus expected 187. |
| [tests/personal-assistant-v1.test.js:8](../tests/personal-assistant-v1.test.js#L8) | “Send” deterministic ingress expects `work`, receives `clarify`. |
| [tests/personal-ops-job-search-v1.test.js:261](../tests/personal-ops-job-search-v1.test.js#L261) | OAuth refresh rejection message does not match the test's expectation. |
| [tests/personal-storage-routing.test.js:96](../tests/personal-storage-routing.test.js#L96) | Model persistence-claim rejection expects `failed`, receives `completed`; a release-blocking policy regression until investigated. |
| [tests/projectless-work.test.js:79](../tests/projectless-work.test.js#L79) | WORK packet text no longer matches the expected multiline form. |
| [tests/terminal-paste-timeout.test.js:21](../tests/terminal-paste-timeout.test.js#L21) | Bracketed TTY paste: expected synthetic output unavailable within the fixture deadline. |
| [tests/terminal-paste-timeout.test.js:60](../tests/terminal-paste-timeout.test.js#L60) | Coalesced multiline paste: same fixture deadline failure. |
| [tests/zero-manual-autopilot.test.js:87](../tests/zero-manual-autopilot.test.js#L87) | Default-repository Autopilot path expects a true admission condition, receives false. |
| [tests/zero-setup-work.test.js:56](../tests/zero-setup-work.test.js#L56) | Disposable Projects expectation receives false. |

Baseline reproduction ran the full autonomous-routing file (4 tests), the CLI and admission-closeout files together (26 tests), and ten exact failing tests across the remaining files. Across those 40 tests, the same 13 failed (27 passed). A complete second baseline regression run was not performed. The audit branch remains a draft, not a qualified release.
