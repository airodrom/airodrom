# Installation and bootstrap

The supported candidate distribution is a source archive with a SHA-256 checksum and exact file manifest. Start in an empty private directory on macOS arm64, using Node 22.23.3 with SQLite/FTS5 and npm 10.9.9. No prebuilt application, native helper or vendor agent binary is bundled. Other operating systems require qualification.

Verify the archive against the separately reviewed checksums. Inspect its file list before extraction. The OS boundary regressions also require Xcode with its macOS SDK and a source-built local helper. Run `npm ci --ignore-scripts`, `node scripts/macos/build-slack-keychain-helper.cjs`, `npm run verify`, `npm test`, both type checks and `node scripts/airodrom.cjs --help`. Initialize an isolated validation checkout with a first commit when testing a source archive; see [development](DEVELOPMENT.md). These checks do not start the application, read Keychain credentials or install a service. Dependencies are locked; lifecycle install scripts are disabled. No general transpilation build is required for the foreground JavaScript CLI.

## Operator setup

OpenCode 2.0.25 and the local Ollama `qwen3-coder:30b` model are the default bounded execution surface. Availability is checked before dispatch; unavailable execution waits for review. See [default runtime boundary](DEFAULT-RUNTIME-CUTOVER.md).

For the interactive local candidate, run `npm run install:local`, then `airodrom`
from any Terminal directory. The CLI bootstraps private persistent user state,
qualifies actual installed OpenCode artifacts and opens terminal tasks; Control
Center is optional. See [Interactive CLI V1](INTERACTIVE-CLI-V1.md). This does not
install login agents, alter another private instance or publish a package.

An optional private control profile may supply non-secret Ollama provider/model settings. Pi executables, profiles, model catalogs and extensions are neither discovered nor installed. Authenticate optional external agents through their supported private mechanisms. Keep auth files mode 0600 under private directories, outside Git and release artifacts. Do not put keys in shell arguments or share raw runtime discovery.

Optional sandboxed host capabilities require an operator-owned `config/safe-autonomy-manifest.json` containing exact executable, runtime library, declared input and job pins for the installed host. The distributed `.example.json` is deliberately unconfigured and grants nothing. It is not safe to copy another host's pins or replace mismatches with wildcard paths. Have a competent operator build and review the exact inventory before attempting runtime qualification. Registered verifier tools start with an empty configuration.

After setup and review, `npm start` starts foreground operation. Review source-profile configuration through the canonical `AIRODROM_SOURCE_PROFILE` option; give the path through private environment configuration, never credentials in arguments. Service installation, restart, external runtime execution and production activation are separate operator actions. No install/start/restart is performed by this candidate preparation.

## Upgrade and recovery

Back up independent current erasure/identity authority separately from old snapshots. Keep migration work in quarantine; verify generations and scope before exposing any recovered service. Raw database substitution and downgrades that lose current dispositions are unsupported. See [privacy and erasure](PRIVACY-ERASURE.md). Keep the preceding private repository and evidence separately; do not publish its history with this archive.

Pi identities in durable old records are readable historical provenance only. Removed-runtime tasks cannot resume, dispatch, invoke capabilities or receive context. Start a fresh bounded Mission; see [migration semantics](PI-REMOVAL.md). No user data or credential values are migrated.
