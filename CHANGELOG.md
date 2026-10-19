## Unreleased

### Added
- Live Execution Monitor V1: active Missions open a three-column real-time activity UI on Observatory SSE/ledger; Cursor stream-json tool events project into Observatory STAGES mid-run; snapshot v2 counters distinguish real-time vs post-execution telemetry ([docs/LIVE-EXECUTION-MONITOR-V1.md](docs/LIVE-EXECUTION-MONITOR-V1.md)).

### Added
- Document Milestone A host Acceptance evidence, the exact pending ChatGPT remote instruction, and the Milestone B Cursor specialist readiness plan ([docs/CHATGPT-HANDOFF-V8-VERIFICATION.md](docs/CHATGPT-HANDOFF-V8-VERIFICATION.md), [docs/MILESTONE-B-CURSOR-SPECIALIST-READINESS.md](docs/MILESTONE-B-CURSOR-SPECIALIST-READINESS.md)).

### Fixed
- Keep specialist settlement honest when host verification already failed: extract embedded OpenCode evaluator JSON, skip evaluation after empty edit mutations, and record `needs_rework` instead of masking the failure as `EVALUATION_UNAVAILABLE` ([docs/CHATGPT-HANDOFF-V8-VERIFICATION.md](docs/CHATGPT-HANDOFF-V8-VERIFICATION.md)).
- Keep identity reads from materializing the full event ledger, and reconcile a dead in-process writer without treating the interrupted run as successful ([docs/OPERATIONAL-RECOVERY-LIFECYCLE-V1.md](docs/OPERATIONAL-RECOVERY-LIFECYCLE-V1.md)).
- Return a reserved Cognitive Router request when OpenCode planning starts, so an MCP client can poll the same request id instead of waiting for the whole Mission ([docs/COGNITIVE-MISSION-ROUTER-V1.md](docs/COGNITIVE-MISSION-ROUTER-V1.md)).
- Release Developer Autonomy concurrent capacity when a Mission ends in `needs_rework` or `blocked` and no further repair can be authorized ([docs/DEVELOPER-AUTONOMY-V1.md](docs/DEVELOPER-AUTONOMY-V1.md)).
- Count only unsettled Developer Autonomy worktrees against `max_worktrees` so retained evidence clones do not exhaust concurrent capacity ([docs/DEVELOPER-AUTONOMY-V1.md](docs/DEVELOPER-AUTONOMY-V1.md)).
- Record the writer-death dispositions, the merged installation SHA, and the local OpenCode recovery Mission ([docs/OPERATIONAL-RECOVERY-LIFECYCLE-V1.md](docs/OPERATIONAL-RECOVERY-LIFECYCLE-V1.md)).
- Route `AIRODROM_WORK_V1` packets as WORK in chat intent; probe Cursor readiness before projectless dispatch; treat unprobed `lastReadiness` as contract-ok until launch/execute; write settlement receipts for projectless Acceptance so Control Center can show settled; cache Cursor readiness from product status.
- Classify Expanded Autonomy control-plane tables in the Memory retention registry so identity validation no longer treats `cp_expanded_autonomy*` as unclassified stores after schema ensure.

