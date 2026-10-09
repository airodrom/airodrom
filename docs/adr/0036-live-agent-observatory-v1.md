# ADR 0036 — Live Agent Observatory V1

Status: Accepted for activation prep; production cutover remains owner-authorized. Compatible with ADRs 0005, 0009 and 0021.

## Decision

Control Center gains one Mission-scoped Live Observatory that projects host-observed execution onto the canonical event ledger. SSE (`/api/product/live-stream`) and polling (`/api/product/live-events`, `/api/product/observatory`) share the same redacted projection. OpenCode mid-run NDJSON tool names are recorded without arguments or reasoning. Host-measured file changes, governed command exit codes and registered test outcomes are displayed when present. Bounded authorized Git diffs require Mission `allowed_files` membership.

## Consequences

Operators can watch Missions with Cursor-comparable visibility without inventing a second Mission system. Monitoring never bypasses capability permissions. Hidden reasoning, credentials, environment dumps and out-of-scope file contents remain excluded. Claude Code and Cursor appear only through already-verified adapter events.

## Observation boundary

File path events are host-measured after the OpenCode turn. Continuous filesystem monitoring is explicitly out of scope for V1. Mid-run NDJSON contributes tool names only. Progress percentages and hidden reasoning are never invented.
