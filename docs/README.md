# Airodrom documentation

**Projectless work** (registered Projects are optional): [PROJECTLESS-WORK-V1.md](PROJECTLESS-WORK-V1.md).

**Master Personal AI Completion V1** (implementation program): [MASTER-PERSONAL-AI-COMPLETION-V1.md](MASTER-PERSONAL-AI-COMPLETION-V1.md).
**Final Acceptance V2** (live tip vs offline evidence): [AIRODROM-FINAL-ACCEPTANCE-V2.md](AIRODROM-FINAL-ACCEPTANCE-V2.md). Cutover plan (not applied): [INSTALLED-TIP-CUTOVER-V2.md](INSTALLED-TIP-CUTOVER-V2.md).
**Cutover approval gate V3** (**HOLD** until explicit auth): [AIRODROM-CUTOVER-APPROVAL-V3.md](AIRODROM-CUTOVER-APPROVAL-V3.md).
**Recovery and live acceptance** (service healthy; cutover still HOLD): [AIRODROM-RECOVERY-AND-LIVE-ACCEPTANCE.md](AIRODROM-RECOVERY-AND-LIVE-ACCEPTANCE.md).

**Final reconciliation V4** (PR inventory, merge HOLD, Memory/CLI/Mission/MCP evidence, Arecibo handoff): [AIRODROM-FINAL-RECONCILIATION.md](AIRODROM-FINAL-RECONCILIATION.md).
**Always-On / Full Mac Reboot Acceptance V1** (login auto-start qualification): [AIRODROM-REBOOT-ACCEPTANCE-V1.md](AIRODROM-REBOOT-ACCEPTANCE-V1.md).
**Web boot-epoch recovery V1**: [WEB-BOOT-EPOCH-RECOVERY-V1.md](WEB-BOOT-EPOCH-RECOVERY-V1.md). Dispatch continuation cutover: [WEB-BOOT-RECOVERY-DISPATCH-CONTINUATION-CUTOVER.md](WEB-BOOT-RECOVERY-DISPATCH-CONTINUATION-CUTOVER.md).
**Bridge invocation boot recovery V1**: [BRIDGE-INVOCATION-BOOT-RECOVERY-V1.md](BRIDGE-INVOCATION-BOOT-RECOVERY-V1.md). Consolidated runtime recovery cutover: [RUNTIME-RECOVERY-CONSOLIDATED-CUTOVER-V1.md](RUNTIME-RECOVERY-CONSOLIDATED-CUTOVER-V1.md).

**Runtime Identity and Health Reporting V1** (`pi_bridge` alias, verified PIDs): [RUNTIME-IDENTITY-HEALTH-V1.md](RUNTIME-IDENTITY-HEALTH-V1.md).

**CLI client reliability** (attach-first Terminal; PATH install alignment): [CLI-CLIENT-RELIABILITY-V1.md](CLI-CLIENT-RELIABILITY-V1.md).

**Menu Status & WhatsApp Connection Closeout V1** (LOCAL IMPLEMENTATION): [MENU-STATUS-WHATSAPP-CLOSEOUT-V1.md](MENU-STATUS-WHATSAPP-CLOSEOUT-V1.md).

**Control Center & Premium macOS Experience V4** (SHIPPED + INSTALLED): [CONTROL-CENTER-MACOS-UX-V4.md](CONTROL-CENTER-MACOS-UX-V4.md).
**Live Execution Monitor V1** (source candidate): [LIVE-EXECUTION-MONITOR-V1.md](LIVE-EXECUTION-MONITOR-V1.md) — active-Mission three-column Observatory UI; see also [Live Agent Observatory](LIVE-AGENT-OBSERVATORY-V1.md).

