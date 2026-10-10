# Everyday Personal AI UX V1

Local-first Control Center and macOS menu improvements for daily personal AI use. Reuses ConversationEngine, Continue Development Session, and the recovered premium Control Center (atmosphere, SKY, themes, navigation). No new Mission framework.

## Status

| Claim | State |
| --- | --- |
| LOCAL FEATURE BRANCH | Yes — `feat/everyday-personal-ai-ux-v1` @ `0142ab9` |
| MERGED TO `origin/main` | Yes — PR [#54](https://github.com/airodrom/airodrom/pull/54) merge `5e23731121d95822255dbef0c257b34d77afb24f` |
| INSTALLED LOCALLY | Yes — `…/airodrom-everyday-ux/install/airodrom-everyday-ux-5e23731` |
| LIVE VERIFIED | Yes — Control Center assets + Qwen turn + menu rebuild |
| PUBLIC ACTIVATION | OFF (WhatsApp HOLD unchanged) |

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

## Installation evidence (2026-10-10)

- **Feature tip:** `0142ab9066eed974ece96eeb0eb228d21395a6d1`
- **Merge on `origin/main`:** `5e23731121d95822255dbef0c257b34d77afb24f`
- **Package:** `1.0.1-rc.1` · 367 files · archive SHA-256 `82df832e9d09365d871db9e899a6bb45cd6f53cf0a9c2d28c45a1fd1f3a145bd`
- **Install root:** `/Users/andrew/Documents/Codex/2026-10-10/airodrom-everyday-ux/install/airodrom-everyday-ux-5e23731`
- **Prior source:** `…/airodrom-ds-continue/install/airodrom-ds-continue-c701289`
- **Backup/rollback:** `~/.airodrom/backups/everyday-ux-v1-20261010T181626Z`
- **Live:** Control/OpenCode/Memory/Provider Ready · hub/css/panel/atmosphere HTTP 200 with Everyday UX markers · menu helper rebuilt · Automatic Acceptance OFF · WhatsApp HOLD
- **Qwen:** `ollama/qwen3-coder:30b` completed marker `everyday-ux-ship-ok`
- **Focused tests:** `everyday-personal-ai-ux-v1` + continue panel **7/7**
- Operator checkout `/Users/andrew/code/airodrom` preserved.

## Limits

- Claude conversation remains WAIT / OFF for inference until independently qualified.
- WhatsApp production HOLD unchanged. Automatic Acceptance OFF.
- Menu helper must be rebuilt from the installed source after cutover (`prepare-local-menu`).
- Start-new / Claude-unavailable Control Center corrections are shipped in [Conversation UX Bugfix V1](CONVERSATION-UX-BUGFIX-V1.md) (installed `airodrom-conversation-ux-bugfix-52e1003`).
