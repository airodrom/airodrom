# Release candidate checklist

- [x] Confirm exact source/archive hashes and preservation manifest.
- [x] Review source and npm allowlists; reject symlinks, unknown files, runtime state, accounts, session references, operator pins and private evidence.
- [x] Run checksum-verified recognized secret scans on all candidate history and release contents; review bounded synthetic exceptions.
- [x] Run locked install with lifecycle scripts disabled, fresh advisory audit, license/notices and SBOM checks.
- [x] Run focused security/privacy/runtime regressions, full suite, both type checks and syntax/docs/reference/hash/boundary checks; record fresh counts and skips.
- [x] Compare two independently generated source archives and inspect package dry-run/import/CLI help without starting a service.
- [x] Review logical erasure, opaque IDs, independent restore authority and physical/provider retention limits.
- [x] Confirm Work optional/live-unqualified, Cursor experimental/denied, Cloud unsupported and no new live claims.
- [x] Select GitHub Private Vulnerability Reporting as the sole confidential vulnerability channel and document it in SECURITY.md; no separate contact channel.
- [x] Complete documentation-only closeout and reseal the same candidate; preserve prior validation and artifacts. See [DOCUMENTATION-CLOSEOUT.md](DOCUMENTATION-CLOSEOUT.md).

## Repository publication completed

- [x] Owner explicitly authorized the existing `airodrom/airodrom` repository visibility change.
- [x] Reverify repository identity, private visibility, `main` and admin access before publication.
- [x] Change repository visibility to public through GitHub's supported repository API.
- [x] Immediately enable GitHub Private Vulnerability Reporting; enable request returned HTTP 204.
- [x] Verify the supported reporting state with HTTP 200 and `enabled: true`; the public Advisories page exposes Report a vulnerability and its private form destination through sign-in.
- [x] Reverify public visibility and record the final reporting state. No vulnerability report was submitted.
- [x] Preserve prior release records and refresh the documentation and integrity seal.

**AIRODROM PUBLICATION GATE COMPLETE — REPOSITORY PUBLIC; PRIVATE VULNERABILITY REPORTING VERIFIED.**

## Separate release decisions

- [ ] Review the public repository against the exact prepared source candidate and hashes before any further release upload or publication.
- [ ] Confirm maintainer/reviewer accounts, hosting checks and protection settings for the next release step; these settings were outside the authorized visibility and reporting sequence.
- [ ] Obtain separate owner authorization for any source push, tag, GitHub release, package publication, deployment or production activation.

GitHub Private Vulnerability Reporting is the sole confidential vulnerability channel. If unavailable, reporters wait and keep sensitive details private. Completed repository publication evidence is recorded in [PUBLICATION-GATE.md](../PUBLICATION-GATE.md).
