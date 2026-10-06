# Pi removal and migration

Pi is removed, not deprecated. Its adapter, RPC supervisor, safety/provider extensions, executable/profile discovery, sandbox package/theme pins, worker preflight and rollback controls are deleted. `AIRODROM_*` is the canonical environment namespace; `PI_*` and `PI_BRIDGE_*` are no longer read. Existing source-profile options select only non-secret provider/model settings. Credentials and model catalogs are never copied into worker profiles.

Airodrom host primitives own typed plans (`airodrom.typed-coding`), broker execution and independent verification (`airodrom:host-verifier`). OpenCode receives only current bounded context and a disposable declared-file workspace. Worker self-verification never grants Acceptance. Cancellation, uncertain termination and writer quarantine retain their fail-closed semantics.

Historical Pi task/run/Mission identities remain readable; no alias maps them to an executable runtime. Tasks predating an execution identity are historical removed-runtime records. Resume, dispatch, capability invocation, context construction and publication deny removed identities. Existing sessions are never imported into canonical memory. Signed older typed plans must be registered again as a new host plan; immutable prior envelopes are not rewritten. No user data is deleted.

The old Active Chat local-model smoke is optional and retired. Its creation mode is removed from the MCP schema; historical removed-runtime grants and continuations are denied. The deterministic acceptance fixture selects Airodrom host primitives without starting any agent. The browser/CLI OpenCode conversation profile and synthetic Memory V2 qualification cover supported reasoning. The Level 1 signed deterministic read remains model-independent. Ollama remains a provider/control-plane capability.

The following retained names have zero Pi runtime dependency:

- `PiSDK`: a deprecated TypeScript alias of `AirodromSDK`, preserving source compatibility for SDK consumers.
- `pi-chatgpt-bridge` MCP/server/former-package identity and provider-decision audience/protocol strings: stable client/signature contracts.
- `pi-task-*`, `pi_bridge`, and existing service/keychain identifiers: destination idempotency, allowlisted host-service capability and private credential lookup contracts.
- `local.pi-chatgpt-bridge*`, managed tunnel profile and `Library/Application Support/Pi Bridge` paths: stable macOS integration/storage identities. They name Airodrom services and preserve existing private installations; they never launch a Pi worker.
- `.pi` path filters and `pi` in historical provenance/erasure allowlists: deny access to old credential directories and retain safe audit identity. New execution using that identity is rejected.
- Earlier ADRs, copyright and validation evidence: explicitly historical.

The architecture scan checks active source/config/UI/package/workflows against exact documented legacy tokens and forbids adapters, executable routes, dependency packages and removed environment selectors. Runtime-neutral lifecycle fixtures live under tests, cannot enter the package, and launch only the fixed synthetic policy worker. They simulate process faults and broker receipts without a model runtime.

No schema rewrite, raw snapshot promotion or credential-value migration occurs. Supported restore still requires current independent erasure/identity authority; removed records cannot gain executable authority through restore. PRE-RELEASE remains. No release, tag, npm publication, deployment or production activation is authorized.

## Dependency inventory and replacement

All tracked source, config, tests, docs, packaging, workflows and assets were inventoried before editing. The classifications were applied as follows:

| Class | Prior dependency | Disposition |
| --- | --- | --- |
| A: runtime implementation | Adapter/router registration, RPC supervisor/process factory, executable/profile discovery, provider/safety/event extensions, worker package/theme pins and launch flags | Deleted; no production factory can start a general host agent |
| B: control-plane logic | Typed coding plans, host verification identity, restricted Level 1 read, capability policy, sandbox executable/library/config pins | Runtime-neutral host primitives; independent broker receipts and verifier evidence remain required |
| B: provider capability | Local Ollama inference and native-tool policy | Explicit provider/control-plane capability; no agent registration, Pi selection or credential/profile inheritance |
| C: historical evidence | Prior ADRs, release/hardening counts and classification snapshots | Labeled historical and superseded; old records retain provenance without execution authority |
| D: stable identifiers | SDK type, MCP/signature audience, destination idempotency, service and Keychain/storage identity | Exact line/hash allowlist; no runtime behavior; values are never exposed or migrated |
| E: obsolete assurance | Installed-agent extension forcing/profile copying, worker closure launch, rollback assertions | Mandatory host denial, synthetic lifecycle/transport, OpenCode context and explicit removed-runtime tests |
| E: optional retired feature | Old Active Chat local-Qwen smoke | Product creation and browser grant controls retired; pure authority/scope invariants remain synthetic tests |

Runtime-neutral module-closure integrity remains a host utility; sandbox jobs cannot opt into a removed worker/provider runtime. OpenCode verifies its pinned standalone artifact and confines work to supplied disposable files. The default route has no agent fallback. An explicitly registered deterministic native plan is a host capability, not a fallback model. Existing optional external-runtime policies retain their separate, bounded classifications.

New browser state keys are `airodromToken` and `airodromTask`; an older tab can reopen its owning Control Center. No token value is transferred or logged. Old `pi-owned` directories remain private historical data; current typed host output uses `host-owned` and cannot traverse into old service state.

## Configuration transition

Existing standalone service configurations must explicitly use the canonical names before restarting: `AIRODROM_DATA_DIR`, `AIRODROM_SOURCE_PROFILE`, `AIRODROM_PORT`, `AIRODROM_WEB`, `AIRODROM_WEB_HOSTS`, `AIRODROM_BACKGROUND`, `AIRODROM_LOG_FILE`, `AIRODROM_NODE`, and `AIRODROM_TRUSTED_DEV_MODE`. The interactive install already uses private `AIRODROM_HOME` state and canonical runtime settings. Removed environment aliases are ignored; no compatibility selector may choose a removed worker. Update variable names in private configuration without exporting, copying or printing credential values. Existing isolated instances and durable user data are not deleted or adopted by this transition.

## Fresh removal validation

The removal implementation was validated from the verified main baseline `00face4e3e7e5a73163a32d746cd815f7418de8c`. Fresh local results: full repository 1,343 passed, 2 prerequisite skips, zero failures; hardening 748 passed; focused runtime/CLI/Memory/restore/Mission/lifecycle checks 129 passed; removal regressions 14 passed and 224 active files scanned with 45 exact legacy lines, zero errors. Suites overlap and must not be added.

Three installed OpenCode 2.0.20 synthetic live checks passed with Pi absent from the command path: read/edit/artifact provenance and independent host verification/Acceptance/Settlement; canonical Memory V2 remember, bounded retrieve, correction, forget/erase, stale-context denial and restore non-resurrection; timeout/cancellation. The isolated no-argument CLI launched, executed OpenCode questions and completed synthetic memory correction/forget. No real user memory was inspected.

Both declared typechecks, public verification, exact package check and archive reproducibility passed. Locked dependency audit found zero vulnerabilities; 38 MIT/Apache-2.0 package records were accepted, with no install scripts. Recognized source/history and additional provider-secret scans returned no findings. Hosted CI and installed-source reconciliation must still be verified for the final merged head. No release, tag, npm publication, deployment or production activation occurred.
