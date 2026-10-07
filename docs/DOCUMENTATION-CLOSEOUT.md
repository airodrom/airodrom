# Documentation closeout

Historical evidence: these counts and runtime references describe earlier revisions. The removal contract is [ADR 0008](adr/0008-remove-worker-runtime.md).

October 5, 2026. Same private **1.0.0-rc.1** candidate; no repository visibility change, release/package publication, deployment or production activation occurred.

**PUBLIC-RELEASE HARDENING COMPLETE — READY FOR OWNER PUBLICATION DECISION**

## Reporting policy and owner step

GitHub Private Vulnerability Reporting is the sole confidential vulnerability-reporting channel. Public GitHub Issues, discussions and pull requests must not contain vulnerability reports or sensitive details. Once the repository is public, reports use Security → Advisories → Report a vulnerability and the private repository security advisory workflow. If unavailable, reporters wait until it returns and keep sensitive details private. No email, external support address, contact form or separate contact channel is provided. No SLA or response-time promise is made.

**GitHub Private Vulnerability Reporting must be enabled/verified immediately upon public visibility switch.** The owner enables it in repository Settings → Advanced Security and verifies that Security → Advisories → Report a vulnerability opens the private form. This pending publication-time check is not a pre-publication hardening blocker. [GitHub configuration guidance](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository).

## Change scope

The documentation amendments cover SECURITY.md, PUBLICATION-GATE.md, PUBLIC-RELEASE-HARDENING.md, CODE_OF_CONDUCT.md, GOVERNANCE.md, the security issue guidance, release checklist/policy/notes, known limitations, CI readiness and threat/privacy summary. This closeout and its public-file classification are added to the exact source allowlist. The owner publication checklist remains unchecked for actions not performed.

Runtime source, tests, configuration, dependency locks, release tooling and the SBOM are byte-identical to the previously sealed candidate. The package stays private. The refreshed integrity manifest records every changed document and the sole inventory addition, docs/DOCUMENTATION-CLOSEOUT.md; release-files.json changes only to include that document.

## Validation and preservation

[Prior validation](FRESH-VALIDATION.md) and [original command/hash evidence](FRESH-VALIDATION.json) are preserved byte-for-byte: 707 focused passed; 1,283 full-suite passed, 0 failed, 12 explained skips; both declared type checks passed. Those are the earlier results, not new runs. The documentation-only maintenance rule in [RELEASE-POLICY.md](RELEASE-POLICY.md) permits retaining that evidence for the same candidate with unchanged executable inputs.

The refreshed CANDIDATE-MANIFEST.json accompanying the archive records targeted documentation/local-reference/canonical-hash/public-boundary verification, recognized secret scanning, npm package allowlist inspection, two byte-identical normalized source archives, archive path/type/content checks, baseline file comparisons and checksums. These checks must pass before delivery; no full or focused runtime suite is rerun for this amendment.

The previous sealed source archive, CANDIDATE-MANIFEST.json, SHA256SUMS and SBOM are retained under history/pre-private-reporting-closeout beside the refreshed artifacts. The earlier working checkouts, test logs, snapshots, private history and original release artifacts remain untouched. The previous incomplete verdict remains in that historical archive; [PUBLICATION-GATE.md](../PUBLICATION-GATE.md) is the current canonical verdict.
