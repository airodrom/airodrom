# Guarded rollback compatibility

This source is a separately qualified rollback candidate based on the V1/V2
OpenCode gateway. It is not a previously installed known-good release. It retains
newer cognitive Missions and node identities without interpreting their graph,
dispatching their work, consuming returned results, repairing, or accepting them.
The normal authenticated cancellation path remains available. Unsupported Missions
show a compatible-source requirement; restoring that source is an operational
recovery step, not a new grant or owner Acceptance request.

The retained node `record_id` schema, opaque origin migration, erasure replay keys
and field classifications match the forward candidate. Legacy node identities
must be migrated explicitly with the canonical identity migration before retained
reads; constructors only prepare schema. Repeated migration preserves identities.
Erased graph context stays unavailable; retained records and outcomes are not
removed or rewritten to make scheduling proceed.

Before switching source, drain and verify idle using the managed host lifecycle.
Unverified worker or evaluator termination, quarantined leases and uncertain
dispatches block resume. Never release them merely to complete rollback. Preserve
a consistent checkpoint after canonical identity migration and before V3 work,
plus current independent identity and erasure dispositions. Restore copies must
validate their retained origins against current independent authority and
reconcile erasure before becoming readable. Do not restore a pre-origin snapshot,
refund reservations, rewind accounting, drop schema, or recreate execution grants.

The rollback deployment must pin this exact reviewed source, aligned CLI and
prepared native artifacts. Supported older work may continue only through the
existing host admission controls. Newer work remains held until a compatible
forward source is restored through the same drained, verified process. The
original installed source is not compatible merely because its database backup
exists. A source-only switch preserves the current database; a database restore
requires the independent canonical restore qualification separately.

Qualification includes newer queued, returned, awaiting-Acceptance, completed and
uncertain cases; erasure and origin validation; no duplicate invocation or
Acceptance; older work progressing; cancellation; and the repository candidate
checks. Fixture and private-copy evidence does not by itself prove an installed
rollback. Record actual managed source-switch and return-to-candidate observations
separately when installation is performed.
