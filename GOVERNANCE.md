# Project governance

The repository owner retains release, publication and maintainer appointment authority. Repository maintainers review source and propose releases; no local author identity or service account is treated as a public maintainer identity.

Authority/security, memory/privacy, runtime, CI/release and documentation claims each require a reviewer competent in the affected boundary. Security and privacy changes require independent review; use two reviewers when implementation and verification roles overlap. Kernel decisions follow the [ADR process](docs/adr/README.md). Dependency and contract changes include compatibility and migration evidence.

Merge requirements are passing required checks, resolved review comments, updated evidence and explicit maintainer approval. Publication, tags, package release, deployment and activation require owner authorization. Automation has no publication or production authority.

CODEOWNERS is intentionally deferred until the owner identifies actual reviewer accounts on the selected hosting repository. Do not use invented handles. Branch-protection requirements are specified in the [CI readiness plan](docs/CI-BRANCH-PROTECTION.md); local preparation does not apply remote policy.

Use safe bug reports and feature requests in the eventual hosting repository. Vulnerability reports use only GitHub Private Vulnerability Reporting and the repository security advisory workflow in [SECURITY.md](SECURITY.md). The owner enables/verifies it immediately upon public visibility switch; this is a publication step, not a pre-publication hardening blocker. No separate confidential conduct or support channel is established.
