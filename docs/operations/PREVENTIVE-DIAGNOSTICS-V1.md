# Preventive diagnostics and authorized recovery V1

Status: source candidate; installation and live qualification require separate owner authorization. See [ADR 0064](../adr/0064-preventive-policy-diagnostics.md) and the [blocker registry](LIMITS-AND-BLOCKERS-REGISTRY.md).

## Authority remains unchanged

YOU → ChatGPT → Airodrom → OpenCode → Cursor → OpenCode → Airodrom → ChatGPT → YOU.

Airodrom owns admission, authority, host verification, settlement, and acceptance. A diagnosis or simulated decision is evidence, never permission. OpenCode evaluates bounded results; Cursor assignments remain separate bounded work. No new controller, framework, approval path, grant, runtime endpoint, or security-disable switch is introduced.

## Rules and enforcement map

| Contract / configuration | Enforcement | Required evidence and remedy |
|---|---|---|
| `config/capability-policy-v2.json`: `precedence.rule`, `precedence.order`, `neverAutomaticClasses`, `alwaysDeny`, `capabilities.<name>.decision/taskScopes/riskClass/alwaysDeny`, `defaultTaskScopes` | `src/capability-policy.js`: `loadCapabilityPolicy`, `CapabilityPolicy.decide` | Most restrictive decision wins; dynamic context cannot weaken a denial. Protected classes cannot become automatic. Correct a specific rule only with positive and negative tests. |
| Task workspace, approval expiry, protected files and private roots | `src/safety-policy.js`: `SafetyPolicy`; `src/fs-scopes.js`: `FilesystemScopes.resolve` | Canonical path, real path, read/write mode, containment, sensitive-path screening. An approved action still cannot escape its filesystem scope. |
| `cp_host_execution_policy.cursor_execution_disabled` | `src/host-execution-policy.js`; `src/cursor-execution-decision.js` | Runtime availability and permission to execute are separate. Host enablement alone does not grant a Mission. |
| `cp_standing_cursor_development`: `repository`, `policy_id`, `path_allowlist`, `disclosure_providers`, `data_classes`, `expires_at`, `revoked_at`, `missions_used`, `max_missions`, `max_invocations_per_mission`, `max_runtime_ms` | `HostExecutionPolicy` standing-grant matching and `CursorExecutionDecision.decideAuthority` | Exact current match, remaining budget, unexpired and unrevoked authority. Renewal or changed ceilings requires the owner. |
| Cognitive enrollment: `files`, `delegated_callers`, `planning_attempts`, `planning_ms`, `execution_ms`, `max_assignments`, `repair_attempts`, `acceptance`; sealed `policy_hash` | `src/cognitive-router.js`: preparation, delegation, binding and dispatch checks | Exact active repository selection, qualified eligible worker, finite timing and assignments. No silent alias selection or resealing during recovery. |
| RequestEnvelope versions 1–3: `permitted_paths`, `denied_paths`, `operations`, `eligible_workers`, `verification`, `limits`, `instruction_hash`, `expires_at`; optional `requested_scope` version 1 | `src/cognitive-contracts.js`, `src/requested-file-scope.js`: extraction, enrollment, proposal, original-request and verification checks | Literal operation/path bindings narrow enrollment. A substituted basename, widened scope, missing operation, or changed instruction cannot become authority. See ADR 0063. |
| DA budgets: `max_repairs`, `max_concurrent_missions`, `grant_ttl_minutes`, `max_files`, `max_worktrees`, `max_runtime_hours`; filesystem reserve | `src/developer-autonomy.js`: preparation, grant, dispatch, repair and cleanup checks | Preserve active, quarantined, dirty and unique work. `max_disk_mb` is compatibility metadata; actual capacity uses filesystem free space. |
| Project `repositories`, `MAX_PROJECT_REPOSITORIES = 24` | `src/project-orchestrator.js`: `repositoryPaths`; DA `repositoryRegistrationPlan` / `reconcileRepositoryRegistrations` | The limit is unchanged. Retire only proven idle terminal DA aliases for the exact policy. Unknown registrations stay protected. |
| Bound Mission authority, immutable contract and registered verification | `src/mission-service.js`: `assertAuthority`; `mission-approval`, `mission-contract`, `mission-permissions`, `repository-verification` | All admission checks repeat at dispatch. Acceptance requires current host verification and settled execution; READY prose is insufficient. |
| Evaluation packet, stage, result schema and durable execution receipts | `src/opencode-gateway.js`; `src/specialist-gateway.js` | Re-evaluate the same verified result within existing budgets; never replay a completed Cursor assignment just to obtain an evaluation. A requested implementation repair is a separate bounded assignment. |
| Writer identity, process termination and lease state | `src/execution-lease.js`, `src/writer-death-recovery.js`, `src/run-settlement.js` | No release of an uncertain writer based solely on elapsed time. Independently prove death and settle before continuing. |

