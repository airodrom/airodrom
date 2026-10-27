# Gmail Live-Send Safety Closeout V1

## Incident (PR #249 live acceptance)

During post-install verification of Terminal `/gmail confirm` session binding on tip `e345452`, an acceptance script intended a **cross-conversation deny**. It called `/api/assistant/conversation/session` twice. That API is **sticky** per Terminal channel unless `{ new: true }`, so both calls returned the staging conversation. The subsequent `/gmail confirm <preview-id>` was therefore a **same-session authenticated confirm** and dispatched once through live Gmail.

### Classification

**Validly authenticated but unintended test dispatch.**

| Check | Result |
| --- | --- |
| Owner mailbox / myself recipient | Yes (authorized account → self) |
| Exact staged preview | Yes (`e9bea74b…`) |
| Explicit `/gmail confirm` | Yes (slash intent sets `confirmed: true`) |
| Valid conversation + operator + send OAuth | Yes |
| Intended as synthetic negative | Yes (tester error: sticky session) |
| Provider dispatches | Exactly one (`message_id` `1a17ba7d89591498…`) |
| Uncertain retry / duplicate | None |
| `write_qualified=true` | Justified by existing policy (provider-confirmed receipt, non-synthetic) |

Successful provider execution is not the same as intended consent for a test probe. The host gates behaved as designed; the acceptance procedure did not.

## Controls added

1. `src/external-write-context.js` — fail-closed synthetic vs live mode.
2. `GmailWriteConnector` / `CalendarConnector` — synthetic requires injected transport; live refused under `NODE_ENV=test`.
3. `gmail-write-service` / `calendar-service` — refuse auto-wiring live connectors in test processes.
4. Synthetic send receipts marked `synthetic` / `fixture` and never qualify.
5. `scripts/gmail-acceptance-no-send-probe.cjs` — canonical no-send live probe.
6. Regression suite `tests/gmail-live-send-guardrails-v1.test.js` including sticky-session mechanism.

## Owner-only follow-ups

- Optional: review the single self-addressed “Test” message in Sent/Inbox.
- Do not re-send for qualification; durable evidence already qualifies.
- Future live sends: interactive Terminal only, after reviewing the preview ID.

## Rollback

Revert the guardrails PR tip; prior install `airodrom-install-e345452` remains a rollback target for the confirm-session fix alone. Qualification rows and completed receipts are preserved in `~/.airodrom/data/memory.sqlite` and must not be hand-edited.
