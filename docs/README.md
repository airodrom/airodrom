# Airodrom documentation

Notion documentation routing: [NOTION-DOCUMENTATION-ROUTING-V1.md](NOTION-DOCUMENTATION-ROUTING-V1.md). Airodrom hub only; Pi Bridge parents refused.

Integrated Release V1 (daily candidate): [INTEGRATED-RELEASE-V1.md](INTEGRATED-RELEASE-V1.md). One coherent local package from `integ/daily-candidate-v1-20261009`; not merged to main; operator service not replaced.

Control Center UI recovery (source candidate): [CONTROL-CENTER-UI-RECOVERY-V1.md](CONTROL-CENTER-UI-RECOVERY-V1.md). Restores atmosphere/theme/nav mounts lost before merge; not SHIPPED on main.

Read the [architecture](ARCHITECTURE.md), [installation](INSTALLATION.md), [development guide](DEVELOPMENT.md), [runtime support](RUNTIME-SUPPORT-MATRIX.md), [Memory V2](MEMORY-V2.md), [erasure and retention](PRIVACY-ERASURE.md), [threat model](THREAT-PRIVACY-SUMMARY.md), [limitations](KNOWN-LIMITATIONS.md) and [troubleshooting](TROUBLESHOOTING.md).

WhatsApp Business (source candidate): [Inbound V1](WHATSAPP-INBOUND-V1.md), [Conversations V1](WHATSAPP-CONVERSATIONS-V1.md), [Production Connection V1](WHATSAPP-PRODUCTION-CONNECTION-V1.md), [Daily WhatsApp gate 2026-10-09](DAILY-INTEGRATION-WHATSAPP-GATE-20261009.md), [V1.1 readiness](WHATSAPP-INBOUND-V1.1.md), [Meta live connection checklist](META-WHATSAPP-LIVE-CONNECTION-V1.md), [ADR 0038](adr/0038-whatsapp-inbound-v1.md), [ADR 0041](adr/0041-whatsapp-conversations-v1.md), [ADR 0040](adr/0042-whatsapp-production-connection-v1.md). Credential onboarding: `airodrom whatsapp bind` (hidden Vault capture + auto-configure). Not merged to main; public ingress inactive; outbound send OFF; production messaging on AI-policy HOLD.

Local-first Development Sessions (source candidate): [LOCAL-FIRST-BATCH-MERGE-V1.md](LOCAL-FIRST-BATCH-MERGE-V1.md), [ADR 0039](adr/0039-local-first-batch-merge.md). Not merged to main; no automatic GitHub CI or per-Mission merge.

Release review uses the [release policy](RELEASE-POLICY.md), [candidate notes](RELEASE-NOTES.md), [CI readiness](CI-BRANCH-PROTECTION.md), [candidate checklist](RELEASE-CANDIDATE-CHECKLIST.md), [dependency/license summary](DEPENDENCY-LICENSE-AUDIT.md), [secret/history summary](SECRET-HISTORY-AUDIT.md) and [fresh validation](FRESH-VALIDATION.md).

Canonical contribution contracts are in [governance](governance/README.md) and [ADRs](adr/README.md). The [file classification](PUBLIC-PRIVATE-CLASSIFICATION.md) describes excluded surfaces. Publication status is in [PUBLICATION-GATE.md](../PUBLICATION-GATE.md).