Existing runtime selectors are not bypasses: `AIRODROM_NODE` selects the supported Node executable; `NODE_ENV=test` alone does not qualify a worker (the explicit fixture option is also required). `AIRODROM_TRUSTED_DEV_MODE` belongs to the existing sandbox workflow. This change sets none of them on the installed service. The new `AIRODROM_POLICY_SIMULATION_FIXTURE` marker exists only in the isolated test runner and is absent from runtime imports.

## Confirmed defects and corrections

1. **Repository alias accumulation.** Workspace history and active project bindings have different lifetimes. Lost best-effort unbinding and retained terminal evidence could consume the 24-path registry even when worktree execution capacity was available. Preparation now reconciles exact policy-owned, disposable, independently idle `cleaned`/`bound`/`held` aliases before cloning. It preserves source/unknown/ready paths, active or missing grants, planning requests, unsettled lineages, quarantined writers and changed identities. Only the active alias list narrows; files and historical rows remain. If another preparation takes the final slot during async materialization, registration and the ready row commit together or the new clone is recorded `held`, without scope or dispatch. A genuine full registry yields `PROJECT_REPOSITORY_CAPACITY_EXHAUSTED` with the exact limit and remedy.
2. **Misclassified errors.** Matching only the first word or any embedded known token could convert an unknown error into operational recovery. Resolution now accepts a complete registered code/message, normalized equivalent, or a complete registered prefix followed by a colon. Unknown and security blockers in a compound failure prevent an operational first code from triggering recovery.
3. **Incomplete observations.** The registry used envelope fallbacks instead of the authoritative `cp_missions.reason`, filtered container objects instead of nested annotations, and concatenated requests before Missions. It now reads durable reason/project fields, filters annotations, and merges by time. This remains a bounded latest-50 sample, not a historical frequency counter.
4. **Recovery could alter enrollment.** Timing recovery called `ensureCognitiveDiscovery`, which can reseal enrollment and add files/workers. Deadline and timing diagnostics now inspect current limits only. Changed authority requires an exact owner decision.
5. **Retry accounting could fail open.** A storage error previously looked like zero attempts, and a recovery callback could re-enter before its attempt was recorded. The dispatcher reserves the attempt under the existing SQLite transaction before callbacks. Missing accounting or lineage prevents executable recovery; a crash consumes the reservation. The existing maximum remains two attempts per blocker/lineage.
6. **Cleanup was too broad.** A capacity failure could invoke cleanup across active policies. Recovery now derives one exact policy from the durable Mission/request and invokes existing proof-gated cleanup only for that policy. No binding means diagnosis only.

The required registry configuration is now explicitly included in the package and checked by `package:check`; the simulator remains excluded.

The registry adds explicit entries for legacy repository-input errors, repository capacity, ambiguous repository selection, projectless scope, filesystem-scope denials, missing file operation, and evaluation-stage mismatch. Missing-operation clarification is separate from security-critical wrong-file substitution. Clarification can be supplied by the requester without issuing a new grant.

## Lightweight preflight contract

The individual checks below exist today. This candidate implements the repository-capacity early check and structured blocker annotations. The complete aggregate response below is a **design for a subsequent adapter**, not a newly shipped API or a new authority layer. It should call existing read-only checks and retain every failure; it must not clone, enroll, issue grants, renew authority, or reserve execution merely to inspect readiness.

