# Coding Reliability & Auto-Acceptance V1

**Date:** 2026-10-10  
**Status:** COMPLETED (local hotfix + live proof)  
**Branch:** `fix/coding-reliability-auto-acceptance`  
**Base:** `origin/main` `2f51644b7408249c3ca9de4fe5af5b0f3c897531`

## Problem

Historical Mission `668a177e-706e-4cd6-a128-8da3ebbbcc0f` failed with `opencode_sensitive_context` while admitting ordinary JavaScript (`//` comments, `/** */` blocks, `/regex/` literals). No credentials were present.

## Root cause

`OpenCodeAdapter.safeText` treated **display redaction mutation** as a security failure:

```js
if (redactValue(value) !== value || containsSecret(value)) fail('opencode_sensitive_context');
```

`redactValue` applies `secret-observation.redactText` → `transport-outcome.redactUrls`, then `event-ledger.redactPayload`. The path rule:

```js
/(?:[A-Za-z]:[\\/]|\\\\|~\/|(?<![\w])\/)[^\r\n]*/g → '[redacted-path]'
```

rewrites any `/` not preceded by a word character (line comments, regex literals, division, `./` requires). Relative-URL redaction can also rewrite patterns containing `?`. Ledger display redaction remains correct for logs; it must not gate authorized source admission.

## Minimal fix

Add `sourceContextSensitive()` in `src/apps/opencode-adapter.js` and use it from `safeText` instead of `redactValue !== value`.

Still fail-closed for:

- `containsSecret` credentials / tokens  
- Absolute Windows/UNC/`~/` roots and `/Users|/home|/private|/root|/etc`  
- `.airodrom` product paths  
- `.env` / `credentials` / `secrets` / `auth.json` and `*.pem|key|sqlite|db` tokens  
- Sensitive `process.env` / `AIRODROM_*` / common API key names  

Does **not** disable the sensitive-context gate or weaken workspace confinement (`file_scope`, sandbox, allowed_files).

## Regression tests

`tests/opencode-source-context.test.js` (via `npm run test:opencode`):

- Ordinary JS comments / regex / relative requires admitted  
- Display redaction still rewrites those samples (documents the historical class)  
- Authorized relative source paths admitted  
- Credential-looking strings, sensitive absolute paths, protected names denied  
- Execute admits slash-containing authorized JS; secret objectives and `../` escape denied  

Focused run: `node scripts/run.cjs --test tests/opencode-source-context.test.js` — 5/5 pass.

## Automatic Acceptance pilot

Operator opt-in: `POST /api/assistant/risk-acceptance` `{enabled:true,confirmed:true}`.

| Field | Value |
| --- | --- |
| Mission ID | `2c57a4e7-c906-4b5f-9590-61242e6b6f82` |
| Worker / model | `opencode` / `ollama/qwen3-coder:30b` |
| Risk source | `operator_preference` |
| Verification | `passed` (host verifier) |
| Acceptance | Host risk policy (`actor: operator`); Qwen did not approve |
| Settlement | `settled` · Mission `completed` |
| File change | `src/marker.js` (`alpha` → `beta`; comments/regex preserved) |
| Independent tests | exit 0 |

Preference restored to `enabled:false` after the pilot.

## Historical evidence preserved

Failed Mission `668a177e-…` remains in durable history as `needs_rework` / `opencode_sensitive_context`. Not rewritten.

## Live runtime note

For the Automatic Acceptance pilot, `~/.airodrom/local.json` `source` temporarily pointed at this git worktree. Operator checkout `/Users/andrew/code/airodrom` was not modified.

## Final closeout — runtime source reconciliation (2026-10-10)

Authorized cutover after idle drain/stop:

| Field | Value |
| --- | --- |
| Prior source | git worktree `…/work/airodrom-coding-reliability` |
| Canonical source | install archive `…/install/airodrom-coding-reliability-a6ee3e3` (no `.git`) |
| Service | Healthy · admission `open` · OpenCode 2.0.25 ready |
| Active runs / leases | 0 / 0 |
| Pilot Mission `2c57a4e7-…` | preserved `completed` |
| Historical `668a177e-…` | preserved `needs_rework` |
| Personal memories | 6 preserved |

No temporary worktree dependency remains for the running service.

## Remaining limitations

- Display `redactPayload` / `redactUrls` still rewrite ordinary JS in **logs and ledger payloads** (intentional).  
- `sourceContextSensitive` is fail-closed on absolute home/private paths even inside comments.  
- Risk Automatic Acceptance remains opt-in, local-only, public, OpenCode-only, and requires host verification `passed` with all checkers passed (no `operator_review` criteria).  
- No push/PR/hosted CI for this branch.
