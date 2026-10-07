# ADR 0013 — Conversational private storage repair

- Status: Proposed
- Date: 2026-10-07
- Review: Independent privacy and authority reviews pending
- Related: [ADR 0011](0011-conversation-engine-and-intent-routing.md), [ADR 0010](0010-personal-assistant-and-qualified-routing.md), [privacy contract](../PRIVACY-ERASURE.md)
- Components: Operator intent ingress, native terminal guide, Sensitive Memory, Secret Vault, Conversation Engine

## Problem and decision

`Hi Airo, let's save my mailbox number 818.` previously fell through to ordinary inference. The host now removes bounded greetings, bounded assistant addresses and greeting vocatives, contractions and polite preambles before deterministic intent matching. Native private requests are handled before chat submission; only the subsequently confirmed Sensitive Memory write crosses the authenticated host endpoint. The original message never becomes a model-selected operation. Quoted, negated, multiline and incomplete private requests receive host clarification and cannot save.

For the fixed identifier names Mailbox number, Locker number and Parking space number, the native terminal asks the operator to choose Sensitive Memory or a named Keychain Vault entry, then asks for confirmation. Only numeric values of 1–12 digits are eligible. This classification is deliberately bounded: a password, PIN, token or credential-looking value is refused in chat and must be entered afresh through the existing detached hidden-input credential guide. A chat credential is never reclassified as secure input.

## Privacy and authority

Sensitive identifiers use the existing canonical PersonalMemory store with sensitive metadata, opaque subjects and a fixed identifier type. The authenticated private-memory endpoint exposes name/ID metadata for lookup and requires explicit confirmation plus the current name/ID for reveal. It never registers an agent tool. Ordinary Memory writes cannot downgrade a named private identifier. Private values are excluded from ordinary retrieval, conversation history/context and execution context. Ordinary Memory reference content retains credential screening; canonical record IDs remain in host provenance for erasure and never enter provider text, avoiding false credential matches in random IDs.

Vault entries retain opaque Keychain references and purpose binding. The existing named Vault contract supplies non-sensitive labels and the `private_identifier` kind; this repair reuses that reviewed implementation and keeps values in Keychain. Native reveal requires fresh operator confirmation, current operator-purpose dispositions before and after resolution, and a numeric value. Credential entries and connector tokens cannot be revealed by this operation. Revocation removes labels and kind metadata before Keychain cleanup. Restored views remain read-only and subordinate to independent current dispositions.

The terminal detaches ordinary readline before any choice or reveal, drops queued pasted input and restores input on cancellation. Non-interactive input cannot save or reveal. Save receipts and lookup metadata contain no value. Reveal is printed only in the operator terminal, never returned as conversation prose. An ambiguous match across backends requires an entry selection before reveal. Duplicate names within a backend require reviewing or forgetting the existing entry; no implicit overwrite occurs.

Explicit Missions, immutable scope, leases, qualification, Acceptance and Settlement retain their existing contracts. Conversation model responses that claim persistence, disclaim the host's storage capability, or expose named private identifiers fail closed.

## Compatibility and alternatives

No database schema, Kernel version or SDK export changes are introduced. Legacy and named Vault entries retain their existing names and lifecycle. New identifier records are additive and disposable; existing private data and other worktrees are preserved. Asking a model to infer or execute storage is rejected because inference cannot grant persistence authority. Treating all numbers as credentials is rejected because it would prevent explicitly confirmed private identifier storage.

## Validation and rollout

Synthetic focused checks cover the exact reported phrase, greeting/nickname/polite variants, quoted text, negation, ambiguity, credential refusal, operator authentication, secure input, cancellation, Memory exclusion, name-bound reveal, fresh-store persistence, Vault purpose/revocation and model bypass. Existing conversation, secure-entry, Memory/privacy and authority regressions plus type checks and source/package gates remain required. Fixture checks do not qualify a live model or Keychain backend; report isolated live evidence separately.

Two independent boundary reviews and maintainer disposition are integration gates under [project governance](../../GOVERNANCE.md). Keep this decision Proposed until those gates are recorded. Merge and local reinstall follow normal governance; release and deployment require separate owner authorization.

## Rollback

Revert the source repair through a reviewed change. Preserve canonical Memory records and Vault dispositions, including revocations. Review and explicitly forget disposable synthetic entries before returning to a Vault reader that predates named identifiers. Do not replace live databases, configuration or independent disposition sources, and do not reset unrelated Gmail, browser or animation work.

## Outcome

Pending independent reviews and maintainer disposition.
