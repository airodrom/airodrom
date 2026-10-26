# Memory-Grounded Email Composition V1

## Purpose

Ordinary requests such as **“Draft an email to a client and include my company's business address”** are **local composition**: the host drafts editable text for operator review. That path is independent of Gmail OAuth write scopes.

Three capabilities stay distinct:

| Capability | Permission | Outcome |
| --- | --- | --- |
| Compose locally | Personal Memory ordinary search (governed); no Gmail write | Editable draft in the conversation session |
| Save to Gmail Drafts | Authorized Gmail draft-write (separate) | Provider draft id only after success |
| Send through Gmail | Authorized Gmail send + confirmation policy | Sent receipt only after success |

Local compose never claims save or send. Missing Gmail write does not refuse composition.

## Routing

1. `email-compose-intent.parse` → `EMAIL_COMPOSE` (compose / revise / show).
2. `assistant-service` → `email-compose-service.run` (host-verified, `model_invoked: false`).
3. Gmail search `refuseMutations` no longer treats “draft an email” as a Gmail mutation refusal.
4. Explicit “send …” / “save to Gmail drafts” remain refused on the read-only Gmail search path until a separate write capability is authorized.

## Memory grounding

- Search Personal Memory V2 with `includeSensitive: false` and ordinary address queries.
- Prefer active records only (search already excludes superseded / forgotten / expired).
- Do not invent an address when missing; ask the operator.
- If multiple ordinary addresses match, ask which to use.
- Sensitive / private facts are not auto-injected into drafts.
- Retrieved memory text is treated as untrusted reference data (instruction-like lines stripped; secret-like content rejected).

## Session UX

Draft state is bound to `(operator, conversation_id)`. Follow-ups (“Make it more formal”, “Show me the draft again”) revise or redisplay that draft without crossing conversations. Composed content is separate from Gmail provider state.

## Non-goals

- No OAuth scope escalation for local compose.
- No automatic activation of inactive Gmail mutation connectors.
- No Mission / OpenCode execution on this path.
- No real private addresses in fixtures or PR artifacts — synthetic values only.
