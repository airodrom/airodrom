# Unified Autonomous Development V1

Canonical description of the ChatGPT → Airodrom → coding worker → independent verification → bounded repair → evidence workflow. Decision record: [ADR 0051](adr/0051-unified-autonomous-development.md). Engineering state on 2026-10-12: **PASS WITH KNOWN LIMITATIONS**. These are separate states and are never collapsed: IMPLEMENTED, TESTED, LIVE VERIFIED, OWNER ACCEPTED, PRODUCTION AUTHORIZED.

## Architecture

```
Owner ─▶ ChatGPT (coordinator/reviewer) ─▶ prepare_mission ─▶ Airodrom host validation
   │                                                            │
   └─ one authenticated approval (Terminal y/N or Control Center) ─▶ cp_mission_approvals
                                                                │
          Goal Planner ─▶ CAE scheduler ─▶ worker router ─▶ OpenCode | Cursor (governed) | host
                                                                │
                                                     sandbox-exec staging (host inventory authoritative)
                                                                │
                                        independent host verifier (trusted baseline + security scans)
                                              │ pass                         │ fail
                                     evidence package                failure classifier
                                     (get_mission_evidence)   repairable ─▶ one corrective Mission (repair_of, same fingerprint)
                                                              unsafe ─▶ HOLD / QUARANTINED with explanation
```

Airodrom is the only scheduler and the only authority for Mission completion. ChatGPT prepares and reviews; it cannot approve, accept, merge or deploy. Workers execute inside the host sandbox and never verify their own work.

## Owner experience

1. "ChatGPT, fix this." → `prepare_mission` returns one bounded proposal: workspace, files, worker, measurable Done criteria (registered tests, `git diff --check`, exact bytes when known), repair budget, no production, no Git mutation.
2. The owner approves once in the authenticated Terminal (`y/N`) or Control Center. The approval is bound to the Mission's immutable scope fingerprint, a time window (default 2 h, max 24 h), a repair budget and an explicit external-disclosure flag.
3. Terminal shows `Working`, then `Verification failed; preparing automatic repair`, `Repairing failed verification`, `Repair completed. Verification passed`, and finally `Awaiting owner Acceptance`. A terminal block always explains the category, for example: "Automatic repair could not start because the authorized automatic repair budget is used up (repair_budget). No additional changes were made."
4. ChatGPT retrieves `get_mission_evidence` whenever the conversation is active; Airodrom never wakes an inactive conversation.
5. Acceptance, merge, installation and production remain owner actions.

## Recovery phases (derived, not persisted)

`INITIAL_EXECUTION`, `INITIAL_VERIFICATION`, `VERIFICATION_FAILED`, `REPAIR_ELIGIBILITY_CHECK`, `REPAIR_PENDING`, `REPAIR_CREATING`, `REPAIR_DISPATCHED`, `REPAIR_RUNNING`, `REPAIR_VERIFYING`, `REPAIR_VERIFIED`, `REPAIR_BLOCKED`, `MISSION_VERIFIED`, `AWAITING_ACCEPTANCE`, `FAILED_TERMINAL`, `CANCELLED`, `QUARANTINED`, `WAITING_OWNER`. Observers keep following the same request identity while the phase is observing; `zero-setup-active.json` is cleared only on a terminal phase. Source: `src/recovery-phase.js`, exposed in `inspect_autonomous_goal` (`autonomous.phases`) and `get_mission_status`.

## Mission contract

Stored in `cp_missions.envelope.contract` (schema 1) with identity, objective, project (`base_commit_sha`), permissions (allowed read/write paths, default denied paths and tools, network mode, external providers, external disclosure, vault/personal-memory `none`), execution (worker allowlist, mode, sandbox), verification (expected outcome, criteria, registered tests only, mandatory Git and security checks, `airodrom:host-verifier`), budget (risk class low 2 / normal 3 / high 0 / fixture 1, absolute ceiling 5, wall clock, invocations, tool calls, inference units, spend observability), restrictions (deployments always prohibited; push/force-push/merge/history rewrite always prohibited) and audit (approval, trusted verifier baseline, lineage). `scope_fingerprint` excludes identity and objective text so a corrective Mission shares it. Unknown fields fail closed. Legacy Missions without a contract keep their prior ceilings.

## Approval model

`cp_mission_approvals` (`src/mission-approval.js`): one approval per scope fingerprint, idempotent request id, replay with a different scope denied, expiry and revocation fail closed at dispatch, corrective Missions reuse it only while fingerprint, workspace and budget match. Zero-setup approval issues and binds exactly one approval. MCP `approve_once` still never grants.

## Workers and routing

| Worker | State on 2026-10-12 | Isolation | Cost |
| --- | --- | --- | --- |
| OpenCode 2.0.25 | READY, LIVE VERIFIED | `sandbox-exec`, disposable staging, loopback only (private server + Ollama), external network denied, Keychain/SSH/secrets denied (PROVEN) | local, no spend |
| Cursor CLI 2026.09.28 | installed, **UNQUALIFIED** (`cursor_credential_file_unavailable`) | `sandbox-exec`, only bundled Node may exec (no shells), writes to literal allowed files, host CONNECT proxy to known Cursor hosts only, Keychain denied (PROVEN) | subscription, spend UNKNOWN; ceilings on time/invocations |
| Claude Code | installed, not qualified for autonomous execution | existing bounded proposal path | subscription |
| host | READY | typed native plans and verification | local |

Cursor routes only when the Mission has a contract with `external_disclosure.authorized` naming `cursor`, a known-host allowlist, a bound approval and a READY governed worker. `local_only` Missions never route to an external worker. Fallback never widens authority.

### Cursor qualification

