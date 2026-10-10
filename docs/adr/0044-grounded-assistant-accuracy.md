# ADR 0044: Grounded assistant accuracy for Mission counts and Development Session metadata

- Status: Proposed
- Date: 2026-10-10
- Owner: Airodrom
- Review: Pending
- Affected contracts and components: ConversationEngine, provider-policy operator screening, provider-envelope / OpenAI-compatible local private admission, product Mission count semantics
- Related decisions: ADR 0011 Conversation Engine; ADR 0015 authenticated browser session handoff screening; ADR 0039 Development Sessions

## Context and problem

A live morning brief on installed Everyday Personal AI UX showed Qwen describing host `current=62` Missions as “active” while `active=0`. Separately, authorized Development Session id/branch metadata could not enter Conversation because display redaction treats `session <word>` as credential-like.

## Decision

1. Host-owned Mission fact snapshot (`active`, `current`, `completed`, `historical`, `retained`) is injected into Conversation system context and used to ground delivery text when the model disputes those counts.
2. Operator instruction screening permits authorized Development Session labels and safe branch/worktree shapes; Cookie/assignment session secrets remain screened.
3. Local private conversation provider admission uses operator/local conversation secret classification rather than display redaction for message bodies, so authorized metadata can reach the model without weakening non-local or credential paths.

## Alternatives considered

- Prompt-only reminders without delivery grounding — rejected; the observed failure already had correct prose facts in the user message.
- Globally disabling `SESSION <word>` display redaction — rejected; too broad.
- Requiring operators to paraphrase all Development Session identifiers — rejected; blocks real daily use.

## Authority, privacy and ownership

No Mission dispatch, Acceptance, Settlement, Memory write, Vault, or WhatsApp production changes. Memory remains opt-in. Automatic Acceptance remains OFF.

## Compatibility and migration

No durable schema migration. Compatible repair to Conversation and operator screening. Separate install/activation required before the live Control Center package uses this tip.

## Consequences

Daily briefs can use host Mission vocabulary and Development Session metadata. Model interpretation remains available. Credential-shaped submissions stay denied.

## Validation and evidence

`tests/conversation-grounding-v1.test.js`; regression `tests/authenticated-research-routing.test.js`; live Qwen brief with authoritative `active=0` / `current=62`.

## Rollback

Revert the feature branch tip; installed Everyday UX package remains unchanged until a later authorized install.
