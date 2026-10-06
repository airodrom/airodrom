# Local development

Install the locked dependencies with `npm ci --ignore-scripts`. Use Node 22.23.3, npm 10.9.9 and macOS for the current tested platform. `npm test` runs source fixtures in disposable stores and loopback servers. `npm run test:hardening` runs focused security/privacy/runtime regression suites. Run `npm run typecheck:authority`, `npm run typecheck:sdk` and `npm run verify` before review.

The authority type check covers the declared hash/JSON/declaration contract. The SDK check covers public declarations. Neither is whole-project JavaScript typing. `verify` checks JavaScript syntax, JSON, local document links, canonical-source hashes, package policy and public-boundary rules. There is no general lint or transpilation build target.

Installed Pi transport simulations and host-pin qualification are conditional on a private reviewed operator manifest. The portable suite retains negative boundary tests; a skipped installed-runtime test does not qualify that runtime. Live test targets and `macos:validate` can perform service/provider actions and must be explicitly authorized separately.

Use `.invalid` identities and seeded data. Never read raw discovery into diagnostics. Preserve unrelated files, independent dispositions and unique history. Document fixture/live boundaries and skipped prerequisites with results.

## Source archive validation checkout

The diagnostic regression exercises Git against its source checkout. A clone already has a first commit. When validating an archive, initialize a disposable local checkout and an empty fixture commit before tests:

```sh
git init
git -c user.name=Fixture -c user.email=fixture@example.invalid -c core.hooksPath=/dev/null commit --allow-empty -m "Disposable validation baseline"
node scripts/macos/build-slack-keychain-helper.cjs
```

The fixture commit has no source tree and is excluded from distribution. It is not a release commit or public author identity. Use a separate clean owner-controlled checkout for actual publication. Xcode/macOS SDK is required to build the local helper; the helper-denial tests invoke only an invalid-account probe and do not authorize or read credentials.
