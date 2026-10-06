# Publication gate

**AIRODROM PUBLICATION GATE COMPLETE — REPOSITORY PUBLIC; PRIVATE VULNERABILITY REPORTING VERIFIED.**

Repository: [airodrom/airodrom](https://github.com/airodrom/airodrom), **public**, default branch **main**. Private Vulnerability Reporting is **enabled and verified** as of October 5, 2026, 21:29:43 PDT (America/Vancouver).

Candidate: **1.0.0-rc.1**, reviewed local source export. The owner explicitly authorized the repository visibility switch. GitHub release/tag and package publication remain separate release steps; production remains unactivated.

| Required category | GO/NO-GO | Evidence and scope |
| --- | --- | --- |
| Secrets and intended history clean | GO | Zero unresolved clean-candidate findings; private history is audited and excluded, never authorized for publication |
| Public/private boundary clean | GO | Explicit source and exact package allowlists; operator manifests/runtime/incident/session/evidence originals excluded |
| Licenses/notices ready | GO for source distribution | Existing MIT preserved; locked MIT/Apache-2.0 inventory, installed upstream notices and SBOM; no vendored binaries; owner rights approval remains part of publication decision |
| Security docs and confidential intake | GO verified | GitHub Private Vulnerability Reporting is enabled; the supported status API returns `enabled: true`, and Security → Advisories exposes Report a vulnerability |
| Contribution/governance ready | GO as prepared | ADR/review requirements, code of conduct, issue/PR forms; real reviewer handles and hosting enforcement are owner configuration |
| CI gates ready | GO as prepared | Pinned read-only workflow and locally passing gates; hosted runs/protections await owner-selected repository |
| Package/release contents clean | GO for source candidate | 221-file package inspection/import smoke; exact source archive, reproducibility, integrity manifest and SBOM |
| Tests green | GO | 707 focused passed; 1,283 full passed, 0 failed, 12 explicitly explained skips; both declared type checks passed |
| Known limitations documented | GO | Logical versus physical erasure, current restore authority, runtime/toolchain prerequisites and bounded typing/advisory/scan coverage |
| No private artifact leakage | GO | Only candidate allowlisted files are distributed; original history/dirty/unique evidence preserved privately |
| No unsupported provider claims | GO | Work optional/live-unqualified; Cursor experimental/governed-denied; Cloud unsupported; no new live provider qualification |

## Owner publication decision completed

The owner explicitly authorized publication of the existing [GitHub repository](https://github.com/airodrom/airodrom). Repository identity was reverified as `airodrom/airodrom` (ID `1405456590`), private, on `main`, with admin access. GitHub's supported repository API changed only visibility to public, then the private reporting API enabled confidential reporting immediately afterward.

The final repository API and connected GitHub account independently confirm **visibility public** and **private false**. An unauthenticated GitHub API request also returns this public state. Publication completion covers repository visibility and confidential vulnerability intake; it does not claim a GitHub release, tag or package registry publication.

## Private vulnerability reporting verified

The enable request returned **HTTP 204**. Separate authenticated and unauthenticated [reporting status requests](https://api.github.com/repos/airodrom/airodrom/private-vulnerability-reporting) returned **HTTP 200**, `{"enabled": true}`. Final verification: `2026-10-06T04:29:43.535188+00:00`.

The public [Security Advisories page](https://github.com/airodrom/airodrom/security/advisories) displays **Report a vulnerability** and describes reports as private to maintainers. Its [report entry point](https://github.com/airodrom/airodrom/security/advisories/new) routes a signed-out visitor through GitHub sign-in with the private form as the return destination. The equivalent supported GitHub reporting state is verified; no vulnerability report was submitted. [GitHub status API documentation](https://docs.github.com/en/rest/repos/repos#check-if-private-vulnerability-reporting-is-enabled-for-a-repository).

GitHub Private Vulnerability Reporting remains the sole confidential reporting channel in [SECURITY.md](SECURITY.md). If it becomes unavailable, reporters must wait and keep sensitive details private.

## Release scope and next action

No push, merge, tag, GitHub release, package registry publication, deployment, production activation, credential rotation or unrelated repository or organization setting change occurred in this publication sequence. Historical hardening and test evidence remain preserved; these results are not new test runs.

The next safe release action is a read-only comparison of the prepared **1.0.0-rc.1** source and release hashes with the public repository, followed by an owner-reviewed release plan. Further source uploads, releases, packages or production actions require separate authorization.
