# ADR 0031 — Managed login startup supervisor

Status: Proposed. Source candidate with isolated synthetic tests only. Installing the
LaunchAgent on an operator Mac is a separate, owner-controlled activation.

Numbering note: ADRs 0020–0030 exist as unmerged proposals elsewhere; this record
uses 0031 so the sequences cannot collide when they land.

## Context

The local service (ADR 0007) runs as a detached child of whichever command started
it. Nothing starts it at login and nothing restarts it after a crash. The installed
`local.airodrom.mcp-tunnel` LaunchAgent restarts only the tunnel, so after a reboot
ChatGPT reaches the stdio adapter while the service is down, and every tool call
fails with the discovery error.

## Decision

Add one user LaunchAgent, `local.airodrom.service`, that runs
`scripts/managed-service.cjs`: a supervisor that owns the service process, not
Mission authority.

- launchd: `RunAtLoad`, `KeepAlive: {SuccessfulExit: false}`, `ThrottleInterval` 30,
  `LimitLoadToSessionType: Aqua`, `Umask` 077, `/usr/bin/env -i` with five fixed
  variables, stdout and stderr discarded. No credential enters argv.
- One supervisor per Airodrom home through a private supervisor lock; a second
  instance waits in standby.
- Preflight repeats `local-service.cjs` validation (configuration, ownership, runtime
  pins). Invalid state blocks; it never launches inference or rewrites configuration.
- The Bridge writer lock remains the only authority on writer exclusion. A live
  service of this installation is adopted, never duplicated. A launch that loses the
  race adopts the winner. A dead-PID lock is reclaimed by the Bridge itself. A lock
  written before the current boot that names a live foreign process blocks with
  `writer_lock_pid_reused`; the supervisor never removes locks or discovery.
- Readiness requires an authenticated `/api/interactive/status` from the spawned PID.
- Crash restarts use exponential backoff with equal jitter (2 s doubling to 5 min).
  Five failures in ten minutes block with `crash_loop`; one retry follows a
  30-minute cooldown.
- A clean exit (status 0) is an operator stop and holds until the next boot or an
  explicit start. Unhealthy or hung processes are reported, never killed: the only
  signal sent is SIGTERM, to a child this supervisor spawned.
- OpenCode readiness is reported as worker status and never restarts the control plane.
- Sleep is detected as a wall/monotonic clock gap and resets health failure counts.
- The stdio MCP adapter waits up to 20 s for discovery only while the supervisor
  reports a launch in progress, and retries once only when the connection was
  refused before any byte was sent. Delivered calls are never replayed.

## Consequences

Startup, crash recovery and reconnection need no terminal in the ordinary case.
Duplicate authority is still impossible because ownership stays with the Bridge lock.
The service still runs from the installation's source checkout (`local.json`), so
edits to that checkout take effect on the next restart; an immutable installed copy
belongs to the native packaging plan.

## Rollback

`npm run macos:service:uninstall -- --apply` boots the job out (the supervisor stops
only its own child gracefully) and removes the plist. Data, credentials, discovery
and the tunnel are untouched. See the [runbook](../operations/startup-recovery-runbook.md).
