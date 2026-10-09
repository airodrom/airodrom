# Operations and recovery V1

## Lifecycle reconciliation

Settled host turns end in `process_state='idle'`. They no longer hold maintenance
admission closed: see [ADR 0033](adr/0033-host-idle-run-settlement.md) for the exact
proofs required. Active, unverified or ambiguous runs, unreleased leases and
uncertain effects still block admission. Reopening admission remains an explicit
operator action, taken only after reconciliation.

## Human-readable CLI

`airodrom status`, `airodrom start`, `airodrom stop`, `airodrom doctor` and
`airodrom admission status` print a short report that ends with a single next action.
`--json` returns exactly the structured data scripts already use. Colour is used
only on a terminal, and never when `NO_COLOR` is set. `admission status` is
read-only; services without an admission gate report that instead of failing.

## Menu bar

The menu bar shows the Airodrom mark with a small status dot and no status text.
Only a waiting-approval count appears as text. The dot is green for Healthy, blue
for Starting, orange for Degraded, yellow for Maintenance, red for Disconnected and
grey for Unknown. Every state has an accessible description.

A process that is running but not answering is Disconnected, never Healthy. The
menu lists Service, MCP, OpenCode, Memory, Mission and Last recovery, and offers Open
Control Center, Run Diagnostics and Review Maintenance. Last recovery comes from the
managed supervisor (PR #36) when it is installed.

## Claude Code jobs

Job metadata and sanitized results persist in `cp_devtools_jobs`, which is
registered for identity migration. A record holds the owning task, worker, times,
state, exit code, an error category, progress events (fixed kinds and byte counts
only), the redacted final result and modified file names. Stdout, stderr, prompts,
environment values and credentials are never stored. Unparseable output keeps only
its byte count.

The owning task can read its live job or retained result; other tasks are told the
job is not theirs. The operator sees live and retained jobs in Control Center →
Workers. Jobs left running across a restart are marked `interrupted`. Results are
unverified worker output and carry no authority.

## Compatibility

- **PR #36 (managed startup):** admission persists across restarts, so supervisor
  restarts cannot reopen it over unresolved work. The menu reads the supervisor
  heartbeat when it exists.
- **PR #37 (DeepSeek reserve):** hooks avoid its edit points. Its reserve tables are
  now classified for identity migration.

## Known limitations

- The admission gate itself lives in uncommitted ServiceLifecycle work. Adopting
  this contract there is a supplied patch the owner applies.
- The menu changes take effect only after the menu app is rebuilt.
- Progress events are coarse (output byte counts). Claude Code runs in single-result
  JSON mode.
