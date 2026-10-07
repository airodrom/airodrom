# Airodrom 1.0.0 rc.1 candidate notes

Historical evidence: these counts and runtime references describe earlier revisions. The removal contract is [ADR 0008](adr/0008-remove-worker-runtime.md).

Prepared October 5, 2026. Repository publication completed October 5, 2026: [airodrom/airodrom](https://github.com/airodrom/airodrom) is public, and GitHub Private Vulnerability Reporting is enabled and verified. GitHub releases, tags and package registry publication remain separate steps; production remains unactivated.

**AIRODROM PUBLICATION GATE COMPLETE — REPOSITORY PUBLIC; PRIVATE VULNERABILITY REPORTING VERIFIED.**

GitHub Private Vulnerability Reporting is the sole confidential vulnerability channel. Its supported status API returns `enabled: true`, and the public Advisories page provides Report a vulnerability. No report was submitted. If unavailable, reporters wait and keep sensitive details private. No separate contact channel is provided. Prior validation evidence is preserved; see [DOCUMENTATION-CLOSEOUT.md](DOCUMENTATION-CLOSEOUT.md) for the earlier documentation closeout and [PUBLICATION-GATE.md](../PUBLICATION-GATE.md) for the completed publication record.

The candidate includes scoped memory erasure, opaque legacy-identity migration, retryable propagation and restore/replay non-resurrection controls. Durable authority, writer ownership, independent verification, Acceptance and local Settlement remain canonical.

Public hardening adds explicit source/package allowlists, private artifact exclusion, locked dependency/security and license checks, public docs, governance, issue/PR hygiene, pinned CI preparation, checksums and a dependency SBOM. Operator runtime pins and private qualification/incident evidence stay outside the distributed surface.

Compatibility: package 1.0.0-rc.1; SDK contract 1.0.0; Kernel contract 1.2.0. Legacy MCP identity `pi-chatgpt-bridge` and compatibility configuration names remain. Legacy identities require independent opaque origin evidence; unanchored archives stay unavailable. Restore uses current independent dispositions in quarantine; raw snapshot rollback is unsupported.

OpenCode is the default primary bounded worker; Airodrom host primitives own control and verification. Pi is removed. Claude Code is optional supported. Work is optional/live-unqualified, Cursor experimental with governed execution denied, and generic Cloud unsupported. No new live provider claim or physical deletion guarantee is made. See the [fresh validation](FRESH-VALIDATION.md), [runtime matrix](RUNTIME-SUPPORT-MATRIX.md) and [publication gate](../PUBLICATION-GATE.md).

## Product Experience V2 source changes

Dimensional geometry-based terminal rendering, safe host pin requalification, an allowlisted live operations cockpit and native Airodrom menu are developed under [ADR 0009](adr/0009-product-observability-and-runtime-requalification.md). Integration and qualification evidence is recorded separately; these notes do not publish a release or claim unfinished gates passed.
