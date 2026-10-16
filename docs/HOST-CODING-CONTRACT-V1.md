# Host coding contract coverage

Status: source candidate. Not merged and not installed.

## Existing closeout review

This packet is read-only. It does not change Mission `8eb8e32d-5523-4938-8480-21364d81a0e2` or verification `fac4f504-d3b9-451f-85a4-47322d9edd05`.

| Item | Observed |
| --- | --- |
| State | `awaiting_acceptance` |
| Verification result | `operator_review` |
| Acceptance | 0 |
| Host run | `3a8d006a-dcd7-43a9-b9f3-1fa808d7bf25` |
| Workspace | disposable closeout checkout, not this source tree |
| `src/events.ts` | `d5fa1bf31e3cbdab2eea692a6d35c5a084c32d58c70c61aa0b0dafbd412d9ed4` |
| `tests/events.test.ts` | `af53beab3a7d62cf11d2b79ecc9fee1129fd5436f5008fbdde91dbf7c2a963f1` |
| Contract | absent |

The working-tree diff against the closeout baseline removes one trailing space on each of lines 40, 41, 42, and 47. The `as OperationalEvent` token remains. Registered `task:diff-check` and `task:static-typecheck` exited 0. The exact-file criterion passed.

Supplementary scan, separate from `fac4f504`: installed `securityScan()` from SHA `ac9ee3eceba5f45a4f3add78a5941e10445c346f`, patterns in `src/verifier-baseline.js` (`private_key_block`, `aws_access_key`, `github_token`, `slack_token`, `openai_key`, `anthropic_key`, `google_api_key`, `jwt`, `generic_assignment`, `url_credentials`) and the sensitive-area expression. Scope was `src/events.ts` only. No model and no network. No secret-like values were printed. Outcome: secret scan passed with zero findings; sensitive-area passed. The scanner is not exhaustive, and this Mission has no trusted contract baseline, so the scan cannot distinguish a historical finding from a new one beyond the file bytes that were read. Owner Acceptance is still pending.

## New Missions

`MissionService.create` derives the contract for every new `coding_plan`. Coverage recorded on verification is contract integrity, verifier-input integrity, protected-test integrity, secret scan, and sensitive-area review. A failed or unreadable prerequisite stays `failed` or `unavailable`. It is not rewritten as `passed`, and it does not become automatic Acceptance.

Legacy contractless coding envelopes are left stored as they are. A later dispatch or verification reports `host_coding_contract_required` instead of implying full coverage.
