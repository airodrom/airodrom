# Current state (2026-10-10)

## Cursor execution decision authority — SOURCE (2026-10-23)

- **Cause (Mission `63385742-6877-4320-9dc4-956b3af05c87` / ChatGPT `chatgpt_post224_scheduler_e2e_20261023_a` / dispatch `0f6964ab…`):** READY admit succeeded; first Cursor assignment queued; `specialist-gateway.select` failed `cognitive_worker_unqualified:cursor` with empty route and zero runs while the agent registry could still show Cursor available. Root cause: select equated `!observation.available` with cognitive ineligibility, lost the readiness reason, permanently blocked, and the code was an unregistered `unknown_blocker`.
- **Repair:** `src/cursor-execution-decision.js` (seven dimensions); fresh readiness on select; transient runtime requeue; registry + `refresh_cursor_execution_decision` recovery. Docs: [CURSOR-EXECUTION-DECISION-V1.md](CURSOR-EXECUTION-DECISION-V1.md).
- Historical Mission preserved blocked; fresh acceptance is the post-install gate.

## READY specialist auto-dispatch — SOURCE (2026-10-23)

- **Cause (Mission `3a6edd9e-e79f-47fd-b78e-2761a76bb367` / ChatGPT `chatgpt_post223_read_edit_acceptance_20261023_a`):** Authorized READY specialist with `prepared` graph, two assignments, zero dispatches/runs; OpenCode+Cursor qualified; stalled until authority expiry. Root cause was scheduler invisibility of `prepared` programs after a lost/failed first wake, plus wrong recovery (`reuse_local_evaluation_authority`) for never-started work — not missing grants or evaluation.
- **Repair:** `admitReady` / `admitPreparedReady` watchdog on `MissionService.tick`; `mission-program.tick` includes `prepared` specialist graphs; orphan READY after dispatch failure fails closed; registry recovery `admit_ready_specialist_dispatch`; bounded `nativeStatus` readiness. Docs: [READY-SCHEDULER-DISPATCH-V1.md](READY-SCHEDULER-DISPATCH-V1.md), [ADR 0061](adr/0061-ready-scheduler-dispatch.md).
- Historical Mission preserved terminal (no deadline extension). Fresh ChatGPT-origin acceptance is the post-managed-install gate.

## Operational Owner Auto-Recovery V1 — SOURCE (2026-10-22)

- **Goal:** Eliminate repeated owner intervention for routine authorized development across the 27 canonical operational blockers while keeping all security-critical categories fail-closed.
- **Dispatcher:** `src/limits-blockers-recovery.js` covers `canonical_operational_owner` (27/27 auto-diagnosis). Executable recovery is truthfully fewer than diagnosis (identity-matched repo resolve, standing grant match, capacity await, timing floor, local eval reuse, proof-gated eval/lease reconcile). Diagnosis/enrollment-prep never set `verification.completed_repair`.
- **Mandatory hardening:** sealed repository identity required (no “only enrolled” guess); standing probes require authoritative Mission `data_class` (never invent `public`); security-critical mismatch/alive-writer fail closed; proof-gated reconcile for unverified termination/quarantine only with ESRCH+lsof.
- **Standing Cursor:** Active `cp_standing_cursor_development` rows in `~/.airodrom/data/` persist across restart and managed install upgrades; recovery **matches** covering grants and surfaces re-enrollment paths for missing/expired/revoked/exhausted — never fabricates approval, raises spend, or restores revoked grants. Live host currently has active grants for `airodrom-da-main` and `arecibo-core-autopilot-main` (fixture handoff grant separate).
- **Chain:** ChatGPT → Airodrom → OpenCode planner → Cursor → host verification → OpenCode evaluator → dependents. Evaluation locks before readiness awaits; no duplicate Cursor dispatch for eval recovery.
- **Runbook:** [operations/OPERATIONAL-BLOCKER-RECOVERY-RUNBOOK.md](operations/OPERATIONAL-BLOCKER-RECOVERY-RUNBOOK.md).
- **Not claimed:** live acceptance until post-merge managed install; Production mutation; automatic DA/standing enrollment without authenticated owner confirm; security-critical bypass.

## OpenCode read-stage evaluation semantics — SOURCE (2026-10-23)

- **Cause (Mission `c8a62931-2329-4378-9b45-699d7c5bb50f` / Cursor `ff3b8583-…` / evaluator `bac0fc8f-…`):** OpenCode planning succeeded; standing Cursor grant matched; Cursor read `recovery-proof.txt` (`PENDING`) and terminated; host verification passed; OpenCode evaluator returned `recommendation: blocked` because it judged Mission-level exact-byte **edit** criteria against the intermediate **read**. Dependent `change-1` never started; Mission settled `NEEDS_REWORK`; repair attempts 0; no duplicate Cursor dispatch; leases released.
- **Repair:** Stage-scoped `assignment_contract` leads the evaluator objective (`src/opencode-gateway.js`); read assignments forbid requiring mutations; stage-confused blocked → `gateway_evaluation_stage_mismatch` / `opencode_evaluation_stage_mismatch` (never blocked→ready); bounded local evaluation retry of the same verified worker packet; deferred retry timers tolerate store shutdown. Dependency unlock still requires host verification **and** a valid ready receipt.
- Historical Mission remains immutable; fresh ChatGPT-origin multi-task acceptance is the post-install gate.

## OpenCode evaluation recovery after verified Cursor work — SOURCE (2026-10-22)

- **Cause (Mission `935215c3-…` / Cursor run `29d0e0b9-…`):** Host-verified README read completed; first OpenCode evaluator never started (`opencode_unavailable_or_unsupported`). Concurrent `recover`/`tick`/`defer` retries raced after the readiness await (lock taken too late), aborted the in-flight evaluator (`854b3dc2…`, pid observed then `termination_unverified`), and blocked the dependent edit. Notification `c2089189-…` delivered via inbox.
- **Repair:** Claim evaluation-retry lock before awaits; reconcile uncertain evaluator PIDs with ESRCH+lsof evidence; classify `opencode_runtime_*` / `opencode_evaluation_*` failures; retry local evaluation of the same verified worker result only when prior evaluators are termination-verified and within budget. No Cursor redispatch for evaluation recovery.
- Historical Mission evidence preserved; a fresh ChatGPT-origin multi-task Mission is the post-install acceptance path.

## Cursor DNS boundary & subscription deadline — SOURCE (2026-10-22)

