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
