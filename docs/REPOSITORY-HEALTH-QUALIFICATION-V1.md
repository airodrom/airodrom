# Repository Health Qualification V1

## Scope

Stabilize repository-wide validation without reimplementing Autonomous Reliability & Intelligence V1 features. Production admission, writer retention and secret scanning stay fail-closed.

## Root causes and fixes

| Class | Cause | Fix |
| --- | --- | --- |
| Shutdown / ownership fixture refusals | Synthetic durable runs, leases and effects reached production `Bridge.shutdown`, which correctly retained the writer | Test-only `disposeFixtureOwnership` classifies `synthetic_fixture_dispose` (not real termination). Default `TestBridge.shutdown` disposes then `shutdownForFixtureRestart` (writer release without production idle proof). `productionShutdown()` exercises fail-closed `shutdownOnce`. `fixtureRestart:true` preserves durable quarantine |
| Recovery admission race | `MissionService.recover` scheduled a tick that set `busy` during booting and blocked `finishRecovery` auto-open | Tick returns before the busy gate when admission is not open; schedule again after open |
| Durable wait vs idle gate | Verified `waiting_for_operator` / `waiting_for_permission` with `process_state=not_started` counted as unresolved runs | `run-settlement` treats those durable waits as settled for admission when no active lease remains |
| Stale MCP catalog expectations | Public catalog has 27 tools | Tests assert 27 |
| Source-policy (97) | 48 tracked files missing from `release-files.json`; absolute home paths and two broken links | Allowlist sync; portable home references in docs; link repairs |
| Secret classifier false positive | Synthetic `sk-ant-...` fixture matched the provider-key scanner | Non-provider Bearer fixture for ingress; adversarial `sk-ant`/`sk-proj` cases with exact SYNTHETIC fingerprints only |

## MCP discovery layers

| Layer | Count | Notes |
| --- | --- | --- |
| SOURCE (`src/mcp-tools.js` TOOLS) | 27 | Includes `personal_memory_get` and `personal_memory_search` |
| Installed / protocol handshake | 27 when source-matched | Not re-probed against a live tunnel in this pass |
| ChatGPT-visible connector | 25 (historical) | Missing the two Personal Memory tools; treated as client-side filtering or registration cache. No tunnel restart or Personal Memory broadening was performed |

## Termination evidence classes

| Class | Meaning | May prove production termination |
| --- | --- | --- |
| A. Real termination verified | Worker exited and termination was independently established | Yes |
| B. Synthetic fixture disposal | Disposable test DB/ownership teardown (`synthetic_fixture_dispose`) | No |
| C. Unknown termination | Process/side-effect state cannot be proved | No (fail-closed) |

## Security implications

- Production `BridgeController.shutdown` still throws when settlement or lifecycle idle checks fail and still retains the writer lock.
- Fixture dispose is TestBridge-only, never ships in the service entrypoint, never creates Acceptance, and never counts as class A termination proof.
- Secret scanning was not disabled; only exact synthetic fingerprints were registered for adversarial fixtures.
- Operator identity was removed from public docs; no credentials were rotated or printed.

## Remaining baseline limitations

- Hosted candidate CI remains intentionally disabled.
- Infrastructure failures that depend on absent host helpers (`/opt/homebrew/bin/python3`, Keychain helper copy) or live Codex pin mismatches are environment-bound and out of scope for this PR.
- Stale UI/status contract tests outside this change set may still fail until addressed separately.
- Live installation, Hindsight and Personal Memory were not mutated.

## Validation

Prefer official `node scripts/run.cjs --test` without `--test-force-exit` for lifecycle evidence. Focused negative coverage: `tests/shutdown-ownership-safety.test.js`. Source policy: `node scripts/verify-public.cjs` with zero errors after this change.
