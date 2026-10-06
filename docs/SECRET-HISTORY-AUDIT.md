# Secret and history audit

Audit date: October 5, 2026. Gitleaks v8.30.1 was downloaded from its upstream release and verified against the upstream archive checksum. Findings are handled privately with redacted output; public reporting contains classes, file/commit references, rules and disposition only.

## Scopes and disposition

The complete private working tree, ignored local/operator state, source/docs/fixtures/scripts/config, all reachable history and refs, historical deleted files, preceding patches/review artifacts and the clean candidate are covered. No tags, remote refs, LFS tracking or submodules were present. All local branches/worktrees and private history are preserved. Unreachable objects and external retention are not claimed erased or certified clean.

Private history: 52 reachable commits across 32 refs and 955 unique historical blobs. Gitleaks reported 26 findings, all reviewed non-secret canonical keys, synthetic alphabet-pattern credential fixtures or internal hash/evidence metadata. An additional recognized Cursor/provider/private-key pattern pass reviewed all unique history blobs; its hits are confined to synthetic fixtures.

The complete local tree produced 24 Gitleaks findings: 7 reviewed source false positives, 11 in private operator/runtime storage, and 6 in internal/transient state. Private credentials and evidence remain outside the candidate, with no validation request sent to a provider. No newly exposed active source credential or revocation requirement was established. Prior sensitive-pattern-bearing evidence is excluded; private historical retention does not authorize publication.

## Public candidate policy

The clean candidate contains only explicit source files; original private refs/history and accounts/session/incident artifacts are never published. Gitleaks default rules are extended, with seven exact path-and-value scoped exceptions for four non-secret canonical keys and known synthetic rejection fixtures. No file-wide or detector-wide bypass is used. Private-path/session boundaries are separately checked by `npm run verify`; synthetic neutral path examples remain only in denial tests and upstream authorship remains in required notices.

Fresh candidate directory and intended-history scans report zero unresolved findings under that reviewed policy. Distribution archives/packages are separately inventoried and scanned after extraction. Scanner matches and credential values are not included in public reports. Detection cannot prove the absence of arbitrary opaque secrets, and the private repository itself must not be made public.

## Exact reviewed exception classes

| File | Rule | Disposition |
| --- | --- | --- |
| `config/architecture-memory-sources-v1.json` | `generic-api-key` | Non-secret canonical invariant key; exact identifier only |
| `config/architecture-memory-sources-v1.json` | `generic-api-key` | Non-secret canonical invariant key; exact identifier only |
| `config/architecture-memory-sources-v1.json` | `generic-api-key` | Non-secret canonical invariant key; exact identifier only |
| `config/architecture-memory-sources-v1.json` | `generic-api-key` | Non-secret canonical invariant key; exact identifier only |
| `tests/memory-erasure-lifecycle.test.js` | `generic-api-key` | Synthetic .invalid/argv persistence-rejection fixture |
| `tests/capability-expansion-v2.test.js` | `generic-api-key` | Synthetic alphabet-pattern credential rejection fixture |
| `tests/capability-expansion-v2.test.js` | `github-pat` | Synthetic alphabet-pattern credential rejection fixture |
