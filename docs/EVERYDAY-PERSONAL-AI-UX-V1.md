# Everyday Personal AI UX V1

Local-first Control Center and macOS menu improvements for daily personal AI use. Reuses ConversationEngine, Continue Development Session, and the recovered premium Control Center (atmosphere, SKY, themes, navigation). No new Mission framework.

## Status

| Claim | State |
| --- | --- |
| LOCAL FEATURE BRANCH | Yes — `feat/everyday-personal-ai-ux-v1` |
| MERGED TO `origin/main` | No |
| INSTALLED LOCALLY | No — installed release remains Continue DS `c701289` |
| LIVE API VALIDATED (installed) | Yes — Qwen conversation + Continue Development Session resolve |
| FOCUSED CONTRACTS | Yes — `tests/everyday-personal-ai-ux-v1.test.js` |

## Improvements

### Conversation

- Visible Conversation model glass and model selector (Qwen default local; Claude WAIT).
- Persistent browser session with Continue previous / Start new conversation.
- Clear Memory consent status (ON/OFF) plus checkbox.
- Honest model activity (idle / waiting / streaming) and reconnect notices.
- Still routes through ConversationEngine (`/api/assistant/input` + history).

### Missions

- Cards show active work, assigned worker, verified latest activity, pending approval, verification / Acceptance / Settlement.
- Direct **Open Observatory** action. No fabricated progress.

### Development Sessions

- Continue Development Session remains the sole continue control.
- Clarity for repository, branch, worktree, assigned worker, next permitted action, execution state.

### macOS menu (Menu V2 preserved)

- Open Conversation
- Active Missions
- Continue Development Session (deep-link to Development Sessions)
- System Health → Open System Health
- Open Control Center

Deep links use allowlisted `local.open({ view })` targets: Conversation, Missions, Development Sessions, System Health.

## Validation

- Focused: `node --test tests/everyday-personal-ai-ux-v1.test.js tests/development-session-continue-v1.test.js` (7/7).
- Installed product (`airodrom-ds-continue-c701289`): Qwen turn completed with model `ollama/qwen3-coder:30b`; Development Session `2eb98c6a` resolve reused existing session (`PR_OPEN`, no new Mission).
- Operator checkout `/Users/andrew/code/airodrom` preserved.

## Limits

- Everyday UX hub/menu assets are not on the installed release until an authorized install checkpoint.
- Claude conversation remains WAIT / OFF for inference until independently qualified.
- WhatsApp production HOLD unchanged. Automatic Acceptance OFF.
