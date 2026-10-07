# ADR 0012 — Natural named private identifiers and browser research gate

Status: Accepted. Two independent privacy/authority boundary reviews completed with no unresolved material findings. Owner explicitly approved reviewed PR #20 for normal merge and local installation on 2026-10-07.

## Decision

Airodrom's deterministic operator ingress identifies a small allowlist of private numeric identifiers before any model or service call. Confirmed saves use the existing Keychain Vault with operator purpose, immutable entry classification and human-readable metadata. Fresh terminal confirmation precedes private-identifier reveal. No value is included in audit, model context, service payload, transcript or operation receipt. Password/API-key/PIN/recovery-code requests retain the credential input boundary and cannot be downgraded to identifiers. Model output and connector text cannot enter this workflow.

The existing disposition file remains version 1. Named operator entries add classification metadata; legacy generated names remain valid. Names are validated and collisions fail closed. Rename preserves purpose and classification. Delete clears metadata and records a canonical tombstone before host cleanup. Restored readers consult independent current source metadata and authority on each list/resolve, and deny writes. Keychain's independent revocation marker remains authoritative even if local metadata is rolled back. No second secret store or automatic Vault migration is added.

The terminal's ordinary reader is detached before secure confirmation, selection or credential capture. Non-TTY/competing readers deny the operation. Inline identifier values exist only in transient operator ingress; credentials never use that path. Confirmed reveal writes to terminal output and returns a content-free receipt. Operator disclosure can remain in terminal scrollback; no screenshot/export/privacy-deletion claim extends to unmanaged captures, swap or physical backups.

Governed browser research has no qualified implementation in this milestone. A deterministic unavailable gate prevents model evidence fabrication and avoids unqualified browser, credential or Mission authority. It exposes empty evidence and an unverified comparison status. Future implementation requires bounded public-domain navigation, redirect/request/domain controls, evidence redaction, account-purpose authorization, human MFA and separate mutation approval. No CAPTCHA bypass, payments or mutation is admitted.

## Compatibility and alternatives

Existing credential references, OAuth purpose binding, revocation markers, personal Memory, Mission governance, provider qualification, fish/wave animation and Pi removal are preserved. A model-mediated lookup was rejected because it would disclose private values to inference and could claim unauthorized operations. A second sensitive store was rejected in favor of the canonical Keychain Vault. Broad browser enablement was rejected until all admission and evidence controls are verified.

## Evidence

Targeted tests cover routing redaction, confirmed save/restart/reveal, refusal and competing readers, collisions, ambiguity, immutable classification, rename, purpose binding, revocation/current-source restore and sanitized failures. Existing conversation, connector-authority, canonical erasure and Mission escalation checks plus both typechecks and package/public sanity remain the focused validation. Independent reviewers assess the changed authority/privacy boundaries; live accounts, public/account navigation and feature-gap reports remain explicitly untested.
