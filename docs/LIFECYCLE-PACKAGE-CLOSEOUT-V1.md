# Lifecycle & Package Closeout V1 (2026-10-10)

Closes two Everyday Reliability findings against installed `1.0.1-rc.1` without restarting the healthy service.

## Root causes

1. **Durable `stopping` residue**  
   A prior lifecycle-capable owner called `prepareStop()` and wrote `cp_service_lifecycle.state=stopping`. The shipped `1.0.1-rc.1` package did not include `src/service-lifecycle.js`, so the replacement process never constructed `ServiceLifecycle` and never replaced that row with a fresh `booting` epoch. The running service stayed healthy in legacy admission mode while the durable row remained `stopping`.

2. **Package omission**  
   `service-lifecycle.js` (and its `run-settlement` blocker SQL helper) existed only in unmerged local trees. Canonical `release-files.json` / `package.json` `files` on `origin/main` omitted them, so clean package extracts could not load the admission gate.

## Fixes (source only; live service undisturbed)

- Ship `src/service-lifecycle.js` and `src/run-settlement.js` on the canonical tree.
- Wire bridge / control-server / control-plane-store / local-service / local-bootstrap admission paths.
- New writer ownership always persists `booting` + fresh epoch, recording `prior_state` / `prior_epoch` for evidence. Orphaned `stopping` cannot survive ownership transfer.
- Planned stop still requires idle blockers; resume remains current-epoch and evidence-gated. Owned `airodrom start` may resume when healthy and idle.
- Allowlist both modules in `release-files.json` and `package.json` `files`.

## Evidence

- Focused tests: `tests/lifecycle-package-closeout.test.js` + trimmed `tests/service-lifecycle-v1.test.js` → **16/16**
- `package:check` clean; disposable source archive contains both modules and resolves imports
- Typechecks: authority + SDK green
- Live installed service: left Healthy on `1.0.1-rc.1` (not restarted). Durable row may remain `stopping` until the next authorized restart under this closeout build.

## Limitations

- Live DB row is not rewritten without process ownership transfer (no concealed SQL overwrite).
- WhatsApp production HOLD unchanged.
- Operator checkout preserved.

Not under Pi Bridge.
