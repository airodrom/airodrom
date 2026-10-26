# Google Workspace Stage A V1 — Calendar manage + Gmail write

Host-authoritative personal-assistant connectors. OpenCode never receives unrestricted Gmail, Calendar, or Drive access. Untrusted email and document bodies never gain instruction authority.

## Consent modes (incremental; no all-Google super-token)

| Service | Command | Scopes | Notes |
| --- | --- | --- | --- |
| Gmail read | `/connect gmail` | `gmail.readonly` | Default; preserved |
| Gmail send | `/connect gmail send` | `gmail.readonly` + `gmail.send` | Outbound send/draft only |
| Gmail manage | `/connect gmail manage` | `gmail.modify` + `gmail.send` | Mailbox mutate + send |
| Calendar read | `/connect calendar` | `calendar.readonly` | Default; preserved |
| Calendar manage | `/connect calendar manage` | `calendar.events` | Create/update/cancel |

Never requests `https://mail.google.com/` by default. Drive/Docs/Sheets/Contacts/Tasks are **not** Stage A.

## Gmail write gates

1. Exact recipients, subject, body, and authorized account identity in the preview.
2. `/gmail confirm <preview-id>` for ordinary sends and mailbox mutations.
3. Independent `/gmail approve <approval-id>` then confirm for trash, sensitive forward, and bulk recipients (>5).
4. Destructive trash also requires `--destructive` after approval.
5. Durable SQLite-backed `operation_id` / preview rows (shared control-plane DB when available): atomic claim (`pending|uncertain` → `sending`) so concurrent confirms cannot double-dispatch; uncertain provider outcomes require `/gmail confirm <id> --ack-uncertain` after operator verification (never blind retry); completed receipts survive restart and replay host-local dedupe (Google send is not idempotent). Account, conversation, approval, and scope bindings fail closed on mismatch.

Natural language examples (after consent):

- `Send email to person@example.com subject “Hello”: Body text`
- After a single verified search/read result: `Reply with: Thanks, confirmed.`
- `Archive that email` / `Trash that email` (manage + gates)

Do **not** claim unimplemented slash verbs such as `/gmail send`.

## Calendar manage acceptance

Calendar V1 write path is unchanged: preview → confirm; destructive cancel needs `/calendar approve` then `/calendar confirm <id> --destructive`. Read-only Calendar continues when manage is not authorized. Owner must run `/connect calendar manage` for write-qualified Calendar (live write qualification is owner-only after install).

## Security invariants

- Separate vault purposes: `gmail` vs `calendar`.
- No credentials in models, logs, Missions, or worker context.
- No silent permission escalation; readonly consent rejects write scopes.
- Fail-closed on scope mismatch, missing conversation binding, and cross-conversation preview reuse.
- `write_qualified` stays false until a provider-confirmed write receipt in-process.

## Stage roadmap

- **A (this doc):** Calendar manage acceptance + Gmail write connector
- **B:** Drive `drive.file` / picker-scoped
- **C:** Docs + Sheets on authorized files
- **D:** Contacts + Tasks

## Tests

- `tests/gmail-write-stage-a.test.js` — OAuth modes, connector flags, preview/approve/confirm, send dedupe, readonly refusal
- Existing `tests/gmail-oauth-token-exchange.test.js`, Calendar NL tests remain authoritative for prior surfaces
