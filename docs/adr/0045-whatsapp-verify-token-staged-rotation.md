# ADR 0045: WhatsApp verify-token staged rotation

- Status: Proposed
- Date: 2026-10-10
- Owner: Local operator maintenance
- Review: Pending
- Affected contracts and components: [WhatsApp Inbound V1](../WHATSAPP-INBOUND-V1.md), [Meta live connection](../META-WHATSAPP-LIVE-CONNECTION-V1.md), Secret Vault, Control Server webhook challenge
- Related decisions: [0038 WhatsApp Inbound V1](0038-whatsapp-inbound-v1.md)

## Context and problem

Installed verify-token rotation used `vault.replace`, which immediately revoked the previous Keychain value. Meta Dashboard still holding the old verify token then failed closed with no Airodrom recovery path. Operator `/secret` cannot reveal connector-purpose credentials.

## Decision

Stage a replacement verify token in a separate Vault reference bound on `cp_whatsapp_inbound_config.staged_verify_token_reference` with `staged_verify_expires_at`. Challenge accepts the active or staged candidate while staging is live. Finalization (promote staged, revoke previous) occurs only via explicit operator `commit-verify-token` after the owner independently confirms Meta Verify and Save succeeded. Webhook GET challenges never finalize: a correct verify-token alone does not cryptographically authenticate Meta. Rollback and TTL expiry discard only the staged candidate. App Secret and Graph access references are unchanged. Public ingress, outbound messaging and production activation remain out of scope.

## Alternatives considered

- Keep immediate `vault.replace`: rejected; irreversible before Meta verify.
- Auto-finalize on successful GET challenge: rejected; verify-token alone does not authenticate Meta.
- Clipboard reveal of the current token: rejected; connector credentials remain non-revealable.

## Authority, privacy and ownership

No Mission authority, allowlist, outbound or public-ingress changes. Token plaintext appears only on an authenticated owner TTY once during stage. Values must not enter logs, worker context, Git, Notion, docs or Mission evidence. Events carry only non-secret match/finalize flags.

## Compatibility and migration

Additive SQLite columns. Existing single-slot configs keep working with staging inactive. Operators on the old replace CLI must reinstall a build that includes this ADR before rotating. No live credential migration is performed by this change.

## Consequences

Recoverable Meta test webhook verification. Slightly longer dual-accept window during staging TTL. Operators must finalize or rollback before expiry after Meta updates the verify token.

## Validation and evidence

Focused `tests/whatsapp-inbound-v1.test.js` cases: successful finalize, non-finalizing probe, rollback, expiry, concurrent rejection, no secret leakage. Fixtures only; no live Keychain or Meta mutation in CI.

## Rollback

Revert the source change before installation. Active staged rows on a profile that already received the schema remain harmless if staging columns are unused; do not restore revoked Keychain items from Git.
