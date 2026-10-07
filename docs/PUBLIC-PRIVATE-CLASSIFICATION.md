# Public and private file classification

Historical export classification for the preceding candidate. Removed or renamed runtime files below describe that historical snapshot; current distribution is governed by release-files.json and the Pi-removal architecture gate.

Only the reviewed candidate [allowlist](../release-files.json) is released. This table classifies original source artifacts; public rewrites replace internal originals without deleting them. Runtime/data/session/credential stores and transient work are excluded as entire categories. No private Git history is distributed.

| Original classification | Files | Treatment |
| --- | ---: | --- |
| GENERATED/TRANSIENT | 7 | Preserve privately; exclude original |
| INTERNAL ONLY | 105 | Preserve privately; exclude original |
| LOCAL OPERATOR ONLY | 3 | Preserve privately; exclude original |
| PUBLIC SAFE | 355 | Keep reviewed source |
| SECURITY-SENSITIVE | 17 | Preserve privately; exclude original |

Candidate public files include reviewed source, seeded tests/fixtures, UI, portable policy defaults, source/build/check tooling, MIT/upstream notices, governance/ADRs and public summaries. Exact npm file entries exclude operator manifests even if locally injected. Generated helpers, stores, logs, backups, patches, IDE state and private incident/session/account evidence never enter source/package archives. Neutral synthetic private paths and `.invalid` contacts remain only in denial tests; required upstream authorship is intentionally public attribution.

All original worktrees, dirty/unique work and evidence remain preserved. No old branch/worktree or unique artifact was deleted. Large local state stays private; the largest historical Git blob is 237,568 bytes and no LFS/submodule is present. Historical private docs are replaced by current public summaries rather than published with old operational claims.

