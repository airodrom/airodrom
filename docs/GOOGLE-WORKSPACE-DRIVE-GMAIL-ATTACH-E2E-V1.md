# Google Drive → Gmail Attachment E2E V1

Owner-controlled personal-assistant workflow on existing host rails:

1. Create a small UTF-8 `.txt` in Drive under `drive.file` (app-created).
2. Provider-confirm readback (exact bytes; not create-response cache).
3. Stage a Gmail send preview that freezes those bytes as a MIME attachment.
4. Send only via authenticated `/gmail confirm <preview-id>`.

## OAuth permissions

| Surface | Scope | Notes |
| --- | --- | --- |
| Drive create + read | `https://www.googleapis.com/auth/drive.file` | Unchanged. App-created files are authorized for this client. No automatic scope broadening. |
| Gmail send | `gmail.readonly` + `gmail.send` (or manage) | Unchanged. |
| Gmail Drafts API | **Not used** | Local durable preview in `gmail_write_ops` is not a saved Gmail Draft. Provider Drafts would need separate draft authorization and an explicit product decision. |

## Commands

```
/drive create text airodrom-test.txt :: <utf8 content>
/drive create text note.txt in <enrolled-folder-id> :: <utf8 content>
/drive read <id>
Send email to myself subject “…”: … Attach drive file <id>
/gmail send to myself subject “…”: … --attach-drive <id>
/gmail confirm <preview-id>
```

Chat text such as “yes, send it” does **not** confirm.

## Security invariants

- Drive create: safe `.txt` names only; size cap; secret-like content refused (fail closed); optional parent must be enrolled folder. Create bodies after `::` preserve UTF-8 newlines and trailing punctuation (parsed before chat whitespace / trailing-`[!?.]` strip).
- Provider readback must exactly match source bytes **before** auto-enrollment. Readback mismatch leaves the file unenrolled.
- Gmail attach: enrolled Drive files only; no local filesystem paths; MIME `text/plain` only; size/checksum; secret-like attachment content refused (fail closed); bytes frozen in proposal at stage time; confirm re-validates checksum and refuses substitution.
- Durable Gmail ops: atomic claim, at-most-once dispatch, uncertain without blind retry, conversation/account binding, synthetic ≠ live qualification.
- Chat replies such as “yes” / “send it” never confirm. Only `/gmail confirm <preview-id>`.
- MCP `drive_write` / `gmail_send` remain inactive.

## Synthetic vs live

Automated tests use synthetic Drive/Gmail transports only. Live Drive create and Gmail delivery require explicit owner authorization after install.

## Tests

- `tests/drive-gmail-attach-e2e-v1.test.js`
- Existing Drive Stage B + Gmail write durability / confirm suites remain mandatory.
