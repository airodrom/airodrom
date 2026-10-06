# Dependency and license audit

Audit date: October 5, 2026. All direct dependencies remain exactly pinned and lockfile integrity is present for every locked package. `npm ci --ignore-scripts` succeeds. Fresh npm advisory audit reports **zero vulnerabilities** across all severity levels. No broad upgrade was performed.

The lockfile contains 38 runtime/development/platform entries. Observed licenses are MIT and Apache-2.0. There are no lifecycle install-script flags. TypeScript platform-native binaries are optional development tooling; no dependency or native/vendor binary is bundled in the source archive. Registry tarballs are resolved through npmjs with integrity. The only newer direct version observed is the next patch of the Node development type declarations; the audited pinned version is retained because it has no advisory finding and upgrades need compatibility evidence.

The source retains its existing MIT license and copyright. Complete installed upstream license/notice texts are preserved in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md); the dependency SBOM and exact lockfile accompany the candidate. Optional uninstalled TypeScript variants declare Apache-2.0 and are not redistributed. Any future binary/vendored distribution requires target-specific notice and license review.

Bundled assets are repository UI, macOS source, examples and synthetic fixture code. No vendored proprietary agent executable, font, artwork or dependency tree is present. Existing code provenance and ownership remain an owner review; this inventory is not a legal-certainty or universal absence-of-copying claim. No unknown license or required missing installed notice was observed. Advisory coverage and package maintenance health are bounded evidence, not a guarantee against unknown supply-chain compromise.

Checks are automated with audit/license gates. Re-audit after any dependency, target-platform or distribution change, and at publication time if delayed.
