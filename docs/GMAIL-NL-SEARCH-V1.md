# Gmail Natural-Language Search & Pagination V1

## Purpose

Everyday requests such as **“Find all mails from GitHub”** are executed by the **host Gmail connector**, not by OpenCode. The model is not used to recognize or run deterministic mailbox search.

## Regression this closes

Before this change, `src/assistant-intent.js` only matched phrases like “check my gmail”. Sender searches fell through to `kind: conversation`. The local model then failed with a turn error while Gmail itself was healthy (`live_qualified`). That was a **routing** failure, not a Gmail API failure.

## Supported natural language (host route)

Examples (case/whitespace insensitive):

- Find all mails from GitHub
- Find emails from GitHub / Show GitHub emails
- Search my Gmail for GitHub notifications
- Find unread GitHub emails / Show recent emails from GitHub
- Search email from `notifications@github.com`
- Find emails from a specified sender or domain
- Show more / Show the next page (continues the active search in this session)

Ambiguous “find all emails from …” asks for one clarification. Mutation verbs (send, archive, delete, label, …) are refused as read-only.

Unrelated GitHub/repo discussion without mail language stays conversation/work routing.

## Deterministic routing

1. `gmail-search-intent.parse` → structured `CONNECTOR` search (query, label, flags).
2. `assistant-service` runs `gmailSearchPage` → authenticated `AssistantConnectors` list + metadata.
3. Receipt is `host_verified: true`, `model_invoked: false`.
4. OpenCode is **not** started on this path.

Summarize / attention / draft_reply may still use the conversation engine after a bounded fetch; plain search does not.

## Query semantics

| Match | Gmail query shape | Caveat |
| --- | --- | --- |
| GitHub alias | `(from:github.com OR from:notifications@github.com OR from:noreply@github.com)` | Display name “GitHub” alone is not proof of authenticity; From metadata is shown |
| Exact address | `from:user@domain` | — |
| Domain | `from:domain.tld` | — |
| Display name | `from:"Name"` | Not proof of domain origin |

Optional flags: `is:unread`, `newer_than:7d`.

Host queries use a narrow operator alphabet (`isHostSearchQuery`) so `from:domain` is not blocked by chat secret heuristics.

## Pagination contract

| Limit | Value |
| --- | --- |
| Page size | 10 default, max 20 |
| Max pages / session | 20 |
| Max messages / session | 200 |
| Cursor TTL | 15 minutes |
| Body fetch | Metadata only on list pages (From, Subject, Date + short snippet) |

Continuation uses an **opaque** `continuation_id` bound to operator + optional conversation + exact query. Gmail `nextPageToken` never leaves the host session store.

“All” means **bounded, resumable pages**, not loading the mailbox into memory. If a safety limit is hit, the receipt is marked **partial**. When the provider returns no further page, the receipt is marked **complete** for that query (distinct from estimates).

## Status vocabulary

| State | Meaning |
| --- | --- |
| configured | OAuth client wiring present |
| connected | Token appears usable |
| live_qualified | At least one successful bounded read/search in this process |
| token_present | Vault reference exists (may still be unusable) |

## Failures

| Class | Presentation |
| --- | --- |
| Gmail OAuth / API | `connect_required` or Gmail error — **not** an OpenCode / `provider_unavailable` message |
| OpenCode down | Deterministic Gmail search still succeeds |
| Ordinary chat model failure | Remains a conversation/`provider_unavailable` classification |

## Privacy

- Read-only `gmail.readonly` only; no send/archive/delete/label/mark-read.
- No OAuth scope expansion.
- No private mail content in Missions, workers, or PR artifacts.
- Snippets/subjects are redacted through existing clean/redact paths.

## Operator after install

1. Ensure `/connectors` shows Gmail `live_qualified` (or complete `/connect gmail` first).
2. Ask: `Find all mails from GitHub`.
3. Use `show more` for the next page when offered.