- **Cause (Mission `68206244-…` / run `a9ef0b83-…`):** Standing grant + cognitive `execution_ms` were 60s. Subscription `deadline_at` fired (~49.6s) after README read succeeded; in-flight CONNECT was mislabeled `dns_boundary` while the abort signal was active. Resolution was `cursor_cancelled`; dependent edit never ran. Successful multi-task `987ac2c5-…` used ~110s deadlines.
- **Repair:** Proxy denies classify `aborted` / `dns_unavailable` / true `dns_boundary` separately with host metadata; Cursor maps deadline abort to `cursor_subscription_deadline`; `ensureCognitiveDiscovery` refreshes 120s timing; owner can raise standing runtime via `POST …/raise-standing-cursor-runtime` (raise-only ≤120s). Private DNS answers stay denied.
- Notification `55738024-…` (`NEEDS_REWORK` → inbox) remains the durable terminal path.

## Limits & Blockers Registry V1 — SOURCE (2026-10-22)

- **Canonical registry:** `config/limits-blockers-registry-v1.json` with live diagnostics in `src/limits-blockers-registry.js`.
- **Entry points:** MCP `get_limits_blockers` / `inspect_blocker`; `GET /api/assistant/limits-blockers`; Control Center **System Health → Limits & Blockers**.
- **Behavior:** Blocked asks/Missions attach `limits_blockers` (registry id, enforcement, next_safe_action). Unknown codes → `unknown_blocker`. Security-critical always fail closed. Automatic recovery only through existing host-authorized ops (e.g. idle ready reclaim). Docs: [operations/LIMITS-AND-BLOCKERS-REGISTRY.md](operations/LIMITS-AND-BLOCKERS-REGISTRY.md).

## Mandatory Autonomous Blocker Resolution V1 — SOURCE (2026-10-22)

- **Dispatcher:** `src/limits-blockers-recovery.js` — every registry entry has automatic diagnosis; executable recoveries are allowlisted (reclaim idle ready, ensure cognitive timing floor, match standing grant evidence, evaluate/writer-death reconcile) with ≤2 attempts per lineage.
- **Wiring:** Blocked cognitive/zero-setup paths call `attemptAuthorizedRecovery` → `dispatch`; engineering report exposes `blocker_recovery`; MCP `get_blocker_recovery_coverage` / `GET …/recovery-coverage`.
- **Not claimed:** Automatic grant creation, NEVER_AUTO expansion, Production changes, dirty worktree deletion, or recovery from unknown error text.

## Developer Autonomy worktree capacity lifecycle — SOURCE (2026-10-22)

- **Cause:** Concurrent `max_worktrees` counted every `ready` workspace, including grantless idle clones left by interrupted/failed cognitive planning. Four clean disposable leftovers under Airodrom Source policy `a99c2399-…` filled the ceiling and blocked `chatgpt_post217_multitask_live_acceptance_20261022_v1` with generic `Worktree budget exhausted` before planning completed.
- **Repair:** Concurrent slots cover only active writers, unsettled Mission lineages, active grants, and invalid prep. Idle grantless ready / settled evidence remain on disk without consuming execution capacity (aligned with disk admission). Exhaustion reports policy id, limit, occupied classifications, and recovery action. Protected dirty/unique workspaces stay preserved; reclaim still deletes only demonstrably clean disposables.
- Historical blocked ask remains immutable; issue a fresh ChatGPT-origin Mission after install.

## Cognitive plan files mismatch & pre-Mission notifications — SOURCE (2026-10-22)

- **Cause:** OpenCode planning echoed every cognitive discovery path into `PlanningProposal.files` while tasks only referenced a legitimate subset (e.g. `README.md` read→edit). Host parse required exact equality between `files` and the union of `task.paths`, yielding durable `cognitive_plan_files_mismatch` (requests `chatgpt_airodrom_multitask_trigger_20261022_v2`, `chatgpt_post215_standing_grant_probe_20261022_v1`). Terminal ask `BLOCKED` had no Mission id, so mission-only notifications never fired.
- **Repair:** normalize `files` to the unique union of task paths (drop unread context; allow subsets/ordering); recover `cognitive_plan_files_mismatch` via existing coerce path; genuine out-of-scope paths fail with authorized/proposed/mismatched detail; ask-row terminal states (`BLOCKED`/`WAIT`/`CANCELLED`/…) enqueue duplicate-safe durable notifications keyed by `request_id` when `mission_id` is absent (`list_mission_notifications`).
- Historical blocked asks remain immutable; issue a fresh ChatGPT-origin request after install.

## Permanent Cursor authorization automation — SOURCE (2026-10-22)

- **Cause:** Active Developer Autonomy policies with Cursor on the worker allowlist do **not** satisfy cognitive spend/disclosure admission. Only an owner-enrolled `cp_standing_cursor_development` grant auto-covers routine Cursor Missions. Live host had a standing grant for chatgpt-handoff only; Airodrom Source (`a99c2399-…` / `airodrom-da-main`) and Arecibo Core (`d07c3c39-…` / `arecibo-core-autopilot-main`) therefore returned recurring `scoped_external_disclosure_required` + `BLOCKED_SPEND_AUTHORIZATION`.
- **Repair:** policy-bound standing-grant matching + exact mismatch diagnosis (`STANDING_CURSOR_GRANT_*`); owner enrolls one finite standing grant per repository via `POST /api/assistant/host-execution-policy/enroll-standing-cursor-development` (`acknowledge_unknown_cost`, cognitive path allowlist, DA `policy_id`). Eligible Missions reuse the grant without a second per-Mission approval. Grants never cross projects; fixture grants never authorize source work.
- **Canonical doc:** [STANDING-CURSOR-DEVELOPMENT-V1.md](STANDING-CURSOR-DEVELOPMENT-V1.md).

## Developer Autonomy disk admission — SOURCE (2026-10-22)

- **Cause:** `assertDiskBudget` charged Git object stores, retained clones, and `node_modules` against signed `max_disk_mb` (often 4096), yielding recurring `Developer Autonomy disk budget exhausted` on otherwise authorized Airodrom Source / Arecibo work.
- **Repair:** preparation admits on filesystem free space after a protected reserve; `max_disk_mb` stays on signed policies for compatibility only; local clones hardlink Git objects; existing worktrees are never deleted for capacity; capacity errors are distinct from the legacy budget string.
- **Policy `a99c2399-…` (airodrom-source-cursor-dev)** remains active and unmodified; workspace prep must succeed without rewriting that grant when free space exists.

## Automatic multi-project development (Airodrom + Arecibo) — SOURCE (2026-10-22)

