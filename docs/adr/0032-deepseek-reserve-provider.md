# ADR 0032 — DeepSeek reserve provider

Status: Proposed. Isolated implementation and synthetic tests only. Enabling the
reserve and storing an API key on an operator Mac are separate owner actions.

Numbering note: ADRs 0020–0031 exist as unmerged proposals elsewhere; this record
uses 0032 so the sequences cannot collide.

## Decision

DeepSeek (`deepseek-flash`, optional `deepseek-v4-pro`) becomes a **reserve**
reasoning provider. It is OFF by default and is never chosen by routing or fallback.

- The DeepSeek profile carries `reserve: true`. The provider router rejects reserve
  providers unconditionally (`reserve_explicit_approval_only`), whatever their
  configuration, credential or health. The authority router already refuses DeepSeek.
- The only path to DeepSeek is `src/deepseek-reserve.js`: an operator proposes a
  request, approves it in the Control Center, and dispatches it.
- An approval is single-use. It is bound by SHA-256 to the task, model, thinking
  mode, reason, data class, scope, exact messages and output limit. It expires after
  10 minutes. Any material change invalidates it, and turning the reserve off
  withdraws every unused approval. MCP clients, including ChatGPT, cannot reach these
  operator-only endpoints.
- Data: `public` and `internal` may be proposed. `private`, `financial` and
  `sensitive` require explicit authorization of the stated scope at approval.
  Credentials, secret-like text, Personal Memory and referenced material (memory,
  attachments, project context) are always refused. Only the supplied text is sent.
- Budget: $10 per Vancouver calendar month by default, configurable. Admission,
  single-use consumption and a reservation of the maximum possible cost commit in one
  SQLite transaction, so concurrent requests cannot overspend. The maximum prices every
  input token at cache-miss, the full output limit, and the highest rate the request
  could meet before its approval and timeout end.
- Settlement uses provider usage: cache-hit input, cache-miss input and output, at
  the higher of the rates at start and finish. A provider refusal (401, 402, 429, 4xx)
  bills nothing. Timeouts, network errors, 5xx, mid-flight cancellation, missing usage
  or a restart hold the full reservation as `unreconciled`.
- One attempt per approval: no retry, no other model, no other provider.
- Pricing follows DeepSeek's official schedule: peak is 01:00–04:00 and
  06:00–10:00 UTC, Monday–Friday, excluding Chinese public holidays; off-peak is half.
  Amounts are integer nano-USD. Holidays use the State Council calendar (2026
  verified). An unverified year, a Chinese make-up workday that falls on a weekend, or
  pricing older than 45 days is billed conservatively at peak and flagged.
- Display uses the IANA `America/Vancouver` zone: no fixed offsets, so PDT, PST and
  transitions are handled.
- The API key lives in the macOS Keychain behind a `keychain:service/account`
  reference. It is read only into this process and never printed, logged, stored or
  sent anywhere except DeepSeek's `Authorization` header. Connection verification is an
  authenticated `GET /models`, which carries no content.

DeepSeek output is unverified and never accepted automatically. Airodrom keeps
Mission authority, permissions, Memory, verification, Acceptance, audit and Settlement.

## Consequences

The budget is a local reservation ledger, not a provider-side spending ceiling.
`unreconciled` charges stay counted until the month ends, because V1 has no
reconciliation command.

## Rollback

Turn the reserve off in the Control Center, which withdraws approvals. Source
rollback removes the reserve module, routes and panel. The ledger tables can stay as
inert history.
