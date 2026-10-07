# Conversation Engine & Intelligent Mission Routing V1

This candidate separates ordinary operator conversation from governed work. `Hi`,
`Who are you?`, explanations and brainstorming use persistent local conversation
turns. They create no Work Mission, Task, execution lease, work verification,
Acceptance or Settlement. The terminal shows the visible answer with the existing
wave/fish waiting animation. `/status`, `/details` and Control Center retain
technical information; Mission progress appears for actual work.

## Host-owned routing

The deterministic router handles authenticated operator input before inference and again before delivering a completed response.
Its classification requests an operation; it never grants a capability.

| Route | Example | Behavior |
| --- | --- | --- |
| CONVERSATION | `Hi` or `Explain this concept` | Direct qualified local text response. |
| MEMORY | `Remember I prefer concise answers` | Canonical Memory V2 operation; unknown data classes require clarification. |
| VAULT | `Let's save a password` | Guided secure terminal workflow. |
| CONNECTOR | `Check my Gmail` | Existing read-only connector or explicit authorization offer. |
| WORK | `Fix this repository` | Governed Mission, with execution admitted only through an existing bounded template. |
| EXPLICIT MISSION | `Create a Mission to audit Arecibo` | Mission control even when the objective sounds conversational. |

Ambiguous requests such as `Do this` ask a short clarification. The model has no
tools or routing authority. A nickname request such as `Your nickname is Airo`
updates a dedicated operator assistant preference, separate from Personal Memory.
The preference cannot change Airodrom's identity, security rules or authority.

## Conversation admission and privacy

The server issues operator-bound conversation and turn UUIDs. Terminal and browser
sessions resume their latest host-owned channel session. Request UUIDs are bound
to a digest of the message, Memory choice, model preference and selected context;
changed or erased replays are refused. Interrupted inference is cancelled on
restart rather than resumed or duplicated.

Direct conversation admits only the configured qualified local Ollama model.
Admission checks the qualification expiry and current model digest/template
evidence. Unknown, changed, expired or unavailable models fail closed. This path
selects no execution worker and cannot dispatch work. Inference stays on the fixed
loopback provider, with no tools, external inference or capability fallback.
Tool requests and secret-like output are refused.

Current ordinary Memory V2 references are selected only when relevant; Sensitive
Memory and Vault values are excluded. Context includes at most six bounded
ordinary references and six prior completed turns, trimming older history to the
24,000-byte request bound. Prior messages and retrieved content remain untrusted
reference data. Context records retain canonical Memory IDs and transitive links
from earlier turns. Canonical correction/erasure invalidates affected history and
derived answers, and current eligibility is rechecked before reuse and delivery.
Unrelated Memory changes do not automatically erase completed conversation.

Visible prompts/responses persist in the existing private SQLite store under the
content-erasure registry. Audit events contain opaque identities, model identity,
state and the absence of execution authority, not message text or hidden
reasoning. In-flight context changes deny the result. Cancellation aborts the
provider and the terminal clears the waiting indicator on completion, error or
Control-C. Private local storage does not imply field-level encryption.

## Work Missions

`/mission new [objective]`, `/mission list`, `/mission status [id]` and
`/mission cancel [id]` use canonical Work Mission control. Natural active-list,
status and cancellation requests use the same host path; multiple possible
current Missions require an explicit selection. `/task <mission.json>` remains
available for declared scope and registered verification.

A bare objective or current working directory cannot authorize filesystem or
external effects. With no single matching host-registered template, missing
qualification or unsupported capabilities, the host creates a canonical
`work_request` draft and explains the required scope. A draft has zero execution
budget, no Task/binding/lease/dispatch, and cannot execute, verify or accept. A
distinct scoped Mission must be registered through the existing path before
execution. A matching template retains its immutable workspace, files,
capabilities, worker policy and registered checks. Execution still applies
authority, privacy, qualification, ownership, independent verification,
Acceptance and Settlement.

## Secure Vault and connectors