| Stage | Existing check to reuse | Fail-closed output |
|---|---|---|
| Repository identity | Project resolution, exact enrollment, directory identity | Missing or ambiguous exact repository |
| Project/workspace | Project membership and DA workspace identities | Unbound, replaced or protected workspace |
| Requested operation | Versioned requested-scope parser and validator | Exact operation/path clarification |
| Read/write scope | Requested scope + filesystem real-path containment | Missing scope; no substitution |
| Worker readiness | Qualified runtime and Cursor execution decision | Ready/available separately from authorized |
| Grants/budgets | Current standing/DA grant match, expiry, remaining quotas | Exact unmatched field, no renewal |
| External disclosure | Provider and data-class grant match | Minimum scoped owner acknowledgement |
| Capacity | DA occupied count, disk reserve, repository registration plan | Exact exhausted resource; no arbitrary cleanup |
| Evaluator readiness | OpenCode runtime probe and bounded evaluation contract | Runtime unavailable, not worker success |
| Leases | Active/uncertain dispatch and quarantine checks | Writer identity and termination evidence needed |
| Verification | Registered manifest, original request and immutable contract | Missing or changed host verification contract |

Suggested response fields: `schema_version`, `request_id`, `mission_id`, source/runtime commit and worker version, observation time, immutable contract/policy fingerprints, `checks[]`, `blockers[]`, `ready`, `authority:false`. Each blocker contains `code` (redacted outward), `registry_id`, `policy_decision`, `source` (file/symbol), `missing_prerequisite`, `allowed_recovery`, `automatic_recovery_allowed`, `owner_approval_required`, and `next_safe_action`. A preflight success is advisory and cannot be reused as a grant: dispatch revalidates current state. Prefer typed operation/path input and sealed contracts; prose remains a convenience input with explicit clarification on ambiguity.

## Unknown-blocker workflow

Preserve original evidence in existing restricted durable storage. Project only redacted code/context to diagnostics. Correlate the request, Mission, current run, worker qualification, installed commit, contract/policy fingerprints and enforcement site using existing records. Missing correlation is a limitation, not a guessed match.

`resolve` maps to a registered definition or `unknown_blocker`; annotation always has `authority:false`. Unknown errors have no executable recovery. Exact source inspection and historical-fix comparison are engineering diagnostics, not automatic policy rewriting. A confirmed transient may use an existing allowlisted recovery only while original authority, lineage, budget and proof gates remain valid. A confirmed defect gets a scoped source change plus regression. An unmatched authority field requests that precise owner action. Security-critical or uncertain failures remain blocked. The dispatcher does not automatically create PRs, deploy corrections, or issue grants.

Recovery receipts remain durable in `cp_limits_blocker_recovery_attempts`. SQLite reservations prevent reentrant work from observing an unconsumed budget. Diagnostic output adds `policy_decision`, `missing_prerequisite` and `allowed_recovery`; source and owner fields remain present. A registry definition describes a possible recovery, not proof that a particular Mission may execute it.

## Recurrence measurement and evidence limitations

Keep installation-specific counts, identifiers, paths and raw incident evidence in the private investigation report, outside the public source/package. The 2026-10-24 investigation produced that report with all 17 requested codes and actual snapshot counts. Do not copy private records into public documentation.

Reproduce counts using a SQLite read-only connection and one read transaction. Record snapshot time, table sizes, ledger sequence/time range, and payload-retention coverage. Count separately: current `cp_missions.reason` matches; `cp_zero_setup_requests.record.blockers` matches; ledger `payload`/`metadata` reference rows. Deduplicate once per row/code. These populations overlap, and explanatory ledger references are not necessarily denials. Current reasons are not an event history. Missing payloads and presentation-only blockers make zeros inconclusive. Do not sum the columns or invent a ranking.

Historical source fixes include exact requested-file binding, exact enrolled aliases, workspace identity handling, evaluator stage/read authority, durable evaluator recovery, Cursor readiness/authority separation, and proof-gated lease/worktree reconciliation. Compare installed and source commits before proposing a reinstall. A legacy `Invalid repositories` record cannot distinguish malformed input from registry capacity without its original request-time array.

## Isolated simulator

Run `node scripts/run.cjs --test tests/policy-simulator.test.js` on macOS with the supported Node runtime and Seatbelt. The parent creates a disposable fixture, copies only two pure policy modules and two public static configurations, and supplies one fixed synthetic scenario. The child receives a clean environment and a fixture-only Node filesystem permission grant. The existing Seatbelt profile denies networking and process creation. Tests require an outside-file read, a child process and a network listener to be denied; unsupported containment fails the test rather than skipping it.

