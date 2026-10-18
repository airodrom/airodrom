# Mission List Cleanup V1

[ADR 0057](adr/0057-mission-list-cleanup.md) extends the existing Mission visibility layer. Archive is a reversible presentation flag, never a Mission lifecycle transition or deletion.

## Lists and search

- **Active** includes unfinished work: drafts, ready/queued work, running, verifying, paused, blocked, rework, Acceptance and operator waits. Terminal records with unresolved safety obligations also remain actionable here. Historical conversation unread results retain their separate view.
- **History** includes completed, cancelled, and effectively archived records, including explicitly archived historical drafts and conversation results. Search by bounded title, ID, state or worker includes archived records. Paging and counts apply to the entire matching set.
- **Archived** is the archived subset. **All** includes every retained Mission. Live execution counts remain separate from the broader Active work list.
- `/mission list` defaults to Active. `/mission list history [search]` and `/mission list all [search]` query retained work history. The assistant list API returns a bounded page of 50, `total`, `has_more`, and `next_offset`; it accepts `filter`, `query`, and `offset`. Conversation records are excluded before pagination on this Work interface.

## Automatic housekeeping

The existing host MissionSupervisor scans at most 200 terminal candidates once per minute while admission is open. A keyset cursor prevents blocked early rows from starving later candidates. On restart the scan resumes from the beginning safely.

Only completed Missions with an explicit settled receipt, and cancelled Missions, qualify. Wait at least 24 hours after the latest Mission, settlement, or Run update. Never automatically archive drafts, ready, paused, blocked, rework, pending Acceptance, or unread conversation results. A restored visibility row pins the Mission against subsequent automatic archival, including after restart. It remains in History if terminal; restore does not resume execution.

Safety checks reject active or unverified Runs (including terminal rows without verified termination), unknown process ownership, active dispatch, held/quarantined leases, pending owner decisions/approvals/continuations, unsettled subscription accounting, unresolved external delivery, active autonomous claims, unfinished program dependencies and active repair descendants. Missing settlement does not imply success. Prior archive flags cannot conceal a Mission that later has unresolved safety obligations.

## Controlled cleanup

**Clean up history…** previews settled/cancelled candidates through `POST /api/product/organize-missions-preview`; the existing `organize-missions` route confirms it. The preview reports total eligible count, selected count and whether the bounded batch is truncated, including an exact-size batch without a false truncation warning.

Confirmation is bound to exact IDs, digest, kind and five-minute expiry. Eligibility, including settlement and safety, is rechecked inside the write transaction. A newly ineligible candidate rejects the whole batch without consuming the preview or partially archiving. Used, expired, substituted and mismatched previews are refused. The general `archive-missions` route accepts preview identity; multi-ID requests require a preview. Individual explicit archive remains available for obsolete drafts/rework and historical conversation results when safe.

All mutations retain existing authenticated operator and origin protections. Cleanup does not grant an execution permission, change Autopilot, accept a Mission, settle accounting, cancel work, release a lease, clear quarantine, or purge anything.

## Retention and recovery

Only `cp_mission_visibility` and existing preview bookkeeping change; archive/restore events append to the canonical ledger in the same transaction. Mission state, grants, Runs, dispatch, verification, Acceptance, settlement, budgets, subscription reservations, approvals, repair/program lineage and artifacts are preserved. Existing personal-content erasure remains authoritative: archive is not a new exemption from erasure or a physical backup guarantee. No new persistence schema or retention classification is introduced.

## Audit of current behavior and Routine Auto

The initial audit of current main found existing Active/History tabs and archive/restore APIs. History excluded archived rows; organize also admitted ready/draft/unread conversation rows; truncation assumed a fixed 200; confirmation rechecked general archive safety without rechecking settled eligibility. The CLI listed the most recent 100 records before filtering. These gaps are addressed here.

The separately prepared Routine Auto approval-gate repair remains awaiting authenticated local approval. The observed proposal is a projectless task sandbox with no dispatched Mission, registered file scope or measurable success criteria. It is not an implementation or a qualified repair. No duplicate task was prepared and no approval was granted by this cleanup.

Global Autopilot and Expanded Autonomy are separate controls: the former provides standing repository delegation, while Routine/Expanded Auto permits eligible verified work to be accepted under existing policies. Neither turns an unapproved projectless proposal into an authorized scoped Mission. This change leaves both mechanisms and all paid-worker, credential, production and destructive-operation gates unchanged.

## Validation and release

Run `tests/mission-list-cleanup.test.js`, Mission activity/API/lifecycle and archive regressions, plus `tests/mission-list-cleanup-browser.cjs` using the repository's declared Node runtime. Tests cover real fixture execution, independent verification and Acceptance/settlement; byte-for-byte canonical evidence preservation; restart/restore; safety denials; stale confirmation; API authentication; search/count/pagination; desktop and mobile UI.

These are synthetic fixture checks, not live worker qualification. Follow the existing full release policy and managed rollback-capable installation process. No install should occur while release gates fail or host-owned work prevents safe maintenance. No live data is purged during rollout or rollback.

### Local release gate observations

The focused cleanup/API/activity/supervisor suite passes 37/37, and the desktop/mobile browser flow passes. Authority and SDK type checks, source/docs verification, package inspection, dependency/license audit, and reproducible archive comparison pass. Native menu compilation and helper checks pass with the installed Xcode SDK selected explicitly; the ambient SDK belonged to a newer incompatible compiler.

The repository-wide regression run is not green. Automatic fallback/Acceptance failures and the unqualified-executable CLI failure reproduce on untouched main. The additional provider/private-key scanner also reports an unchanged fixture at `tests/opencode-process-failure.test.js:29` and its historical blob; the standard recognized directory/history scans are clean. No scanner exception or authority change was added to clear these failures. Remaining full-suite failures require separate triage and exact-head validation. Source-only status: no merge, managed install, runtime restart or live Mission cleanup is claimed.
