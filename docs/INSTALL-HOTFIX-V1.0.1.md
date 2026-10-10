# Installation Hotfix V1.0.1

Closes the activation gaps found when installing Integrated Release V1 (`77724f8`) without changing product architecture.

## Defects corrected

1. **Gmail optional `clientSecretReference`** — ControlServer now accepts the supported two- or three-field Gmail OAuth config shape and preserves `clientSecretReference` on reference rotation. Unknown keys still fail closed.
2. **Package completeness** — `src/wait-presentation.js` and `config/wait-presentation-v1.json` are on `release-files.json` and `package.json` `files`. Product-observability’s packaged require graph resolves inside the allowlist.
3. **Compatibility floor** — installation compatibility `min_package` is `1.0.1-rc.1`. Installed `1.0.0-rc.1` reports `compatible_outdated` until upgraded.

## Package identity

| Field | Value |
| --- | --- |
| Package version | `1.0.1-rc.1` |
| Branch | `fix/v1.0.1-install-hotfix` |
| Base | `origin/main` @ `710971798c0a27d47d3e3e4fdb32a4a3553e1c0a` |
| Candidate artifacts | `/Users/andrew/Documents/Codex/2026-10-09/airodrom-v101-install-hotfix/release-candidate-v101/` |
| Authoritative digest | `SHA256SUMS` / `SOURCE-MANIFEST.json` in that directory (not embedded in allowlisted docs) |

## Reproducible qualification (this pass)

- Dual byte-identical source archives; `package:check` forbidden=[]  
- Extract + `npm ci --ignore-scripts` into a disposable directory with **no** manual overlays  
- Isolated start under `AIRODROM_HOME=/Users/andrew/.a101` → healthy Control, OpenCode 2.0.25, Memory Ready, overview Ready  
- Disposable service stopped afterward  

## Running installation (do not disturb)

| Field | Current |
| --- | --- |
| Install root | `…/airodrom-daily-integration-v1/install/airodrom-77724f8` |
| Release source | `77724f8` + local activation hotfixes |
| Health | Healthy (OpenCode 2.0.25, Memory Ready) |
| States | MERGED Yes · INSTALLED Yes · LIVE VERIFIED Yes · Upgraded to installed `1.0.1-rc.1` |

V1.0.1 must not restart or replace that service until an authorized maintenance checkpoint.

## Reversible upgrade plan (next checkpoint)

1. Backup `~/.airodrom` pins, `local.json`, and SQLite via `sqlite3.backup` (same pattern as V1 activation).  
2. Graceful drain/stop of the owned service.  
3. Extract the V1.0.1 archive into a new install root (do not overlay onto the dirty operator checkout).  
4. `npm ci --ignore-scripts` in that root; `npm unlink -g airodrom` then `npm run install:local` from the new root.  
5. Point `local.json` `source` at the new root; keep `dataDir` / `pinsFile` / `profile`.  
6. `airodrom start`; verify `/status`, `/compat`, Gmail connector, Memory/Mission counts.  
7. Rollback: stop; restore previous `local.json` source + npm link to `install/airodrom-77724f8`; start.

Preserve Memory V2, Keychain/Vault, runtime pins, Mission/approval history, and the protected operator Git checkout throughout.
