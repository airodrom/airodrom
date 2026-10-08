# Universal Browser V2 — local operator guide

Use `/browser open https://app.monarch.com/` or `/research login https://app.monarch.com/` in Airodrom. Review the site, purpose, connection and temporary permission before approving. The browser menu offers:

1. Existing Chrome — unavailable in Airodrom until its scoped Chrome 144+ consent adapter is qualified.
2. Owned loopback CDP — explicitly starts and verifies a separate Airodrom debugging profile. Existing external endpoints cannot be attached.
3. Dedicated browser — isolated persistent site profile; reuse requires fresh owner consent.
4. Regular Chrome — human-guided inspection, without Airodrom automation or collected findings.
5. Human login — same-site login and supported MFA in the dedicated browser. External OAuth, popups and dedicated passkeys are unavailable; use regular Chrome for these.
6. Extended public browsing — separate fresh public-only research, bounded by the Mission deadline.
7. Cancel.

Strict is read-only. Authentication allows only fixed human-controlled same-site login POST until hand-back or expiry. After manual sign-in, confirm hand-back in Terminal or Control Center. Airodrom stops login traffic and inspects only fixed navigation categories. No private financial text or screenshots enter reports or models. Unknown identity/GraphQL POST cannot be authorized by a website or by choosing Extended.

Use `/browser options`, `/browser sessions`, `/browser status [mission-id]`, `/browser permissions [mission-id]`, `/browser revoke [mission-id]`, `/browser diagnostics [mission-id]` and `/browser close [mission-id]`. Revoke and close immediately stop authority and close owned browser resources. Status distinguishes closed from unverified termination; quarantine requires explicit reconciliation. The shell command `airodrom browser options` shows configuration availability without starting a service or accessing Chrome.

Any qualified Mission can use `/mission web on|off|all|status|revoke [mission-id]`. `on` is Strict exact public sites; `all` is Extended public discovery from approved starting sources and verified evidence links. Signed grants intersect the immutable Mission authority and deadline. The operator API accepts a downward-configurable `duration_ms`, with Extended capped at 900000 ms; default and standalone research are three minutes. Actions, pages, domains, requests and bytes have independent bounded budgets. Expiry never grants account access.

Search currently has no qualified provider and PDF has no qualified reader. Explicit public HTTPS source browsing, screenshots, accessibility projection, HTML/text reading and safe functionality observations remain broker-controlled. Functionality results distinguish navigation observed from forms untested and mutations denied. Reports distinguish observed, documented, inferred and inaccessible evidence; a navigation label does not prove a working feature. Recommendations compare with current approved Arecibo docs/code and require a separate implementation request.

The prior Google-button failure has multiple demonstrated policy blockers: window.open returns null, external identity origins/queries/POST are denied, and redirects are checked before follow-up. ERR_BLOCKED_BY_CLIENT reports sanitized method/resource/reason metadata. The earlier observed static.monarch.com asset and monarch.com/www.monarch.com root repairs remain explicitly consented. No real account was used for qualification; third-party cookie, provider anti-automation and actual Monarch login behavior remain unverified.

Local synthetic validation covers both connection modes, profile isolation and reuse, exact consent, expiry/revocation, authority binding, every redirect/method boundary, no private credential/evidence leakage, budget exhaustion, verified process termination, uncertain-status reporting and changed Control Center controls. No hosted Actions, publication, release, tag, deployment or production activation is part of this change.
