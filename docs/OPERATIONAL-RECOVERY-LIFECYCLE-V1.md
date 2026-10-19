# Operational recovery and lifecycle closeout V1

## Identity-read hang

Every retained read called `memory-identity` validation. Inside a write transaction the validation cache is bypassed. The previous check loaded every ledger correlation column, and every JSON value, into the process. A live database with tens of thousands of ledger rows made `ask_airodrom` stop answering; the process stayed inside synchronous SQLite until it was force-stopped.

Validation now asks SQLite for the first unsafe row only. Values shorter than 64 characters cannot be a legacy content identifier and are not passed to the checker. Longer payload columns are returned only when they are already legacy-shaped. A legacy correlation still denies the read. Successful unchanged reads still reuse the autocommit stamp.

## Writer-death reconciliation

`POST /api/control-v2/writer-death-reconcile` settles interrupted `host` and `bridge` runs whose resolution is `reconcile_process` when all of the following hold:

- the named writer pid is not this process and `kill(pid, 0)` returns `ESRCH`
- no other process has the leased workspace as its current directory
- the run has no recorded pid and no external-worker ledger event
- bridge capabilities on that run are read-only git inspections with a ledger bind

The run stays `interrupted`. `termination_verified` becomes true and `process_state` becomes `exited`. A quarantined lease on that run is released. A bound invocation is settled `incomplete`, not successful. The Mission stays blocked. The result is `recovery_not_execution` and `accepted: false`.

A live writer, a recorded pid, an external worker event, or a capability outside the read-only git set leaves the rows unresolved.

Cold-boot web and bridge recovery are unchanged and are not used for this same-boot writer death.

## Checkpoint copies

Private checkpoint verification still sets its own umask to `077` and creates a `0700` directory. After the copy, each file mode is restored from the sealed source so a recorded `0644` is not mistaken for corruption. The process umask is not changed globally. Absolute and escaping symlinks are rejected. A hash mismatch is still a failure.

## Admission

Admission opens only through the existing idle resume. This path does not delete rows, rewind accounting, or force `admission=open`.

## Closeout

Repair commits on `main`:

- `bcedc6d5260fbf0f230813fec6b0f76e7df2504b` — pull request 152, writer-death reconciliation and bounded identity reads
- `c2ffaddaebe97df3e1d9437ec4435f62e57c31c4` — pull request 153, skip identity checks for values shorter than 64 characters

The managed installation that completed acceptance runs `c2ffaddaebe97df3e1d9437ec4435f62e57c31c4`. A product status call on that build returned in about one second.

Evidence-backed dispositions, preserved in the live database:

| Record | Disposition |
|---|---|
| Bridge run `2d3527b7-4700-405c-af32-df08dc2959ec` | Stays `interrupted`. `process_state=exited`, `termination_verified`, resolution `writer_death_in_process`. Not successful. |
| Host run `4cf66102-ca05-4bfa-aef7-056a0c9921f7` | Same disposition as the bridge run. |
| Lease `99018858-bdcc-4179-a251-9faede39fb83` | Released after the writer was observed gone and no workspace holder remained. |
| Read-only `git_diff` invocation | Settled `incomplete`. The row was not deleted and was not marked successful. |
| Mission `26a6407c-5bf4-4f1a-8279-1ed970559f48` | Remains blocked. |

Admission then opened because the existing resume saw an idle, reconciled host. No blocker row was removed by hand.

The pre-migration checkpoint taken while that host was stopped passed private verification: file hashes matched, copied modes matched the sealed source, and authority records were preserved. The sealed checkpoints were not rewritten. Source-only rollback `1e2fadd96f339fe49f50440219c0cd1e724d8051` remains staged. It was not swapped under the database after these writer-death rows were recorded.

Live acceptance used the installed MCP front door, not a remote ChatGPT conversation. `ask_airodrom` exceeded the 15-second client window and was recorded as a client timeout. The same request then completed as Mission `6a90f72d-a31e-47fb-a5fc-3700840a0c9b`: OpenCode run `72033f42-1843-409b-830c-ae2a4ed52d18` exited with termination verified, a second OpenCode run completed, both workspace leases were released, host verification passed, and the Mission settled `AUTOMATICALLY_ACCEPTED`. The disposable worktree contains `recovery-proof.txt` with exactly `AIRODROM-RECOVERY-PASS` and one trailing newline. The enrolled repository was not modified. That automatic settlement is not a separate human Acceptance. Control Center showed the service connected and this Mission settled on OpenCode with automatic completion.
