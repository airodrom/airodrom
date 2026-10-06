# Security policy

The current candidate is 1.0.0-rc.1. No public release or security-response SLA has been established. Maintainers review candidate fixes; unsupported runtimes receive no support commitment.

## Confidential reporting

Do not report vulnerabilities through public GitHub Issues, discussions or pull requests.

Once this repository is public, use **GitHub Private Vulnerability Reporting** at **Security → Advisories → Report a vulnerability**. This repository security advisory workflow is the sole confidential vulnerability-reporting channel. [GitHub reporting guidance](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately).

If private reporting is temporarily unavailable, wait until it is available. Do not post sensitive details publicly or request another contact channel.

The owner must enable and verify GitHub Private Vulnerability Reporting immediately after the repository becomes public. This is a publication-time activation/verification step, not a pre-publication hardening blocker. [GitHub configuration guidance](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository).

A confidential report should include the affected candidate/version, boundary involved, expected and actual behavior, a minimal synthetic reproduction, impact and a proposed mitigation if known. Do not send credentials, personal memory, raw runtime discovery, database exports, process arguments or provider account details. Use seeded fixtures and safe metadata.

## Coordinated handling

Use the private repository security advisory workflow for assessment, remediation and coordinated disclosure. Reporter credit requires consent. No response deadline or SLA is promised. Unresolved exploit details stay private until mitigated and disclosure is agreed.

## Security boundaries

Execution requires immutable Mission authority intersected with scopes, protected approvals, runtime qualification, sandbox and writer ownership. Memory and model output grant no authority. Results are untrusted until independent verification, Acceptance and local Settlement. Quarantined writers and stale restore authority deny progress.

Runtime discovery and credentials remain in private local storage. Diagnostic interfaces expose allowlisted metadata only. Credential rotation, production activation and provider deletion are explicit operator actions. See the [threat model](docs/THREAT-PRIVACY-SUMMARY.md) and [privacy contract](docs/PRIVACY-ERASURE.md).
