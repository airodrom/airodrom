# Universal Mission Web V1

Public browsing belongs to the Mission. Airodrom owns the browser and network transport; worker models request typed actions and receive verified public references.

- “Airo, search the web for Canadian fintech competitors” offers bounded public discovery and a public query. Search stops honestly when no approved source is available.
- “Explore monarch.com and example.com” offers exact-site public browsing.
- `/mission web on [mission-id] [HTTPS URLs]` approves public sites for a qualified Mission.
- `/mission web all [mission-id] [HTTPS URLs]` approves discovery from verified links within that Mission's budget.
- `/mission web off [mission-id]` revokes the web grant and stops its current web operation.
- `/mission run [mission-id]` dispatches a ready/blocked eligible Mission after its required scope is approved.
- `/research search <query>` and `/research explore <URLs>` open the same public permission workflow.
- `/research login https://app.monarch.com/` opens the dedicated-profile consent flow. Review the displayed exact Monarch static-resource/root-redirect scope, sign in manually, complete MFA, then confirm hand-back.

Grants expire within three minutes and permit at most eight pages, eight public origins, forty typed actions, one hundred requests and eight MiB of bounded content/evidence. Initial sources and public queries come from authenticated operator intent. New top-level URLs must be initial sources or links obtained from verified evidence. Private/login/mutation URLs and credentials in query/path data stay denied. On requires separate scope approval for an unknown domain; all only permits bounded public discovery. Login, private documents, account mutation and payment are never implied by all.

Coding Missions automatically select web preflight from their objective. Eligibility requires an explicit unexpired authority ceiling with internet and data-read permission, the current canonical task/Run, and the qualified local host/OpenCode route. Missing policy blocks before worker execution. Existing offline/read-only authority cannot be edited by this command. Register a fresh properly scoped Mission. OpenCode's direct web/browser tools and external networking remain denied; it may submit typed public evidence requests for host execution. Model proposals and website content never grant authority.

Reports distinguish observed navigation/rendering, documented claims, inferred comparison and inaccessible areas. Existing Arecibo research uses its current registered repository/doc baseline. Screenshots are public-only immutable evidence. A reported navigation test does not establish a working financial feature. Recommendations remain proposals; independent verification and owner Acceptance/Settlement are mandatory.

## Qualification limits

The fixed DuckDuckGo HTML source adapter is implemented but disabled in `config/mission-web-v1.json`: its live uncredentialed probe required human verification. No search provider is currently qualified for installed live use. A missing source produces a truthful stop. Synthetic source tests qualify policy/provenance behavior only.

Public PDF extraction fails explicitly until a pinned local reader and its sandbox are independently qualified. No reader is currently qualified on this machine, so live PDF extraction is unavailable. HTML and UTF-8 public documents are supported. No private financial download is allowed.

Monarch public pre-login observations qualify the exact static asset domain and the root redirect. The dedicated login catalog requires fresh displayed owner consent. Other identity domains, query-bearing redirects, GraphQL POST and CAPTCHA-sensitive flows remain inaccessible. Full Monarch login/account research is untested; the operator must complete and qualify it manually. Safe network-denial events identify the Airodrom route/CDP source, reason, exact origin, fixed/redacted route, method, resource class and query presence. They contain no credential values, request bodies, headers or cookies.

The integrated local test/review record is in the focused pull request. GitHub Actions remains disabled. Local installation does not authorize publication, release, deployment or production activation.

Local qualification: 178 targeted tests passed with two older opt-in browser/account cases skipped; a separate real Chrome synthetic public-page smoke passed. The session suite also exercised the actual dedicated visible profile with synthetic pages. Authority/SDK typechecks, source syntax/privacy/allowlist verification and package dry-run inspection passed. Independent runtime/authority and security/privacy reviews are required on the candidate commit and recorded in the pull request. No hosted CI was dispatched.
