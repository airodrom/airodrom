# ADR 0055: Host coding contract coverage

- Status: Proposed
- Date: 2026-10-16
- Owner: Andrew
- Review: Pending maintainer disposition
- Affected contracts and components: MissionService.create, qualified coding adapter, Mission contract, MissionVerifier, verifier baseline
- Related decisions: [ADR 0051](0051-unified-autonomous-development.md)

## Context and problem

A deterministic host `coding_plan` could be registered without a canonical Mission contract. `MissionVerifier` runs `securityScan()` only when `envelope.contract` exists, so a host closeout could reach `operator_review` with diff-check and typecheck evidence while contract integrity, verifier-input audit, protected-test audit, secret scan, and sensitive-area review were absent. That absence was not recorded as unavailable.

## Decision

Newly created host coding Missions derive a canonical contract from the already validated workspace, allowed files, manifest, operations, verification tasks, and manifest expiry. The derived contract names the host worker, no reasoning provider, no external disclosure, no network, and zero repair attempts. Caller-supplied contracts cannot remove those checks or add authority. The trusted verifier baseline is captured at registration, before the host write.

Dispatch and verification both require the intact contract. A legacy coding Mission that has no contract is not promoted: dispatch fails with `host_coding_contract_required`, and verification records that gap as failed contract integrity plus unavailable coverage. It does not invent a passing security result. Unreadable scan inputs and a failed trusted-baseline lookup are `unavailable`, not passed. An absent path is empty historical content only after the baseline commit and tree have been read successfully. Historical verification rows are not rewritten.

`assertIntact()` does not enforce expiry. A new verifier command is blocked by the manifest runtime budget through `MissionProgram.assert()` before the command starts, unless the Mission is already in the owner-Acceptance window. That window is unchanged.

## Alternatives considered

Leaving coverage optional preserves old host registrations but continues to omit security evidence. Retrofitting contracts onto stored Missions would falsify historical records. Requiring an external-provider disclosure for a local host write would block model-free operation without adding a provider.

## Authority, privacy and ownership

The contract describes the existing host file grant. It does not widen write paths, open a provider, or authorize Acceptance. Automatic Acceptance remains only where an operator already set that separate preauthorization, and it still requires a fully passed verification. Owner review criteria stay `operator_review`.

## Compatibility and migration

No durable schema migration. Existing contractless envelopes stay readable. New creates gain a contract; old rows do not. Conversation and browser-research verification are unchanged. This decision is source-only until a maintainer merges and installs it. No live Mission is requalified by this change.

## Consequences

Host coding registrations are larger and fail closed when the manifest, preimage, contract, or baseline does not match. Secret scanning remains a pattern check, not an exhaustive audit. The two pre-existing `external_disclosure_unauthorized` mission-service failures are outside this decision. The existing execution-qualification expectation that an expired manifest blocks automatic settlement also fails on unmodified main, because `awaiting_acceptance` is inside the manifest acceptance window. This decision does not change that window.
