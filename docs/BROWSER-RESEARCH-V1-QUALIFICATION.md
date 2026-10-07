# Browser Research V1 qualification

Reviewed code candidate: `940e51d` (includes the normal merge of current main `33ba963`). This evidence document changes no executable behavior. The owner explicitly approved reviewed PR #24 for normal merge and local installation on 2026-10-07. Local installation is verified separately; these results do not authorize release, deployment or production activation.

## Focused checks

- Research browser, capability, credentials, canonical Mission lifecycle, baseline/report and intent routing: 50 cases, 48 passed, 2 opt-in real-browser cases skipped by the default invocation. The two opt-in cases were separately exercised with installed Chrome against synthetic public/account fixtures. They establish real browser isolation, not qualification of a competitor account.
- Merge compatibility: 21 conversation CLI, canonical speaker-name and inline private Vault cases passed. These include Memory name erasure, detached secure ingress, connector authorization, direct-chat cancellation and fish cleanup. Earlier focused conversation routing checks cover ordinary chat, Memory V2, explicit Missions and unavailable capabilities.
- Both declared authority and SDK type checks passed. Public source validation: 530 files, 399 syntax checks, 26 JSON checks, 180 references, zero errors. Package allowlist: 292 files, zero forbidden entries. The qualification document is included in the final source/package validation.
- The pinned production dependency audit found zero vulnerabilities. All 39 locked packages have permitted MIT/Apache licenses and no installation scripts. Playwright-core is the only new dependency; no browser engine download is performed.

A reproducible failure was resolved before the final combined run: a valid screenshot UUID could trigger the free-form credential detector when the entire Markdown report entered the canonical result summary. A deterministic UUID canary reproduced the six-action failure. The summary now holds bounded completion metadata; the authenticated immutable report retains all verified evidence references. The canary passes through independent Verification, explicit fixture owner Acceptance and Settlement.

The final lifecycle test also denies reads of excluded synthetic credential/export files and traps the legacy broad repository snapshot. Both counters stayed zero through Mission creation, execution, report, Verification and Acceptance. Browser research hashes only approved safe Arecibo source preimages; existing unrelated and dirty work is preserved.

## Live observations

These smokes ran during implementation before the final metadata and scoped-snapshot fixes. The final focused cases at `940e51d` cover those fixes; the live smokes were not redundantly repeated.

One canonical public research Mission used installed Chrome to investigate `https://example.com` and compare against current approved Arecibo repository evidence. It completed six native broker invocations, produced three immutable evidence rows including two real desktop/mobile screenshots, reached independent operator review, verified owned browser termination and retained zero held/quarantined leases. It remained awaiting owner Acceptance with no automatic Settlement. The current Arecibo baseline contained 16 safe sources at repository HEAD `b94545365cf3dceef331b7d60a244dc044ed4cc7`; unapproved files were excluded.

One qualified local-model greeting completed as direct conversation with zero Work Missions, execution leases, Acceptance or Settlement. Eight waiting frames contained the existing fish. The fish was detected in live terminal output; a native Terminal window was not visually inspected. The wave/fish renderer is unchanged by this candidate.

A focused Chrome Control Center smoke displayed the research header and all 11 actual phases without invented percentages or page errors. The public report projection preserves verified same-origin citations while dropping host paths and private values. Existing operator authentication protects report, evidence, account and download endpoints.

## Independent boundary review

Two independent non-maintainer reviews covered authority/runtime and privacy/evidence boundaries; overlapping implementation areas were cross-reviewed. Findings were resolved before qualification: mutation-shaped GETs and registration forms are denied; baseline snapshots exclude unrelated private files; private navigation uses fixed categories; reports and evidence are rehashed; termination is independently verified; read/write leases exclude conflicting writers; login and download approvals are exact and consumed once; public citations use an authenticated bounded projection. No unresolved source blocker was reported. These reviews are evidence and do not replace explicit maintainer approval.

## Limits

Public research is bounded to one approved HTTPS origin, 12 pages, 90 actions and 180 seconds. An installed Chrome engine and current canonical Arecibo baseline are required. Cross-origin resources can be inaccessible and are reported honestly.

Account research supports a purpose-bound existing-account standard POST login using two current Vault references. Credentials remain outside page DOM, model context, arguments, ordinary input, logs, screenshots and evidence. Account observations are limited to fixed navigation categories; authenticated screenshots and downloads are disabled. JavaScript-only/OAuth login, MFA and CAPTCHA stop for manual inspection; resumable live handoff is unavailable. No real credentials or competitor accounts were used in validation.

Account creation, payments, settings changes, deletion and other data mutations remain unsupported and fail closed. Public UTF-8 text/CSV/JSON downloads require exact approval and are limited to 48 KiB. Reports distinguish observations from claims and inference, retain unknown comparisons, and never automatically implement recommendations. Infrastructure cost estimates are assumptions, not measured vendor prices.

Remote rulesets currently impose no hosted checks; the existing public candidate workflow remains manually disabled under the repository fast-track policy. No hosted run or broad duplicate regression suite was started. The concrete maintainer disposition approves PR #24 for normal merge and local installation only.