- **Catalog:** `config/development-targets-v1.json` defines authoritative targets `airodrom/airodrom` and `arecibo-inc/arecibo-core`. Add a third repository by appending an entry; do not redesign the ChatGPT → Airodrom → OpenCode → Cursor path.
- **Routing:** `resolveAuthoritativeDevelopment` binds product prose before named/fixture matches; negation (`not Arecibo`) fails closed; missing DA returns `SOURCE_REPOSITORY_NOT_ENROLLED` / `ARECIBO_REPOSITORY_NOT_ENROLLED` with no cross-project grant transfer.
- **MCP:** `list_development_targets` / `resolve_development_target` expose enrollment readiness and dry-run resolution. Engineering report + terminal notification tools from PR #211 remain the progress/result path.
- **Live DA (pre-owner confirm):** Arecibo Core has an active OpenCode-only cognitive policy on `/Users/andrew/code/arecibo-core-autopilot-main` (Cursor worker missing). Airodrom source has **no** enrolled DA for `~/code/airodrom` / `airodrom-da-main`.
- **Owner actions required (not self-approved):** (1) create/register clean `airodrom-da-main` worktree + project/goal, enroll DA with Cursor + cognitive; (2) re-enroll Arecibo with Cursor on the worker allowlist (revoke or supersede OpenCode-only policy). Use `scripts/prepare-development-target-enrollment.cjs` for proposal JSON under `~/.airodrom/activation/development-target-enrollment/`.
- **Boundaries:** Arecibo routine development never implies Production deploy, Plaid LIVE, financial-data disclosure, or privileged infrastructure. Operator checkout `~/code/airodrom` stays protected/dirty.

## Source routing, engineering visibility, terminal notifications — SOURCE (2026-10-22)

- **Misroute cause:** ChatGPT source-development instructions that said “not chatgpt-handoff / not recovery proof” still matched those project names as positive mentions, then preferred the enrolled handoff DA + standing Cursor grant (`recovery-proof.txt`). There is no enrolled DA policy for `~/code/airodrom` / `airodrom/airodrom`.
- **Repair:** negation-aware project matching; explicit `airodrom/airodrom` source resolution before fixture hits; fail closed with `SOURCE_REPOSITORY_NOT_ENROLLED` / `CROSS_PROJECT_FIXTURE_FALLBACK_REJECTED`; seal repository binding on cognitive asks; standing Cursor grants remain repository-scoped.
- **Visibility:** `get_mission_engineering_report` + richer `get_mission_events` expose chronological Cursor/OpenCode/host evidence with worker vs host provenance.
- **Notifications:** terminal Mission states enqueue durable outbox notifications (no hourly poll). Destination is `chatgpt_trigger` only when configured; otherwise `mission_notification_inbox` via `list_mission_notifications`. Owner may set `local.json` `mission_notifications.enabled=false`.
- **Historical:** Missions `76be0b40-…`, `c5e20cbc-…`, ask `airodrom_source_notifications_scope_20261022_v1`, and successful handoff `987ac2c5-…` stay immutable.
- **Owner next step for real source work:** enroll Developer Autonomy for the authorized `airodrom/airodrom` checkout (not chatgpt-handoff), then issue a fresh ChatGPT ask. Do not treat fixture grants as source authorization.

## Standing Cursor development authorization — SOURCE (2026-10-22)

- **Owner need:** recurring Cursor development on an approved enrolled repository must not re-prompt `BLOCKED_SPEND_AUTHORIZATION` / `scoped_external_disclosure_required` for every eligible Mission.
- **Mechanism:** authenticated operator enrolls `cp_standing_cursor_development` via host execution policy (finite missions, invocations, runtime, public path allowlist, acknowledged unknown subscription cost, optional DA `policy_id` binding). Cognitive Cursor planning auto-consumes a covering grant; otherwise WAIT with exact `STANDING_CURSOR_GRANT_*` diagnosis. See [STANDING-CURSOR-DEVELOPMENT-V1.md](STANDING-CURSOR-DEVELOPMENT-V1.md).
- **Projects:** Airodrom Source and Arecibo Core each need their own grant; chatgpt-handoff fixture grant never covers them.
- **Out of scope:** paid overages, unapproved repositories, private data, production, credentials, cross-repo access, and historical request mutation. Do not run a paid Cursor Mission solely to configure the grant.

## Cognitive enrollment auto-prepare for standing DA — SOURCE (2026-10-22)

- **Cause:** `chatgpt-handoff` cognitive policy expired while Autopilot standing for the same repo remained active without cognitive files → `standing_cognitive_enrollment_required` for Cursor.
- **Repair:** `developerAutonomy.ensureCognitiveDiscovery` reuses same-repo discovery files or Autopilot-admissible paths on the active standing policy and attaches Cursor to workers when host Cursor is enabled. Autopilot MCP / operator Cursor gates call it before failing closed — including when cognitive files already exist but the standing worker allowlist is still OpenCode-only.
- **Next gate:** OpenCode planning or scoped disclosure / subscription spend — not manual cognitive or Cursor-worker re-enrollment for already-authorized repos when host Cursor execution is enabled.
- Historical request `chatgpt_cursor_execution_20261022_v2` stays immutable; do not replay.

## Cursor Mission Admission & Round-Trip Closeout V1 — SOURCE (2026-10-22)

- **Reconciled request:** `chatgpt_cursor_live_roundtrip_20261022_v1` remains `awaiting_approval` / WAIT; `mission_id=null`; no Cursor dispatch; historical proposal wrongly showed `Local OpenCode` / `requested_specialist=opencode`. Do not replay.
- **Admission cause:** phrase “OpenCode as planner and evaluator and Cursor as the explicitly requested implementation specialist” failed closed into standing OpenCode activate; Autopilot OpenCode-only policy `autopilot-9e6bc9470984` (no cognitive) was selected beside `chatgpt-handoff`; MCP host-policy delegation (`enable_cursor`/`disable_cursor` only) is not DA Cursor worker allowlist or spend; Autopilot activate then hit `Concurrent Mission budget exhausted` on idle grant `bd44d3de-…` (parent+repair `needs_rework`, `canRepair`, writers gone) and statusView reported `standing_policy_requires_authenticated_owner_intake`.
- **Repair:** preserve planner=`opencode` / specialist=`cursor` / evaluator=`opencode`; standing + cognitive fail-closed gates (`CURSOR_EXECUTION_DISABLED`, `standing_cognitive_enrollment_required`, `standing_cursor_worker_not_enrolled`) before PLANNING or Local OpenCode activate; prefer cognitive/Cursor-capable standing policy when Autopilot and named enrollments share a repo; idle terminal `needs_rework`/`blocked` frees concurrent admission while the grant stays active for repair; capacity activate failures return `concurrent_mission_budget_exhausted` instead of a false owner-intake WAIT.
- **Precise owner action for live Cursor round trip:** with host Cursor enabled, standing ensure attaches cognitive discovery + Cursor worker on already-authorized enrollments (operator or Autopilot MCP). Remaining Gate B requirement is scoped disclosure + subscription execution grant — not manual DA re-enrollment solely for cognitive/Cursor allowlist.
- **Gate B / ChatGPT-origin Cursor Mission:** still **PENDING** until spend/disclosure grant exists. Protected checkout `~/code/airodrom` and draft PR #148 untouched.

