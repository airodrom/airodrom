# Airodrom public release hardening

Prepared October 5, 2026. Candidate **1.0.0-rc.1** completes public-release hardening and remains private/unactivated. GitHub Private Vulnerability Reporting is the sole confidential channel; its activation/verification is an owner step immediately upon public visibility switch. The sole final verdict is **PUBLIC-RELEASE HARDENING COMPLETE — READY FOR OWNER PUBLICATION DECISION**, recorded in [PUBLICATION-GATE.md](PUBLICATION-GATE.md).

## Repository choice and preservation

The private source HEAD is `f55a00c76b4e684a6d3cfc70b0ed3ee763ec8ca9` on `airodrom-platform-completion`; local main is `a34699fa868d8f61c9d2623ed21df388dce3439f`. There is no remote, origin/main, tag, hosted PR list or remote protection state to inspect. Main is older and lacks the qualified dirty privacy work. An isolated history-free export from the verified working snapshot is therefore safer than a main-based branch or publication of private history. Its disposable validation branch is `hardening/1.0.0-rc.1`; the empty fixture baseline is local test metadata and is not distributed.

All 10 original worktrees, 3 dirty worktrees and 9 worktrees with commits unique from main are preserved. A read-only lease inspection found no held/quarantined writer in the current application store. All 487 snapshotted source files still match their before-images. Private reachable history is preserved in a local bundle. No branch/worktree/history or unique evidence was deleted, rewritten, reset, merged or pushed.

## Completed reversible work

| Phase | Local result |
| --- | --- |
| Git/repository preflight | Current/main/refs/worktrees/dirty/untracked/unique state inventoried and protected; no remote or tags |
| Secret/sensitive history audit | Full local tree, reachable refs/commits, historical blobs/deleted files, prior patches/evidence and release candidate audited with redacted output |
| Public/private boundary | Explicit classifications and clean export; private runtime/account/session/operator/incident originals excluded |
| Dependency/supply-chain | Exact locks and integrity retained, scripts disabled, fresh advisory audit clean; no broad dependency upgrade |
| License/third-party | MIT preserved; 38 locked MIT/Apache-2.0 entries, full installed upstream notices, no vendored third-party binaries/assets; SBOM |
| Public docs | README, architecture, install/development, runtime matrix, Memory V2, erasure/recovery, security/threat, limitations/troubleshooting and release guidance |
| Security/governance | Policy and repository security advisory workflow documented; GitHub Private Vulnerability Reporting selected as the sole confidential vulnerability channel; governance, conduct and independent ADR/review requirements prepared |
| Issue/PR hygiene | Safe seeded bug/feature forms, security redirect, no-personal-data/no-secret and evidence checklist |
| CI/protection readiness | Read-only pinned workflow for tests/types/static/docs/secrets/audit/licenses/package/reproducibility; remote settings remain owner-controlled |
| Distribution | Source archive only; exact npm file entries prevent injected operator config; package import/help/version and clean install smoke pass |
| Version/release candidate | Package 1.0.0-rc.1, SDK 1.0.0, Kernel 1.2.0, changelog, notes, migration/compatibility and owner checklist |
| Cleanup review | Generated/transient, old patches, local pins/private docs and evidence classified/excluded; original historical material preserved |
| Threat/privacy final review | Authority/Acceptance/Settlement and memory separation preserved; opaque IDs/current restore authority and physical/provider limits documented |
| Fresh validation | 707 focused passed; 1,283 full passed, 0 failed, 12 explained skips; both declared type checks passed; local security/package gates pass |
| Publication gate | Local hardening complete; owner publication decision pending; GitHub Private Vulnerability Reporting must be enabled/verified immediately upon public visibility switch; no publication/activation performed |

## Findings and concrete repairs

Private operator-specific sandbox/verifier configuration and a one-off credential ACL helper never enter the export. The verifier defaults are empty and sandbox example is unconfigured; authority is not fabricated. Public canonical architecture excerpts retain non-authority invariants and replace local account observations with general admission/experimental-runtime policies; source hashes are reconciled. Original canonical/history evidence remains private and unchanged.

