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

**Gmail `gmail.readonly` does not grant Calendar.** Broader historical workspace grants are not reused for Gmail; Calendar enrolls independently with operator consent. Stage A Gmail write consent (`/connect gmail send|manage`) is likewise separate from Calendar manage — see `docs/GOOGLE-WORKSPACE-STAGE-A-V1.md`.

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
- Am I free Friday afternoon? (FreeBusy — fails closed if Google omits the calendar or returns errors)
- Search calendar for …
- List calendars
- Create event \<title\> tomorrow 14:00 to 14:30 → **preview** then `/calendar confirm <id>`
- Move / duration / cancel follow-ups resolved only from **previously verified** results in **this** Terminal conversation
- Generic “show more” / “cancel that” only with an active verified Calendar session (do not continue Gmail pagination)

## Session binding

Selection, pagination, and pending writes are keyed by `operator` + conversation UUID. Missing or mismatched Terminal session identity fails closed. One conversation cannot continue or confirm another conversation’s Calendar state.

## Writes and policy

MCP `calendar_*` capabilities in `config/capability-policy-v2.json` remain `active: false` until a worker MCP adapter exists. **Host** NL/CLI Calendar writes:

- Require `calendar.events` manage consent
- Stage a conversation-bound preview (no Google mutation yet)
- Create/update confirm with `/calendar confirm <id>`
- Destructive cancel requires **independent** `/calendar approve <approval_id>`, then explicit owner confirmation with `/calendar confirm <preview_id> --destructive`. A textual `--destructive` flag alone is not sufficient.
- Updates/cancels verify the **queried calendar id** (not organizer email) before mutating
- Create success is host-recorded for local replay only — Google does not provide create idempotency; uncertain responses leave the preview available and never claim provider dedupe
- Attendee bulk invites are out of auto path (NEVER_AUTO / approval)

## Date / time

- Start must be strictly before end (including all-day date-only values)
- Timed reschedule of all-day events is refused in V1
- List uses `singleEvents=true` so recurring instances are expanded; exception handling is limited to verified instance ids from the list
- Local day windows use the host clock; DST shifts follow the platform `Date` rules for the operator machine

## Failures

| Class | Presentation |
| --- | --- |
| Calendar OAuth / API | `connect_required` or Calendar error — not OpenCode `provider_unavailable` |
| Incomplete free/busy | Clarify — never claim free without complete verified evidence |
| OpenCode down | Deterministic Calendar reads still succeed |
| Ordinary chat failure | Remains conversation classification |

## Credential screening note

Empty/ZWSP-only lines are rejected as invalid input (not “Credentials typed in chat”). Calendar control phrases are regression-tested against secret false positives. Real password/token pastes still fail closed via `/vault`.

## Coexistence with Gmail NL Search

Gmail search (#234) and Calendar NL control share assistant routing. Active-session flags keep generic “show more” bound to the connector that owns the conversation’s verified session. Both features remain independently gated until their merge order is verified.

## Live acceptance (after authorized install)

1. Owner `/connect calendar` consent  
2. Bounded events or freeBusy read → `live_qualified`  
3. Service restart → token refresh without unnecessary re-consent  
4. Optional `/connect calendar manage` + preview create when separately authorized  

Do not claim LIVE from mocks alone.