**Limits & Blockers Registry V1:** [operations/LIMITS-AND-BLOCKERS-REGISTRY.md](operations/LIMITS-AND-BLOCKERS-REGISTRY.md) — canonical limits/blockers catalog, live diagnostics, safe recovery classes.
**Operational blocker recovery runbook:** [operations/OPERATIONAL-BLOCKER-RECOVERY-RUNBOOK.md](operations/OPERATIONAL-BLOCKER-RECOVERY-RUNBOOK.md) — all 27 operational blockers: diagnosis, authorized recovery, owner fallback.

**Operational recovery V1:** [OPERATIONAL-RECOVERY-LIFECYCLE-V1.md](OPERATIONAL-RECOVERY-LIFECYCLE-V1.md) — bounded identity reads, writer-death reconciliation, checkpoint copy modes.

**ChatGPT handoff / Milestone A:** [CHATGPT-HANDOFF-V8-VERIFICATION.md](CHATGPT-HANDOFF-V8-VERIFICATION.md) — exact-byte contract, v8 failure forensics, host v11 PASS, genuine remote **v9 PASS** (Milestone A complete).

**Milestone B (OpenCode ↔ Cursor):** [MILESTONE-B-CURSOR-SPECIALIST-READINESS.md](MILESTONE-B-CURSOR-SPECIALIST-READINESS.md) — canonical USER → ChatGPT → Airodrom → OpenCode → Cursor → OpenCode → Airodrom path; evidence packet; spend boundaries.

**Standing Cursor development:** [STANDING-CURSOR-DEVELOPMENT-V1.md](STANDING-CURSOR-DEVELOPMENT-V1.md) — owner-enrolled finite grants that stop recurring spend/disclosure WAIT for routine authorized Cursor work; project-scoped; fail-closed recovery.

**macOS Desktop Activation V1** (Menu V3 + login startup — SHIPPED + INSTALLED): [MACOS-DESKTOP-ACTIVATION-V1.md](MACOS-DESKTOP-ACTIVATION-V1.md).

**Final Product Consolidation V1** (local usable release stop line): [FINAL-PRODUCT-CONSOLIDATION-V1.md](FINAL-PRODUCT-CONSOLIDATION-V1.md).

Notion documentation routing: [NOTION-DOCUMENTATION-ROUTING-V1.md](NOTION-DOCUMENTATION-ROUTING-V1.md). Airodrom hub only; Pi Bridge parents refused.

Installation Hotfix V1.0.1: [INSTALL-HOTFIX-V1.0.1.md](INSTALL-HOTFIX-V1.0.1.md). Reproducible package fix; pending authorized upgrade of the healthy V1 install.

Integrated Release V1 (daily candidate): [INTEGRATED-RELEASE-V1.md](INTEGRATED-RELEASE-V1.md). One coherent local package from `integ/daily-candidate-v1-20261009`; not merged to main; operator service not replaced.

Control Center UI recovery (source candidate): [CONTROL-CENTER-UI-RECOVERY-V1.md](CONTROL-CENTER-UI-RECOVERY-V1.md). Restores atmosphere/theme/nav mounts lost before merge; not SHIPPED on main.

Read the [architecture](ARCHITECTURE.md), [multi-project development](MULTI-PROJECT-DEVELOPMENT-V1.md), [installation](INSTALLATION.md), [development guide](DEVELOPMENT.md), [runtime support](RUNTIME-SUPPORT-MATRIX.md), [Memory V2](MEMORY-V2.md), [Developer Memory V1](DEVELOPER-MEMORY-V1.md), [Memory correction](MEMORY-CORRECTION-V1.md), [erasure and retention](PRIVACY-ERASURE.md), [threat model](THREAT-PRIVACY-SUMMARY.md), [limitations](KNOWN-LIMITATIONS.md) and [troubleshooting](TROUBLESHOOTING.md).