`tests/fixtures/policy-simulator.cjs` compares synthetic current/proposed decisions and reports the changed rule. Cases cover an overrestrictive read, missing scope, `alwaysDeny`, and protected risk classes. The actual capability configuration is unchanged. Every output has `synthetic_only:true`, `authority:false`, `accepted:false`, `execution_permitted:false`. No control plane, database, real workspace, Mission constructor, credentials, grant path, or acceptance path is copied. The fixture is excluded from `package.json.files`, has no production import/endpoint, and refuses execution without its fixture marker and directory contract. The marker is not a security boundary by itself; sandbox and Node permissions are mandatory.

## Regression, release and rollback

New regressions cover exact/unknown code matching, compound denials, diagnostic redaction/filtering/chronology, read-only timing diagnosis, unavailable accounting, nested attempt reservation, missing lineage, policy-bound cleanup, stale alias retention, dirty evidence preservation, unknown/active registrations, final-slot races, and simulator containment. Existing requested-scope, cognitive router, host policy, Mission approval, evaluation, specialist gateway and writer-death suites exercise admission, expiry/revocation, bounded repairs, evaluator-only recovery, host verification and settlement.

Use the supported wrapper, source/publication verifier, package checker, authority and SDK type checks. Fixture success does not establish real Cursor/OpenCode qualification. The simulator intentionally supports fixed synthetic cases, not arbitrary operator-supplied policy programs. The broad preflight adapter, other natural-language parser work, and a live canary remain separate work.

Before publication, review the source diff and preserve unrelated branches. Before installation, obtain separate owner authorization, verify immutable candidate and rollback commits, check no active/uncertain execution, and retain durable state. Run one small enrolled exact-file canary with existing legitimate authority through OpenCode → Cursor → OpenCode and inspect host verification, settlement and acceptance. Halt on wrong scope, changed authority, duplicate Cursor dispatch, unverified termination, or incomplete evidence. No grant enlargement is a recovery step.

Rollback requires owner authorization and drained/proven-settled execution. Keep the previous immutable installation, restore it through the existing install procedure, and preserve all evidence and held clones. New diagnostic fields are additive and the attempts table uses its existing schema. Reverting to the prior runtime also reintroduces the diagnosed recovery defects; do not invoke those recovery paths until corrected. Do not rewrite historical envelopes, grants or receipts to make an older runtime accept them.

## Primary research and adopted patterns

- [OWASP Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html): deny by default, least privilege, authorization on each request, and positive/negative tests.
- [OPA debugging](https://www.openpolicyagent.org/docs/debugging) and [REST API explanations](https://www.openpolicyagent.org/docs/rest-api): structured decision explanations and isolated policy evaluation. Adopted as patterns; no OPA dependency or policy-language migration.
- [Canadian Centre for Cyber Security: agentic AI](https://www.cyber.gc.ca/en/guidance/careful-adoption-agentic-ai): narrow resource/action/time authority and short-lived access. Recovery must not silently expand a grant.
- [Google SRE canarying](https://sre.google/workbook/canarying-releases/): bounded rollout with explicit comparison and rollback; a small sample cannot establish universal reliability.
- [SQLite isolation](https://sqlite.org/isolation.html): transactional snapshots and serialized writes inform read-only counting and durable attempt reservation.
- [OpenCode issue 54332](https://github.com/anomalyco/opencode/issues/54332): late approval after abort motivates cancellation/authority revalidation. The report concerned v1 and the v2 reproduction failed closed; it does not prove a defect in the pinned runtime.
- [MCP TypeScript SDK issue 2151](https://github.com/modelcontextprotocol/typescript-sdk/issues/2151): disconnected transport can lose delivery of a terminal result. Durable IDs and status lookup are preferable to blind resubmission; Airodrom impact is unproven.
- [Temporal recovery documentation](https://github.com/temporalio/documentation/blob/main/docs/guides/recover-without-restart.mdx): preserve completed work while correcting the failed step. Existing SQLite receipts already support this pattern; no Temporal integration.
- [Cursor agent run modes](https://cursor.com/docs/agent/security/run-modes) and [CLI permissions](https://docs.cursor.com/cli/reference/permissions): sandbox containment and action permissions are separate boundaries. No Cursor configuration was changed.
