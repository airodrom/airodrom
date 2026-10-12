# WhatsApp Verify Token Staged Rotation — shipped

2026-10-10. Feature [PR #62](https://github.com/airodrom/airodrom/pull/62) merged to `origin/main` as `879daa38e759b3e7c616d6575f04fae8f60a148e` (tips `02067eb` + `e31d1c9`). ADR 0045.

## Install

| Item | Value |
| --- | --- |
| Root | `…/airodrom-whatsapp-verify-token-safe-rotation/install/airodrom-whatsapp-verify-safe-879daa3` |
| Package | `1.0.1-rc.1` · install from merge tip 373 files · tarball SHA-256 `e37b2b010d6830095681eefc997ede1c782122b560311798c3b948324917ec57` (docs ship allowlists this evidence file) |
| Backup | `…/backup/pre-whatsapp-verify-safe-20261010T205019Z` |
| Prior source | Conversation UX Bugfix `airodrom-conversation-ux-bugfix-52e1003` |

## Validation (fixtures)

- `tests/whatsapp-inbound-v1.test.js` **25/25**
- `typecheck:authority` + `typecheck:sdk` green
- `package:check` clean (373 files)

## Live profile after install

- Schema columns `staged_verify_token_reference` / `staged_verify_expires_at` present; staging idle
- Verify token, App Secret, and Graph access Keychain references bound and resolvable; values not displayed
- Public ingress OFF · outbound OFF · Mission auto-dispatch OFF · production HOLD
- Test quick tunnel retargeted to the restarted local port; prepared callback URL refreshed privately
- Meta Dashboard Verify and Save: **owner-controlled**, not performed by install

## Owner path (TTY only)

1. Show prepared callback: private evidence file under the Codex install tree (never paste verify tokens into chat).
2. `airodrom whatsapp rotate-verify-token` — candidate prints only in that Terminal.
3. Meta test app: Callback URL + Verify Token → Verify and Save.
4. After independent Meta success: `airodrom whatsapp commit-verify-token`.
5. On failure: `airodrom whatsapp rollback-verify-token`.

Webhook GET never finalizes. A correct verify-token challenge does not cryptographically authenticate Meta.

## Distinctions

| Claim | State |
| --- | --- |
| MERGED IN SOURCE | Yes |
| INSTALLED LOCALLY | Yes |
| LIVE VERIFIED (Meta callback) | Owner-pending |
| PUBLIC ACTIVATION | OFF |
| PRODUCTION HOLD | WhatsApp / Meta AI |

Operator checkout `~/code/airodrom` preserved. No AI/editor attribution.
