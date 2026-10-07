# Authenticated Browser Session Handoff V1

Use `airodrom`, then:

> I'm already logged in to Monarch; inspect my account

Or use `/research login https://app.monarch.com/` for the deterministic dedicated-profile flow. Choose dedicated login or cancel. Normal Chrome authentication is not inherited. External Chrome attachment is unavailable in V1; supported remote debugging of separate profiles exists, but arbitrary local endpoint ownership has not been qualified.

A visible, isolated Chrome profile opens only after explicit authorization. Sign in manually and complete MFA in that window, then confirm hand-back in Terminal. Airodrom begins read-only investigation within the signed three-minute Mission budget. Each future reuse requires fresh consent. Browser profile storage stays private and local; no password or cookie is imported or exported by this workflow.

The report retains fixed navigation feature labels only. Private screenshots, financial text, raw network metadata, downloads, exports, settings changes, payments, account mutations and external model calls are disabled. Current Arecibo baseline files and HEAD are verified using existing host registration. Account navigation labels are observations; underlying functionality remains unverified and inaccessible areas remain unknown. Recommendations cannot implement themselves.

V1 intentionally blocks all redirects, extra domains, query parameters, encoded paths and POST data APIs such as GraphQL. Only fixed same-origin login POST endpoints are admitted during human login. A competitor requiring OAuth, external APIs or unrecognized endpoints may fail to sign in or render. Real Monarch login has not been qualified. On an MFA/CAPTCHA challenge during automated investigation, inspection stops safely; complete human takeover through a fresh consented Mission. Cancellation and deadline closure preserve the dedicated profile and quarantine uncertain termination.

## Targeted qualification

Seven focused checks passed, with zero skips or failures. The package allowlist check passed with no forbidden files. Implementation evidence is limited to synthetic checks: exact domain/method/path policy, explicit consent, no external attach or credential export, profile permissions and owner locking, canonical hand-back and cancellation, independently verified sanitized report evidence, no model calls, and a visible persistent Chrome smoke that closes and reuses only its own synthetic profile. No real competitor account or account mutation is exercised. Required independent review and normal merge remain pending.

[Architecture decision](adr/0015-authenticated-browser-session-handoff.md)

Remote inspection found no active branch protection or repository rulesets; the existing candidate workflow is manually disabled. No hosted workflow or broad local regression suite was started. Independent privacy/authority review is still required by repository governance before merge/reinstall.

The current main branch was merged into the isolated PR worktree after the concurrent private-storage routing change landed. Two specifically selected private-routing checks also passed. ADR numbering uses 0015 to preserve main’s accepted ADR 0014. Main and installed service were not modified by this task.
