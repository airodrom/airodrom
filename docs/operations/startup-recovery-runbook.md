# Startup recovery runbook

Architecture: [automatic startup and reconnection V1](automatic-startup-reconnection-v1.md).

## Install automatic login startup

Run these from the installation's source checkout, the one recorded by `airodrom`
setup.

1. `npm run macos:service:plan`: read-only; shows the LaunchAgent and any conflicts.
2. Resolve any refusals:
   - `legacy_agent_present`: remove the retired Pi Bridge agent first.
   - `installation_source_mismatch`: run from the recorded source checkout.
3. `npm run macos:service:install -- --apply`.
4. `npm run macos:service:status` should show the job running. Then check `airodrom doctor`.

An already running service is adopted, not restarted. Installing never changes
data, credentials, discovery or the tunnel.

## Diagnose

`airodrom doctor` reports the blocking condition and the next action:

| Blocking | Action |
|---|---|
| `not_installed` | Start from the menu or `airodrom start`, or install the agent |
| `setup_required` | Run `airodrom` once to complete setup |
| `runtime_requalification_required` | `airodrom requalify`; the supervisor retries by itself |
| `configuration_mismatch` | The installation belongs to another checkout; inspect before changing |
| `private_home_unsafe` | Restore private, owned permissions on the Airodrom home |
| `writer_lock_pid_reused` | Confirm no Airodrom service runs, then remove only the stale writer lock |
| `writer_lock_unverified` | Inspect the lock holder; never force-kill |
| `crash_loop` | Inspect supervisor events; one retry follows the 30-minute cooldown |

## Stop and start

`airodrom stop` (or the menu) drains and stops the service. The supervisor treats
the clean exit as an operator stop and does not relaunch it until the next login or
an explicit `airodrom start`, which the supervisor then adopts.

## Rollback

`npm run macos:service:uninstall -- --apply` boots the job out and removes its plist.
The supervisor stops only the child it launched, gracefully. A service started by
the menu or CLI keeps running.

## What not to do

Never delete discovery, credentials, launch holds, lifecycle rows or quarantines to
recover a service. Never SIGKILL a service that holds the writer lock.