## Cursor Round-Trip Reliability & Acceptance V1 — INSTALLED (2026-10-22)

- **Merged / installed:** PR #200 → `5c91f9f70d40242964a8dce3125a9defd6a8e5f0` at `…/airodrom-install-bcedc6d`. Rollback checkpoint `~/.airodrom/activation/checkpoint-pre-a843741-20261022T205931Z` → previous `a843741`.
- **Reconciled Mission:** `db7c6eaa-d623-4e9f-822c-b8b50bc9c0c2` / request `chatgpt_cursor_roundtrip_probe_20261022_v1` — Cursor explicitly requested; standing DA dispatched Local OpenCode; settled `needs_rework` after failed verification. Historical evidence immutable. Cancel `chatgpt_cursor_roundtrip_cancel_20261022_v1` never recorded (**uncertain / not acknowledged**); leases released; no active Cursor runs.
- **Root cause:** standing DA OpenCode dispatch when routine files resolved (skipped Cursor disabled gate); phrase gaps (“Have Cursor change”); cancel lacked ask-origin + durable `request_id`.
- **Repair:** fail-closed explicit Cursor (no OpenCode substitution); durable replay-safe cancel; Cursor stays disabled (`cursor_execution_disabled=1`).
- **Gate A (host MCP entry, not ChatGPT-typed):** `host_gate_a_standing_da_20261022T210210Z_v1` → durable `BLOCKED` / `CURSOR_EXECUTION_DISABLED`; `execution_authorized=false`; zero new Missions; zero `cp_runs` with `agent_id=cursor`; `get_ask_status` ~1.7s. Fixture suite also proves `requested_specialist=cursor` on standing DA.
- **Gate B:** **PENDING** (Cursor execution remains disabled; no paid spend).
- Protected checkout `~/code/airodrom` @ `a1f97c50` and draft PR #148 untouched.

## MCP Recovery & Cursor Mission Connectivity V1 — SOURCE (2026-10-20)

- **Reconciled ChatGPT request:** `arecibo_chatgpt_localfirst_acceptance_20261019_v1` → Mission `7da96c04-…` **Completed and settled** (planner `b049e54e-…`, OpenCode eval `ready`, Acceptance accept, settlement settled). Do not replay.
- **Timeout root cause:** After cognitive ack, sync `prepareWorkspace` (`git clone --local` + `cp -Rc` materialize of multi-GB Arecibo `node_modules`) blocked the bridge Node event loop for ~17s. Concurrent ChatGPT `get_ask_status` / `agent_status` hit the 15s MCP client / HTTP `requestTimeout` and appeared failed while the Mission continued.
- **Repair:** `prepareWorkspaceAsync` + async dependency materialize on the cognitive path; Cursor readiness probe is async with a short TTL cache; `agent_status` reports Cursor observable but `cursor_execution_disabled` while host policy denies execution.
- **Preserved:** Historical local-first Mission `634be433-…` Acceptance; Cursor stays disabled (`cp_host_execution_policy`); architecture USER→ChatGPT→AIRODROM→OPENCODE→(Cursor if authorized)→OPENCODE→AIRODROM→ChatGPT→USER.
- Protected checkout `~/code/airodrom` and draft PR #148 untouched.

## Local-First Autopilot Final Recovery V1 — SOURCE (2026-10-20)