### Added
- Host coding plans now derive a canonical Mission contract and record contract, verifier-input, protected-test, secret-scan, and sensitive-area coverage. A failed trusted-baseline lookup stays unavailable. Legacy contractless rows are not rewritten ([ADR 0055](docs/adr/0055-host-coding-contract.md)).
- Global Autopilot V1: owner ON/OFF/status/STOP across registered projects; Control Center switch; defaults OFF ([ADR 0054](docs/adr/0054-global-autopilot.md)).
- Developer Autonomy V1 (Issue #111): standing per-repository owner enrollment, short-lived Mission grants, automatic disposable local clones, bounded repair budgets, draft-PR preparation, and fail-closed revocation/expiry. Never auto-merges or deploys.

## Unreleased — Personal Operations & Job Search V1 (Issue #112)

- Host capability plans for vague Gmail/Drive/Calendar/Excel/Notes/job-search asks (`AVAILABLE` / `AUTH_REQUIRED` / `NOT_SUPPORTED`); never treat connector `configured` as live access.
- Actionable conversation `safe_error_class` reporting (timeout, content policy, empty response, etc.) instead of a single opaque model-failure string.
- Gmail connector states: configured → connected → live_qualified; repeated `metadataHeaders` query params; categorical OAuth refresh failure classes; OAuth revoke; standing automation exact booleans + bounded expiry fail-closed.
- Local Job Search Manager: CSV formula-injection neutralization with lossless apostrophe round-trip, typed evidence, path/symlink bounds (exclusive `O_EXCL|O_NOFOLLOW` temps/backups for CSV and `manager.json`), authenticated propose→`review_proposal` (human-readable company/role/evidence/before→after in Control Center Approvals)→`approve_proposal`→consume mutation gate bound to payload digest, status preservation, local-timezone digests. `operator_confirmation` is a manual claim (not the approval id); authorization is standing or reviewed `host_approval_id`. Conversation cannot auto-approve. Calendar/Drive/Sheets remain honestly NOT_SUPPORTED.
- Recall: “What do you remember about my job search?” uses bounded compound-query normalization without weakening Memory privacy.
- Docs: `docs/PERSONAL-OPS-JOB-SEARCH-V1.md` (includes f968 conversation-routing release-gate note). Focused tests: `tests/personal-ops-job-search-v1.test.js`.

## Unreleased — Autonomous Supervisor V1 (Issue #108)

- Project Mission V2 / CAE execution into Live Activity with explicit states, active Run honesty, multi-generation repair-budget lineage, and AUTO worker admission (no second scheduler).
- Now excludes obsolete blocked `needs_rework`; Control Center can presentation-archive eligible obsolete rework while preserving evidence.
- CLI: `airodrom logs follow` and interactive `/logs` stream redacted host-observed live events; `GET /api/product/execution-sessions` exposes session classification and standing WORK-template status.
- Active-Run reporting counts only positively advancing Runs with trustworthy process evidence; interrupted, `termination_unverified`, and unknown process ownership are surfaced separately and never inflate `active_agent_runs`.
- Filesystem watch is restricted to active Mission / WORK-template allowlists; sensitive paths, idle projects, host roots, symlink escapes, and Mission-null global observations outside approved scope are refused.
- Writer attribution binds to exact workspace + allowlisted path + Mission/Run (no same-basename cross-workspace leakage); in-repo directory symlink parents are refused; Control Center labels unverified/unknown ownership for review.
- Scope isolation: Trusted Autonomy default-on / standing public-research Acceptance, bridge-invocation recovery, and Mission-web navigation remain on preserve branches and are not part of this change.
- Docs: `docs/AUTONOMOUS-SUPERVISOR-V1.md`, ADR 0052. Focused tests: `tests/autonomous-supervisor-v1.test.js`, `tests/supervisor-boundary-adversarial.test.js`.

## Unreleased — Bridge invocation ownership and packaging

- `proveInvocationOwnership` no longer accepts `lifecycle.lease_acquired` (lease acquire precedes `latestMcpRequestId` and can bind a previous invocation id to a new bridge Run).
- Authoritative ownership requires `orchestrator.capability.requested` or `capability.requested` with exact `request_id` and non-empty `metadata.capability`; contradictory column/metadata ids fail closed.
- Include `src/bridge-invocation-recovery.js` in `package.json` `files` and require it in `package-check`.
- Regression covers real lease→capability event order with prior+current unknown invocations.

## Unreleased — Bridge invocation boot recovery

- Add governed `control-v2/bridge-invocation-reconcile-boot` for interrupted `agent_id=bridge` invocation-lease Runs that are not web-execution proven.
- Ownership requires an exact Event Ledger bind of `invocation_id` to the named bridge `run_id`; shared Mission/task never settles an invocation.
- Boot boundary is witnessed by an existing web-boot evidence packet (`prepared` or already `consumed`) without consuming or rewriting that row.
- Settles only the named bridge Run and proven invocation as `recovery_not_execution`; host lease/dispatch/evidence and unproven siblings remain untouched.
- Focused regression: `tests/bridge-invocation-recovery.test.js`. Consolidated cutover: `docs/RUNTIME-RECOVERY-CONSOLIDATED-CUTOVER-V1.md`.

## Unreleased — Boot-recovery pre-boot dispatch continuation

- `assertNoPostBootContinuation` no longer treats a durable `dispatching`/`running` dispatch state alone as post-boot execution. Only `created_at`/`updated_at` at or after the current OS boot epoch (or a post-boot-created row) counts as continuation; historical pre-boot running rows remain eligible after a verified cold reboot.
- Reject unbound `running`/`dispatching` dispatches on the Mission task (`run_id IS NULL`) as relationship drift.
- Invocation settlement remains strictly run-scoped: only `cp_mission_web_evidence` rows that bind `invocation_id` to the named `run_id` may finish an unknown/running invocation. Shared task/Mission, timestamps, or a sibling dispatch never imply ownership; unproven same-task invocations (including bridge) stay `unknown`.
- Focused regression extended in `tests/public-web-termination.test.js`.

## Unreleased — Public web termination reconcile

- Bound owned research browser close end-to-end: `startPromise` wait is deadline-bound, Playwright teardown steps are timed, and termination is verified from the owned ChildProcess exit fields only (no `process.kill(pid)` signaling).
- Record the owned Chromium PID on mission-web host runs; reserve a document concurrency seat so Mission transport accounting cannot starve navigation.
- Add governed `control-v2/web-reconcile` for same-boot recorded-PID ESRCH on the named run only.
- Add governed boot-epoch recovery for historical PID-less quarantines: `web-boot-recovery-prepare` seals durable pre-reboot evidence and an independently protected SHA-256 registry row; after an owner-authorized cold OS reboot with a changed boot epoch, `web-reconcile-boot` verifies digest/binding/boot/snapshot identity, rejects tamper/replace/replay and post-boot continuation, then settles only the bound run/lease. Prepare, boot-reconcile, and same-boot web-reconcile require Mission/Task/Run/web-capability eligibility; coding without web, reasoning, and external-worker runs are refused; bridge siblings need run-scoped web-execution proof. Distinguishes recovery from successful execution; never invents `browser_closed` receipts.
- Focused regression: `tests/public-web-termination.test.js`.

## Unreleased — Unified Autonomous Development V1

- Derived recovery phases (`src/recovery-phase.js`) keep Terminal, Control Center and MCP observing a Goal through automatic repair; terminal blocks are explained from a fixed vocabulary instead of a bare "Blocked"; `zero-setup-active.json` survives nonterminal repair.
- Corrective Mission creation is idempotent and transactional (deterministic `cae-repair:*` identities per plan/stage/parent; create + rebind + lineage + claim + dispatch commit together); transient blocks become `REPAIR_PENDING`; repeated failure signatures stop before the budget; failure classifier with explicit recovery policy; host-built repair context package.
- Canonical Mission contract (`envelope.contract`) with deny-by-default permissions, immutable `scope_fingerprint` separate from per-Mission identity, explicit external-disclosure authorization and a trusted verifier baseline; one owner approval (`cp_mission_approvals`) bound to fingerprint, window, repair budget and disclosure; replay/expiry/revocation fail closed.
- Governed sandboxed headless Cursor worker (`src/cursor-worker.js`): containment enforced by sandbox-exec independent of `--force`; provenance-tagged tracing; host inventory authoritative; qualification script with honest verdict (currently `CURSOR_UNQUALIFIED`: `cursor_credential_file_unavailable`).
- Empirical sandbox containment proof (`src/sandbox-containment.js`); OpenCode profile keeps loopback (private server, verified), external network denied; `sandbox_id` in provenance.
- Verifier test-integrity (tampering, removed assertions, skips, trusted-source reproducibility) and proportional security scans (NEW / PRE_EXISTING / UNAVAILABLE).
- MCP coordinator tools `prepare_mission`, `inspect_mission_proposal`, `get_mission_status`, `get_mission_events`, `get_mission_evidence`, `request_mission_correction`, `cancel_mission`; final evidence package; discovery schema 2.
- Component states and worker tiers at `/api/control-v2/components`; Slack routes for approval/repair/acceptance events.
- Suites: `npm run test:unified` (42), hardening group extended; live OpenCode self-repair proof passed; Cursor qualification recorded as UNQUALIFIED with exact blocker. See [UNIFIED-AUTONOMOUS-DEVELOPMENT-V1.md](docs/UNIFIED-AUTONOMOUS-DEVELOPMENT-V1.md) and [ADR 0051](docs/adr/0051-unified-autonomous-development.md).

## Unreleased — Repair spawn with parent-baseline dirt

- Corrective Mission create allows dirty paths already recorded on the parent Mission baseline (for example owner README notes) while still denying newly introduced dirt outside `allowed_files`.
- Same-scope repair Missions omit `work_template` rebinding so live template ceiling fingerprints cannot block corrective create after a failed parent.
- Repair create strips envelope-only authority fields and refreshes expiry into the create window.
- Focused regression in `tests/autonomous-self-repair.test.js`.

## Unreleased — ZeroSetup unique Mission names

- Append a short request-id suffix to ZeroSetup Mission objectives so repeated asks under one Goal do not hit project_missions uniqueness.

## Unreleased — Zero-setup scope filter for No Production limitations

- Do not treat Project limitations that explicitly deny Production as production Projects when resolving disposable WORK scope.
- Prefer instruction-named Projects and exact-byte self-repair disposables over bare human-acceptance name matches.
- Focused regression in `tests/zero-setup-work.test.js`.

## Unreleased — Terminal intent routing & live self-repair proof

- Classify natural-language WORK when file/repository actions follow contextual preambles (not only leading verbs); ordinary discussion about files stays conversation.
- Route recognized Terminal WORK through ZeroSetupWork (no chatbot refusal, no draft-only UUID forms).
- Add test-only host marker `.airodrom/controlled-verify-fail-once.json` for one deterministic verification failure before independent verify; repair Missions ignore the marker.
- Terminal result text reports original failure, single corrective Mission, Goal resume, and owner-only Acceptance.
- Focused suites: `tests/terminal-intent-routing.test.js`, `tests/self-repair-fixture.test.js`.

## Unreleased — Autonomous Self-Repair & Mission Resume V1

- After a safe host verification failure, CAE may spawn one in-scope corrective Mission (`repair_of`), rebind the Goal Plan stage, and dispatch once without a second owner Continue.
- Fail closed on uncertain termination, quarantine, scope expansion, or exhausted `max_repairs`; Acceptance and Settlement remain owner-only.
- Terminal/zero-setup status follows the repair Mission and reports independent verification.
- Focused suite: `tests/autonomous-self-repair.test.js`.

## Unreleased — Terminal-first autonomous WORK

- Route natural-language Terminal WORK through ZeroSetupWork instead of draft-only Mission intake that demanded UUID WORK-template forms.
- Add secure inline Terminal `y/N` authorization that shows project, files, worker and permissions; reuse host vault-cli consent (model/chat text is never consent).
- After owner confirmation, CAE dispatches once; Terminal polls and reports independent verification without Acceptance/Settlement.
- Focused suite: `tests/zero-setup-terminal.test.js`.

## Unreleased — Zero-Setup Autonomous Work V1

- Add `ask_airodrom` / `get_ask_status` MCP entry so ChatGPT can request bounded local work without Project/Goal/WORK-template UUID forms.
- Prepare owner-readable Control Center approval cards; registration, Goal Plan binding, and CAE authorization remain distinct confirmed host operations.
- Fix MCP handoff session minting for discovery/CAE tools; advertise `listChanged` and document new-conversation refresh when ChatGPT caches an old catalog.
- Focused suite: `tests/zero-setup-work.test.js` + updated `tests/mcp-schema.test.js`.

## Unreleased — Continuous Autonomous Execution V1

- Extend Goal Planner with versioned `autonomous` authorization, durable `cp_autonomous_claims`, and a Mission-path scheduler that continues authorized goals without ChatGPT/Cursor ownership ([ADR 0048](docs/adr/0048-continuous-autonomous-execution.md)).
- Authenticated control-plane authorize/pause/resume/stop/switch-worker actions; Control Center Autonomous Goals surface; Flight Recorder events for autonomous lifecycle.
- Fixture suite `tests/continuous-autonomous-execution.test.js`. Source-only; live install and Production mutation remain separately gated.

## Unreleased — Developer Memory repository allowlist

- Add authoritative `allowed_repositories` (`repository_id` + `bank_id`) to Developer Memory V1. Empty allowlist fails closed while the feature is enabled.
- Host-derived repository identity must match the allowlist before search, retain, prefetch, and ContextPack contribution. Global enable/retrieval flags alone never authorize a repository.
- Allowlist revocation immediately blocks retrieval/retention/ContextPack and clears caches, while preserving a separate owner-authenticated suppress/delete cleanup path that never restores retrieval. Cleanup binds to canonical retained-row metadata and single-use host-minted approval.
- Contract tests cover approved repo success, linked worktree bank sharing, unapproved denial, forged bank denial, allowlist revocation cache clear, post-revocation cleanup, unauthorized deletion, cross-repo isolation, approval replay, and Personal Memory isolation.

## Unreleased — Memory final acceptance reliability V1

- Reboot-acceptance `verify` treats missing `pending.json` as an idle RunAtLoad no-op (`ok: true`, `skipped: true`, `acceptance_ok: null`) so `launchctl last_exit=1` is not mistaken for live control-service failure.
- Status exposes `idle_verify_expected` when no pending stamp exists.
- Add disposable ContextPack→OpenCode and live Control Center memory-layer qualification scripts (fixtures / read-only owner UI).
- Document MCP public vs broker tool boundary and reboot-acceptance LaunchAgent path skew in Known Limitations.

## Unreleased — Developer Memory V1 (Hindsight subordinate provider)

- Add governed Developer Memory adapter with loopback Hindsight HTTP transport (`/v1/default/banks/…`, retain `{ items }`), repository bank isolation via `git-common-dir`+remote, host-bound authorize-before retain/retrieve, operator approval for suppress/delete, cache invalidation, Mission-lifecycle prefetch, and sync ContextPack contribution.
- Feature defaults all-off (`config/developer-memory-v1.json`). No agent plugins, no auto-ingest, no cloud fallback, no live install mutation.
- Control Center Overview and Memory views show animated live stats for all memory layers (Personal, Project, Architecture, ContextPack, Developer) with usage percent against labeled reference soft capacities; `memoryStatus.layers` never includes private content.
- Destructive suppress/delete require host-minted single-use operator approval via authenticated control-plane minting; caller booleans are rejected. Stale developer ContextPack cache is dropped on task repository identity change.
- Document architecture and limits in [DEVELOPER-MEMORY-V1.md](docs/DEVELOPER-MEMORY-V1.md) / [ADR 0046](docs/adr/0046-developer-memory-hindsight.md). Contract suite: `tests/developer-memory-v1.test.js` (17/17). Disposable REAL LOCAL HINDSIGHT PASS against `hindsight:0.10.2` + Ollama; not owner-install verified.

## Unreleased — Context & Personal Memory V2 end-to-end

- Align broker/MCP read contracts so ChatGPT `personal_memory_search` / `personal_memory_recent` / `memory_search` accept optional bounded `limit` and default `domain=personal` for recent without weakening unknown-key rejection.
- Honor `limit` on personal and legacy memory search execution paths; keep defaults (6 / 4) when omitted.
- Add synthetic contract + acceptance suites for create/retrieve/continuity/correction/forget/isolation/injection/restart. Live owner store untouched.
- Document canonical tool schemas and SOURCE FIXED vs INSTALLED distinction in [MEMORY-V2.md](docs/MEMORY-V2.md).

## Unreleased — Master Production Cutover Readiness V3

- Prepared isolated candidate install from exact PR tip `3dc3e8c` (27 MCP tools); qualified with focused tests and typechecks. Production tip unchanged (**CUTOVER HOLD**).
- Online SQLite backup + isolated restore rehearsal of personal-memory DB; LaunchAgent snapshot retained.
- Operator approval gate: [AIRODROM-CUTOVER-APPROVAL-V3.md](docs/AIRODROM-CUTOVER-APPROVAL-V3.md).

## Unreleased — Master Finalization & Live Acceptance V2

- Live tip audit: installed `airodrom-menu-status-525458c` exposes MCP health + 25 tools; personal-memory calls fail closed until cutover. Branch stdio catalog remains 27 tools.
- Document reversible tip cutover/rollback without applying it ([INSTALLED-TIP-CUTOVER-V2.md](docs/INSTALLED-TIP-CUTOVER-V2.md)).
- Repair `removed-runtime` legacy-identifier allowlist drift and fixture shutdown for intentional historical quarantine.
- Final acceptance report: [AIRODROM-FINAL-ACCEPTANCE-V2.md](docs/AIRODROM-FINAL-ACCEPTANCE-V2.md). WhatsApp HOLD. Production unchanged.

## Unreleased — Master Personal AI Completion V1

- Synthetic TestBridge fixtures resume admission after recovery so Memory/Mission suites match managed closed-startup without weakening production gates.
- ChatGPT MCP adds read-only `personal_memory_search` / `personal_memory_get` (ordinary Personal Memory only; writes remain capability-scoped). Surface is 27 tools.
- Unify Mission lifecycle aliases into one authoritative vocabulary (`canonicalize` / `project`); persist canonical states in control-plane and authority stores; treat `paused` as a first-class transition.
- Document Personal Memory erasure layers (suppression, cache invalidation, retention, logical purge) and keep physical/forensic wipe unclaimed.
- Offline always-on qualification tests and bounded Mission Acceptance/restart fixtures; iPhone viewport emulation checks (not physical-device verification).
- Completion matrix and evidence: [MASTER-PERSONAL-AI-COMPLETION-V1.md](docs/MASTER-PERSONAL-AI-COMPLETION-V1.md). WhatsApp remains HOLD. Production tip unchanged.

## Unreleased — macOS Desktop Activation V1 (shipped locally)

## Unreleased — Menu Status & WhatsApp Connection Closeout V1

- Menu tone: historical Mission review backlog stays CONNECTED/healthy; gold ACTION REQUIRED reserved for pending protected Approvals.
- Document WhatsApp test-path status and Meta eligibility HOLD for general-purpose personal AI messaging. See [MENU-STATUS-WHATSAPP-CLOSEOUT-V1.md](docs/MENU-STATUS-WHATSAPP-CLOSEOUT-V1.md).


## Unreleased — Control Center & Premium macOS Experience V4 (shipped locally)

- Merged PR #67 to `origin/main` (`1105659`); installed `airodrom-ux-v4-1105659` with Menu CFBundleVersion **4** and Mission history / Needs review presentation. See [CONTROL-CENTER-MACOS-UX-V4.md](docs/CONTROL-CENTER-MACOS-UX-V4.md).

## Unreleased — Control Center & Premium macOS Experience V4

- Port Mission history + `mission_counts` so Control Center Missions / Overview show Active, Needs review, Failed, Completed, and Settled correctly.
- Menu bar uses full-logo status gradients (healthy / working / approval / degraded / disconnected) instead of a colored status disk; CFBundleVersion **4**.
- Review banner, humanized mission chips, and restrained CSS polish; Acceptance not blocked by transient transport failures.
- See [CONTROL-CENTER-MACOS-UX-V4.md](docs/CONTROL-CENTER-MACOS-UX-V4.md). Local branch only — not installed over Menu V3 tip.


- Record Premium Menu V3 + `local.airodrom.desktop-login` installed on tip `airodrom-menu-v3-1cff95d` (merge `1cff95d` / PR #65). Login rehearsal verified. See [MACOS-DESKTOP-ACTIVATION-V1.md](docs/MACOS-DESKTOP-ACTIVATION-V1.md).

## Unreleased — Premium macOS Menu V3

- Refine the native menu-bar mark (18pt optically padded template A) and replace pale-yellow status wash with a compact warm-gold ACTION REQUIRED indicator.
- Clarify menu hierarchy (System Status / Active Mission / Workers / Memory / Model / Connectors / Actions) and status vocabulary: CONNECTED, DEGRADED, DISCONNECTED, ACTION REQUIRED.
- Feature only live Missions in the Active Mission row; `awaiting_acceptance` / `waiting_for_operator` report as NEEDS REVIEW and never as active work.
- Preserve Everyday UX deep links, service controls and security boundaries. See [PRODUCT-EXPERIENCE-V2.md](docs/PRODUCT-EXPERIENCE-V2.md).
- Optional `local.airodrom.desktop-login` LaunchAgent starts Ollama, the owned Control Plane and the native menu at login without enabling legacy `pi-chatgpt` agents or merging startup PR #36.

## Unreleased — Final Product Consolidation V1

- Document local usable release stop line: installed tip meets daily-use criteria; no essential blockers; optional draft PRs #36–#38 and packaging/Claude remain future work. Protect dirty operator checkout. See [FINAL-PRODUCT-CONSOLIDATION-V1.md](docs/FINAL-PRODUCT-CONSOLIDATION-V1.md).

## Unreleased — WhatsApp verify-token staged rotation

- Staged verify-token recovery: new Vault candidate while current remains valid; webhook GET never finalizes; owner `commit-verify-token` after Meta success; `rollback-verify-token` and TTL discard the candidate. App Secret and Graph token references preserved. Production HOLD / public ingress / outbound unchanged.
- Shipped on `origin/main` via PR #62 (`879daa3`); installed locally as `airodrom-whatsapp-verify-safe-879daa3`. Meta test callback Verify/Save remains owner-controlled. See [WHATSAPP-VERIFY-TOKEN-STAGED-ROTATION-SHIPPED.md](docs/WHATSAPP-VERIFY-TOKEN-STAGED-ROTATION-SHIPPED.md).

## Unreleased — Conversation UX Bugfix V1 shipped and installed

- Merged PR #60 to `origin/main` (`52e1003`); installed `airodrom-conversation-ux-bugfix-52e1003`; live Control Center verifies Start new / pending-new refresh / Continue previous and Claude unavailable→Qwen fallback.

## Unreleased — Conversation UX Bugfix V1

- Start new conversation clears the browser display and skips auto-restoring the latest host browser session across refresh; Continue previous restores the prior session; first send creates a fresh identity.
- Claude is labeled unavailable until qualified; selection keeps Qwen as the working provider with explicit fallback messaging (no activation or subscription workaround).

## Unreleased — Git Repository Cleanup V1

- Delete fully merged unused remote branches and remove clean merged disposable worktrees; retain open draft PRs #36–#38, active Development Session branch, operator checkout, and unique/dirty review worktrees.

## Unreleased — Grounded Assistant Accuracy V1 shipped and installed

- Merged PRs #56/#57 to `origin/main` (`fe918cc`); installed `airodrom-grounded-accuracy-fe918cc`; live Qwen Control Center conversation preserved host-verified active/current Mission distinction and authorized Development Session metadata; credentials stay on the Vault path.

## Unreleased — Grounded Assistant Accuracy V1

- Inject host-verified Mission counts into Conversation and ground delivery text when the model mislabels current as active.
- Permit authorized Development Session id/branch/worktree metadata through operator screening; keep Cookie/assignment session secrets fail-closed for local private conversation.

## Unreleased — Everyday Personal AI UX V1 shipped and installed

- Merged PR #54 to `origin/main` (`5e23731`); installed `airodrom-everyday-ux-5e23731`; live Control Center serves Conversation model/continue/Memory consent, Mission Observatory links, Development Session Continue clarity, and macOS menu deep links.

## Unreleased — Everyday Personal AI UX V1

- Conversation: visible Qwen-default model selection, persistent session continue/new, Memory consent status, honest activity/reconnect; reuse ConversationEngine.
- Missions: clearer active work, worker, verified activity, pending approval, Settlement, Open Observatory.
- Development Sessions: Continue clarity for repository, branch, worktree and next permitted action (no duplicate execution controls).
- macOS Menu V2: Active Missions, Continue Development Session and Open System Health deep links alongside Open Conversation and Control Center.

## Unreleased — Continue Development Session V1 shipped and installed

- Merged PR #52 to `origin/main` (`c701289`); installed `airodrom-ds-continue-c701289`; live Control Center serves Continue Development Session using host `resolve` / `observe-git` / `native-status` (no invented `/continue` route).

## Unreleased — Continue Development Session V1

- Add Continue Development Session action to the Control Center Development Sessions panel: session identity, authorized repository/worktree, last Mission, next permitted action, Observatory execution state; reuse existing session via host resolve; block duplicate active execution.
- OpenCode/Qwen draft Mission `79a170b2-…`; host coding-plan settlement Mission `a286ca1d-…` accepted and settled. Focused contract `development-session-continue-v1`.

## Unreleased — Self-Development Reliability V1.1 shipped and installed

- Merged PRs #49/#50 to `origin/main` (`61d0b0d`); installed `airodrom-self-dev-af5fce8`; live Control Center serves Development Sessions panel; coding admission and 120s timeout active.

## Unreleased — Self-Development Reliability V1.1

- Admit authorized OpenCode coding source for Control Hub JS: host-owned Authorization+identifier neutralization, credential-filename rules that ignore UI prose, 256 KiB staged-file bound; keep real secrets and sensitive paths fail-closed.
- Raise default local OpenCode coding Mission timeout to the existing 120000 ms ceiling (no unlimited timeouts).
- Extend Development Sessions summary and source-context focused contracts; document Mission `d55695c4-…` timeout evidence.

## Unreleased — Autonomous Self-Development V1

- Control Center Development Sessions view shows an evidence-backed Active Session Summary (missions, worker, repository/branch, local changes, focused verification, pending integration, last activity, next permitted action) via `public/development-sessions-panel.js`.

# Changelog

## Unreleased — Coding Reliability & Auto-Acceptance V1

- Stop using display `redactValue` mutation as the OpenCode coding-context sensitivity gate; admit ordinary JS comments/regex while keeping secret and sensitive-path fail-closed checks.
- Prove host-owned risk Automatic Acceptance on one disposable local OpenCode Mission after explicit operator preference opt-in.
- Reconcile live `local.json` source from the temporary proof worktree to a canonical install archive of the fix tip; preserve Mission and Memory evidence.

## Unreleased — Lifecycle closeout shipped and installed

- Merged PR #47 (`f28e8ca`); installed corrected package; reconciled durable `stopping` to admission `open` with preserved Memory/Missions.

## Unreleased — Lifecycle & Package Closeout V1

- Ship service lifecycle admission and run-settlement helpers in the canonical package; reconcile orphaned durable `stopping` on new writer ownership without restarting the healthy installed service.

## Unreleased — V1.0.1 hotfix shipped and installed

- Merged PR #46 (`14ee5ab`); installed canonical `1.0.1-rc.1` package at `install/airodrom-1.0.1-rc.1` with Memory/Mission preservation and WhatsApp production HOLD unchanged.

## Unreleased — Installation Hotfix V1.0.1

- Accept optional Gmail OAuth `clientSecretReference` in ControlServer without weakening unknown-key rejection.
- Allowlist `wait-presentation` runtime module/config so clean package installs need no manual overlays.
- Raise installation compatibility minimum to `1.0.1-rc.1`; document reversible upgrade while leaving the healthy V1 install running.

## Unreleased — Integrated Release V1 local activation

- Activated verified package install at `install/airodrom-77724f8`; preserved Memory/Missions; WhatsApp production HOLD unchanged.
- Local install hotfixes: Gmail `clientSecretReference` acceptance; restore `wait-presentation` omitted from package allowlist.

## Unreleased — Integrated Release V1 shipped

- Merged consolidated daily candidate via PR #45 to `origin/main` (`0e5f0a86da1a21526105ebda24984ec309f91897`); release source `77724f83569eadae41727c86b201e433a801f910`.
- Closed superseded feature PRs #43/#44 after inclusion verification. Operator install remains separately authorized; WhatsApp production HOLD unchanged.

## Unreleased — Integrated Release V1 (daily candidate 2026-10-09)

- Prepare one local-first release candidate from `integ/daily-candidate-v1-20261009` with allowlisted source archives, SOURCE/COMPATIBILITY manifests, and reversible install plan (service not replaced).
- Restore WhatsApp inbound credential API routes dropped during daily merge (`validate-credentials`, `bind-credentials`, and related).
- Complete package allowlists for Conversation provider, risk Acceptance, and WhatsApp ADRs 0041/0042; remove ghost ADR paths that broke archive generation.

## Unreleased — Core Contracts & Runtime Consistency V1

- Add versioned core contracts, host-evidence runtime security conformance, and installation compatibility observation without rewriting durable state.
- Expose `/api/product/compatibility`, Control Center System Health rows, and interactive `/compat`.

## Unreleased — Personal AI Channels V1

- Restore `/api/assistant/provider` + ConversationEngine provider revision binding; Control Center Conversation refresh fails soft if provider is unavailable.
- Unify first-party ConversationEngine reliability across Control Center, ChatGPT MCP and the macOS menu.
- Control Center: persistent browser session, scoped history, Memory consent, local-ollama/model identity and Thinking activity.
- macOS menu: Conversation status row and Open Conversation deep-link (`?view=Conversation`).
- Preserve WhatsApp production outbound and automatic Mission execution OFF under Meta policy HOLD.


## 1.0.0-rc.1 — October 5, 2026 — private candidate

- Include opaque candidate/ContextPack identity migration, scoped erasure and current-authority restore/replay safeguards from the qualified private source.
- Prepare history-free source distribution, explicit package allowlists, dependency/license/SBOM review and deterministic archive checksums.
- Add public security/privacy, installation, development, runtime, governance and contribution documentation; issue/PR forms and pinned CI gates.
- Keep operator state and historical private evidence excluded. Keep `private: true`, production unactivated and publication owner-controlled.
- Preserve SDK 1.0.0, Kernel 1.2.0 and legacy MCP identity. Record optional/unqualified external runtime and physical/provider-retention limits.

Fresh candidate evidence is in [FRESH-VALIDATION.md](docs/FRESH-VALIDATION.md). No public stable release is implied by the preceding private package version.
