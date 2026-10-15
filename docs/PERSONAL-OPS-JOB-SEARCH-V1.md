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

Local tracker path: `<dataDir>/job-search/applications.csv` (**CSV**, Excel-openable — **not** an `.xlsx` workbook). Paths are confined to that directory; symlinks (including the `job-search` root and fixed `.tmp`/`.bak` names) are refused. Writes use exclusive `O_EXCL|O_NOFOLLOW` temporary files with unpredictable names, then `rename` (never follow a substituted destination).

Schema: `id, company, role, source, status, applied_at, recruiter_email, posting_url, evidence, follow_up_at, notes, updated_at`.

Rules:

- Every create/update requires **typed** evidence: `{kind: message_id|thread_id|url|operator_confirmation, value}` (operator_confirmation also requires `explicit:true`). Arbitrary text is not evidence.
- Tracker **mutations** (`upsert`, `follow_up`) additionally require either a **current** standing local-tracker grant or a **reviewed host proposal**: `propose` / denied non-executable `pending_proposal` → authenticated `review_proposal` (human-readable company/role/evidence/before→after) in Control Center Approvals or Terminal → `approve_proposal` with `confirmed:true` → execute once with `host_approval_id` bound to the exact payload digest, tracker path, action, expiry and request id. Conversation cannot auto-approve. `operator_confirmation` is typed manual evidence (a claim phrase), never the approval token; authorization is standing or the reviewed `host_approval_id`.
- `manager.json` uses the same exclusive nofollow temp + atomic rename protections as the CSV tracker; symlink/tamper states fail closed as HOLD without deleting unexpected legacy `.tmp`/`.bak` links.
- Spreadsheet formula injection (`=`, `+`, `-`, `@`) is neutralized on write with a reversible apostrophe policy (literal leading `'=` round-trips losslessly) and restored on read.
- Duplicate company+role+posting merges; existing higher-progress status is preserved unless an explicit status is supplied. `applied` requires an explicit `applied_at` (never invented).
- Daily digests use the operator-local calendar date (or an explicit IANA timezone); empty means empty — never fabricate jobs or outcomes.
- Recruiter categorization uses only fields present on selected messages (Gmail metadata headers are repeated query params).
- Material prep and calendar suggestions are drafts/suggestions; send and invite remain gated.

## Bounded automation

Owner may grant standing **read-only Gmail organization** and **selected local tracker updates** (`/api/assistant/personal-ops/automation` with exact boolean fields, ISO-8601 `expires_at` within 30 days, schema `version:1`, and `confirmed:true`). Malformed, stringy, expired, ceiling-violating, or unsupported-version grants fail closed to inactive immediately; `jobSearchManager.status().standing_local_updates` always reflects live policy, never a stale `manager.json` flag. Never standing-authorized without separate confirmation:

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
   - Manual entries without Gmail, a posting URL, or standing permission: submit `operator_confirmation` claim evidence → open Control Center → Approvals → Review exact fields → Approve → re-submit the exact body with `host_approval_id`. Conversation cannot auto-approve.
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
- Tracker is CSV (Excel-openable), not a native `.xlsx` workbook.
- Gmail OAuth refresh failures surface categorical `safe_error_class` values only (timeout/network/consent/http/schema/scope); live inbox reads remain an owner-only gate.
- Live Ollama conversation success was verified with synthetic prompts against the qualified local model; private inbox content was not read.
- Compatibility: rebase/retest if still-open PR #113 (Developer Autonomy) merges first; grants from #113 never imply personal-ops authority.

## Release-gate note — conversation-routing suite

`npm run test:conversation` reports **69/71** on this branch. Independent comparison against unchanged baseline `f968f49870a306cca7e5c18732501976c21644b5` in a clean worktree reproduced the **same two failures** (`private ingress and invalid research scope return no model authority or execution`, `invalid explicit and direct research scopes cannot dispatch even with a matching web template`): intent for `Research https://example.invalid` already returns `public_web_offer` on f968, so the assertions are pre-existing test/code drift on main, **not a regression from PR #114**. **Release-gate decision:** accept the pre-existing red suite for this personal-ops change; do not block #114 on those two routing assertions.

## Hosted CI policy

Repository workflow `Public candidate gates` (`.github/workflows/candidate.yml`) is **`disabled_manually`** in GitHub Actions. Feature-branch pushes therefore produce **zero** check-runs and **zero** commit statuses — this is not a green CI result. Per `docs/CI-BRANCH-PROTECTION.md` owner fast-track policy, local focused/typecheck/package evidence is the integration gate while the workflow remains disabled. Do not treat absent hosted checks as passing.
