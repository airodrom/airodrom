# Google Calendar Integration & Natural-Language Control V1

## Purpose

Everyday Calendar requests are **host-routed** through a dedicated Google Calendar connector. OpenCode must not invent Calendar access or silently drop deterministic Calendar asks.

## Regression closed

Phrases such as **“yes i want you help me to control calendar”** previously fell through to tool-free conversation. The model then answered generically while Calendar remained unenrolled. That was a **routing** failure.

## OAuth (separate from Gmail)

| Item | Value |
| --- | --- |
| Read consent | `/connect calendar` → `https://www.googleapis.com/auth/calendar.readonly` |
| Write consent | `/connect calendar manage` → `https://www.googleapis.com/auth/calendar.events` |
| Vault purpose | `calendar` (never the Gmail token slot) |
| Callback | `http://127.0.0.1:<port>/oauth/calendar/callback` |
| Desktop client | Same owner Google desktop client as `airodrom gmail setup` (client secret may resolve from the Gmail vault purpose) |

**Gmail `gmail.readonly` does not grant Calendar.** Broader historical workspace grants are not reused for Gmail; Calendar enrolls independently with operator consent.

### Status vocabulary

| State | Meaning |
| --- | --- |
| configured | Desktop client wiring present for Calendar |
| token_present | Vault reference exists |
| connected | Token appears usable |
| live_qualified | Successful bounded Calendar API read/search/freeBusy in this process |

## Supported natural language

- Help / control / manage my calendar (capability + auth state)
- What’s on my calendar today/tomorrow · Show my schedule
- Am I free Friday afternoon? (FreeBusy)
- Search calendar for …
- List calendars
- Create event \<title\> tomorrow 14:00 to 14:30 → **preview** then `/calendar confirm <id>`
- Move / duration / cancel follow-ups resolved only from **previously verified** results
- Destructive cancel: `/calendar confirm <id> --destructive`

Ambiguous creates/cancels ask for the missing detail. Invitation bodies and event descriptions are never executable instructions.

## Writes and policy

MCP `calendar_*` capabilities in `config/capability-policy-v2.json` remain `active: false` until a worker MCP adapter exists. **Host** NL/CLI Calendar writes:

- Require `calendar.events` manage consent
- Stage a preview (no Google mutation yet)
- Create/update confirm with `/calendar confirm <id>`
- Delete/cancel requires `--destructive`
- Attendee bulk invites are out of auto path (NEVER_AUTO / approval)

## Failures

| Class | Presentation |
| --- | --- |
| Calendar OAuth / API | `connect_required` or Calendar error — not OpenCode `provider_unavailable` |
| OpenCode down | Deterministic Calendar reads still succeed |
| Ordinary chat failure | Remains conversation classification |

## Credential screening note

Empty/ZWSP-only lines are rejected as invalid input (not “Credentials typed in chat”). Calendar control phrases are regression-tested against secret false positives. Real password/token pastes still fail closed via `/vault`.

## Live acceptance (after authorized install)

1. Owner `/connect calendar` consent  
2. Bounded events or freeBusy read → `live_qualified`  
3. Service restart → token refresh without unnecessary re-consent  
4. Optional `/connect calendar manage` + preview create when separately authorized  

Do not claim LIVE from mocks alone.