- **Forensics (evaluator):** Historical Mission `98a67bd6-…` / request `1b6456ee-…` — OpenCode plan+implement completed; host verification passed on finished assignment; evaluator never started (`gateway_evaluation_unavailable` / `opencode_unavailable_or_unsupported`). Mission remains blocked/immutable. Fixed on main via eval-recovery (#194/#195).
- **Forensics (Acceptance gap):** Mission `cbc4e596-…` / request `7ccfb7cd-…` — OpenCode plan+first assignment+evaluation `ca327058-…` (`ready`); second assignment `c8ca132d-…` failed `opencode_output_bound` reading Arecibo `docs/README.md` (~78KB > OpenCode `MAX_OUTPUT` 64KB stream). Mission `needs_rework`; no Acceptance.
- **Root cause (Acceptance):** Autopilot discovery enrolled oversized indexes; multi-read Autopilot audit plans re-read them during execution and exhausted the stream budget. Host verification did not fail independently on the first assignment; the Mission stalled on the later bound failure.
- **Repair:** `planningContextAdmissible` / `MAX_DISCOVERY_FILE` (16KB) filters discovery and planner permitted_paths; `coerceAutopilotDeliverable` turns read-only report/audit plans into one enrolled edit when edit is authorized. Cursor stays disabled; host verification remains authoritative.
- Evidence: [COGNITIVE-MISSION-ROUTER-V1.md](COGNITIVE-MISSION-ROUTER-V1.md), [GLOBAL-AUTOPILOT-V1.md](GLOBAL-AUTOPILOT-V1.md). Protected checkout and PR #148 untouched.

## Local OpenCode Evaluation & Verification Recovery V1 — SOURCE (2026-10-20)

- **Forensics:** Historical Mission `98a67bd6-…` / request `1b6456ee-…` — OpenCode plan+implement completed; host verification passed on finished assignment; evaluator never started (`gateway_evaluation_unavailable` / `opencode_unavailable_or_unsupported`). Mission remains blocked/immutable.
- **Root cause:** retry path required Cursor specialist; single-OpenCode-run retry shape excluded local OpenCode implement+failed-eval; readiness `fresh` coalescing; DA continuation required Cursor `approval_id`.
- **Repair:** local OpenCode → OpenCode evaluate retry; DA-safe continuation authority; independent fresh readiness probe. Cursor stays disabled; host verification remains authoritative.
- Evidence: [COGNITIVE-MISSION-ROUTER-V1.md](COGNITIVE-MISSION-ROUTER-V1.md), [GLOBAL-AUTOPILOT-V1.md](GLOBAL-AUTOPILOT-V1.md). Protected checkout and PR #148 untouched.

## Local-First Autopilot V3 — INSTALLED (2026-10-20)

- **Decision:** Paid Cursor execution through Airodrom is **disabled by default** (`cp_host_execution_policy`). External Cursor billing is separately identified as unaffected.
- **Default path:** Local OpenCode plan → local OpenCode code (when suitable) → OpenCode evaluate → Airodrom host verification.
- **Architecture unchanged:** `USER → ChatGPT → AIRODROM → OPENCODE → (specialist if authorized) → OPENCODE → AIRODROM → ChatGPT → USER`.
- **Install:** `12c462cfe3919834a839fc44d5cc68280372fe05` at `…/airodrom-install-bcedc6d` (pre-eval-recovery baseline).
- **Reactivation:** authenticated operator `enable-cursor` only; adapters and Milestone A/B evidence preserved.
- Evidence: [GLOBAL-AUTOPILOT-V1.md](GLOBAL-AUTOPILOT-V1.md), [ADR 0060](adr/0060-host-execution-policy.md). Protected checkout `~/code/airodrom` and PR #148 remain untouched.

## ChatGPT Acceptance Milestone A — COMPLETE (2026-10-18)

- **Genuine ChatGPT-origin PASS:** request `chatgpt_handoff_remote_20261018_v9` / Mission `7050a853-4754-4cab-a357-ff882b3446f0` — planning `02c71cea-…`, execution `5087f6ac-…`, evaluation `18e58f0e-…` (`ready`), host verification passed (exact bytes `4149524f…530a`), automatic Acceptance `8302db4a-…`, program settled, leases released. Evidence: [CHATGPT-HANDOFF-V8-VERIFICATION.md](CHATGPT-HANDOFF-V8-VERIFICATION.md).
- **Host path (earlier):** `chatgpt_handoff_host_worktree_20261018_v11` remains a separate non-ChatGPT proof.
- **Historical v8** remains `blocked` / immutable.
- **Next priority:** Milestone B — [MILESTONE-B-CURSOR-SPECIALIST-READINESS.md](MILESTONE-B-CURSOR-SPECIALIST-READINESS.md). Do not start Cursor spend until that plan’s qualification steps complete.
- Protected checkout `~/code/airodrom` and draft PR #148 remain untouched.

## ChatGPT handoff remote v8 verification closeout (2026-10-18)

- Genuine Mission `chatgpt_handoff_remote_20261018_v8` / `42272706-…` remains historical: worker claimed an edit, host observed **no** filesystem mutation (`PENDING\n`), then evaluator JSON failed (`gateway_json_required`). Extra-LF and wrong-worktree hypotheses are disproven for v8.
- Source repair: extract embedded evaluator JSON; when host verification already failed, do not mask settlement as `EVALUATION_UNAVAILABLE`; skip evaluator for empty edit mutations after host `expected_changes` failure.
- Exact-byte contract and diagnostics: [CHATGPT-HANDOFF-V8-VERIFICATION.md](CHATGPT-HANDOFF-V8-VERIFICATION.md). Fresh ChatGPT request id required for genuine remote Acceptance; host OpenCode acceptance is tracked separately after merge/install.
- Protected operator checkout `~/code/airodrom` and draft PR #148 remain untouched.

## Cognitive Mission Router V1 — SOURCE IMPLEMENTATION, RELEASE HOLD (2026-10-18)

- Implemented over ZeroSetupWork, Developer Autonomy, OpenCode and existing Mission machinery; [ADR 0057](adr/0057-cognitive-mission-router.md).
- Four strict contracts, scoped read-only planning, content integrity, deterministic routing, standing caller delegation, bounded Cursor approval and durable evidence.
- Real local OpenCode/Qwen planning plus bounded execution verified in an isolated disposable fixture; host checks and termination passed, Acceptance pending. Cursor fixture coverage is not paid-worker acceptance.
- Not merged or installed. Required regression/security gates and independent authority review remain release gates; pristine-main regressions must not be presented as passing.
- PR #150 includes #149's diagnostic changes without commit ancestry; preserve #148 independently. Merge #150 first only when its gates pass, then the router; no duplicate merge of #149 is needed once superseded.
- Operator instructions and limitations: [COGNITIVE-MISSION-ROUTER-V1.md](COGNITIVE-MISSION-ROUTER-V1.md). Older entries below are historical and do not establish today's installed state.

## Unified Autonomous Development V1 — SOURCE IMPLEMENTATION, PR PENDING (2026-10-12)

- **Branch:** `feat/unified-autonomous-development-v1` (fresh worktree from `origin/main` `079eee9`, which is also the installed service)
- **Engineering verdict:** PASS WITH KNOWN LIMITATIONS — IMPLEMENTED + TESTED (`npm run test:unified` 42/42, hardening/typecheck/verify/package gates local); OpenCode path LIVE VERIFIED (self-repair proof: parent `3d44a1df` → corrective `3eb871e9`, bytes `626574610a`); Cursor LIVE UNQUALIFIED (`cursor_credential_file_unavailable`, containment PROVEN, zero paid runs)
- **Not merged / not installed / not restarted:** live service unchanged; merge + controlled cutover remain owner actions; rollback `079eee9`
- **Owner acceptance:** HOLD until install and the fresh disposable Self-Repair Acceptance run
- Evidence: [UNIFIED-AUTONOMOUS-DEVELOPMENT-V1.md](UNIFIED-AUTONOMOUS-DEVELOPMENT-V1.md), [ADR 0051](adr/0051-unified-autonomous-development.md)

## Continuous Autonomous Execution V1 — SOURCE IMPLEMENTATION (2026-10-12)

- **Branch:** `feat/continuous-autonomous-execution-v1` (isolated worktree from post-#78 `origin/main` `d0f3ee6`)
- **Extends:** Goal Planner (ADR 0047) with durable authorize/pause/resume/stop, claims, and Mission-path scheduler (ADR 0048)
- **Not merged / not installed / not activated:** live service, LaunchAgents, credentials and Production mutation unchanged
- Evidence: [CONTINUOUS-AUTONOMOUS-EXECUTION-V1.md](CONTINUOUS-AUTONOMOUS-EXECUTION-V1.md), [ADR 0048](adr/0048-continuous-autonomous-execution.md)

## Autonomous Reliability & Intelligence V1 — MERGED SOURCE (2026-10-12)

- **PR:** [#78](https://github.com/airodrom/airodrom/pull/78) **MERGED** @ `d0f3ee660e88639f282b3aea14c9f59239dda8f6` after Repository Health Qualification V1 ([#79](https://github.com/airodrom/airodrom/pull/79))
- **Preserved health invariants:** Mission tick busy-gate while admission closed; durable-wait settlement; synthetic fixture disposal ≠ real termination; fail-closed production shutdown
- **Not installed / not activated:** Developer Memory off; Hindsight unactivated by that PR; live installation unchanged until separate cutover
- Evidence: [AUTONOMOUS-RELIABILITY-V1.md](AUTONOMOUS-RELIABILITY-V1.md), [ADR 0047](adr/0047-autonomous-reliability-intelligence.md)

## Menu Status & WhatsApp Connection Closeout V1 — LOCAL IMPLEMENTATION (2026-10-10)

- **Branch:** `feat/menu-status-whatsapp-closeout` (isolated worktree from `origin/main` `f6e13ca`)
- **Menu:** historical Mission review backlog no longer forces gold icon; only pending protected Approvals do
- **WhatsApp:** test WABA path remains; production HOLD; host eligibility `prohibited` for general-purpose personal AI assistant use
- **Not** pushed / merged / installed over tip `airodrom-ux-v4-1105659`
- Evidence: [MENU-STATUS-WHATSAPP-CLOSEOUT-V1.md](MENU-STATUS-WHATSAPP-CLOSEOUT-V1.md). Operator checkout preserved.

## Control Center & Premium macOS Experience V4 — SHIPPED + INSTALLED (2026-10-10)

- **PR:** [#67](https://github.com/airodrom/airodrom/pull/67) **MERGED**
- **Merge on `origin/main`:** `11056596024b7f8847bbc509bbb33f6f764fd58f`
- **Feature tip:** `2e7ed21380a3462c66614ab027a023ee4ba76f3f`
- **Installed:** `…/airodrom-ux-v4/install/airodrom-ux-v4-1105659` (`1.0.1-rc.1`) — Control / OpenCode 2.0.25 / Memory / Provider Ready
- **Menu V4:** CFBundleVersion **4** · full-logo status gradients (no status disk) · section header `Mission`
- **Startup:** `local.airodrom.desktop-login` (WorkingDirectory → V4 tip); legacy `local.pi-chatgpt-bridge*` remain disabled
- **Live Mission presentation:** Active **0** · Needs review **45** · Failed **20** (historical review not shown as active)
- **Backup/rollback:** `~/.airodrom/backups/macos-ux-v4-20261010T233213Z` (prior `airodrom-menu-v3-1cff95d`)
- **Authority:** Automatic Acceptance OFF · WhatsApp HOLD · operator checkout preserved
- Evidence: [CONTROL-CENTER-MACOS-UX-V4.md](CONTROL-CENTER-MACOS-UX-V4.md).

## macOS Desktop Activation V1 — SHIPPED + INSTALLED (2026-10-10)

- **PR:** [#65](https://github.com/airodrom/airodrom/pull/65) **MERGED**
- **Merge on `origin/main`:** `1cff95d478838ad9b088ae27b1a67b22ff941ec1`
- **Installed:** `…/airodrom-menu-v3/install/airodrom-menu-v3-1cff95d` (`1.0.1-rc.1`) — Control / OpenCode 2.0.25 / Memory / Provider Ready
- **Menu V3:** CFBundleVersion **3** · live-only Active Mission · historical review Missions not shown as active
- **Startup:** `local.airodrom.desktop-login` (RunAtLoad, no KeepAlive) starts Ollama, owned Control Plane, then menu; legacy `local.pi-chatgpt-bridge*` remain disabled; PR #36 not merged
- **Backup/rollback:** `~/.airodrom/backups/macos-desktop-activation-v1-20261010T225226Z` (prior source `…/airodrom-whatsapp-verify-safe-879daa3`)
- **Acceptance:** login rehearsal (drain/stop → desktop-login start) · single local-service · Control Center opens · Qwen probe OK · Memory Ready · Automatic Acceptance OFF · WhatsApp HOLD
- Evidence: [MACOS-DESKTOP-ACTIVATION-V1.md](MACOS-DESKTOP-ACTIVATION-V1.md). Operator checkout preserved.

## Final Product Consolidation V1 — RELEASE CRITERIA MET (2026-10-10)

Local daily-use Airodrom is **finished** against the consolidation stop line. See [FINAL-PRODUCT-CONSOLIDATION-V1.md](FINAL-PRODUCT-CONSOLIDATION-V1.md).

- **`origin/main` (docs consolidation):** `21db75b624fb84cef947544f7f121a75c6a7c170` · desktop activation follow-on `1cff95d`
- **Installed:** `airodrom-menu-v3-1cff95d` (`1.0.1-rc.1`) — Control / OpenCode 2.0.25 / Memory / Provider Ready · Menu V3
- **Menu helper:** Premium Menu V3 with Conversation + Development Session + System Health deep links
- **Automatic Acceptance:** OFF · **WhatsApp production:** HOLD · **Public activation:** OFF
- **Operator checkout** `~/code/airodrom`: protected dirty; not the release source
- **Essential blockers for local use:** none · optional future: draft PRs #36–#38 (do not merge #38 wholesale), Claude WAIT, packaging roadmap

No new feature milestone was invented for this consolidation. Live status observation only; unchanged focused suites were not re-executed.

## WhatsApp Verify Token Staged Rotation — SHIPPED + INSTALLED (2026-10-10)

- **PR:** [#62](https://github.com/airodrom/airodrom/pull/62) **MERGED**
- **Feature tip:** `02067eba651b74abe057a13b801da6217a327afd` · security tip `e31d1c9` (explicit owner commit only; GET never finalizes)
- **Merge on `origin/main`:** `879daa38e759b3e7c616d6575f04fae8f60a148e`
- **Installed:** `…/airodrom-whatsapp-verify-token-safe-rotation/install/airodrom-whatsapp-verify-safe-879daa3` (runtime from main `879daa3`; docs ship adds shipped-status pack file — see PR for allowlist)
- **Backup/rollback:** `…/airodrom-whatsapp-verify-token-safe-rotation/backup/pre-whatsapp-verify-safe-20261010T205019Z` (prior source `…/airodrom-conversation-ux-bugfix-52e1003`)
- **Migration:** `staged_verify_token_reference` / `staged_verify_expires_at` present; staging idle; verify/app-secret/access Keychain refs bound and resolvable
- **Live:** Control Healthy · admission open · test tunnel retargeted · prepared callback refreshed · public ingress OFF · outbound OFF · auto-Mission OFF · production HOLD · Meta Verify **owner-pending** (no token staged by installer)
- Evidence: [WHATSAPP-VERIFY-TOKEN-STAGED-ROTATION-SHIPPED.md](WHATSAPP-VERIFY-TOKEN-STAGED-ROTATION-SHIPPED.md), ADR 0045. Operator checkout preserved.

## Conversation UX Bugfix V1 — SHIPPED + INSTALLED (2026-10-10)

- **PR:** [#60](https://github.com/airodrom/airodrom/pull/60) **MERGED**
- **Feature tip:** `3a37c40898251b060a5390ca52f2db79ad5188f0`
- **Merge on `origin/main`:** `52e1003caa64b6f7f2660b7650006c324ce1ccbc`
- **Installed:** `…/airodrom-conversation-ux-bugfix/install/airodrom-conversation-ux-bugfix-52e1003` (npm pack 372 files; tarball SHA-256 `8d0d3a9e932ba1866edda9ca5679f49e4e9bc135d58adba04a77f74bd7255743`)
- **Backup/rollback:** `…/airodrom-conversation-ux-bugfix/backup/pre-conversation-ux-bugfix-20261010T193433Z` (prior source `…/airodrom-grounded-accuracy-fe918cc`)
- **Live:** Control/OpenCode/Memory/Provider Ready · Start new / pending-new refresh / distinct send / Continue previous / Claude unavailable→Qwen verified · missions **71** · personal_memories **6** · Automatic Acceptance OFF · WhatsApp HOLD
- Evidence: [CONVERSATION-UX-BUGFIX-V1.md](CONVERSATION-UX-BUGFIX-V1.md). Operator checkout preserved.

## Git Repository Cleanup V1 (2026-10-10)

- Deleted **49** remote branches whose tips were fully ancestral to `origin/main` with no open PR.
- Removed **34** clean, merged, unused Git worktrees.
- **Retained open drafts:** [#36](https://github.com/airodrom/airodrom/pull/36), [#37](https://github.com/airodrom/airodrom/pull/37), [#38](https://github.com/airodrom/airodrom/pull/38).
- **Protected:** operator checkout `~/code/airodrom`; active DS `feat/ds-continue-session-v1`; install `airodrom-grounded-accuracy-fe918cc` (unchanged, Healthy).
- **Review required (preserved):** `fix/opencode-pin-replacement-requalify`, WhatsApp local tip `581a30f`, and other unique/dirty worktrees listed in [GIT-REPOSITORY-CLEANUP-V1.md](GIT-REPOSITORY-CLEANUP-V1.md).
- No PRs closed this Mission; no force-push; no CI dispatch; no service restart.

## Grounded Assistant Accuracy V1 — SHIPPED + INSTALLED (2026-10-10)

- **PRs:** [#56](https://github.com/airodrom/airodrom/pull/56) (feature) · [#57](https://github.com/airodrom/airodrom/pull/57) (release package allowlist) **MERGED**
- **Feature tip:** `2ef5ba8418cdc8a66e4322e85407064b9e2e504d` (same tree as expected `2e18107`; commit message cleaned of editor attribution)
- **Merge on `origin/main`:** `fe918ccae9053c70bf9b6c9dfedfe5f9027590b1` (allowlist; includes feature merge `350a8e5`)
- **Installed:** `…/airodrom-grounded-accuracy/install/airodrom-grounded-accuracy-fe918cc` (npm pack 371 files; tarball SHA-256 `0296c83012bf2df46e931e679d648c1dabae5913cc48971eac92b5ed7d66697b`)
- **Backup/rollback:** `…/airodrom-grounded-accuracy/backup/pre-grounded-accuracy-20261010T185313Z` (prior source `…/airodrom-everyday-ux-5e23731`)
- **Live:** Control/OpenCode/Memory/Provider Ready · Qwen `ollama/qwen3-coder:30b` reported host-verified **active=0** / **current=62** distinctly · Development Session metadata `feat/ds-continue-session-v1` / `PR_OPEN` · credential chat → Vault (not model) · personal Memory consent (`memory_id_count≥1`) · Mission activity unchanged · Automatic Acceptance OFF · WhatsApp HOLD
- Evidence: [GROUNDED-ASSISTANT-ACCURACY-V1.md](GROUNDED-ASSISTANT-ACCURACY-V1.md), ADR 0044. Operator checkout preserved.

## Everyday Personal AI UX V1 — SHIPPED + INSTALLED (2026-10-10)

- **PR:** [#54](https://github.com/airodrom/airodrom/pull/54) **MERGED**
- **Feature tip:** `0142ab9066eed974ece96eeb0eb228d21395a6d1`
- **Merge on `origin/main`:** `5e23731121d95822255dbef0c257b34d77afb24f`
- **Installed:** `…/airodrom-everyday-ux/install/airodrom-everyday-ux-5e23731` (npm pack 367 files; archive SHA-256 `82df832e9d09365d871db9e899a6bb45cd6f53cf0a9c2d28c45a1fd1f3a145bd`)
- **Backup/rollback:** `~/.airodrom/backups/everyday-ux-v1-20261010T181626Z` (prior source `…/airodrom-ds-continue-c701289`)
- **Live:** Control/OpenCode/Memory/Provider Ready · Conversation model/continue/Memory consent markers served · atmosphere 200 · menu helper rebuilt with deep links · Qwen marker `everyday-ux-ship-ok` · Automatic Acceptance OFF · WhatsApp HOLD
- Evidence: [EVERYDAY-PERSONAL-AI-UX-V1.md](EVERYDAY-PERSONAL-AI-UX-V1.md). Operator checkout preserved.

## Coding Reliability & Auto-Acceptance V1 (COMPLETED + RUNTIME RECONCILED)

- OpenCode `safeText` no longer treats display path/URL redaction mutation as `opencode_sensitive_context`; ordinary JS comments/regex admitted; secrets and sensitive absolute paths remain denied.
- Live Mission `2c57a4e7-c906-4b5f-9590-61242e6b6f82` completed via host risk Automatic Acceptance (operator preference opt-in, then restored OFF).
- Branch `fix/coding-reliability-auto-acceptance` @ `a6ee3e3` (+ closeout commit). Evidence: [CODING-RELIABILITY-AUTO-ACCEPTANCE-V1.md](CODING-RELIABILITY-AUTO-ACCEPTANCE-V1.md).
- **Runtime source:** canonical install `…/install/airodrom-coding-reliability-a6ee3e3` (not the proof worktree). Healthy · admission open.
- Historical failed Mission `668a177e-…` preserved. Operator checkout untouched. Memories/Missions preserved.

## Shipped source

- **PR:** [#46](https://github.com/airodrom/airodrom/pull/46) **MERGED**
- **Hotfix source:** `1c6fb24308998ea28ec07c91db764f10ceafb3bc`
- **`origin/main` merge:** `14ee5ab21ea348982bfc762cc57d5d6bd1b4620f`
- **Package:** `1.0.1-rc.1` — [INSTALL-HOTFIX-V1.0.1.md](INSTALL-HOTFIX-V1.0.1.md)

## Installed release (running)

- **Root:** `~/Documents/Codex/2026-10-10/airodrom-menu-v3/install/airodrom-menu-v3-1cff95d`
- **Health:** Ready — managed local service healthy; admission open
- **Includes:** Premium Menu V3 + desktop-login startup on `1cff95d` (ancestry includes WhatsApp verify-token `879daa3`)
- **Prior WhatsApp verify install:** `…/airodrom-whatsapp-verify-token-safe-rotation/install/airodrom-whatsapp-verify-safe-879daa3` (retained; backup `macos-desktop-activation-v1-20261010T225226Z`)
- **Manual patches required:** No

## Distinctions

| Claim | State |
| --- | --- |
| MERGED IN SOURCE (V1.0.1) | Yes |
| INSTALLED LOCALLY (V1.0.1) | Yes |
| LIVE VERIFIED (V1.0.1) | Yes |
| PRODUCTION HOLD | WhatsApp / Meta AI |

## Operator checkout

`~/code/airodrom` remains protected and dirty; it was not the install source.

## Lifecycle & Package Closeout V1 (2026-10-10)

- Root cause: shipped package omitted lifecycle admission module, so durable `stopping` survived upgrade.
- Fix on branch `fix/lifecycle-package-closeout` (local): ship `service-lifecycle.js` + `run-settlement.js`, reconcile orphaned stopping on new writer ownership, complete package allowlist.
- Live `1.0.1-rc.1` service not restarted; remains Healthy. Evidence: [LIFECYCLE-PACKAGE-CLOSEOUT-V1.md](LIFECYCLE-PACKAGE-CLOSEOUT-V1.md).

## Lifecycle closeout — SHIPPED + INSTALLED (2026-10-10)

- **PR:** [#47](https://github.com/airodrom/airodrom/pull/47) **MERGED**
- **`origin/main`:** `f28e8ca17e26297d49bfe6dcb25d6f232e3c93a3`
- **Installed:** `…/install/airodrom-lifecycle-f28e8ca` · admission **open** · prior_state **stopping** reconciled to epoch `4d5e0893…`
- **Preservation:** missions 62 · personal_memories 6 · pins unchanged
- **Backup:** `~/.airodrom/backups/lifecycle-closeout-20261010T163020Z`

## Autonomous Self-Development V1 (LOCAL)

- Development Sessions Control Center summary panel: `public/development-sessions-panel.js` (OpenCode Mission `eea8d18d-…` draft + host independent verification repair).
- Branch `feat/dev-sessions-summary-v1` worktree under Documents/Codex (operator checkout untouched).
- Focused contract: `tests/development-session-summary-v1.test.js` via registered task `development-session-summary-v1`.
- Local-first: no push / no per-Mission PR / Automatic Acceptance OFF.

## Continue Development Session V1 — SHIPPED + INSTALLED (2026-10-10)

- **PR:** [#52](https://github.com/airodrom/airodrom/pull/52) **MERGED**
- **Feature tip:** `06e80cff21e694546224d629ed0f7101ffcaf772`
- **Merge on `origin/main`:** `c7012899ed5e5be43d5708cd01f5311d3225bb3c`
- **Installed:** `…/airodrom-ds-continue/install/airodrom-ds-continue-c701289` (npm pack 366 files; dual archive SHA-256 `8761d2b00bb11840e84098c5524ed322bdc7410de05f9ce48136311c98c8afac`)
- **Backup/rollback:** `~/.airodrom/backups/ds-continue-v1-20261010T180123Z` (prior source `…/airodrom-self-dev-v1/install/airodrom-self-dev-af5fce8`)
- **Live:** Control/OpenCode/Memory/Provider Ready · `/development-sessions-panel.js` HTTP 200 with Continue Development Session · host APIs `resolve` / `observe-git` / `native-status` · no invented `/continue` · Automatic Acceptance OFF · WhatsApp HOLD
- OpenCode draft Mission `79a170b2-…` (cancelled) · host settlement `a286ca1d-…` settled · Development Session `2eb98c6a-…`
- Operator checkout preserved.

## Self-Development Reliability V1.1 — SHIPPED + INSTALLED (2026-10-10)

- **PRs:** [#49](https://github.com/airodrom/airodrom/pull/49) (feature) · [#50](https://github.com/airodrom/airodrom/pull/50) (package allowlist `connection-status.js`)
- **Merge on `origin/main`:** `61d0b0d8fbabfed70532751f7ca713d3d082c17d` (contains tip `af5fce8021b52038c7ee18c99c6f02d4069fdd1b`)
- **Installed:** `…/airodrom-self-dev-v1/install/airodrom-self-dev-af5fce8` from npm pack (366 files; archive SHA-256 `753227615d5c942312b25c8e091d98bb25de5fa530ca694365ea896bb0c604cd`)
- **Backup/rollback:** `~/.airodrom/backups/self-dev-v11-20261010T174215Z` (prior source `…/airodrom-coding-reliability-a6ee3e3`)
- **Live:** Control/OpenCode/Memory/Provider Ready · panel `/development-sessions-panel.js` HTTP 200 · hub coding admission `sourceContextSensitive=false` · timeout 120000 · Automatic Acceptance OFF · WhatsApp HOLD
- Evidence: [SELF-DEVELOPMENT-RELIABILITY-V1.1.md](SELF-DEVELOPMENT-RELIABILITY-V1.1.md). Operator checkout preserved.

## WhatsApp verify-token staged rotation — see SHIPPED + INSTALLED above

Owner Meta test callback verification remains pending: stage in owner TTY → Meta Verify/Save → explicit `commit-verify-token` (or `rollback-verify-token`).

## Developer Autonomy V1 (in progress on feature branch)

Standing per-repository enrollment and short-lived Mission grants are implemented on `feat/developer-autonomy-v1`. Not installed on the live service until an owner-accepted revision.
