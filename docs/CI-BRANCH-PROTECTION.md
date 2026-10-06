# CI and branch protection readiness

The prepared workflow grants read-only contents permission, pins checkout/setup-node actions by commit, disables credential persistence and install scripts, and has no deployment/publish token or release action. Fork PRs use `pull_request`, never privileged `pull_request_target`. Full history is fetched only inside the clean candidate repository for recognized secret scanning.

Required checks: `candidate-validation`, `secret-history`, and `dependency-license`. Candidate validation includes full and focused tests, both declared type checks, syntax/JSON/docs/reference/source hashes, public-boundary checks, package allowlist and archive reproducibility. Secret scanning uses a checksum-verified pinned Gitleaks binary, plus public-boundary rules. Dependency/license jobs use `npm ci --ignore-scripts`, audit, locked license checks and SBOM generation.

The workflow uses macOS arm64 and exact Node 22.23.3 for the current host boundary. Installed-Pi positive qualification requires separate private host pins; absence is reported as an explicit skip. Mandatory synthetic denial, authority, erasure, migration and replay regressions remain in full/focused suites. Live provider/service targets are separate authorized private work.

For the future default/release branches require these checks, independent approving review, stale-review dismissal, resolved conversations, no force-push/deletion and restricted release/tag access. Add actual CODEOWNERS after reviewer accounts are chosen. Keep bots read-only for publication/production. Enable push protection where supported. GitHub Private Vulnerability Reporting must be enabled/verified immediately upon public visibility switch, including opening Security → Advisories → Report a vulnerability to verify the private form. This is an owner publication step, not a pre-publication hardening blocker; see [SECURITY.md](../SECURITY.md).

No hosting repository is configured in the inspected source. Remote workflow execution and branch protection application remain owner/platform actions. Local verification proves commands and file policy, not a hosted check-run result.