`/vault` or `Let's save a password` opens the menu to save a password/API key,
list saved names, remove a secret or cancel. Ordinary readline is closed and
detached before the reviewed raw no-echo reader takes input. Pasted follow-up
lines are dropped at this boundary. Non-interactive entry fails closed; missing
Keychain support gives preparation guidance before accepting a value.

The existing Keychain-backed Secret Vault stores values. Names are generated by
the host, such as `Password` or `API key` plus an opaque reference suffix; the menu
lists/removes only operator-purpose entries. There is no second secret store or
value-reveal command. Credentials never enter chat, model context, shell
arguments, logs or ordinary readline. Removal rechecks the selected active entry
and uses existing revocation/disposition guards.

`Check my Gmail` uses the canonical read-only connector when authorized. Missing
or revoked authorization offers the existing `/connect gmail` OAuth flow; account
consent requires the operator's explicit action. The router never starts OAuth
silently. Selected summaries and reply previews use a fresh isolated conversation
with bounded untrusted excerpts, no Personal Memory and no prior chat history.
Previews do not send messages or create remote drafts. WhatsApp retains its
existing authorized official inbound foundation and capability limits.

## Evidence and integration status

Focused synthetic checks cover direct routing, replay/privacy/erasure, secure
input isolation, connector authorization, draft execution denial, Mission control
and unchanged animation cleanup. The existing startup and terminal-control
checks use an injected text-only provider; they do not establish live model,
account or worker qualification. Revision-specific local smoke results belong in
the implementation report.

This is a pre-release candidate. [ADR 0011](adr/0011-conversation-engine-and-intent-routing.md)
is Accepted after two independent boundary source reviews and explicit owner
approval of reviewed PR #19 on 2026-10-07. Local installation must respect the owning checkout, existing
command/source guards and active work. No release, publication, deployment or
production activation is authorized by this document.

### Candidate validation — 2026-10-07

The focused candidate passed 43 tests across `conversation-engine.test.js`,
`conversation-routing-v1.test.js`, `conversation-cli.test.js` and
`secure-vault-guide.test.js`. They cover canonical and personal Memory erasure,
transitive transcript invalidation, replay policy, admission concurrency,
qualification changes at delivery, disconnected-request cancellation,
read-only connector authorization, secure input isolation and draft execution
denial. Selected affected legacy conversation, startup and animation checks
also passed. The broad regression suite and hosted CI were not run.

A real pinned local Qwen3 Coder model answered `Hi` with a visible greeting in a
fresh synthetic fixture. The canonical store recorded zero Missions, runs,
leases, Acceptances or Settlements. No real account or personal context was
used. Fish glyphs appeared in captured waiting frames and the renderer is byte
identical to the prior approved version. Visual observation in macOS Terminal
has not been performed.

Two independent boundary source reviews completed. Replay-policy binding,
concurrent admission, unrelated-history retention, combined capability
classification, query relevance, restart tombstones and model qualification
at delivery were corrected. No unresolved material security finding remained.
These reviews are source review evidence and do not represent maintainer
approval. Both declared typechecks, public/source checks and package sanity
passed; dependencies and the lockfile are unchanged.

At qualification, the owning local main checkout and service stayed on the
previously approved fish revision while normal integration awaited approval. Existing Gmail work,
private homes, Memory and Vault data were preserved. No release, deployment,
registry publication or production activation was performed. ADR 0011 remains
Accepted following the owner’s explicit PR #19 review disposition.

## Conversational private storage repair (proposed)

The focused repair described in [ADR 0013](adr/0013-conversational-private-storage.md) recognizes greeting, nickname, polite and contraction prefixes before routing a save request. `Hi Airo, let's save my mailbox number 818.` opens a native choice between operator-only Sensitive Memory and a named Keychain Vault entry, followed by explicit confirmation. Asking `What's my mailbox number?` performs host lookup and asks for operator reveal confirmation. Quoted text, negation and ambiguous requests do not authorize storage. Credentials supplied in chat are refused and must be entered again through the native hidden-input Vault guide. Independent privacy and authority reviews are pending; this repair has not yet been approved for integration.
