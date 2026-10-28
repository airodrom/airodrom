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

### Live acceptance (installed tip `8dcb7de`, 2026-10-28)

Authorized owner live run after managed install of PRs #257 + #258:

| Check | Result |
| --- | --- |
| `/drive create text airodrom-test.txt :: …` (newlines + trailing period) | Provider file `1x8gfpgjIJ_RDQPPwaX8FS2eimgUzp-oZ`, 98 bytes |
| Provider readback SHA-256 | `1ba0b1aa24cab35150595053433f79ad849d00f02820aa1c104bbfa51c454865` (exact) |
| Auto-enrollment | Only after readback match |
| Immutable preview | `56075465-09a2-457e-9e80-a466a65a0dfb` — filename/MIME/size/sha frozen |
| Chat approval bypass | “yes” / conversational approve did **not** send |
| `/gmail confirm <preview-id>` | Single provider message `1a183cfb21d0c264`; attachment sha matched source |
| Duplicate confirm | Host-local replay; same message id (no second provider send) |
| Gmail Drafts API | Not used / not claimed (`gmail_drafts_persisted: false`) |

**Delivery interpretation:** Provider send receipt and Sent-path message id are confirmed. Independent inbox SMTP delivery and standalone raw-MIME re-download are not claimed beyond that receipt. Private evidence: `~/.airodrom/activation/DRIVE-GMAIL-ATTACH-LIVE-ACCEPT-8dcb7de.json`.

### Recovery / rollback

- Pre-#258 cutover checkpoint: `~/.airodrom/activation/recovery-checkpoint-pre-drive-body-preserve-8dcb7de-*`
- Prior install path retained: `…/airodrom-install-12f7d06` (`12f7d06`) and earlier `…/airodrom-install-5f217d9`
- Retarget managed install to the prior archive and restart LaunchAgent `local.airodrom.desktop-login` per standard release procedure

### Known limitations

- OAuth remains `drive.file` only; non–app-created Drive files still need exact enrollment / open under that scope.
- Attachment source is enrolled Drive `.txt` only (no local filesystem paths; no arbitrary MIME).
- Local durable preview ≠ Gmail Drafts API persistence.
- Hosted GitHub Actions may be disabled; release gates use local equivalent focused suites.
- First live create on tip `12f7d06` stripped newlines/trailing `.` (97 B); fixed in PR #258 before re-accept on `8dcb7de`.

## Tests

- `tests/drive-gmail-attach-e2e-v1.test.js`
- Existing Drive Stage B + Gmail write durability / confirm suites remain mandatory.
- Focused attach E2E + related suites: **87/87** on feature tip before merge; re-run after #258 body-preserve fix.
