# Release and versioning policy

The first public candidate is **1.0.0-rc.1**, derived from the existing private package 1.0.0. No public tags exist. This prerelease communicates candidate status without claiming a previously published stable release. Package name stays `airodrom`; `private: true` remains. SDK contract 1.0.0 and Kernel contract 1.2.0 are independent source contract versions.

The supported distribution is a reviewed source archive with SHA-256 checksums, exact file manifest, dependency/license inventory and SBOM. npm tarball inspection is a dry-run packaging check, not an authorized registry distribution. There is no transpilation build or bundled vendor/native executable. No source maps are generated.

Every candidate reruns locked installation, focused/full tests, both type checks, syntax/docs/hash/boundary checks, recognized secret/history scans, dependency audit, license/notices and archive/package inspection. Reproducibility compares independently generated archive bytes from the same allowlist, version and normalized metadata. Signing requires separately authorized maintainer infrastructure; checksums provide integrity comparison, not identity authentication.

A documentation-only closeout of the same already-qualified candidate preserves prior test/type/dependency/license evidence when runtime, tests, configuration, dependencies and release tooling remain byte-identical. Rerun documentation/reference/source-hash and public-boundary checks, secret scans, package inspection and archive/integrity sealing. Record changed documents and the exact allowlist update. Any executable, dependency, runtime or substantive distribution change requires full candidate validation.

The owner reviews exact hashes, limitations, the documented GitHub Private Vulnerability Reporting policy, reviewer accounts and branch protections before publishing. GitHub Private Vulnerability Reporting must be enabled/verified immediately upon public visibility switch; this is a publication-time owner check, not a pre-publication hardening blocker. Only the history-free reviewed candidate may enter the future public repository. Existing private refs/history, dirty work, evidence and operator state remain private. No push, merge, release/tag, public switch or production activation follows automatically.

Security/privacy and breaking authority changes require independent review and migration guidance. Downgrades that lose dispositions are prohibited. Rerun advisories and scans if dependencies, files, runtime or publication timing changes materially.
