# ADR 0011 — Conversation Engine and intelligent intent routing

- Status: Accepted
- Date: 2026-10-07
- Review: Two independent boundary source reviews completed; owner explicitly approved reviewed PR #19 for normal merge and local installation on 2026-10-07.
- Supersedes: Ordinary authenticated chat/Mission semantics only in
  [ADR 0007](0007-local-interactive-missions.md) and
  [ADR 0010](0010-personal-assistant-and-qualified-routing.md)
- Affected components: Conversation Engine, operator intent/service ingress,
  Mission drafts, Memory content-erasure registry, secure Vault guide, terminal
  and authenticated Control Center

## Why the prior decision must change

The earlier operator path registered a signed reasoning Mission for each ordinary
question and required work verification, Acceptance and Settlement for its
answer. A greeting or explanation does not request governed execution. The owner
requests natural persistent conversation while retaining the existing authority
boundary for real work and explicit Missions.

## Replacement decision and alternatives

Authenticated ordinary input uses a host-owned Conversation Engine with durable
operator/channel sessions and text-only local inference. It creates no Mission,
Task, execution lease, independent work verification, Acceptance or Settlement.
Explicit Missions and work requests continue through the governed control plane.
The terminal keeps its existing wave/fish renderer; ordinary answers show prose
without work status or technical review instructions.

The host routes deterministic CONVERSATION, MEMORY, VAULT, CONNECTOR, WORK and
EXPLICIT MISSION intents before calling a model. Ambiguous requests ask a brief
clarification. Explicit Mission requests cannot become ordinary chat. Model
output, prior history and retrieved references cannot grant capabilities or
mutate routing. Retaining a Mission for every question would preserve the old
operational overhead. Letting a model choose or grant capabilities would weaken
the host boundary. Both alternatives are rejected by this proposal.

## Authority, privacy and ownership

Direct inference admits only the configured qualified local model after current
expiry, digest and template evidence checks at admission and delivery. It uses the fixed loopback provider,
no execution worker and no tools; tool requests and credential-like output fail
closed. The inference deadline, bounded context and cancellation cover the entire
turn. This does not qualify a discovered model or optional worker by itself.

Host-issued conversation/turn UUIDs bind the authenticated operator. Request
replays require a matching digest of the message, Memory choice, model and
selected context, with current canonical references. Ordinary relevant Memory
and completed prior turns are bounded, with older history trimmed when necessary.
Transitive Memory IDs preserve correction/erasure effects on derived answers.
Canonical eligibility and erasure barriers apply before reuse, persistence and
delivery; interrupted inference is cancelled on restart. Prompts/responses are
erasable private-store content. Safe audit events retain opaque identity/model
and lifecycle metadata only; hidden reasoning is excluded. A nickname is a
dedicated bounded assistant preference, never a sensitive personal fact or an
override of identity, security or authority.

Work classification describes requested capability classes and the terminal's
workspace context; neither grants execution. Only an existing host-registered
bounded template can create and dispatch executable work. Otherwise the host
creates a canonical `work_request` draft with zero budget and no Task, lease or
dispatch. Draft dispatch, verification and Acceptance fail closed. Execution
requires a distinct fully scoped registration and the existing immutable scope,
qualification, ownership, privacy, independent verification, Acceptance and
Settlement gates. Mission controls use the canonical operator owner; ambiguous
current-Mission selection requires a choice.

The secure Vault guide detaches ordinary readline and uses the reviewed no-echo
reader for the entire workflow. Host-generated non-sensitive names and active
operator-purpose references use the existing Keychain-backed store and
revocation/disposition rules. No credentials cross chat, model context, command
arguments, logs or ordinary readline. Non-interactive entry and unavailable
Keychain support fail closed before accepting a value.

Gmail read requests use existing authorization, with an explicit OAuth offer
when authorization is missing or revoked. The router does not silently consent
to a new account. Connector summaries/previews use a fresh isolated conversation,
minimum selected untrusted excerpts, no Personal Memory and no prior chat
history. Existing read-only scopes and denial of remote mutations remain in
force. WhatsApp retains its existing authorized official inbound limits.

## Compatibility, migration and rollout

The change adds private conversation/preference tables and erasable content
classification to the existing store. Existing Memory, Vault and connector data
are preserved; credentials are not copied. Existing governed conversation
Missions, explicit MCP Mission contracts and their provenance remain readable
and governed. They are not retroactively converted to direct chat. Kernel/SDK
version identifiers are unchanged by this additive operator ingress proposal;
its reviewed authority distinction is recorded here.

This proposal supersedes only the ordinary authenticated chat/Mission semantics
of ADRs 0007 and 0010. Their work authority, qualification, sensitive data,
connector, ownership and explicit Mission contracts remain applicable. Their
historical reasoning is preserved. The new decision remains Proposed until
maintainer disposition; installation respects existing command/source ownership
and active-work guards. Release, deployment, publication and production activation
require their separate owner authorization.

## Consequences and validation

Conversation has a persistent natural interface with no execution admission.
The router and privacy boundary remain host-owned. Unsupported or insufficiently
bounded work can be recorded as a draft, but cannot execute until registration
satisfies the existing gates. The current provider returns one bounded visible
response; streaming and optional worker qualification are outside this proposal.

Focused fixtures cover no-Mission direct chat, replay binding, qualified-model
denial, canonical Memory correction/erasure and late-result denial, nickname
separation, connector authorization and context isolation, secure input and
revocation, Mission draft guards/manual controls, and waiting-animation cleanup.
Affected startup/terminal checks use a synthetic text-only provider. These checks
do not prove live model, account or runtime qualification. Record exact-revision
results and any separately authorized local smoke in the implementation report.
Independent reviewers must assess authority/runtime and privacy/secret
boundaries; passing fixtures do not constitute maintainer approval.

## Rollback

Revert the operator ingress/UI change through the normal reviewed source path.
Preserve existing conversation/preference rows and erasure dispositions; do not
substitute an old database, delete Memory/Vault state or resume interrupted turns.
Keep request drafts non-executable and retain all existing governed Mission
history. A source rollback must not discard unrelated Gmail, Memory or animation
work or rewrite a live service's owning configuration.

## Outcome and history updates

Maintainer disposition is pending. After review, record the accepting review,
date and unresolved conditions. Do not mark the prior ADRs wholly Superseded:
this proposal replaces only their ordinary authenticated chat semantics.
