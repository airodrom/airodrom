# ADR 0064 — Preventive policy diagnostics and bounded recovery

Status: Accepted for implementation; publication, installation and live qualification remain separately gated.

## Context

An operational error must not become permission to expand scope. Registry substring matching, incomplete observations, recovery-driven enrollment resealing, non-durable attempt counting, cross-policy cleanup, and stale repository aliases made some blockers misleading or unnecessarily persistent. A policy dispute also needs a way to compare decisions without authorizing a real action.

## Decision

Preserve the existing authority architecture and frozen execution chain. Resolve complete registered error identities; unknown or compound security failures remain closed. Surface source, decision, prerequisite and permitted remedy using the existing registry. Reserve recovery attempts before work using the existing SQLite transaction helper; unavailable accounting or lineage permits diagnosis only. Timing recovery is read-only. Cleanup requires the exact policy bound in durable Mission/request evidence and existing proof gates.

Keep the project repository ceiling at 24. Before workspace creation, reconcile only exact policy-owned idle terminal disposable aliases. Retain source/unknown/active/quarantined/replaced identities. Retire active scope bindings without deleting files or historical rows. Recheck after async materialization and atomically bind the ready record; a final-slot race preserves the new clone as held evidence without authority.

Provide a fixed-scenario simulator only in test fixtures, under Seatbelt and Node permissions, with clean environment, synthetic inputs, and no Mission or acceptance implementation. It compares decisions and identifies the disputed rule. It is excluded from release execution paths. Real `alwaysDeny`, protected classes, explicit approvals and filesystem enforcement are unchanged.

The aggregate eleven-check preflight is a documented adapter contract over existing authorities, not an implemented parallel controller. This candidate adds early capacity validation and improves the existing diagnostic response. See the [operations guide](../operations/PREVENTIVE-DIAGNOSTICS-V1.md) for exact fields, recovery rules, research, coverage, limitations and rollout gates.

## Consequences

Ordinary preparation can recover stale active bindings without erasing retained work. Incorrect and unknown errors no longer receive guessed operational recovery. Storage failures consume or prevent attempts rather than granting fresh budgets. Legitimate authority gaps still require an exact owner action. Completed Cursor work remains reusable only through existing verified receipts and bounded evaluator recovery.

No new dependency, public simulator endpoint, global bypass, standing grant, background deployment or schema migration is introduced. Diagnostic additions are backward-compatible. Rollback is owner-controlled and preserves every durable record; reverting also restores the old defects and therefore requires care around recovery invocation. Fixture tests are source qualification, not evidence of a live installation or real-worker acceptance.
