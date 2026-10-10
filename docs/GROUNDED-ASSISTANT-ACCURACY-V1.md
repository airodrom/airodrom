# Grounded Assistant Accuracy V1

Corrects two defects observed during a real morning focus brief on the installed Everyday Personal AI UX release.

## Problems

1. **Mission count accuracy** — Host overview reported `active=0` and `current=62`, but local Qwen prose called 62 “active”.
2. **Development Session metadata** — Legitimate Development Session identifiers and branch names were rejected as credential-like because display redaction treats `SESSION <word>` as sensitive.

## Decision

- Conversation injects host-verified Mission counts (`active`, `current`, `completed`, `historical`, `retained`) into the system context.
- On delivery, host grounding rewrites or annotates disputed active/current count claims; useful interpretation is preserved.
- Operator instruction screening normalizes authorized Development Session labels, git branch/worktree shapes, ordinary “session with …”, and title-case “Session Heading” prose for screening only.
- Local private conversation provider admission uses operator screening (`localConversationSecret`) instead of display `secretLike`, without globally disabling credential protection.
- Actual secrets (`session=…`, `Cookie: session=…`, passwords, tokens, mixed browser+credential submissions) remain fail-closed.

## Non-goals

- No new AI architecture milestone, Mission authority changes, Memory consent changes, Automatic Acceptance, WhatsApp production changes, push, PR, merge, or install.

## Validation

- Focused: `tests/conversation-grounding-v1.test.js`, `tests/authenticated-research-routing.test.js`
- Live local Qwen brief with host `active=0` / `current=62` and authorized Development Session metadata; final visible text must not claim “62 active Missions”.
