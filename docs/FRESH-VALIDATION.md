# Fresh candidate validation

October 5, 2026. Candidate 1.0.0-rc.1, source-only and unactivated. All counts below are from this pass. Focused and full suites overlap and must not be added.

| Check | Fresh result |
| --- | --- |
| Security/privacy/runtime and release-policy focused suite | **707 passed, 0 failed, 0 skipped** |
| Full repository suite | **1,283 passed, 0 failed, 12 skipped** (1,295 tests) |
| Authority type check | Passed |
| SDK type check | Passed |
| Syntax/JSON/docs/source hashes/public boundary | Passed |
| Recognized directory/history + additional Cursor/provider/key scan | Zero unresolved candidate findings |
| Dependency audit | Zero known vulnerabilities |
| License gate | 38 locked entries, MIT/Apache-2.0, zero blocked licenses/integrity/install-script findings |
| npm package inspection | 221 allowlisted files; no forbidden entries |
| Clean packaged install and import/CLI smoke | Passed; no service started |
| Source archive reproducibility/inventory | Final sealing verification records exact hashes |

Ten skips require an independently reviewed installed Pi/operator runtime manifest that is deliberately excluded from the candidate. Two pre-existing skips require separately authorized installed-service/tunnel-client environments. They do not qualify live providers. The OS helper-denial regressions ran with a locally compiled helper and passed. The five new public-release policy tests pass, including unexpected-file, symlink, modified-source-hash, missing-integrity, deterministic archive and injected operator-manifest rejection cases.

The tested runtime is macOS arm64, Node 22.23.3 with SQLite/FTS5 and npm 10.9.9. Both type checks cover their declared contracts, not whole-project JavaScript. No general lint or transpilation build target exists; syntax, documentation/hash policy and deterministic source packaging supply the canonical static/build checks. Live inference, service lifecycle, credential rotation, deployment and production activation were not run.

Exact commands, UTC timestamps, source fingerprint and log hashes are in [FRESH-VALIDATION.json](FRESH-VALIDATION.json). Raw local logs and private qualification evidence stay outside the release surface. Hosted CI has not run because no remote repository is configured; the workflow and required-check recommendations are prepared and local commands pass.
