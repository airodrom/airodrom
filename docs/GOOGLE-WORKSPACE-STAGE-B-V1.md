# Google Workspace Stage B V1 — Governed Google Drive (read-only)

Host-authoritative Drive connector. OpenCode never receives Drive tokens or unrestricted Drive tools. Document bodies are untrusted content and never gain instruction authority.

## Lifecycle states (do not conflate)

| State | Meaning |
| --- | --- |
| Implemented | Source + synthetic suite on feature branch / PR |
| Merged | On `main` |
| Installed | Managed tip SHA includes Stage B |
| OAuth connected | Owner completed `/connect drive` (`drive.file`) |
| Resource enrolled | Exact file (or folder probe) ids recorded by owner |
| Live read-qualified | Provider-confirmed enrolled-file read recorded (`drive_read_qualification`, non-synthetic) |

## Consent and scope

| Service | Command | Scopes | Notes |
| --- | --- | --- | --- |
| Drive (Stage B) | `/connect drive` | `https://www.googleapis.com/auth/drive.file` | App-created **or app-opened** resources only. **Not** blanket `drive` or `drive.readonly`. |

- Vault purpose: `drive` (separate from `gmail` and `calendar`).
- Gmail or Calendar consent does **not** grant Drive.
- Chat text never grants OAuth or enrollment.
- Owner reconnect: `/connect drive fresh`.

### Critical `drive.file` semantics

`drive.file` does **not** grant access to every file inside a selected folder.

Google authorizes only files this OAuth client **created** or the owner **opened with this app** (Google Picker / Open with). Knowing a folder id, or enrolling a folder in Airodrom, does **not** expand Google’s grant to arbitrary children.

#### Google Picker (required for existing files)

1. In the Google Cloud project that owns the desktop OAuth client: enable **Google Picker API** + **Drive API**.
2. Create a browser API key restricted to Picker.
3. `airodrom drive picker-setup <api-key> <gcp-project-number>`
4. `/connect drive` (or `fresh`) → consent → picker opens automatically when configured.
5. Or later: `/drive select` to open the picker for an already-connected Drive session.

Picker bootstrap hands an access token to the local picker page once (loopback), via a dedicated response path that does **not** run through Control Center `safeValue` redaction (which would otherwise omit tokens). Tokens are not logged, not returned on connector status, and not given to models. Bootstrap runs only after the owner clicks **Open Google Picker**. Picker enrollment is loopback-session gated (bootstrapped UUID); conversation UUID remains required for `/drive read` and Terminal enroll paths.

Airodrom policy matches Google:

- **File reads/metadata** require exact enrollment after Google visibility under `drive.file`.
- **Folder enrollment** is probe-only; children need their own enroll.
- File enroll attempts that Google rejects (403/404) fail closed with `drive_file_not_authorized_under_scope` — **no silent escalation**.

If a proposed operation needs broader Google scopes than `drive.file`, the host reports the limitation instead of requesting them.

## Enrollment (required for reads)

Connected OAuth alone is **not** resource access.

1. `/connect drive`
2. Open/select the target file with this Airodrom Google client under `drive.file`
3. `/drive enroll file <id> [label]`
4. Optional: `/drive enroll folder <id>` for folder identity / list probes only

Revoke one resource: `/drive unenroll <id>`. Disconnect/revoke OAuth clears the Drive vault reference and revokes all enrollments.

## Supported capabilities (V1)

| Capability | Host path | Mutations |
| --- | --- | --- |
| Connect / disconnect | `/connect drive`, owner revoke | none |
| Enroll / unenroll | `/drive enroll…`, `/drive unenroll…` | none |
| List enrolled | `/drive list` / NL | none |
| List folder children (probe) | `/drive ls <folder-id>` | none — does not authorize reads |
| Search enrolled files | `/drive search <query>` / NL | none |
| Metadata / text read | `/drive meta\|read <id>` | none — exact file enrollment |

**Not in Stage B (historical):** edit, move, trash, delete, sharing, permission mutation.

**Stage B+ (Drive→Gmail attach E2E):** app-created UTF-8 `.txt` via `/drive create text …` under the same `drive.file` scope (no scope broadening). See `docs/GOOGLE-WORKSPACE-DRIVE-GMAIL-ATTACH-E2E-V1.md`.

Supported content export: `text/*`, markdown, CSV, JSON, Google Docs → `text/plain`. Other mime types return unsupported-format. Size capped (`MAX_CONTENT`).

## Natural-language examples

- `Show the files I've authorized in Google Drive.` → enrolled list
- `Find the report in my connected Drive files.` → enrolled-file name search
- `Summarize this authorized document.` → enrolled-file read excerpt (`untrusted`)

## Control Center / Connections states

| State | Meaning |
| --- | --- |
| `unavailable` | Drive OAuth client not wired |
| `not_connected` | Client ready; no consent |
| `resource_enrollment_required` | Connected; zero enrollments |
| `connected` | Connected + enrolled; live read not yet qualified |
| `read_qualified` | Durable provider-confirmed enrolled-file read |
| `scope_restricted` / `consent_expired` / `revoked` | Failure / disconnect classes |

Tokens never appear in connector status payloads, logs, Missions, or frontend JSON.

## Synthetic versus live

- `NODE_ENV=test` → synthetic Drive mode via `external-write-context`.
- Synthetic requires an injected transport; missing transport fails closed.
- Test processes must inject `driveConnector`; auto-wiring live OAuth Drive is refused.
- Synthetic reads never set `drive_read_qualification`.
- Live qualification requires installed tip + owner consent + exact file enrollment + provider-confirmed read.

## Security invariants

- Narrow `drive.file` only; no default broad Drive.
- Operator-only enrollment; conversation UUID required for enroll/read paths.
- No parent-folder inference for file reads.
- Path/id manipulation rejected.
- Document prompt-injection text returned as data only.
- Capability policy: MCP `drive_*` inactive; writes reserved / approval-gated.
- No regression to Gmail/Calendar vault purposes or write gates.

## Tests

- `tests/drive-stage-b-v1.test.js` — OAuth scope, enrollment, `drive.file` semantics, NL routing, isolation, timeouts, mime/size, qualification negatives, allowlists

## Rollback

Retarget prior managed install tip; Drive OAuth revoke clears vault + enrollments; Gmail/Calendar unaffected.
