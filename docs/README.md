# Airodrom documentation

**Master Personal AI Completion V1** (implementation program): [MASTER-PERSONAL-AI-COMPLETION-V1.md](MASTER-PERSONAL-AI-COMPLETION-V1.md).
**Final Acceptance V2** (live tip vs offline evidence): [AIRODROM-FINAL-ACCEPTANCE-V2.md](AIRODROM-FINAL-ACCEPTANCE-V2.md). Cutover plan (not applied): [INSTALLED-TIP-CUTOVER-V2.md](INSTALLED-TIP-CUTOVER-V2.md).
**Cutover approval gate V3** (**HOLD** until explicit auth): [AIRODROM-CUTOVER-APPROVAL-V3.md](AIRODROM-CUTOVER-APPROVAL-V3.md).
**Recovery and live acceptance** (service healthy; cutover still HOLD): [AIRODROM-RECOVERY-AND-LIVE-ACCEPTANCE.md](AIRODROM-RECOVERY-AND-LIVE-ACCEPTANCE.md).

**Final reconciliation V4** (PR inventory, merge HOLD, Memory/CLI/Mission/MCP evidence, Arecibo handoff): [AIRODROM-FINAL-RECONCILIATION.md](AIRODROM-FINAL-RECONCILIATION.md).
**Always-On / Full Mac Reboot Acceptance V1** (login auto-start qualification): [AIRODROM-REBOOT-ACCEPTANCE-V1.md](AIRODROM-REBOOT-ACCEPTANCE-V1.md).

**Runtime Identity and Health Reporting V1** (`pi_bridge` alias, verified PIDs): [RUNTIME-IDENTITY-HEALTH-V1.md](RUNTIME-IDENTITY-HEALTH-V1.md).

**CLI client reliability** (attach-first Terminal; PATH install alignment): [CLI-CLIENT-RELIABILITY-V1.md](CLI-CLIENT-RELIABILITY-V1.md).

**Menu Status & WhatsApp Connection Closeout V1** (LOCAL IMPLEMENTATION): [MENU-STATUS-WHATSAPP-CLOSEOUT-V1.md](MENU-STATUS-WHATSAPP-CLOSEOUT-V1.md).

**Control Center & Premium macOS Experience V4** (SHIPPED + INSTALLED): [CONTROL-CENTER-MACOS-UX-V4.md](CONTROL-CENTER-MACOS-UX-V4.md).

**macOS Desktop Activation V1** (Menu V3 + login startup — SHIPPED + INSTALLED): [MACOS-DESKTOP-ACTIVATION-V1.md](MACOS-DESKTOP-ACTIVATION-V1.md).

**Final Product Consolidation V1** (local usable release stop line): [FINAL-PRODUCT-CONSOLIDATION-V1.md](FINAL-PRODUCT-CONSOLIDATION-V1.md).

Notion documentation routing: [NOTION-DOCUMENTATION-ROUTING-V1.md](NOTION-DOCUMENTATION-ROUTING-V1.md). Airodrom hub only; Pi Bridge parents refused.

Installation Hotfix V1.0.1: [INSTALL-HOTFIX-V1.0.1.md](INSTALL-HOTFIX-V1.0.1.md). Reproducible package fix; pending authorized upgrade of the healthy V1 install.

Integrated Release V1 (daily candidate): [INTEGRATED-RELEASE-V1.md](INTEGRATED-RELEASE-V1.md). One coherent local package from `integ/daily-candidate-v1-20261009`; not merged to main; operator service not replaced.

Control Center UI recovery (source candidate): [CONTROL-CENTER-UI-RECOVERY-V1.md](CONTROL-CENTER-UI-RECOVERY-V1.md). Restores atmosphere/theme/nav mounts lost before merge; not SHIPPED on main.

Read the [architecture](ARCHITECTURE.md), [installation](INSTALLATION.md), [development guide](DEVELOPMENT.md), [runtime support](RUNTIME-SUPPORT-MATRIX.md), [Memory V2](MEMORY-V2.md), [Memory correction](MEMORY-CORRECTION-V1.md), [erasure and retention](PRIVACY-ERASURE.md), [threat model](THREAT-PRIVACY-SUMMARY.md), [limitations](KNOWN-LIMITATIONS.md) and [troubleshooting](TROUBLESHOOTING.md).

WhatsApp Business (source candidate): [Inbound V1](WHATSAPP-INBOUND-V1.md), [Conversations V1](WHATSAPP-CONVERSATIONS-V1.md), [Production Connection V1](WHATSAPP-PRODUCTION-CONNECTION-V1.md), [Daily WhatsApp gate 2026-10-09](DAILY-INTEGRATION-WHATSAPP-GATE-20261009.md), [V1.1 readiness](WHATSAPP-INBOUND-V1.1.md), [Meta live connection checklist](META-WHATSAPP-LIVE-CONNECTION-V1.md), [ADR 0038](adr/0038-whatsapp-inbound-v1.md), [ADR 0041](adr/0041-whatsapp-conversations-v1.md), [ADR 0040](adr/0042-whatsapp-production-connection-v1.md). Credential onboarding: `airodrom whatsapp bind` (hidden Vault capture + auto-configure). Not merged to main; public ingress inactive; outbound send OFF; production messaging on AI-policy HOLD.

Local-first Development Sessions (source candidate): [LOCAL-FIRST-BATCH-MERGE-V1.md](LOCAL-FIRST-BATCH-MERGE-V1.md), [ADR 0039](adr/0039-local-first-batch-merge.md). Not merged to main; no automatic GitHub CI or per-Mission merge.

Release review uses the [release policy](RELEASE-POLICY.md), [candidate notes](RELEASE-NOTES.md), [CI readiness](CI-BRANCH-PROTECTION.md), [candidate checklist](RELEASE-CANDIDATE-CHECKLIST.md), [dependency/license summary](DEPENDENCY-LICENSE-AUDIT.md), [secret/history summary](SECRET-HISTORY-AUDIT.md) and [fresh validation](FRESH-VALIDATION.md).

Canonical contribution contracts are in [governance](governance/README.md) and [ADRs](adr/README.md). The [file classification](PUBLIC-PRIVATE-CLASSIFICATION.md) describes excluded surfaces. Publication status is in [PUBLICATION-GATE.md](../PUBLICATION-GATE.md).

- [Lifecycle & Package Closeout V1](LIFECYCLE-PACKAGE-CLOSEOUT-V1.md)
- [Coding Reliability & Auto-Acceptance V1](CODING-RELIABILITY-AUTO-ACCEPTANCE-V1.md)
- [Autonomous Self-Development V1](AUTONOMOUS-SELF-DEVELOPMENT-V1.md)
- [Self-Development Reliability V1.1](SELF-DEVELOPMENT-RELIABILITY-V1.1.md)
- [Everyday Personal AI UX V1](EVERYDAY-PERSONAL-AI-UX-V1.md) (SHIPPED + INSTALLED)
- [Grounded Assistant Accuracy V1](GROUNDED-ASSISTANT-ACCURACY-V1.md) (SHIPPED + INSTALLED)
- [Conversation UX Bugfix V1](CONVERSATION-UX-BUGFIX-V1.md) (SHIPPED + INSTALLED)
- [Git Repository Cleanup V1](GIT-REPOSITORY-CLEANUP-V1.md)
