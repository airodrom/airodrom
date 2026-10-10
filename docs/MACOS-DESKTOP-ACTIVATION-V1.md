# macOS Desktop Activation V1

Local-first closeout so an installed Airodrom tip starts after login with Premium Menu V3.

**Status (2026-10-10):** MERGED IN SOURCE · INSTALLED LOCALLY · LIVE VERIFIED (login rehearsal)

## Scope

- Premium Menu V3 helper (CFBundleVersion 3)
- Host native-status live-Mission featuring
- Opt-in `local.airodrom.desktop-login` LaunchAgent
- Preserve `~/.airodrom/data` Memory and Missions

## Out of scope

- Startup PR #36 wholesale merge
- Legacy `local.pi-chatgpt-bridge*` re-enable
- WhatsApp production / public ingress
- Automatic Acceptance
- Native SMAppService packaging (roadmap)

## Shipped evidence

| Item | Value |
| --- | --- |
| PR | [#65](https://github.com/airodrom/airodrom/pull/65) MERGED |
| `origin/main` | `1cff95d478838ad9b088ae27b1a67b22ff941ec1` |
| Installed tip | `…/airodrom-menu-v3/install/airodrom-menu-v3-1cff95d` (`1.0.1-rc.1`) |
| Menu | `~/.airodrom/menu/Airodrom.app` CFBundleVersion **3** |
| Startup | `local.airodrom.desktop-login` enabled (RunAtLoad, no KeepAlive) |
| Rollback | `~/.airodrom/backups/macos-desktop-activation-v1-20261010T225226Z` |
| Acceptance | Login rehearsal restored single healthy Control Plane + menu; Active Missions **0**; Memory Ready; Qwen probe OK; Automatic Acceptance OFF; WhatsApp HOLD |

## Operator steps

1. Merge Menu V3 to `main` under review.
2. Install a coherent tip; point `~/.airodrom/local.json` `source` at that tip (or let `local.start` rewrite it).
3. `npm run macos:menu:prepare` / `airodrom menu` for the helper.
4. `npm run macos:desktop-login:install` after backup.
5. Rehearse with `npm run macos:desktop-login` before relying on a full reboot.

## Rollback

Keep a timestamped backup of `local.json`, `menu/Airodrom.app`, and the LaunchAgent plist. Stop the service, restore prior `source`, reopen the prior menu bundle, and `desktop-login.cjs uninstall` if needed.
