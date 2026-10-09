# WhatsApp Inbound V1 — next OpenCode Mission prep

## Current boundary (main / PR #43 base)

- Connector status: official WhatsApp Business Cloud API inbound only; personal WhatsApp history unsupported.
- Capabilities declared: `whatsapp_read`, `whatsapp_send`, `whatsapp_reply` (send/reply gated; not live-qualified).
- Assistant connect path states WhatsApp needs an official host webhook transport.
- **Do not** expose a public webhook in this Mission.

## Recommended Mission branch

`feat/whatsapp-inbound-v1` from current `origin/main` (or post-merge main after PR #43), in a **new isolated worktree**. Do not use the dirty operator checkout.

## Bounded WORK template (operator-owned)

Suggested local-only OpenCode WORK (public fixture only):

- Worker: OpenCode / Qwen3 Coder 30B
- Privacy: `local_only`; data_class: `public`
- Scopes: `repo`, `developer_environment` only
- Allowed files: synthetic inbound parser + fixture webhook payloads under a disposable repo
- Criteria: exact_file / registered tests proving signature verification, fail-closed unknown payloads, no outbound send
- Explicit non-goals: public tunnel, production webhook URL, send mutations, personal chat history

## Acceptance

If risk auto-Acceptance preference is enabled, eligible fixture WORK can settle automatically after host verification. Otherwise remain awaiting Acceptance.

## Authorization still required

Owner must approve Mission creation/dispatch, any network grant for a future private webhook receiver, and any credential binding. This note does not authorize live Meta app configuration.
