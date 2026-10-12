# Personal Memory V2 correction identity

## Defect

Storing `Correction: My favorite test planet is now Proxima-77, not Kepler-42.` after
`My favorite test planet is Kepler-42.` left both rows **active**. `/memory` and
ordinary conversation could still answer Kepler-42 because subject derivation treated
the correction preamble as a distinct identity and search ranked the older row first.

## Contract

1. Fact identity is the deterministic subject of the statement (`favorite test planet`),
   after stripping correction preambles and normalizing `is now` / `, not …` scaffolding.
2. A correction **supersedes** other active personal rows with that fact key and stores a
   canonical current statement. Prior content remains as `superseded` provenance.
3. Current listings and conversation/ContextPack assembly use `presentCurrentItems`:
   collapse by fact key, keep the newest winner, and project canonical content so
   superseded values do not enter current-answer context.
4. Conflicting corrections are ordered by `updatedAt`, then `memoryId`.
5. Existing dual-active rows are never mutated automatically. Inspect a **copy** with:

```bash
node scripts/reconcile-memory-corrections.cjs --db /path/to/copy.sqlite
```

Apply only with explicit `--apply --confirm-apply`. Do not point apply at the live
operator home without separate authorization.

## Runtime note

Correction semantics execute in the managed service process. Updating the Terminal
CLI link alone does not change live tip handlers until the owned service is restarted
from a package that includes this change.

## Activation readiness (PR #70 / adc7f1e)

Pre-activation kit pattern: `~/.airodrom/backups/memory-correction-adc7f1e-*`
(online `memory.sqlite` backup, `local.json`, LaunchAgent snapshot, candidate
pointers, `APPROVAL-REQUEST.md`). Prepared install:
`…/airodrom-master-completion/install/airodrom-memory-correction-adc7f1e`.

## Live activation (operator-approved)

On explicit approval, managed service was switched from tip `525458c` to the
prepared candidate install built from `adc7f1e`:

- Single `local-service` supervisor; Control / Memory V2 / OpenCode Ready
- Fresh Terminal conversation answered **Proxima-77** with memory included
- Kepler-42 was not presented as current
- Live Kepler/Proxima row statuses were **not** auto-reconciled (presentation-only)
- Rollback kit retained under the backup root; unused when acceptance passed
