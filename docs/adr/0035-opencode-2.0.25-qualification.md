# ADR 0035 — OpenCode 2.0.25 qualification

Status: Proposed. Primary confined live Mission evidence recorded on this branch.

## Context

Homebrew `homebrew/core` replaced OpenCode 2.0.20 with 2.0.25 and removed the
previous Cellar path. Package evidence still named 2.0.20. PR #39 adds fail-closed
replacement requalification once package evidence matches the installed binary.

## Decision

Qualify OpenCode CLI **2.0.25** on darwin-arm64 with local `ollama/qwen3-coder:30b`
using the existing confined live synthetic suite (`tests/live-opencode.cjs`).
Record the observed executable SHA-256 and Homebrew package version in
`config/agent-runtime-qualification-v1.json`. Set adapter `VERSION` to `2.0.25`.
Exact digest verification, Seatbelt confinement, stopped-service requalify gates
and fail-closed mismatch behavior remain unchanged.

## Consequences

Operators must stop the service and run `airodrom requalify` (with
`AIRODROM_OPENCODE_EXECUTABLE` if needed) after installing a build that contains
this evidence. Production pins are not rewritten by this change. Older 2.0.20
pins fail closed until requalified.

## Evidence recorded

- Homebrew `homebrew/core` OpenCode 2.0.25 at Cellar `bin/opencode`.
- SHA-256 `7b05019947d9eaff7b5c3412038a466908e9dc78e166b9316ec0588cee375664`.
- Confined live primary Mission: read-only, one-file edit, artifact return, registered verifier, Acceptance and Settlement passed with that digest and `runtime_version` 2.0.25.
- Timeout/cancel and external MCP handoff live checks also passed.
- Adapter normalizes OpenCode 2.0.25 result status `success` to `completed` before the existing allowlist; unknown statuses still fail closed.
