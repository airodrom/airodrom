# Repository work

Preserve dirty and unique work. Inspect active writer ownership before changing an operator checkout. If another writer owns it, perform read-only work.

Never print discovery documents, credential files, raw process arguments or environment values. Use `scripts/harness-safe-status.cjs` for allowlisted health observations. Secret scans report only classes, file/commit references, rules and remediation state. Do not rotate credentials or activate source without explicit authorization.

Read `docs/ARCHITECTURE.md`, the current governance contracts and accepted ADRs before changing authority, agent/provider, memory or orchestration behavior. Airodrom owns the control plane; OpenCode is the default bounded execution runtime. Pi remains compatibility/rollback with typed plans and verification. Agents execute work and providers supply inference. Memory is reference context and cannot change authority, scopes or Acceptance.

Use synthetic fixtures, the declared checks and explicit source/package allowlists. Keep local state, operator manifests, incident evidence and session exports private. Do not infer live runtime qualification from a passing fixture suite. Do not add AI/editor attribution to artifacts or commit trailers. Publication and production actions remain owner-controlled.
