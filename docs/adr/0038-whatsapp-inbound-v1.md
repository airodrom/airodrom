# ADR 0038: WhatsApp Inbound V1

- Status: Proposed
- Date: 2026-10-09
- Owner: Operator request
- Review: Pending
- Affected contracts and components: Control Server webhook surface, Assistant Connectors, Memory retention registry, Control Center Connectors view
- Related decisions: [0010 personal assistant](0010-personal-assistant-and-qualified-routing.md)

## Context and problem

Airodrom already exposes a host-owned official WhatsApp Business HMAC parser (`officialInbound`) and a read-only connector adapter, but there was no durable inbound webhook path, allowlist, inbox, or Control Center observability. Operators need a loopback-bound Business Cloud webhook that never auto-dispatches Missions.

## Decision

Add host-owned `WhatsAppInbound`:

- `GET /webhooks/whatsapp` challenge verification with operator-bound verify token
- `POST /webhooks/whatsapp` raw-body `X-Hub-Signature-256` HMAC verification
- Supported inbound text only, message-id dedupe, sender allowlist, durable inbox and delivery-status rows
- Authenticated operator APIs for configure/status/inbox/statuses
- Control Center Connectors surface for inbound state and recent retained messages
- Explicit `auto_mission_execution: false` and `public_ingress: false`
- Vault references or test-injected secrets only; no credential values in status

Inbound WhatsApp remains untrusted data. Future WhatsApp-to-Airodrom actions require separately approved bounded Mission templates.

## Alternatives considered

- Reuse Slack inbox semantics unchanged — rejected; WhatsApp Business Cloud uses Meta challenge/HMAC contracts.
- Auto-create Missions from inbound text — rejected; violates host authority boundaries.
- Public tunnel activation in this change — rejected; requires separate owner authorization.

## Authority, privacy and ownership

Messages never grant approvals, scopes, Acceptance, or Mission dispatch. Retention fields are registered for config, inbox and status tables. Secrets stay in Vault or injected test options. Loopback Host binding remains mandatory.

## Compatibility and migration

Additive SQLite tables via `CREATE TABLE IF NOT EXISTS`. No Kernel version bump. No production webhook publication. Connector status becomes `configured` when the WhatsApp source is wired.

## Consequences

Operators can qualify Meta webhook verification and observe durable inbox/status locally. Public ingress, send adapters and Mission templates remain follow-up work.

## Validation and evidence

Focused fixture suite `tests/whatsapp-inbound-v1.test.js`: challenge, invalid token, valid/invalid HMAC, duplicate, unauthorized sender, durable inbox/status, no Mission creation. Distinguishes fixture verification from live Meta activation.

## Rollback

Revert the branch; tables are inert when inbound remains disabled. No irreversible remote publication.

## Decision outcome

Proposed pending maintainer review.
