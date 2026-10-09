# ADR 0034 — OpenCode pin replacement requalification

Status: Proposed. Extends ADR 0009's Node-only repair with an explicit
fail-closed path when the pinned OpenCode executable has been removed.

## Context

`repairablePins()` previously called `verifyExecutable` on the pinned OpenCode
path. When Homebrew upgrades OpenCode and deletes the old Cellar directory, that
`lstat` fails with ENOENT and `airodrom requalify` cannot run. ADR 0009 still
requires exact OpenCode digest matching for ordinary Node-pin repair; it does not
authorize trusting a new version string alone.

## Decision

When the pinned OpenCode path is missing (`ENOENT`):

1. Structural pin checks, Seatbelt exactness, model/platform and the Node engine
   floor still apply.
2. The previous OpenCode digest/version need not match current package evidence
   (the pin names a removed artifact).
3. `requalify` resolves a replacement from `AIRODROM_OPENCODE_EXECUTABLE` or the
   adapter's discovered install path.
4. `qualify()` still requires the candidate's SHA-256, model, platform and
   runtime version to match package evidence, then runs the confined probe.
5. Previous pins are archived to `runtime-pins.previous.json` and current pins
   are replaced only after success. Failures leave `runtime-pins.json` unchanged.
6. Stopped service, durable idle writers, exclusive `qualification.lock` and
   mid-flight pin identity checks remain mandatory.

When the pinned OpenCode path still exists, ADR 0009 Node-only repair is
unchanged: OpenCode digest and runtime version must match package evidence.

## Consequences

Operators can recover after a package manager removes the old binary once package
evidence names the installed replacement. A newer OpenCode build that is not yet
in `config/agent-runtime-qualification-v1.json` still fails closed. Production
pins are never rewritten by this ADR itself.