`npm run qualify:cursor` runs the real CLI on a disposable repository (max 3 runs). Recorded result: `CURSOR_UNQUALIFIED`. The CLI stores its login in the macOS Keychain, which the sandbox correctly denies (`spawn EPERM` for `/usr/bin/security`). To qualify, the owner runs once:

```
AGENT_CLI_CREDENTIAL_STORE=file agent login
```

(writes `~/.cursor/auth.json`, mode 0600), or provides an API-key file, then reruns `npm run qualify:cursor` and reviews before flipping `execution_qualified` in `config/agent-runtime-qualification-v1.json`. The worker copies the file credential into the disposable sandbox HOME, reads it read-only, and shreds the copy afterwards.

## Sandbox model

Containment is proven empirically by `src/sandbox-containment.js` (PROVEN on this machine for both worker shapes): allowed file write/read succeed; outside write, read-only staged write, home secret read, SSH key read, symlink escape, shell exec, Keychain CLI exec, external TCP, other loopback port (cursor shape), metadata endpoint all return `EPERM`. OpenCode allows loopback because `run --standalone` needs its private server (verified; narrowing broke the runtime). A Git worktree is source isolation, never a security sandbox.

## Verification and test integrity

`verifier-baseline.js` records sha256 of verifier-owned inputs (tests, `tasks.json`, verification scripts) at creation; corrective Missions inherit the parent baseline. At verification: contract integrity, baseline audit (immutable verifier-owned vs agent-authored vs authorized), removed assertions / skips / weakened negative checks, trusted-source reproducibility from the base commit, and no registered task runs on tampered inputs. Security scans: secret patterns (NEW vs PRE_EXISTING), sensitive-area review, and `npm audit` / eslint / typecheck / semgrep / gitleaks only when required and installed (`UNAVAILABLE` otherwise, never "passed").

## Repair engine

Sequence: failure → classifier (`src/failure-classifier.js`) → termination proven → scope valid → approval and budgets (contract, plan, approval minimum) → one corrective Mission with deterministic identity in one transaction → stage rebind → host-built repair context (`src/repair-context.js`: expected vs observed bytes, failed check ids, redacted excerpts, previous attempts, remaining budget) → re-verification → Goal resumes. Loop prevention: repeated failure signature stops before the budget; transient blocks time out after 10 minutes; UNKNOWN effects quarantine.

## ChatGPT handoff

Tools: `prepare_mission`, `inspect_mission_proposal`, `get_mission_status`, `get_mission_events`, `get_mission_evidence`, `request_mission_correction` (WAIT), `cancel_mission`, plus existing `ask_airodrom`, `get_ask_status`, `submit_mission`, `get_mission_handoff`. Discovery schema 2 / catalog `unified-autonomous-development-v1`. An existing ChatGPT conversation may hold a stale 36-tool catalog; start a new conversation after install.

## Operations

`/api/control-v2/components`: READY / DEGRADED / UNAVAILABLE / BLOCKED / RECOVERING for service, Goal Planner, CAE, Ollama, MCP, verifier, sandbox, Mission store, Slack; worker tiers installed / authenticated / qualified / available / executing / verified. Audit events: approval issued/bound/revoked, dispatched, started, terminated, needs_rework, repair created/pending/blocked, awaiting acceptance, accepted, completed, blocked, worker trace. Slack routes exist for these events; the live install has no Slack configuration, so delivery is a recorded limitation.

## Git workflow

Workers never commit, push, merge or deploy. Each Mission records `base_commit_sha`; verification confirms head unchanged, only allowed files changed, no symlink escape, `git diff --check`. PRs, merges, installs and production remain owner actions.

## Known limitations (2026-10-12)

- Cursor live execution UNQUALIFIED until the owner creates the file-store credential; zero paid runs consumed.
- Live local-model repair variance: with `qwen3-coder:30b` the corrective attempt succeeded on 1 of 2 live runs after repair context was added (0 of 1 before); failures stop safely under the budget/signature rules.
- Hosted CI workflow is disabled and `main` is unprotected; required gates were run locally.
- Airodrom Slack delivery unconfigured; Mission notifications recorded as limitation.
- Cursor spend unobservable (subscription); ceilings on time/invocations are compensating controls.
- ChatGPT catalog staleness requires a new conversation; no background wake-up exists.
- Pre-existing flaky/failing tests unrelated to this change: `mission-service` "waiting Decision ... survive restart", `agent-dispatch` "restart after fallback selection", `mcp-protocol` `listChanged` negotiation; all fail identically on `079eee9`.

## Human acceptance procedure

1. Owner merges the PR (normal review) and performs the controlled install (`docs/INSTALLED-TIP-CUTOVER-V2.md`), keeping `079eee9` as rollback.
2. Owner creates the Cursor file-store credential if Cursor should be qualified; runs `npm run qualify:cursor`; reviews.
3. Owner prepares a fresh disposable Self-Repair Acceptance workspace and says to ChatGPT: "In the prepared self-repair test workspace, change fixture.txt from alpha to beta and verify it." ChatGPT calls `prepare_mission`; owner approves once in Terminal; observes repair; reviews `get_mission_evidence`; records Acceptance.

## Troubleshooting

- `Automatic repair is waiting because another writer still holds the approved workspace (workspace_writer)`: a lease is held; the scheduler retries for 10 minutes, then stops with `repair_pending_timeout`.
- `approval_expired` / `approval_revoked` at dispatch: issue a new approval through the owner flow; running work is not interrupted by expiry.
- `external_disclosure_unauthorized`: the Mission names an external worker without a disclosure-authorized contract; local OpenCode remains available.
- `cursor_credential_file_unavailable`: see Cursor qualification above.
- `QUARANTINED`: a lease or dispatch is uncertain; reconcile in Control Center before any retry.
