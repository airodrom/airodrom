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

Pre-activation kit (service still on tip `525458c` until operator approval):

- Backup root pattern: `~/.airodrom/backups/memory-correction-adc7f1e-*`
- Contains: online `memory.sqlite` backup, `local.json`, LaunchAgent snapshot,
  `candidate-local.json`, candidate LaunchAgent, `APPROVAL-REQUEST.md`
- Prepared install: `…/airodrom-master-completion/install/airodrom-memory-correction-adc7f1e`
- Copy verification: `presentCurrentItems` returns Proxima-77 as current without
  mutating the live database; optional reconcile apply is separate and opt-in

Do not change `local.json`, LaunchAgent, or stop the managed service without the
single explicit activation approval recorded in the backup kit.
