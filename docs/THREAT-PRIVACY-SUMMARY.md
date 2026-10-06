# Threat and privacy summary

Assets include local workspaces, personal memory, credentials, approvals, writer leases, results, execution evidence and independent restore authority. Principals include operator, Kernel, App, worker, model, provider and host. Model/context/result inputs are untrusted; host admission and policy remain authoritative.

| Threat | Control and regression boundary | Residual limit |
| --- | --- | --- |
| Prompt injection or unauthorized memory promotion | Scoped bounded references; host review; immutable authority; memory/authority suites | Authorized providers still receive admitted content |
| Forged or stale completion | Attempt correlation, untrusted inbox, independent verification, Acceptance/Settlement guards | Vendor assertions alone never qualify execution |
| Cross-workspace write or abandoned writer | Immutable scopes and durable held/quarantined leases | Timeout/cancel does not prove termination |
| Credential persistence or argv exposure | Admission rejection, private discovery, sanitized observations and seeded diagnostic tests | Arbitrary operator shell output remains outside sanitizers |
| Erasure reconstruction from identifiers | Random UUID migration; no retained legacy aliases; provenance/context/result erasure suites | Unknown origins deny availability |
| Backup/replay resurrection | Independent current generations, quarantined migration, freshness checks | Physical old bytes and unmanaged exports persist outside logical guarantee |
| App/supply-chain compromise | Locked integrity, no install scripts, notices, pinned CI actions, source allowlist | Pattern scanning and advisory databases are incomplete |
| Public evidence or package leakage | History-free allowlist, boundary checks, package manifest and archive inspection | Owner must publish only this reviewed candidate |
| Optional external runtime claims | Work optional/live-unqualified, Cursor experimental/denied, Cloud unsupported | No live provider proof is asserted |

Release review maps these controls to fresh focused/full validation. Type checks have bounded declared scope. The public candidate excludes operator manifests, account/session evidence and private incident records. Independent maintainer review remains an owner responsibility before publication. GitHub Private Vulnerability Reporting is the sole confidential vulnerability channel and must be enabled/verified immediately upon public visibility switch. Reporters wait if unavailable and keep sensitive details private; see [SECURITY.md](../SECURITY.md).
