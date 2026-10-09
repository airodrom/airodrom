# Known limitations

This candidate is source-only and unactivated. macOS arm64 is the freshly tested host. Installed runtime qualification requires private operator pins and exact dependency closure; other operating systems are unqualified. No production provider, service lifecycle or external Work port was exercised for public release.

Work is optional and live-unqualified. Claude Code needs host qualification. Cursor governed execution is experimental and denied. Generic Cloud is unsupported. DeepSeek stays disabled/auth_required. An agent CLI wrapper does not establish a vendor or OS sandbox guarantee, exclusive network egress or universal hard cancellation.

Logical erasure does not prove forensic deletion of physical media, WAL/free pages, backups, swap, unmanaged exports or provider copies. Unknown legacy origins and unclassified stores remain unavailable. Source installation does not automatically migrate real user data. Restore needs independently current authority; raw old-backup substitution is unsupported.

Secret patterns and dependency advisory databases cannot prove the absence of every unknown secret or vulnerability. License inventory describes observed upstream terms and preserves notices; it is not a legal ownership opinion. GitHub Private Vulnerability Reporting is the sole confidential vulnerability channel; the owner must enable/verify it immediately upon public visibility switch. If unavailable, reporters wait and keep sensitive details private. This publication step is not a pre-publication hardening blocker.

## Live Agent Observatory V1

- Continuous filesystem watching is unavailable; file create/modify/delete evidence is host-measured after the worker turn.
- OpenCode mid-run streams expose tool names only — not arguments, file contents, or model reasoning.
- Diff panels are Mission-scoped and size-capped; out-of-scope paths never appear.
- Empty activity panes show "Detailed activity unavailable." instead of synthetic progress.
- Installing Observatory into a running service requires an owner-authorized restart; `live_cutover_authorized` remains false until then.

## Development Sessions / local-first batch merge

- Source on `feat/local-first-batch-merge-v1` (feature impl `7c2217e127140e3d25fd3511e59cc4bab4e978c7` as of 2026-10-09; later docs-sync commits may tip the branch). **Not pushed**, **not merged**, **not SHIPPED IN SOURCE on main**, **not ACTIVE** as the default operator workflow until installed from main.
- Focused evidence: `tests/development-session-v1.test.js` **9/9**. Fixture success is not live multi-Mission qualification on a production checkout.
- Auto push, auto merge and hosted CI auto-dispatch remain fail-closed. Prepare Daily Integration never pushes or merges.
- Feature-branch hosted CI remains gated to `main` + `workflow_dispatch` in `candidate.yml`; repository-required checks are not bypassed.
- Standing merge authorization remains **INACTIVE**.
- See [LOCAL-FIRST-BATCH-MERGE-V1.md](LOCAL-FIRST-BATCH-MERGE-V1.md) and [ADR 0039](adr/0039-local-first-batch-merge.md).
