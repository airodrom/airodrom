# Self-Development Reliability V1.1

## Status

SHIPPED + INSTALLED LOCALLY — 2026-10-10

Focused reliability fixes on `feat/dev-sessions-summary-v1` so authorized repository source is usable by OpenCode, Development Sessions summary remains wired, and coding Missions use the existing 120s hard timeout ceiling.

### Integration

| Item | Value |
| --- | --- |
| Feature tip | `af5fce8021b52038c7ee18c99c6f02d4069fdd1b` |
| PRs | #49, #50 |
| `origin/main` | `61d0b0d8fbabfed70532751f7ca713d3d082c17d` |
| Install | `…/airodrom-self-dev-v1/install/airodrom-self-dev-af5fce8` |
| Backup | `~/.airodrom/backups/self-dev-v11-20261010T174215Z` |

## Source-context root cause

OpenCode refused `public/control-hub.js` for three host-classifier reasons (not worker self-classification):

1. **Prose false positives** — `sourceContextSensitive` treated bare UI words `credentials` / `secrets` as credential filenames.
2. **Authorization header construction** — `containsSecret` flags `Authorization:'Bearer '+token` because its assignment rule matches any `authorization:` binding; Memory protection correctly keeps that rule. Coding admission now applies a host-owned `codingSecretScanView` that neutralizes Authorization headers bound to a JS identifier before calling `containsSecret`. Literal Bearer tokens and other embedded secrets still fail closed.
3. **File size bound** — hub script is ~119 KiB; staged coding files were capped at 12 KiB (`opencode_file_boundary`). Bound raised to 256 KiB hard maximum.

Workers still cannot self-classify. Private Memory, absolute sensitive paths, `.env` / `auth.json` / `credentials.json` / `/secrets/` paths, PEM/key/sqlite names, and env token bindings remain denied.

## Timeout root cause

Mission `d55695c4-ac6b-4d83-85bf-89b9fd324eaf` failed with `opencode_timeout` after ~90438 ms. Evidence: `evidence/mission-final-v3.json`, `evidence/observatory-v3.json` (elapsed_s 90). Cause: **runtime supervision** — `scripts/local-service.cjs` and OpenCode `dispatch` defaulted to 90000 ms while the adapter hard ceiling is already 120000 ms. Not verification, not Mission polling. Default coding timeout is now 120000 ms; unlimited timeouts remain forbidden.

## Development Sessions UI

Preserved OpenCode panel `public/development-sessions-panel.js`. Control Center wires via `control-hub.html` script tag and `AirodromDevelopmentSessions.render`. APIs remain on `/api/assistant/development-sessions*`; product observability exposes `development_sessions`; Live Observatory continues host OpenCode observation.

## Focused validation

- `tests/opencode-source-context.test.js` — admit hub + Authorization variable headers; reject real secrets/paths; bounded timeout + oversized file fail-closed
- `tests/development-session-summary-v1.test.js` — panel labels, hub/CSS wire, API/Observatory host ownership
- `tests/opencode-runtime.test.js` — timeout/cancel; Mission settlement (fixture opens lifecycle admission after initialize)
- Typechecks: `typecheck:authority`, `typecheck:sdk`

## Preserved Mission evidence

| Mission | Outcome |
| --- | --- |
| `07617aaa-…` | `opencode_sensitive_context` (hub) — preserved |
| `eea8d18d-…` | Panel draft completed; verification unavailable → needs_rework — preserved |
| `d55695c4-…` | `opencode_timeout` ~90s — preserved |
| `0ca9a75d-…` | Host settlement accept/settled — preserved |

## Limits

- Automatic Acceptance OFF; no push/PR/hosted CI in this Mission.
- Operator checkout `/Users/andrew/code/airodrom` untouched.
- Live install cutover still separate (panel not live until package cutover).
- No AI/editor attribution.