| Original file | Classification | Release treatment |
| --- | --- | --- |
| `.gitignore` | INTERNAL ONLY | preserve original privately; distribute reviewed candidate replacement |
| `AGENTS.md` | INTERNAL ONLY | preserve original privately; distribute reviewed candidate replacement |
| `CONTRIBUTING.md` | INTERNAL ONLY | preserve original privately; distribute reviewed candidate replacement |
| `LICENSE` | PUBLIC SAFE | keep public |
| `README.md` | INTERNAL ONLY | preserve original privately; distribute reviewed candidate replacement |
| `check_mission_issue.js` | GENERATED/TRANSIENT | preserve original; exclude from release |
| `config/agent-runtime-qualification-v1.json` | PUBLIC SAFE | keep public |
| `config/architecture-memory-sources-v1.json` | INTERNAL ONLY | preserve original privately; distribute reviewed candidate replacement |
| `config/capability-policy-v2.json` | PUBLIC SAFE | keep public |
| `config/local-model-capability-v1.json` | PUBLIC SAFE | keep public |
| `config/local-services-v2.json` | PUBLIC SAFE | keep public |
| `config/memory-retention-fields.json` | PUBLIC SAFE | keep public |
| `config/provider-gateway.json` | PUBLIC SAFE | keep public |
| `config/safe-autonomy-level1.json` | PUBLIC SAFE | keep public |
| `config/safe-autonomy-manifest.json` | LOCAL OPERATOR ONLY | preserve original privately; distribute empty/default template only if applicable |
| `config/trusted-routine-actions-v1.json` | PUBLIC SAFE | keep public |
| `config/verification-runtime-v1.json` | LOCAL OPERATOR ONLY | preserve original privately; distribute empty/default template only if applicable |
| `docs/AGENT-ADAPTER-V1.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/AIRODROM-MIGRATION.md` | SECURITY-SENSITIVE | preserve original; use public summary |
| `docs/API-REFERENCE.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/AUDIT-CONTEXT-MIGRATION-REPORT.md` | SECURITY-SENSITIVE | preserve original; use public summary |
| `docs/AUTONOMY-STATUS-2026-09-29.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/CANDIDATE-MIGRATION-PROOF.md` | SECURITY-SENSITIVE | preserve original; use public summary |
| `docs/CAPABILITY-EXPANSION-V2.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/CHATGPT-INTEGRATION.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/CHATGPT-PI-AUTONOMY-FLOW.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/CHATGPT-PI-CURSOR-ARCHITECTURE.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/CONTEXTPACK-MIGRATION-PROOF.md` | SECURITY-SENSITIVE | preserve original; use public summary |
| `docs/CONTROL-PLANE-V2.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/DOCUMENTATION-INVENTORY.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/EXECUTION-QUALIFICATION.md` | SECURITY-SENSITIVE | preserve original; use public summary |
| `docs/FINAL-RELEASE-GATE-CHECKLIST.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/FINAL-VERDICT.md` | SECURITY-SENSITIVE | preserve original; use public summary |
| `docs/HOST-ISOLATION-V2.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/IDENTIFIER-INVENTORY.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/MACOS-STARTUP.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/MEMORY-ERASURE-RETENTION-MATRIX.md` | SECURITY-SENSITIVE | preserve original; use public summary |
| `docs/MEMORY-LIFECYCLE-POLICY.json` | INTERNAL ONLY | preserve original; use public summary |
| `docs/MEMORY-LIFECYCLE-PROOF.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/MEMORY-PRIVATE-COMPLETION.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/MEMORY-V1.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/MEMORY-V2-INTEGRATION-PLAN.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/MEMORY-V2.md` | INTERNAL ONLY | preserve original privately; distribute reviewed public summary |
| `docs/MISSION-1-AUTONOMOUS-WORKFLOW.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/MISSION-AUTHORITY-MODEL.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/NATIVE-EXECUTION-V1.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/OPAQUE-IDENTIFIER-DESIGN-REPORT.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/OPAQUE-IDENTIFIER-MIGRATION.md` | SECURITY-SENSITIVE | preserve original; use public summary |
| `docs/PI-CHATGPT-EVENTS.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/PLATFORM-INTEGRATION.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/PLATFORM.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/PRIVATE-QUALIFICATION.md` | SECURITY-SENSITIVE | preserve original; use public summary |
| `docs/PRIVATE-VALIDATION-SUMMARY.json` | INTERNAL ONLY | preserve original; use public summary |
| `docs/PUBLIC-RELEASE-HARDENING.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/README.md` | INTERNAL ONLY | preserve original privately; distribute reviewed public summary |
| `docs/REALITY-GATES.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/RELEASE-COMPLETION.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/RELEASE-DASHBOARD.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/RELEASE-ENGINEERING.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/RELEASE-GATES.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/RESTORE-REPLAY-MIGRATION-PROOF.md` | SECURITY-SENSITIVE | preserve original; use public summary |
| `docs/RUNTIME-SUPPORT-MATRIX.md` | INTERNAL ONLY | preserve original privately; distribute reviewed public summary |
| `docs/SAFE-AUTONOMY-LEVEL1.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/SAFETY-V2-CHECKPOINTS.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/SECURITY-PRIVACY-QUALIFICATION.md` | SECURITY-SENSITIVE | preserve original; use public summary |
| `docs/TASK-HEALTH.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/TRUSTED-DEVELOPER-MODE.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/adr/0001-execution-qualification.md` | INTERNAL ONLY | preserve original privately; distribute reviewed public summary |
| `docs/adr/0002-work-execution-adapter-v1.md` | INTERNAL ONLY | preserve original privately; distribute reviewed public summary |
| `docs/adr/0003-runtime-support-freeze.md` | INTERNAL ONLY | preserve original privately; distribute reviewed public summary |
| `docs/adr/0004-memory-erasure-retention.md` | INTERNAL ONLY | preserve original privately; distribute reviewed public summary |
| `docs/adr/README.md` | INTERNAL ONLY | preserve original privately; distribute reviewed public summary |
| `docs/adr/SUPERSESSION-TEMPLATE.md` | PUBLIC SAFE | keep public |
| `docs/adr/TEMPLATE.md` | PUBLIC SAFE | keep public |
| `docs/governance/AIRODROM-PRINCIPLES.md` | INTERNAL ONLY | preserve original privately; distribute reviewed public summary |
| `docs/governance/APP-DEVELOPMENT-GUIDE.md` | INTERNAL ONLY | preserve original privately; distribute reviewed public summary |
| `docs/governance/KERNEL-CONTRACT.md` | INTERNAL ONLY | preserve original privately; distribute reviewed public summary |
| `docs/governance/MISSION-AUTHORITY-GUIDE.md` | INTERNAL ONLY | preserve original privately; distribute reviewed public summary |
| `docs/governance/README.md` | INTERNAL ONLY | preserve original privately; distribute reviewed public summary |
| `docs/governance/SDK-CONTRACT.md` | INTERNAL ONLY | preserve original privately; distribute reviewed public summary |
| `docs/harness/agent-model.md` | INTERNAL ONLY | preserve original privately; distribute reviewed public summary |
| `docs/harness/airodrom-kernel-sdk-apps-v1.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/harness/anthropic-subscription-reasoning.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/harness/architecture-memory-continuity-v1.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/harness/architecture.md` | INTERNAL ONLY | preserve original privately; distribute reviewed public summary |
| `docs/harness/article-draft.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/harness/article-notes.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/harness/authority-memory-router-v2.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/harness/codex-completion-relay-v1.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/harness/codex-dispatch-reliability-v1.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/harness/codex-work-handoff-template.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/harness/decisions.md` | INTERNAL ONLY | preserve original privately; distribute reviewed public summary |
| `docs/harness/durable-workflows.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/harness/evidence.md` | SECURITY-SENSITIVE | preserve original; use public summary |
| `docs/harness/evidence/unified-agent-runtime-v1.json` | SECURITY-SENSITIVE | preserve original; use public summary |
| `docs/harness/failure-log.md` | SECURITY-SENSITIVE | preserve original; use public summary |
| `docs/harness/final-automation-closure-v1.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/harness/future-roadmap.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/harness/large-repository-verification-v2.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/harness/managed-reasoning-activation.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/harness/mission-program-v1.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/harness/multi-provider-gateway-v1.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/harness/operations-runbook.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/harness/pi-kernel-sdk-apps-v1.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/harness/pi-runtime-upgrade-1.0.2.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/harness/provider-independence.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/harness/relay-operator-rotation-2026-10-02.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/harness/relay-security-closeout-2026-10-02.md` | SECURITY-SENSITIVE | preserve original; use public summary |
| `docs/harness/release-candidate.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/harness/restricted-personal-memory-vault.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/harness/security-model.md` | SECURITY-SENSITIVE | preserve original; use public summary |
| `docs/harness/slack-human-loop.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/harness/structured-tool-evidence-v1.md` | SECURITY-SENSITIVE | preserve original; use public summary |
| `docs/harness/testing-and-chaos.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/harness/troubleshooting.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/harness/unified-agent-runtime-v1.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/harness/work-execution-adapter-v1.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/live-gates.json` | INTERNAL ONLY | preserve original; use public summary |
| `docs/live-web.json` | INTERNAL ONLY | preserve original; use public summary |
| `docs/mcp-repair-2026-09-27.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/mcp-schema-exposure-2026-09-27.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/mcp-validation.json` | INTERNAL ONLY | preserve original; use public summary |
| `docs/read-only-diagnostics.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/supervisor-core.md` | INTERNAL ONLY | preserve original; use public summary |
| `docs/ui-verification.json` | INTERNAL ONLY | preserve original; use public summary |
| `docs/validation-summary.json` | INTERNAL ONLY | preserve original; use public summary |
| `example.js` | GENERATED/TRANSIENT | preserve original; exclude from release |
| `examples/apps/mission-observer.js` | PUBLIC SAFE | keep public |
| `extracted_initialize_lines.js` | GENERATED/TRANSIENT | preserve original; exclude from release |
| `fixtures/cursor-cli-permissions-v1.json` | PUBLIC SAFE | keep public |
| `fixtures/cursor-handoff-v1.json` | PUBLIC SAFE | keep public |
| `fixtures/cursor-sandbox-readonly-v1.json` | PUBLIC SAFE | keep public |
| `fixtures/memory-v2-bootstrap-apply.py` | PUBLIC SAFE | keep public |
| `fixtures/memory-v2-full-bootstrap-v1.json` | PUBLIC SAFE | keep public |
| `fixtures/memory-v2/adapter-lifecycle-fixture.cjs` | PUBLIC SAFE | keep public |
| `fixtures/memory-v2/resume-fixture.cjs` | PUBLIC SAFE | keep public |
| `fixtures/safe-autonomy-level1/amber-proof.txt` | PUBLIC SAFE | keep public |
| `fixtures/safe-autonomy-level1/cobalt-proof.txt` | PUBLIC SAFE | keep public |
| `fixtures/safe-autonomy-level1/route.txt` | PUBLIC SAFE | keep public |
| `fixtures/task-capability-lease-v1.json` | PUBLIC SAFE | keep public |
| `macos/PiBridgeMenu.swift` | PUBLIC SAFE | keep public |
| `package-lock.json` | INTERNAL ONLY | preserve original privately; distribute reviewed candidate replacement |
| `package.json` | INTERNAL ONLY | preserve original privately; distribute reviewed candidate replacement |
| `public/app.js` | PUBLIC SAFE | keep public |
| `public/branding.js` | PUBLIC SAFE | keep public |
| `public/control-hub.css` | PUBLIC SAFE | keep public |
| `public/control-hub.html` | PUBLIC SAFE | keep public |
| `public/control-hub.js` | PUBLIC SAFE | keep public |
| `public/index.html` | PUBLIC SAFE | keep public |
| `public/style.css` | PUBLIC SAFE | keep public |
| `scripts/airodrom.cjs` | PUBLIC SAFE | keep public |
| `scripts/authority-migration-audit.cjs` | PUBLIC SAFE | keep public |
| `scripts/bootstrap-architecture-memory.cjs` | PUBLIC SAFE | keep public |
| `scripts/harness-safe-status.cjs` | PUBLIC SAFE | keep public |
| `scripts/macos/build-slack-keychain-helper.cjs` | INTERNAL ONLY | preserve original privately; distribute reviewed candidate replacement |
| `scripts/macos/control.cjs` | PUBLIC SAFE | keep public |
| `scripts/macos/install.cjs` | PUBLIC SAFE | keep public |
| `scripts/macos/mcp-tunnel.cjs` | PUBLIC SAFE | keep public |
| `scripts/macos/resilient-control.cjs` | PUBLIC SAFE | keep public |
| `scripts/macos/restart-handoff.cjs` | PUBLIC SAFE | keep public |
| `scripts/macos/slack-keychain-acl.c` | LOCAL OPERATOR ONLY | preserve original privately; distribute empty/default template only if applicable |
| `scripts/macos/slack-keychain-helper.c` | PUBLIC SAFE | keep public |
| `scripts/macos/uninstall.cjs` | PUBLIC SAFE | keep public |
| `scripts/macos/validate.cjs` | PUBLIC SAFE | keep public |
| `scripts/memory-identity-plan.cjs` | PUBLIC SAFE | keep public |
| `scripts/open.cjs` | PUBLIC SAFE | keep public |
| `scripts/publish-agent-result.cjs` | PUBLIC SAFE | keep public |
| `scripts/qualify-local-ollama-tools.cjs` | PUBLIC SAFE | keep public |
| `scripts/run.cjs` | PUBLIC SAFE | keep public |
| `scripts/worker-preflight.cjs` | PUBLIC SAFE | keep public |
| `search_results.md` | GENERATED/TRANSIENT | preserve original; exclude from release |
| `src/active-chat-mission.js` | PUBLIC SAFE | keep public |
| `src/agent-adapter.js` | PUBLIC SAFE | keep public |
| `src/agent-dispatch.js` | PUBLIC SAFE | keep public |
| `src/agent-routing.js` | PUBLIC SAFE | keep public |
| `src/agent-runtime-profile.js` | PUBLIC SAFE | keep public |
| `src/anthropic-subscription-provider.js` | PUBLIC SAFE | keep public |
| `src/anthropic-subscription-runtime.js` | PUBLIC SAFE | keep public |
| `src/apps/anthropic-subscription-provider.js` | PUBLIC SAFE | keep public |
| `src/apps/anthropic-subscription-runtime.js` | PUBLIC SAFE | keep public |
| `src/apps/capability-connectors.js` | PUBLIC SAFE | keep public |
| `src/apps/capability-git.js` | PUBLIC SAFE | keep public |
| `src/apps/claude-code-adapter.js` | PUBLIC SAFE | keep public |
| `src/apps/codex-adapter.js` | PUBLIC SAFE | keep public |
| `src/apps/cursor-adapter.js` | PUBLIC SAFE | keep public |
| `src/apps/index.js` | PUBLIC SAFE | keep public |
| `src/apps/openai-compatible-provider.js` | PUBLIC SAFE | keep public |
| `src/apps/project-memory-v2-adapter.js` | PUBLIC SAFE | keep public |
| `src/apps/provider-secrets.js` | PUBLIC SAFE | keep public |
| `src/apps/slack-ci-flow.js` | PUBLIC SAFE | keep public |
| `src/apps/slack-ci-ui.js` | PUBLIC SAFE | keep public |
| `src/apps/slack-credentials.js` | PUBLIC SAFE | keep public |
| `src/apps/slack-gateway.js` | PUBLIC SAFE | keep public |
| `src/apps/slack-runtime.js` | PUBLIC SAFE | keep public |
| `src/apps/slack-schema.js` | PUBLIC SAFE | keep public |
| `src/apps/task-health-slack.js` | PUBLIC SAFE | keep public |
| `src/apps/work-execution-adapter.js` | PUBLIC SAFE | keep public |
| `src/architecture-memory.js` | PUBLIC SAFE | keep public |
| `src/authority-hash.js` | PUBLIC SAFE | keep public |
| `src/authority-integration.js` | PUBLIC SAFE | keep public |
| `src/authority-json.js` | PUBLIC SAFE | keep public |
| `src/authority-memory.js` | PUBLIC SAFE | keep public |
| `src/authority-migration.js` | PUBLIC SAFE | keep public |
| `src/authority-qualification.js` | PUBLIC SAFE | keep public |
| `src/authority-router.js` | PUBLIC SAFE | keep public |
| `src/authority-schema.js` | PUBLIC SAFE | keep public |
| `src/authority-store.d.ts` | PUBLIC SAFE | keep public |
| `src/authority-store.js` | PUBLIC SAFE | keep public |
| `src/authority-types.d.ts` | PUBLIC SAFE | keep public |
| `src/autonomy-policy.js` | PUBLIC SAFE | keep public |
| `src/bounded-next-action.js` | PUBLIC SAFE | keep public |
| `src/branding.js` | PUBLIC SAFE | keep public |
| `src/bridge-controller.js` | PUBLIC SAFE | keep public |
| `src/bridge-restart.js` | PUBLIC SAFE | keep public |
| `src/capability-broker.js` | PUBLIC SAFE | keep public |
| `src/capability-connectors.js` | PUBLIC SAFE | keep public |
| `src/capability-devtools.js` | PUBLIC SAFE | keep public |
| `src/capability-files.js` | PUBLIC SAFE | keep public |
| `src/capability-git.js` | PUBLIC SAFE | keep public |
| `src/capability-host.js` | PUBLIC SAFE | keep public |
| `src/capability-mac.js` | PUBLIC SAFE | keep public |
| `src/capability-policy.js` | PUBLIC SAFE | keep public |
| `src/capability-util.js` | PUBLIC SAFE | keep public |
| `src/chatgpt-connection.js` | PUBLIC SAFE | keep public |
| `src/chatgpt-event-extension.mjs` | PUBLIC SAFE | keep public |
| `src/chatgpt-events.js` | PUBLIC SAFE | keep public |
| `src/claude-code-adapter.js` | PUBLIC SAFE | keep public |
| `src/codex-adapter.js` | PUBLIC SAFE | keep public |
| `src/codex-completion-relay.js` | PUBLIC SAFE | keep public |
| `src/command-classifier.js` | PUBLIC SAFE | keep public |
| `src/config.js` | PUBLIC SAFE | keep public |
| `src/control-context.js` | PUBLIC SAFE | keep public |
| `src/control-execution.js` | PUBLIC SAFE | keep public |
| `src/control-plane-api.js` | PUBLIC SAFE | keep public |
| `src/control-plane-store.js` | PUBLIC SAFE | keep public |
| `src/control-server.js` | PUBLIC SAFE | keep public |
| `src/control-transaction.js` | PUBLIC SAFE | keep public |
| `src/coordinator.js` | PUBLIC SAFE | keep public |
| `src/cursor-adapter.js` | PUBLIC SAFE | keep public |
| `src/cursor-runtime.js` | PUBLIC SAFE | keep public |
| `src/deterministic-acceptance.js` | PUBLIC SAFE | keep public |
| `src/event-ledger.js` | PUBLIC SAFE | keep public |
| `src/execution-evidence.js` | PUBLIC SAFE | keep public |
| `src/execution-lease.js` | PUBLIC SAFE | keep public |
| `src/fixture-acceptance.js` | PUBLIC SAFE | keep public |
| `src/fs-scopes.js` | PUBLIC SAFE | keep public |
| `src/host-exec.js` | PUBLIC SAFE | keep public |
| `src/host-reasoning-admission.js` | PUBLIC SAFE | keep public |
| `src/index.js` | PUBLIC SAFE | keep public |
| `src/kernel/index.js` | PUBLIC SAFE | keep public |
| `src/kernel/sdk-host.js` | PUBLIC SAFE | keep public |
| `src/level1-acceptance.js` | PUBLIC SAFE | keep public |
| `src/level1-mission.js` | PUBLIC SAFE | keep public |
| `src/level1-profile.js` | PUBLIC SAFE | keep public |
| `src/level1-provider.js` | PUBLIC SAFE | keep public |
| `src/level1-restricted-worker.js` | PUBLIC SAFE | keep public |
| `src/local-model-capability.js` | PUBLIC SAFE | keep public |
| `src/local-ollama-broker.js` | PUBLIC SAFE | keep public |
| `src/local-transport.js` | PUBLIC SAFE | keep public |
| `src/mcp-client.js` | PUBLIC SAFE | keep public |
| `src/mcp-stdio-trace.js` | PUBLIC SAFE | keep public |
| `src/mcp-stdio.js` | PUBLIC SAFE | keep public |
| `src/mcp-tools.js` | PUBLIC SAFE | keep public |
| `src/mcp.js` | PUBLIC SAFE | keep public |
| `src/memory-content-erasure.js` | PUBLIC SAFE | keep public |
| `src/memory-erasure.js` | PUBLIC SAFE | keep public |
| `src/memory-identity.js` | PUBLIC SAFE | keep public |
| `src/memory-restore.js` | PUBLIC SAFE | keep public |
| `src/memory-store.js` | PUBLIC SAFE | keep public |
| `src/mission-agents.js` | PUBLIC SAFE | keep public |
| `src/mission-authority.js` | PUBLIC SAFE | keep public |
| `src/mission-checkpoint.js` | PUBLIC SAFE | keep public |
| `src/mission-coordinator.js` | PUBLIC SAFE | keep public |
| `src/mission-lifecycle.js` | PUBLIC SAFE | keep public |
| `src/mission-manifest-paths.js` | PUBLIC SAFE | keep public |
| `src/mission-manifest.js` | PUBLIC SAFE | keep public |
| `src/mission-permissions.js` | PUBLIC SAFE | keep public |
| `src/mission-program.js` | PUBLIC SAFE | keep public |
| `src/mission-provider.js` | PUBLIC SAFE | keep public |
| `src/mission-result.js` | PUBLIC SAFE | keep public |
| `src/mission-schema.js` | PUBLIC SAFE | keep public |
| `src/mission-service.js` | PUBLIC SAFE | keep public |
| `src/mission-supervisor.js` | PUBLIC SAFE | keep public |
| `src/mission-verifier.js` | PUBLIC SAFE | keep public |
| `src/native-execution-router.js` | PUBLIC SAFE | keep public |
| `src/next-action-engine.js` | PUBLIC SAFE | keep public |
| `src/openai-compatible-provider.js` | PUBLIC SAFE | keep public |
| `src/orchestrator.js` | PUBLIC SAFE | keep public |
| `src/personal-memory.js` | PUBLIC SAFE | keep public |
| `src/pi-adapter.js` | PUBLIC SAFE | keep public |
| `src/private-json.js` | PUBLIC SAFE | keep public |
| `src/project-memory-v2-adapter.js` | PUBLIC SAFE | keep public |
| `src/project-memory-v2.js` | PUBLIC SAFE | keep public |
| `src/project-orchestrator.js` | PUBLIC SAFE | keep public |
| `src/provider-diagnostic.js` | PUBLIC SAFE | keep public |
| `src/provider-envelope.js` | PUBLIC SAFE | keep public |
| `src/provider-gateway.js` | PUBLIC SAFE | keep public |
| `src/provider-policy.js` | PUBLIC SAFE | keep public |
| `src/provider-profiles.js` | PUBLIC SAFE | keep public |
| `src/provider-reliability.js` | PUBLIC SAFE | keep public |
| `src/provider-secrets.js` | PUBLIC SAFE | keep public |
| `src/qualified-coding-adapter.js` | PUBLIC SAFE | keep public |
| `src/reasoning-admission.js` | PUBLIC SAFE | keep public |
| `src/repository-verification.js` | PUBLIC SAFE | keep public |
| `src/restricted-memory-vault.js` | PUBLIC SAFE | keep public |
| `src/result-inbox.js` | PUBLIC SAFE | keep public |
| `src/retained-context-files.js` | PUBLIC SAFE | keep public |
| `src/rpc-supervisor.js` | PUBLIC SAFE | keep public |
| `src/runtime-fingerprint.js` | PUBLIC SAFE | keep public |
| `src/runtime-support.js` | PUBLIC SAFE | keep public |
| `src/safe-diagnostics.js` | PUBLIC SAFE | keep public |
| `src/safety-extension.js` | PUBLIC SAFE | keep public |
| `src/safety-extension.mjs` | PUBLIC SAFE | keep public |
| `src/safety-policy.js` | PUBLIC SAFE | keep public |
| `src/sandbox-runner.js` | PUBLIC SAFE | keep public |
| `src/sdk/app-registry.d.ts` | PUBLIC SAFE | keep public |
| `src/sdk/app-registry.js` | PUBLIC SAFE | keep public |
| `src/sdk/index.d.ts` | PUBLIC SAFE | keep public |
| `src/sdk/index.js` | PUBLIC SAFE | keep public |
| `src/secret-observation.js` | PUBLIC SAFE | keep public |
| `src/service-log.js` | PUBLIC SAFE | keep public |
| `src/slack-ci-flow.js` | PUBLIC SAFE | keep public |
| `src/slack-ci-ui.js` | PUBLIC SAFE | keep public |
| `src/slack-credentials.js` | PUBLIC SAFE | keep public |
| `src/slack-gateway.js` | PUBLIC SAFE | keep public |
| `src/slack-runtime.js` | PUBLIC SAFE | keep public |
| `src/slack-schema.js` | PUBLIC SAFE | keep public |
| `src/supervisor-acceptance.js` | PUBLIC SAFE | keep public |
| `src/task-health-slack.js` | PUBLIC SAFE | keep public |
| `src/task-health.js` | PUBLIC SAFE | keep public |
| `src/task-session-model.js` | PUBLIC SAFE | keep public |
| `src/transactional-outbox.js` | PUBLIC SAFE | keep public |
| `src/transport-outcome.js` | PUBLIC SAFE | keep public |
| `src/trusted-dev-runner.js` | PUBLIC SAFE | keep public |
| `src/verification-runtime.js` | PUBLIC SAFE | keep public |
| `src/web-reader.js` | PUBLIC SAFE | keep public |
| `src/work-execution-adapter.js` | PUBLIC SAFE | keep public |
| `src/sandbox-policy.js` | PUBLIC SAFE | keep public |
| `test-empty-array-validation.js` | GENERATED/TRANSIENT | preserve original; exclude from release |
| `tests/active-chat-mission.test.js` | PUBLIC SAFE | keep public |
| `tests/agent-adapter.test.js` | PUBLIC SAFE | keep public |
| `tests/agent-dispatch-identity.test.js` | PUBLIC SAFE | keep public |
| `tests/agent-dispatch.test.js` | PUBLIC SAFE | keep public |
| `tests/anthropic-subscription-provider.test.js` | PUBLIC SAFE | keep public |
| `tests/anthropic-subscription-runtime.test.js` | PUBLIC SAFE | keep public |
| `tests/approval-resume-ledger.test.js` | PUBLIC SAFE | keep public |
| `tests/architecture-identity.test.js` | PUBLIC SAFE | keep public |
| `tests/architecture-memory.test.js` | PUBLIC SAFE | keep public |
| `tests/authority-integration.test.js` | PUBLIC SAFE | keep public |
| `tests/authority-plane.test.js` | PUBLIC SAFE | keep public |
| `tests/autonomy-policy.test.js` | PUBLIC SAFE | keep public |
| `tests/blocker-closure.test.js` | PUBLIC SAFE | keep public |
| `tests/bootstrap-repair.test.js` | PUBLIC SAFE | keep public |
| `tests/bootstrap.test.js` | PUBLIC SAFE | keep public |
| `tests/bounded-next-action.test.js` | PUBLIC SAFE | keep public |
| `tests/branding.test.js` | PUBLIC SAFE | keep public |
| `tests/bridge-log-diagnostics.test.js` | PUBLIC SAFE | keep public |
| `tests/bridge-restart.test.js` | PUBLIC SAFE | keep public |
| `tests/capability-broker.test.js` | PUBLIC SAFE | keep public |
| `tests/capability-expansion-v2.test.js` | PUBLIC SAFE | keep public |
| `tests/capability-policy-v2.test.js` | PUBLIC SAFE | keep public |
| `tests/chatgpt-connection.test.js` | PUBLIC SAFE | keep public |
| `tests/chatgpt-events.test.js` | PUBLIC SAFE | keep public |
| `tests/codex-completion-relay.test.js` | PUBLIC SAFE | keep public |
| `tests/codex-memory-context.test.js` | PUBLIC SAFE | keep public |
| `tests/codex-subscription-provider.test.js` | PUBLIC SAFE | keep public |
| `tests/control-center-ui.test.js` | PUBLIC SAFE | keep public |
| `tests/control-context.test.js` | PUBLIC SAFE | keep public |
| `tests/control-durable-dispatch.test.js` | PUBLIC SAFE | keep public |
| `tests/control-plane-api.test.js` | PUBLIC SAFE | keep public |
| `tests/control-plane-v2.test.js` | PUBLIC SAFE | keep public |
| `tests/control-server.test.js` | PUBLIC SAFE | keep public |
| `tests/cp-request-identity.test.js` | PUBLIC SAFE | keep public |
| `tests/cursor-fixtures.test.js` | PUBLIC SAFE | keep public |
| `tests/cursor-runtime-status.test.js` | PUBLIC SAFE | keep public |
| `tests/direct-bounded-reasoning-mcp.test.js` | PUBLIC SAFE | keep public |
| `tests/event-ledger.test.js` | PUBLIC SAFE | keep public |
| `tests/execution-qualification.test.js` | PUBLIC SAFE | keep public |
| `tests/fixtures/fake-pi.cjs` | PUBLIC SAFE | keep public |
| `tests/fixtures/git-baseline.cjs` | PUBLIC SAFE | keep public |
| `tests/fixtures/mission-fixture.cjs` | PUBLIC SAFE | keep public |
| `tests/fixtures/restarting-http.cjs` | PUBLIC SAFE | keep public |
| `tests/harness-agent-truthfulness.test.js` | PUBLIC SAFE | keep public |
| `tests/harness-chaos-boundaries.test.js` | PUBLIC SAFE | keep public |
| `tests/harness-closure-execution.test.js` | PUBLIC SAFE | keep public |
| `tests/harness-closure-isolation.test.js` | PUBLIC SAFE | keep public |
| `tests/harness-codex.test.js` | PUBLIC SAFE | keep public |
| `tests/harness-inbox-hardening.test.js` | PUBLIC SAFE | keep public |
| `tests/harness-outbox.test.js` | PUBLIC SAFE | keep public |
| `tests/harness-rc-closure.test.js` | PUBLIC SAFE | keep public |
| `tests/host-reasoning-admission.test.js` | PUBLIC SAFE | keep public |
| `tests/invocation-origin-erasure.test.js` | PUBLIC SAFE | keep public |
| `tests/level1-mission.test.js` | PUBLIC SAFE | keep public |
| `tests/level1-restricted-worker.test.js` | PUBLIC SAFE | keep public |
| `tests/lifecycle.test.js` | PUBLIC SAFE | keep public |
| `tests/live-gates.js` | INTERNAL ONLY | preserve original privately; distribute reviewed candidate replacement |
| `tests/live-mcp.js` | PUBLIC SAFE | keep public |
| `tests/local-model-capability.test.js` | PUBLIC SAFE | keep public |
| `tests/local-ollama-broker.test.js` | PUBLIC SAFE | keep public |
| `tests/local-ollama-provider-extension.test.js` | INTERNAL ONLY | preserve original privately; distribute reviewed candidate replacement |
| `tests/macos-helper.py` | PUBLIC SAFE | keep public |
| `tests/macos-validation.test.js` | PUBLIC SAFE | keep public |
| `tests/macos.test.js` | PUBLIC SAFE | keep public |
| `tests/mcp-integration.test.js` | INTERNAL ONLY | preserve original privately; distribute reviewed candidate replacement |
| `tests/mcp-protocol.test.js` | PUBLIC SAFE | keep public |
| `tests/mcp-restart-transport.test.js` | PUBLIC SAFE | keep public |
| `tests/mcp-schema.test.js` | PUBLIC SAFE | keep public |
| `tests/mcp-status-compact.test.js` | PUBLIC SAFE | keep public |
| `tests/mcp-trace.test.js` | PUBLIC SAFE | keep public |
| `tests/mcp-tunnel.test.js` | PUBLIC SAFE | keep public |
| `tests/memory-content-erasure.test.js` | PUBLIC SAFE | keep public |
| `tests/memory-erasure-lifecycle.test.js` | PUBLIC SAFE | keep public |
| `tests/memory-identity-plan.test.js` | PUBLIC SAFE | keep public |
| `tests/memory-identity-read-cache.test.js` | PUBLIC SAFE | keep public |
| `tests/memory-identity.test.js` | PUBLIC SAFE | keep public |
| `tests/memory-privacy-completion.test.js` | PUBLIC SAFE | keep public |
| `tests/memory-provenance-erasure.test.js` | PUBLIC SAFE | keep public |
| `tests/memory-request-identity.test.js` | PUBLIC SAFE | keep public |
| `tests/memory-restore-authority-freshness.test.js` | PUBLIC SAFE | keep public |
| `tests/memory.test.js` | PUBLIC SAFE | keep public |
| `tests/mission-1-autonomous-workflow.test.js` | INTERNAL ONLY | preserve original privately; distribute reviewed candidate replacement |
| `tests/mission-api.test.js` | PUBLIC SAFE | keep public |
| `tests/mission-authority.test.js` | PUBLIC SAFE | keep public |
| `tests/mission-coordinator.test.js` | PUBLIC SAFE | keep public |
| `tests/mission-permissions.test.js` | PUBLIC SAFE | keep public |
| `tests/mission-program.test.js` | PUBLIC SAFE | keep public |
| `tests/mission-provider.test.js` | PUBLIC SAFE | keep public |
| `tests/mission-recovery.test.js` | PUBLIC SAFE | keep public |
| `tests/mission-service.test.js` | PUBLIC SAFE | keep public |
| `tests/native-execution-router.test.js` | PUBLIC SAFE | keep public |
| `tests/native-tool-determinism-v11.test.js` | INTERNAL ONLY | preserve original privately; distribute reviewed candidate replacement |
| `tests/native-tool-reliability.test.js` | PUBLIC SAFE | keep public |
| `tests/next-action-engine.test.js` | PUBLIC SAFE | keep public |
| `tests/notification-content-erasure.test.js` | PUBLIC SAFE | keep public |
| `tests/orchestrator-mcp.test.js` | PUBLIC SAFE | keep public |
| `tests/outbox-memory-barrier.test.js` | PUBLIC SAFE | keep public |
| `tests/p0-safety.test.js` | PUBLIC SAFE | keep public |
| `tests/personal-memory-bridge.test.js` | PUBLIC SAFE | keep public |
| `tests/personal-memory-worker-tools.test.js` | PUBLIC SAFE | keep public |
| `tests/personal-memory.test.js` | PUBLIC SAFE | keep public |
| `tests/phase3-readiness.test.js` | PUBLIC SAFE | keep public |
| `tests/pi-adapter-bridge.test.js` | PUBLIC SAFE | keep public |
| `tests/pi-sdk.test.js` | PUBLIC SAFE | keep public |
| `tests/project-memory-v2-adapter.test.js` | PUBLIC SAFE | keep public |
| `tests/project-memory-v2-bridge-integration.test.js` | INTERNAL ONLY | preserve original privately; distribute reviewed candidate replacement |
| `tests/project-memory-v2-create-task-integration.test.js` | PUBLIC SAFE | keep public |
| `tests/project-memory-v2-lifecycle-integration.test.js` | PUBLIC SAFE | keep public |
| `tests/project-memory-v2.test.js` | PUBLIC SAFE | keep public |
| `tests/project-orchestrator.test.js` | PUBLIC SAFE | keep public |
| `tests/provider-budget-identity.test.js` | PUBLIC SAFE | keep public |
| `tests/provider-gateway.test.js` | PUBLIC SAFE | keep public |
| `tests/provider-http-fixture.test.js` | PUBLIC SAFE | keep public |
| `tests/readonly-policy.test.js` | PUBLIC SAFE | keep public |
| `tests/reasoning-admission.test.js` | PUBLIC SAFE | keep public |
| `tests/repository-verification.test.js` | PUBLIC SAFE | keep public |
| `tests/resilient-control.test.js` | PUBLIC SAFE | keep public |
| `tests/restricted-memory-vault.test.js` | PUBLIC SAFE | keep public |
| `tests/retained-read-identity.test.js` | PUBLIC SAFE | keep public |
| `tests/retained-result-erasure.test.js` | PUBLIC SAFE | keep public |
| `tests/rpc.test.js` | PUBLIC SAFE | keep public |
| `tests/runtime-support-freeze.test.js` | PUBLIC SAFE | keep public |
| `tests/safety.test.js` | PUBLIC SAFE | keep public |
| `tests/sandbox-runner.test.js` | PUBLIC SAFE | keep public |
| `tests/secret-diagnostic-boundaries.test.js` | PUBLIC SAFE | keep public |
| `tests/service-log.test.js` | PUBLIC SAFE | keep public |
| `tests/slack-ci-flow.test.js` | PUBLIC SAFE | keep public |
| `tests/slack-credentials.test.js` | PUBLIC SAFE | keep public |
| `tests/slack-gateway.test.js` | PUBLIC SAFE | keep public |
| `tests/slack-identity.test.js` | PUBLIC SAFE | keep public |
| `tests/supervisor-acceptance.test.js` | PUBLIC SAFE | keep public |
| `tests/supervisor.test.js` | PUBLIC SAFE | keep public |
| `tests/task-health-slack.test.js` | PUBLIC SAFE | keep public |
| `tests/task-health.test.js` | PUBLIC SAFE | keep public |
| `tests/task-lifecycle.test.js` | PUBLIC SAFE | keep public |
| `tests/tool-evidence.test.js` | PUBLIC SAFE | keep public |
| `tests/types/authority-contract.ts` | PUBLIC SAFE | keep public |
| `tests/types/pi-sdk-contract.ts` | PUBLIC SAFE | keep public |
| `tests/unified-agent-runtime.test.js` | PUBLIC SAFE | keep public |
| `tests/verification-runtime.test.js` | PUBLIC SAFE | keep public |
| `tests/web.test.js` | PUBLIC SAFE | keep public |
| `tests/work-execution-adapter.test.js` | PUBLIC SAFE | keep public |
| `tests/worker-preflight.test.js` | INTERNAL ONLY | preserve original privately; distribute reviewed candidate replacement |
| `tests/zero-click-routing.test.js` | PUBLIC SAFE | keep public |
| `tmp_file_check.txt` | GENERATED/TRANSIENT | preserve original; exclude from release |
| `tmp_update_script.js` | GENERATED/TRANSIENT | preserve original; exclude from release |
| `tsconfig.authority.json` | PUBLIC SAFE | keep public |
| `tsconfig.sdk.json` | PUBLIC SAFE | keep public |

## Documentation closeout addition

| Candidate addition | Classification | Treatment |
| --- | --- | --- |
| `docs/DOCUMENTATION-CLOSEOUT.md` | PUBLIC SAFE | Release policy, bounded validation and preservation references only; no private evidence |

Original-source classification counts above are historical and unchanged. This documentation-only closeout adds one reviewed public document to the candidate allowlist.
