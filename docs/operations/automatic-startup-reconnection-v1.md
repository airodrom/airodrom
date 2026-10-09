# Automatic startup, self-healing and reconnection V1

Decision record: [ADR 0031](../adr/0031-managed-login-startup-supervisor.md).
Operator procedures: [startup recovery runbook](startup-recovery-runbook.md).

## Startup architecture

```
login → launchd (local.airodrom.service) → supervisor → local service (Bridge)
                                                       ↳ ui.json / mcp.json discovery
ChatGPT → OpenAI tunnel → tunnel-client (local.airodrom.mcp-tunnel) → stdio adapter → local service
```

The tunnel and the service are separate LaunchAgents. The tunnel already restarts
on its own. The new agent starts and supervises the service.

## launchd ownership

One user agent in the Aqua (login) session, owned by the operator account. No
administrator rights are needed. It refuses to install while a retired Pi Bridge
agent (`local.pi-chatgpt-bridge`, `.menubar`) exists, or when the Airodrom
installation belongs to another source checkout. Node runs from Homebrew's stable
`opt` path; runtime pins still fail closed when that Node changes.

## Process lifecycle

| State | Meaning |
|---|---|
| STOPPED | No service, and none wanted: operator stop, or the supervisor is exiting |
| STARTING | First launch; waiting for authenticated readiness |
| HEALTHY | Spawned or adopted service answers status with its own PID |
| DEGRADED | Service alive but unhealthy or hung; reported, never killed |
| RECOVERING | Service exited unexpectedly; backing off before relaunch |
| BLOCKED | Unsafe or invalid state; no launch until the cause changes |
| STOPPING | Supervisor received SIGTERM and is stopping its own child |

The supervisor publishes this state privately and appends fixed-code events. Both
contain no tokens, URLs, paths, arguments or environment values.

## Private discovery

The service still writes `ui.json` and `mcp.json` after it starts and removes them
on a clean stop. The supervisor never edits or deletes discovery. A record is
accepted only when its PID matches the writer lock and the authenticated status
response. A crash leaves stale discovery behind; the next service overwrites it.

## MCP reconnection

The stdio adapter answers `initialize` and `tools/list` from its static 25-tool
catalog even while the service is down. Every tool call rereads discovery. While a
supervised launch is in progress, a call waits up to 20 s for fresh discovery. If
the connection was refused before any byte was sent, it retries once against the
replacement endpoint. Without a supervised launch, errors are reported at once.
Credentials are never rotated by this flow; the preserved MCP credential opt-in
continues to apply.

ChatGPT reconnection is observable only when its calls arrive. Local readiness is
never reported as a ChatGPT connection.

## OpenCode recovery

Pinned OpenCode readiness is read from service status and reported as worker
health. An unavailable worker never restarts the control plane, and reconnecting
grants no new permissions.

## Network, tunnel and sleep/wake

The control plane is loopback-only, so Wi-Fi changes do not affect it. The tunnel
keeps its own KeepAlive; external connectivity is outside this milestone. After
sleep, a wall/monotonic clock gap resets health failure counts, so a wake-time
timeout does not restart a service that is about to answer.

## Failure and restart policy

- Backoff: 2 s doubling to 5 min, with equal jitter.
- Crash loop: 5 failures in 10 min block the supervisor; one retry follows a 30-minute cooldown.
- Startup timeout: 60 s, then SIGTERM. A process that does not exit is preserved and reported DEGRADED.
- Health: 15 s interval. Three consecutive failures mean DEGRADED.

## Operator diagnostics

`airodrom doctor` (or `--json`) adds a startup section:
- automatic startup registration
- supervisor state and mode
- writer-lock classification
- discovery validity
- tunnel job state
- last recovery
- the blocking condition and next action

`npm run macos:service:status` shows the launchd job using allowlisted fields only.

## Security boundaries

Authentication is never disabled. No public endpoint, DNS, firewall, credential or
tunnel change is made. The supervisor signals only its own spawned child. It reads
other processes' arguments only in memory to classify lock ownership.

## Installation and rollback

See the [runbook](startup-recovery-runbook.md). Installation is explicit
(`--apply`); planning and status are read-only.

## Known limitations

- Real login, reboot and sleep behaviour has not been observed; only synthetic tests ran.
- The service runs from the installation's source checkout, so edits apply at the next restart.
- A lock left before a reboot whose PID was reused needs one operator check before restart.
- The Control Center and menu still show their existing status; the new startup state appears in `doctor`.

## Tests

`npm run test:startup` covers:
- launch, adoption, races and invalid configuration
- crash backoff and the crash loop
- clean stop, hung startup, degraded health and sleep detection
- lock classification
- the LaunchAgent plan and install, with a fake `launchctl`
- MCP wait, retry and no-replay
- doctor privacy
