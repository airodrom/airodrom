# Contributing to Airodrom

Read the [architecture](docs/ARCHITECTURE.md), [governance](GOVERNANCE.md), [Kernel contract](docs/governance/KERNEL-CONTRACT.md), [SDK contract](docs/governance/SDK-CONTRACT.md) and [Mission authority guide](docs/governance/MISSION-AUTHORITY-GUIDE.md). App contributors also read the [App development guide](docs/governance/APP-DEVELOPMENT-GUIDE.md).

## Development and evidence

Use an empty private checkout, the supported Node/npm versions and `npm ci --ignore-scripts`. Run affected tests, `npm test`, both type checks and `npm run verify`. Release/security changes also run the secret, dependency, license and package gates described in the [candidate checklist](docs/RELEASE-CANDIDATE-CHECKLIST.md). Keep host qualification distinct from portable fixtures; record skips and runtime prerequisites.

Every Kernel change references an [ADR](docs/adr/README.md). Compatible repairs may cite an accepted decision; authority, lifecycle or public-contract changes need a new or superseding record. Proposed decisions require maintainer review. Preserve the distinction between agents and reasoning providers, private default storage, one-shot approvals, session ownership, bounded context and independent Acceptance.

Describe the concrete trigger and resulting behavior, affected contracts, compatibility, validation and remaining limits. Security, erasure, runtime, migration and authority changes require independent review. Changes to trust boundaries need two reviewers when roles overlap. Maintainer review never authorizes deployment or publication by itself.

## Safe contributions

Use synthetic data and `.invalid` contacts. Do not commit runtime state, personal payloads, provider account metadata, credentials, local operator pins, raw discovery, session exports or internal incident evidence. Inspect staged changes and package contents. Never place real secrets in arguments or fixtures. Report vulnerabilities using [SECURITY.md](SECURITY.md).

Do not edit installed vendor packages, broaden loopback listeners, weaken denial gates, auto-promote model content or describe fixture evidence as live provider qualification. Avoid unrelated dependency upgrades. New dependencies require locked integrity, vulnerability and license review. Do not add editor or AI attribution to commits, PRs, documents, changelog entries or trailers.

See the [development guide](docs/DEVELOPMENT.md), [review checklist](.github/pull_request_template.md) and [code of conduct](CODE_OF_CONDUCT.md).