Seeded source fixtures use neutral personal-path examples, `.invalid` contacts and runtime paths resolved from the local home instead of an actual operator identifier. Installed-runtime positive qualification is conditional on private pins. Disposable fixture workspaces and short temporary database paths remove private-checkout assumptions. OS helper boundary tests compile existing local source without authorizing or reading credentials. There is no change to agent/provider, authority, erasure, identifier, restore or production behavior in runtime source.

A new packaging adversarial test demonstrated that npm directory entries can override a root ignore pattern and accidentally package an injected local manifest. The package now enumerates exact runtime files; the gate rejects unauthorized contents. New release-policy tests cover unexpected files, symlinks, altered source hashes, missing dependency integrity and deterministic archive exclusion. No dependency upgrade or provider qualification was needed.

## Qualification and residual limits

Pi local remains required. Claude Code is optional supported. Work is optional/live-unqualified, Cursor experimental with governed execution denied, and generic Cloud unsupported. DeepSeek remains disabled/auth_required. Personal payload logical erasure and current-authority quarantine/replay safeguards have synthetic source evidence; physical media/WAL/free pages/old backup bytes, unmanaged exports and delivered provider copies have no synchronous forensic deletion proof. Unknown origins/schemas remain unavailable. The public docs make no legal compliance or universal deletion claim.

The public source candidate is distinct from the private history. Recognized secret scans and advisory databases have bounded coverage; no arbitrary-secret/vulnerability absence guarantee is implied. License evidence describes observed terms, not a legal ownership opinion. Hosted CI enforcement, real reviewer accounts and eventual owner publication authorization cannot be inferred from a local checkout. GitHub Private Vulnerability Reporting has been selected and documented, but enablement/verification is deferred to immediately after the repository becomes public. Reporters must wait if it is unavailable and keep sensitive details private. No automatic activation follows a passing suite.

## Documentation closeout

The owner selected GitHub Private Vulnerability Reporting only, with no email, external support address or separate contact channel. All canonical pre-verified-channel blockers are replaced by the publication-time owner check. Prior source/archive manifests and historical test evidence are preserved. The same 1.0.0-rc.1 candidate receives documentation-only amendments and a refreshed integrity seal; runtime, tests, dependencies and configuration remain byte-identical. Targeted documentation/reference/boundary, secret and package checks plus deterministic archive verification are recorded in [DOCUMENTATION-CLOSEOUT.md](docs/DOCUMENTATION-CLOSEOUT.md). The prior 707 focused passes, 1,283 full-suite passes, 12 explained skips and both passing type checks remain historical evidence, not new test runs.

## Canonical artifact set

1. [Hardening report](PUBLIC-RELEASE-HARDENING.md).
2. [Publication gate and sole final verdict](PUBLICATION-GATE.md).
3. [Security policy](SECURITY.md).
4. [Contributing](CONTRIBUTING.md).
5. [README](README.md).
6. [Runtime matrix](docs/RUNTIME-SUPPORT-MATRIX.md).
7. [Threat/privacy summary](docs/THREAT-PRIVACY-SUMMARY.md).
8. [Dependency/license audit](docs/DEPENDENCY-LICENSE-AUDIT.md) and [notices](THIRD_PARTY_NOTICES.md).
9. [Secret/history audit](docs/SECRET-HISTORY-AUDIT.md).
10. [Release-candidate checklist](docs/RELEASE-CANDIDATE-CHECKLIST.md).
11. [Fresh validation](docs/FRESH-VALIDATION.md) and [command/hash evidence](docs/FRESH-VALIDATION.json).
12. [Release notes](docs/RELEASE-NOTES.md) and [changelog](CHANGELOG.md).
13. [Public/private classification](docs/PUBLIC-PRIVATE-CLASSIFICATION.md) and [exact file allowlist](release-files.json).
14. [Documentation closeout](docs/DOCUMENTATION-CLOSEOUT.md).

The source archive, integrity manifest/checksums and SBOM accompany this canonical set. Local raw logs, private history bundle and preservation snapshots stay outside release contents.
