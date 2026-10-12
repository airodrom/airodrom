# Conversation UX Bugfix V1

Fixes two Control Center usability defects observed on the installed Grounded Accuracy release. Reuses ConversationEngine, provider policy, and existing Conversation controls. No ConversationEngine redesign.

## Problems

1. **Start new conversation** — UI notice said a new conversation was ready, but the status line still showed `Continuing session … · N retained turns` because refresh auto-restored the latest browser session after the tab cleared local state.
2. **Claude selection** — Claude was labeled `subscription · WAIT until qualified`. Selecting it looked like activation, then fell back to Qwen without an explicit unavailable explanation.

## Root causes

1. After Start new, `refresh()` called `conversationSession()` without `new:true` whenever `conversationSessionId` was null, reattaching the latest host browser session and reloading its history. Pending-new intent was not persisted across reload.
2. Conversation model picker used activation-shaped Claude copy. Notices set before `refresh()` could be wiped by `clearMemory()`.

## Fix (Control Center only)

- Track `pendingNewConversation` in memory and `sessionStorage` (`airodromConversationPendingNew`).
- Remember the prior browser session id for Continue previous (`airodromPreviousConversationSession`).
- Skip auto-restore and history fetch while pending new; first send uses `session({ channel:'browser', new:true })`.
- Label Claude `unavailable · WAIT until qualified`; refuse activation; keep Qwen as the working provider; set the unavailable notice after refresh.
- Host history for the previous conversation id remains unchanged.

## Status

| Claim | State |
| --- | --- |
| LOCAL FEATURE BRANCH | Yes — `fix/conversation-ux-bugfix-v1` @ `3a37c40` |
| MERGED TO `origin/main` | Yes — PR [#60](https://github.com/airodrom/airodrom/pull/60) merge `52e1003caa64b6f7f2660b7650006c324ce1ccbc` |
| INSTALLED LOCALLY | Yes — `…/airodrom-conversation-ux-bugfix/install/airodrom-conversation-ux-bugfix-52e1003` |
| LIVE VERIFIED | Yes — installed Control Center Start new / refresh pending / send / Continue / Claude→Qwen |
| PUBLIC ACTIVATION | OFF |

## Shipment (2026-10-10)

- **Feature tip:** `3a37c40898251b060a5390ca52f2db79ad5188f0`
- **PR:** [#60](https://github.com/airodrom/airodrom/pull/60) **MERGED**
- **`origin/main`:** `52e1003caa64b6f7f2660b7650006c324ce1ccbc`
- **Package:** `1.0.1-rc.1` · 372 files · tarball SHA-256 `8d0d3a9e932ba1866edda9ca5679f49e4e9bc135d58adba04a77f74bd7255743`
- **Install root:** `~/Documents/Codex/2026-10-10/airodrom-conversation-ux-bugfix/install/airodrom-conversation-ux-bugfix-52e1003`
- **Prior source:** `…/airodrom-grounded-accuracy/install/airodrom-grounded-accuracy-fe918cc`
- **Backup/rollback:** `~/Documents/Codex/2026-10-10/airodrom-conversation-ux-bugfix/backup/pre-conversation-ux-bugfix-20261010T193433Z`
- **Live:** Control/OpenCode/Memory/Provider Ready · Qwen `ollama/qwen3-coder:30b` · Start new clears continuing line · pending-new survives refresh · first send creates distinct session · Continue previous restores history · Claude unavailable notice keeps Qwen · missions **71** · personal_memories **6** · Automatic Acceptance OFF · WhatsApp HOLD
- **Focused tests:** `conversation-ux-bugfix-v1` + browser + Everyday UX **11/11**
- Operator checkout `~/code/airodrom` preserved.

## Limits

- Claude conversation remains WAIT / OFF for inference until independently qualified. No API-key or subscription workaround.
- WhatsApp production HOLD unchanged. Automatic Acceptance OFF.
