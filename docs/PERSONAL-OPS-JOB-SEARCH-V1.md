# Personal Operations & Job Search V1

Issue #112. Host-owned personal-account workflows and a local Job Search Manager. Ordinary conversation stays tool-free; the host router owns connector calls and tracker mutations.

## Conversation reliability

Vague “manage my Gmail / Drive / Calendar / Excel / Notes and help me find a job” requests return a host **capability plan** (`AVAILABLE` / `AUTH_REQUIRED` / `NOT_SUPPORTED`) instead of a model denial or an opaque “qualified local model could not respond” while `/status` still shows Ready.

Failed inference surfaces distinct `safe_error_class` values with actionable reasons: `provider_timeout`, `empty_response`, `content_policy`, `tool_prohibited`, `response_too_long`, `qualification_changed`, `provider_changed`, `context_changed`, `context_or_provider_unavailable`, `provider_unavailable`.

There is no automatic external provider fallback for private conversation.

## Connector capability matrix

| Connector | Availability in V1 | Auth | Live qualification | Reads | Writes / mutations |
|---|---|---|---|---|---|
| Gmail | `AUTH_REQUIRED` until connected; `AVAILABLE` after live read | Owner Google desktop OAuth `gmail.readonly` | Successful bounded list/search/read in-process | list, search, read, thread, job_categorize, local draft preview | **None** (send/archive/label/mark-read denied) |
| Google Calendar | `NOT_SUPPORTED` | — | No | — | Local interview **suggestions** only; no invites |
| Google Drive | `NOT_SUPPORTED` | — | No | — | — |
| Google Sheets | `NOT_SUPPORTED` | — | No | — | Use local tracker |
| Local files (selected tracker) | `AVAILABLE` | Host-governed | Yes | Tracker read | Tracker create/update with evidence |
| Job Search Tracker | `AVAILABLE` | Local CSV (Excel-openable) | Yes | list, digest | upsert / follow-up with evidence |

**State vocabulary**

- **configured** — OAuth client metadata present. Not live access.
- **connected** — OAuth token/reference present. Not yet proven by a successful read.
- **live_qualified** — At least one successful bounded read in this process.
- **NOT_SUPPORTED** — Honest WAIT; do not claim cloud sync.

## Job Search Manager

Local tracker path: `<dataDir>/job-search/applications.csv` (CSV, Excel-openable).

Schema: `id, company, role, source, status, applied_at, recruiter_email, posting_url, evidence, follow_up_at, notes, updated_at`.

Rules:

- Every create/update requires identifiable evidence (message id, posting URL, or operator confirmation).
- Duplicate company+role+posting merges instead of inventing a second row.
- Daily digests report only tracked rows; empty means empty — never fabricate jobs or outcomes.
- Recruiter categorization uses only fields present on selected messages.
- Material prep and calendar suggestions are drafts/suggestions; send and invite remain gated.

## Bounded automation

Owner may grant standing **read-only Gmail organization** and **selected local tracker updates** (`/api/assistant/personal-ops/automation` with `confirmed:true`). Never standing-authorized without separate confirmation:

`send_email`, `submit_job_application`, `invite_attendees`, `share_documents`, `delete_records`, `expand_drive_scope`, `credential_changes`, `paid_external_services`, `account_deletion`, `unrestricted_memory_disclosure`.

## Owner setup guide

1. Keep the live installation untouched until a separate cutover is authorized.
2. Gmail (optional, read-only):
   - `airodrom gmail setup <Google-desktop-OAuth-client-id>`
   - Prepare Keychain / secret helper; restart the owned service when you next authorize a cutover.
   - In Terminal: `/connect gmail` → complete Google consent for **gmail.readonly** only.
   - Prove live access with a bounded search (for example job-related subjects). `/connectors` should move beyond mere `configured`.
   - Revoke with explicit disconnect (`confirmed:true`); tokens are not printed.
3. Job tracker (local, no cloud required):
   - Ask: “Create a local job-search tracker”
   - Log applications only with evidence; ask for a “daily digest”.
4. Calendar / Drive / Sheets remain WAIT until separately enrolled with least-privilege OAuth. Do not infer them from Gmail consent.
5. Standing local tracker updates (optional): confirm via personal-ops automation API; never grants send/apply/invite.

## Privacy and adversarial boundaries

- Email bodies and connector excerpts are untrusted data; injection cannot grant send, Mission, or Vault authority.
- Credentials typed in chat remain refused; use `/vault`.
- Synthetic fixtures only unless the owner authorizes a specific live account test.
- Complementary to Developer Autonomy (#111): DA grants never imply personal-ops or job-search authority.

## Limitations

- Calendar, Drive, and Sheets cloud connectors are not live-qualified in this revision.
- No remote Gmail draft/send/archive/label.
- Job discovery does not scrape or invent postings; only evidence-backed tracker rows and host categorization of selected mail.
- Live Ollama conversation success was verified with synthetic prompts against the qualified local model; private inbox content was not read.
