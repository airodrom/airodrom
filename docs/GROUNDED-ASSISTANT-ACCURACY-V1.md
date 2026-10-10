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

- No new AI architecture milestone, Mission authority changes, Memory consent changes, Automatic Acceptance, or WhatsApp production activation.

## Shipment (2026-10-10)

- **MERGED IN SOURCE:** PRs [#56](https://github.com/airodrom/airodrom/pull/56) (feature) and [#57](https://github.com/airodrom/airodrom/pull/57) (package allowlist for `conversation-grounding.js` + docs/tests).
- **Feature tip:** `2ef5ba8` (tree-equivalent to expected `2e18107`, without editor attribution trailer).
- **`origin/main`:** `fe918ccae9053c70bf9b6c9dfedfe5f9027590b1`.
- **INSTALLED LOCALLY:** `…/airodrom-grounded-accuracy/install/airodrom-grounded-accuracy-fe918cc` (371-file npm pack).
- **LIVE VERIFIED:** Control Center browser-channel Qwen restated host-verified active/current distinctly; authorized Development Session branch/integration echoed; Vault route blocked credential-shaped chat; personal Memory consent preserved; Mission activity unchanged.
- **PUBLIC ACTIVATION OFF** · Automatic Acceptance OFF · WhatsApp HOLD.

## Validation

- Focused: `tests/conversation-grounding-v1.test.js` (4/4), ConversationEngine grounding subtest, credential/operator-screening cases in authenticated-research routing.
- Live local Qwen: host facts `active=0` / `current=62` (authoritative at acceptance; not hardcoded for future briefs); Development Session `feat/ds-continue-session-v1` / `PR_OPEN`; no “62 active Missions” claim.
