# Control Center UI Recovery V1

## Root cause

The premium Control Center (Somin-adapted atmosphere canvas, theme switcher, expanded navigation, light/dark tokens) was implemented in local Development Sessions around 2026-10-08 and retained as private preimage assets, but the mount surface was never merged to `main`.

Evidence:

- Strongest recovered source: `Documents/Codex/2026-10-08/referenced-chatgpt-conversation-this-is-an-18/work/preimage/public/` (`control-hub.html` 4601 B with `#atmosphere` + `#weather-switcher` + theme select; `atmosphere.js` 25407 B; richer CSS).
- `origin/main` (`bf7baf1`) and installed npm package served `control-hub.html` **without** those mount nodes (3125 B), while `public/atmosphere.js` existed only as untracked/local install debris and was not bundled into `control-hub.js`.
- Product Experience V2 already documented WeatherAtmosphere adaptation; runtime entry `/` → `control-hub.html` never received the HTML/CSS/JS wiring after later Observatory and Menu V2 merges.

Regression class: **unmerged premium UI mount + missing atmosphere bundle**, not a deleted design system. Observatory and Menu V2 on `main` remained present and are preserved.

## Recovery

Branch `feat/control-center-ui-recovery-v1` (isolated worktree):

- Restored preimage HTML (canvas, SKY switcher, appearance select).
- Restored `public/atmosphere.js`, `scripts/build-atmosphere.cjs`, and compatibility bundle into `control-hub.js`.
- Merged preimage navigation/views (AI & Workers, Google Connections, WORK Templates, etc.) with `origin/main` Live Observatory + connectivity helpers.
- Appended atmosphere/theme/light CSS onto main Observatory styles.
- Served optional `/atmosphere.js` asset; runtime uses the hub bundle (HTML does not load a second script tag).

## Preserved newer functionality

- Live Agent Observatory V1 (`obs-grid`, mission detail, SSE helpers)
- Control Center connectivity states (Connected / Reconnecting / Degraded / …)
- Menu Bar V2 remains on `main` (native Swift; unchanged here)
- Expanded assistant/Google/WORK template views from the 2026-10-08 preimage
- WhatsApp inbound UI remains on PR #44 / separate branch (not removed; not part of this mount recovery)

## Verification

Focused tests (isolated worktree):

- `tests/atmosphere.test.js`
- `tests/control-center-ui.test.js`
- `tests/connection-status.test.js`
- `tests/live-observatory-v1.test.js`

Result: **20/20 passed**.

Browser: static serve of recovered `public/` at `http://127.0.0.1:8766/control-hub.html` (no secrets). Headless Chrome screenshot evidence stored outside the git tree under the Mission evidence folder. Observed: brand shell, expanded nav, theme select, SKY atmosphere switcher with animated scene, reconnecting chip when no local service API is attached. Static fixture is not live Activation proof.

## Status

**In source on feature branch** — not pushed, not merged, not SHIPPED IN SOURCE on main, not ACTIVE/DEPLOYED into the running operator service.

## Next action

1. Owner review of recovered UI on an authorized private Control Center link after install from this branch.
2. Daily-integration merge only under standing-merge rules (currently inactive).
3. After merge: verify main SHA; mark SHIPPED IN SOURCE; keep ACTIVE until installed runtime evidence.

## Limitations

- Static browser check cannot exercise authenticated Mission/Observatory live streams.
- Installed operator service still serves the pre-recovery assets until an authorized install/cutover.
- Atmospheric scenes are visual presets only — not live weather.
