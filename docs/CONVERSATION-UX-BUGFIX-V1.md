# Conversation UX Bugfix V1

Fixes two Control Center usability defects observed on the installed Grounded Accuracy release. Reuses ConversationEngine, provider policy, and existing Conversation controls. No ConversationEngine redesign.

## Problems

1. **Start new conversation** — UI notice said a new conversation was ready, but the status line still showed `Continuing session … · N retained turns` because refresh auto-restored the latest browser session after the tab cleared local state.
2. **Claude selection** — Claude was labeled `subscription · WAIT until qualified`. Selecting it looked like activation, then fell back to Qwen without an explicit unavailable explanation.

## Root causes

1. After Start new, `refresh()` called `conversationSession()` without `new:true` whenever `conversationSessionId` was null, reattaching the latest host browser session and reloading its history. Pending-new intent was not persisted across reload.
2. Conversation model picker called the provider preference API for Claude and used activation-shaped copy. `refresh()` / `clearMemory()` could also wipe a notice set before refresh completed.

## Fix (Control Center only)

- Track `pendingNewConversation` in memory and `sessionStorage` (`airodromConversationPendingNew`).
- Remember the prior browser session id for Continue previous (`airodromPreviousConversationSession`).
- Skip auto-restore and history fetch while pending new; first send uses `session({ channel:'browser', new:true })`.
- Label Claude `unavailable · WAIT until qualified`; refuse activation; keep Qwen as the working provider; set the unavailable notice after refresh.
- Host history for the previous conversation id remains unchanged.

## Status

| Claim | State |
| --- | --- |
| LOCAL FEATURE BRANCH | Yes — `fix/conversation-ux-bugfix-v1` |
| MERGED TO `origin/main` | No |
| INSTALLED LOCALLY | No — live package remains `airodrom-grounded-accuracy-fe918cc` (hot-patch verify only; restored) |
| LIVE VERIFIED | Yes — installed Control Center hot-patch browser evidence (then restored) |
| PUBLIC ACTIVATION | OFF |

## Validation

- Focused: `tests/conversation-ux-bugfix-v1.test.js`, `tests/conversation-ux-bugfix-browser.cjs`, Everyday UX contract still green.
- Installed hot-patch browser: Start new clears continuing line; refresh keeps pending new; Continue previous restores prior session; Claude unavailable message keeps Qwen selected.

## Limits

- Not installed into the running package until a later authorized maintenance cutover.
- Claude conversation remains WAIT / OFF for inference until independently qualified. No API-key or subscription workaround.
- WhatsApp HOLD and Automatic Acceptance OFF unchanged.