WhatsApp Business (source candidate): [Inbound V1](WHATSAPP-INBOUND-V1.md), [Conversations V1](WHATSAPP-CONVERSATIONS-V1.md), [Production Connection V1](WHATSAPP-PRODUCTION-CONNECTION-V1.md), [Daily WhatsApp gate 2026-10-09](DAILY-INTEGRATION-WHATSAPP-GATE-20261009.md), [V1.1 readiness](WHATSAPP-INBOUND-V1.1.md), [Meta live connection checklist](META-WHATSAPP-LIVE-CONNECTION-V1.md), [ADR 0038](adr/0038-whatsapp-inbound-v1.md), [ADR 0041](adr/0041-whatsapp-conversations-v1.md), [ADR 0040](adr/0042-whatsapp-production-connection-v1.md). Credential onboarding: `airodrom whatsapp bind` (hidden Vault capture + auto-configure). Not merged to main; public ingress inactive; outbound send OFF; production messaging on AI-policy HOLD.

Local-first Development Sessions (source candidate): [LOCAL-FIRST-BATCH-MERGE-V1.md](LOCAL-FIRST-BATCH-MERGE-V1.md), [ADR 0039](adr/0039-local-first-batch-merge.md). Not merged to main; no automatic GitHub CI or per-Mission merge.

Release review uses the [release policy](RELEASE-POLICY.md), [candidate notes](RELEASE-NOTES.md), [CI readiness](CI-BRANCH-PROTECTION.md), [candidate checklist](RELEASE-CANDIDATE-CHECKLIST.md), [dependency/license summary](DEPENDENCY-LICENSE-AUDIT.md), [secret/history summary](SECRET-HISTORY-AUDIT.md) and [fresh validation](FRESH-VALIDATION.md).

Canonical contribution contracts are in [governance](governance/README.md) and [ADRs](adr/README.md). The [file classification](PUBLIC-PRIVATE-CLASSIFICATION.md) describes excluded surfaces. Publication status is in [PUBLICATION-GATE.md](../PUBLICATION-GATE.md).

- [Lifecycle & Package Closeout V1](LIFECYCLE-PACKAGE-CLOSEOUT-V1.md)
- [Coding Reliability & Auto-Acceptance V1](CODING-RELIABILITY-AUTO-ACCEPTANCE-V1.md)
- [Autonomous Self-Development V1](AUTONOMOUS-SELF-DEVELOPMENT-V1.md)
- [Self-Development Reliability V1.1](SELF-DEVELOPMENT-RELIABILITY-V1.1.md)
- [Personal Operations & Job Search V1](PERSONAL-OPS-JOB-SEARCH-V1.md) (Issue #112 — draft; not installed)
- [Everyday Personal AI UX V1](EVERYDAY-PERSONAL-AI-UX-V1.md) (SHIPPED + INSTALLED)
- [Grounded Assistant Accuracy V1](GROUNDED-ASSISTANT-ACCURACY-V1.md) (SHIPPED + INSTALLED)
- [Conversation UX Bugfix V1](CONVERSATION-UX-BUGFIX-V1.md) (SHIPPED + INSTALLED)
- [Git Repository Cleanup V1](GIT-REPOSITORY-CLEANUP-V1.md)

- [Autonomous Reliability & Intelligence V1](AUTONOMOUS-RELIABILITY-V1.md): local evaluations, memory metrics, durable observing goals, flight traces and discovery diagnostics.
- [Autonomous Supervisor V1](AUTONOMOUS-SUPERVISOR-V1.md): Live Activity execution projection, CLI `logs follow`, AUTO admission honesty, obsolete rework cleanup, standing WORK-template authorization (Issue #108).
- [Unified Autonomous Development V1](UNIFIED-AUTONOMOUS-DEVELOPMENT-V1.md): ChatGPT proposal → one owner approval → sandboxed worker → independent verification → bounded idempotent repair → durable evidence; Cursor governed worker and honest qualification.
- [Continuous Autonomous Execution V1](CONTINUOUS-AUTONOMOUS-EXECUTION-V1.md): durable authorized goal continuation without ChatGPT/Cursor ownership; extends Goal Planner.

- [Developer Autonomy V1](DEVELOPER-AUTONOMY-V1.md)
- [Global Autopilot V1](GLOBAL-AUTOPILOT-V1.md)
