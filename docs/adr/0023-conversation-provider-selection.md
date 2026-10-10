# ADR 0023 — Operator conversation provider selection

Status: Proposed; independent boundary review and owner disposition required.

Extends ADR 0011 with persistent conversation routing intent, separate from
ADR 0018 coding-worker qualification and ADR 0020 worker preferences. No Mission
V2, Capability Broker, execution, Acceptance or Settlement authority changes.

The authenticated operator endpoint saves a private versioned preference using
optimistic revisions. Missing configuration defaults to Qwen/local-only. Invalid
configuration fails closed. Selecting Claude never consents to disclosure. An
independently confirmed versioned policy permits only public text subject to exact
per-message review; it does not permit inference, charges, API billing, or context
injection. Switching to Qwen revokes this policy. In-flight local replies are
cancelled or discarded on revision changes. Replay digests bind the revision.

## Current transport gate

Claude remains WAIT, even with a saved data policy. The legacy pinned subscription
adapter can authenticate locally, but its broad filesystem/network sandbox and
runtime-alias model reporting do not establish the new conversation boundary or
subscription-only billing. This implementation deliberately does not wire that
adapter into ordinary chat, reuse worker qualification, expose a force-enable flag,
or treat fixture success as live qualification. No automatic fallback follows a
Claude selection. Selected connector previews retain the qualified local route.

A follow-on reviewed transport must pin and report the actual model, contain
filesystem/network access, verify subscription-only billing, obtain separate owner
permission before any live inference, and bind exact message consent to request,
provider/model, revision, expiry and a single use. It must send only that reviewed
public message plus fixed host instructions, with empty history, Memory, nickname,
connector and file context, rechecking revocation before dispatch and delivery.
Persisted policy alone must never enable that transport after an upgrade.

## Compatibility and rollback

The new optional preference file does not rewrite worker settings, credentials,
MCP tokens, history, Google stores or existing private data. Older backends expose
no selector. Disconnected and paused frontends disable its mutations. There is no
new public MCP capability or inference API. The CLI supports /provider qwen,
claude, consent, revoke and --json. Consent uses the existing detached terminal.

Use /provider qwen before source rollback; preserve the optional file and all
existing data. Source rollback requires preserved preimages and idle service
checks. Activation follows the existing credential-preserving managed lifecycle
only after independent review. Tests are synthetic and narrowly scoped; they do
not qualify Claude or authorize any external traffic.
