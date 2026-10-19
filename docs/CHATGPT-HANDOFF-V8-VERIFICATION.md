# ChatGPT handoff remote v8 — verification closeout

## Scope

Genuine ChatGPT-origin Mission `chatgpt_handoff_remote_20261018_v8`
(`42272706-7e6a-4842-9eaa-3936435d7067`) is preserved as historical evidence.
It is not replayed and its failed verification record is not rewritten.

## Hypothesis matrix (authoritative evidence)

| Hypothesis | Result | Evidence |
|---|---|---|
| A. Extra trailing LF in worker output | **Disproven** | Worktree file remained `PENDING\n` (`50454e44494e470a`); `before_hash === after_hash` |
| B. Wrong worktree | **Disproven** | Worker and verifier bound to `765b2713-…`; same inode `87583125` for `recovery-proof.txt` |
| C. File application / no mutation | **Proven** | Worker summary claimed an edit; host `artifacts:[]`; `expected_changes` failed with `task_owned_changes:[]` |
| D. Sealed contract mismatch | **Disproven** | Assignment and registered `handoff-proof` expect `AIRODROM-CHATGPT-HANDOFF-PASS\n` |
| E. Evaluation JSON / binding failure | **Proven** | Evaluator run `394be850-…` failed `gateway_evaluation_unavailable` / `gateway_json_required` |
| F. Verification raced incomplete write | **Disproven** | Worker termination verified before verify; mtime unchanged |

## Exact-byte contract

Required file: `recovery-proof.txt`

Required bytes (hex):

```text
4149524f44524f4d2d434841544750542d48414e444f46462d504153530a
```

Equivalent text: `AIRODROM-CHATGPT-HANDOFF-PASS` + one LF. Two trailing LFs, missing LF, or other whitespace fail independent host checks. Worker prose never overrides host inventory.

## Lifecycle boundaries

1. OpenCode edits allowlisted files in a disposable sandbox.
2. Host measures staging deltas and applies them through `file_write`.
3. Specialist host verification records checks (including `expected_changes`).
4. OpenCode evaluation is advisory JSON against host checks; it cannot grant Acceptance.
5. Automatic Acceptance requires passed host verification **and** evaluation `ready`.

When an edit assignment produces **no** host-observed artifacts and verification fails, settlement skips evaluation and records `needs_rework` with the host failure. When verification already failed and evaluation later throws (for example `gateway_json_required`), settlement is `needs_rework` with both facts — not a permanent `EVALUATION_UNAVAILABLE` block that masks the host failure.

Evaluation JSON may be wrapped in prose or a Markdown fence; the host extracts one authority JSON object and still validates `binding_hash` and recommendation.

## Recovery and replay

- Failed Missions remain immutable and retrievable.
- Evaluation receipts are not blindly retried after restart.
- Unrepayable `needs_rework` must release concurrent worktree budget per existing DA accounting.
- Replay of ChatGPT request ids `v2`–`v8` is forbidden for acceptance claims.

## What has been proven from genuine ChatGPT

- Planning, dispatch, OpenCode execution, evaluation attempt, host verification, lease release, and durable settlement against the standing `chatgpt-handoff` delegation.
- v8 specifically proves host refusal of a no-op edit claim and an independent evaluator JSON failure.

A fresh typed ChatGPT-origin request (new request id) is required to mark genuine remote Acceptance complete. Host-resumed MCP traffic is not equivalent.

## Host-side Acceptance (proven; not ChatGPT-origin)

Request `chatgpt_handoff_host_worktree_20261018_v11` / Mission `15413223-8404-4801-b6b1-c112ceb7903b` on installed `5ff3b68…`:

- OpenCode planning and execution completed; OpenCode evaluation completed.
- Host verification `passed` (exact bytes `4149524f44524f4d2d434841544750542d48414e444f46462d504153530a`).
- Worker termination verified; leases released; automatic Acceptance recorded; Mission `completed` / settled.
- Origin was an authenticated host MCP session reusing the ChatGPT caller principal — **not** a new typed ChatGPT-origin call.

## Milestone A — COMPLETE (genuine ChatGPT-origin v9)

Request `chatgpt_handoff_remote_20261018_v9` (ChatGPT-origin, caller `mcp:c95b0dba-…`, policy `chatgpt-handoff` / `f32fb28b-…`) completed the full path on installed `f60f931…`:

| Stage | Evidence |
|---|---|
| Durable MCP ack / reservation | `cp_zero_setup_requests` state `approved`; principal matches standing delegation |
| OpenCode planning | Planner run `02c71cea-6517-48f7-94c4-be9e3430daa1` completed; termination verified |
| Mission | `7050a853-4754-4cab-a357-ff882b3446f0` → `completed` |
| OpenCode execution | `5087f6ac-c790-445e-9957-33dd4db83cca` completed; host artifact `recovery-proof.txt` size 30; termination verified |
| OpenCode evaluation | `18e58f0e-7b73-4ee6-be5a-c8e7c50e9835` completed; recommendation `ready`; termination verified |
| Host exact-byte verification | `5f397e60-17a0-436d-b3c2-8fc943cbff45` **passed**; worktree file hex `4149524f44524f4d2d434841544750542d48414e444f46462d504153530a` |
| Automatic Acceptance | `8302db4a-5192-4cd2-93db-ce808407548d` decision `accept` |
| Settlement | Specialist program `settled`; assignment `change` `ready`; leases **released** |
| ChatGPT retrieval | `get_ask_status` → `ACCEPTED`; `get_mission_evidence` → `AUTOMATICALLY_ACCEPTED` / `settled` / verification `passed` |

Worktree: `…/worktrees/d6a63730-419b-45c6-81db-f22b978ce3c1`. Historical failures (including remote v8) remain immutable. Do not replay `v2`–`v9` request ids for a second “first” acceptance claim.

**Milestone A status: PASS.** Next development priority is Milestone B — OpenCode ↔ Cursor bidirectional specialist execution ([MILESTONE-B-CURSOR-SPECIALIST-READINESS.md](MILESTONE-B-CURSOR-SPECIALIST-READINESS.md)).

## Diagnostics for future mismatches

1. Compare worktree realpath and sealed `workspace_id`.
2. Hex-dump the allowlisted file (`xxd` / `Buffer.toString('hex')`).
3. Inspect run `artifacts` vs worker `summary`.
4. Read specialist attempt `verification.checks`.
5. Inspect evaluator run `resolution` separately from host check status.
