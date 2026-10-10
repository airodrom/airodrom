# macOS Desktop Activation V1

Local-first closeout so an installed Airodrom tip starts after login with Premium Menu V3.

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

## Operator steps

1. Merge Menu V3 to `main` under review.
2. Install a coherent tip; point `~/.airodrom/local.json` `source` at that tip (or let `local.start` rewrite it).
3. `npm run macos:menu:prepare` / `airodrom menu` for the helper.
4. `npm run macos:desktop-login:install` after backup.
5. Rehearse with `npm run macos:desktop-login` before relying on a full reboot.

## Rollback

Keep a timestamped backup of `local.json`, `menu/Airodrom.app`, and the LaunchAgent plist. Stop the service, restore prior `source`, reopen the prior menu bundle, and `desktop-login.cjs uninstall` if needed.
