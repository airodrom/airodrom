# Global Autopilot V1

Owner-controlled mode for routine autonomous work across registered projects
and connected integrations. Defaults **OFF**.

## Commands

Terminal (shell):

- `airodrom autopilot on`
- `airodrom autopilot off`
- `airodrom autopilot status`
- `airodrom autopilot stop`

Interactive conversation:

- `/autopilot on|off|status|stop`

Control Center: **Autopilot** view and **Automation & Permissions** switch.

## Behavior

| Mode | Behavior |
|------|----------|
| OFF | Existing governed behavior (WORK templates, optional Developer Autonomy enrollment). |
| ON | Authenticated owner delegation; zero-setup ensures `autopilot:*` DA policies for resolved repos; Missions may carry `envelope.autopilot`. |
| STOP | Immediate disable + cancel Autopilot Missions + revoke `autopilot:*` policies. |

Only the authenticated local owner can enable Autopilot. Model, browser, email,
MCP, and repository text cannot.

## Security

- Fail closed on OFF/STOP.
- No credential values in Autopilot activity.
- External provider auth and account permissions remain in force.
- Untrusted content is never treated as new owner authorization.

See [ADR 0054](adr/0054-global-autopilot.md).
