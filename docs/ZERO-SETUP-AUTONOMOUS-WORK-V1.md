# Zero-Setup Autonomous Work V1

## Product flow

### Terminal (ordinary local execution)

1. Owner runs `airodrom` and types one natural-language instruction.
2. Airodrom resolves an authorized Project/workspace (or asks one short clarification).
3. Terminal shows the exact project, files, worker and permissions.
4. Owner confirms with explicit local `y` / `yes` (model/chat text is never consent).
5. Host registers the WORK scope, binds one Mission + Goal Plan, authorizes CAE, and dispatches OpenCode once.
6. Terminal reports independent verification. Acceptance remains a separate owner decision.

### ChatGPT MCP

1. ChatGPT calls `ask_airodrom` with a natural-language instruction.
2. Airodrom resolves an authorized Project/workspace (or asks one short clarification).
3. Airodrom prepares a bounded WORK template proposal and Goal Plan request.
4. Control Center shows one readable approval card (no UUID form), or Terminal can authorize the same prepared request.
5. Owner confirms **Approve this task** (or Terminal `y/N`).
6. Host registers the WORK template, binds one Mission, authorizes CAE, and dispatches OpenCode.
7. Host verifies independently; Acceptance remains a separate owner decision.


Preparation is never permission. ChatGPT text never grants execution.

## Enrolled-project routing (Autonomous Development Unblocking V1)

Ordinary development requests that name an authorized Project — for example
`Start the Arecibo release-readiness audit in Cursor` — resolve through the
enrolled-project path. They must **not** enter the projectless exact two-file
fixture grammar.

Decision order for `ask_airodrom` / `prepare_mission`:

1. Authenticate the caller and run Cognitive Mission Router when a standing
   Developer Autonomy policy with cognitive enrollment uniquely matches.
2. Otherwise discover enrolled Projects by full name, alias, distinctive token,
   or authorized absolute path. Longer exact names win over shorter trailing
   phrases. Owner-configured project defaults (see [Global Autopilot](GLOBAL-AUTOPILOT-V1.md))
   and live-Git filtering of cleaned disposable leftovers resolve ordinary
   Arecibo Core ambiguity. Genuine multi-repo ambiguity without a default still
   returns `ENROLLED_REPOSITORY_AMBIGUOUS`.
3. Only when no enrolled Project matches may Cursor prose use the projectless
   two-file contract (`projectless_exact_two_file_syntax_required`).
4. With Global Autopilot ON, authenticated intake ensures a standing
   `autopilot:*` Developer Autonomy policy for the resolved live repository
   (verification from `.vscode/tasks.json` or an already-active Work template).
   Without Autopilot, a recognized Project without an active standing enrollment
   returns `ENROLLED_WORKSPACE_REQUIRED`. Cursor planning without cognitive
   discovery files returns `standing_cognitive_enrollment_required`.

Multi-file enrolled objectives are valid. OpenCode proposes a bounded file plan
inside standing enrollment; Airodrom validates it against the grant. Dirty and
unique checkouts stay protected; disposable worktrees are prepared by Developer
Autonomy, not by the projectless sandbox.

Mandatory architecture remains:

```text
USER → ChatGPT → AIRODROM → OPENCODE → CURSOR / CLAUDE CODE / CODEX → OPENCODE → AIRODROM → ChatGPT → USER
```

Do not reintroduce the obsolete two-file restriction into enrolled-project
workflows. See [Projectless work](PROJECTLESS-WORK-V1.md) for the fixture-only
contract and [Cognitive Mission Router](COGNITIVE-MISSION-ROUTER-V1.md) for
standing cognitive planning.

### Live acceptance (2026-10-19)

Installed `b401f5dbcd122572e1d1e3e264d3f195e4436b83` (PR #179). Host-origin
operator intake (not a ChatGPT MCP session; no paid Cursor run):

| Request | Result |
| --- | --- |
| `Use Cursor to continue the Arecibo development task…` | Enrolled path. Did **not** return `projectless_exact_two_file_syntax_required`. Resolved the single-repo Arecibo enrollment; Autopilot reported missing `.vscode/tasks.json` on that checkout (precise standing-prep gate). |
| `Use Cursor to continue the Arecibo Core development task…` | `ENROLLED_REPOSITORY_AMBIGUOUS` with the enrolled Arecibo Core worktrees listed. No two-file fixture prompt. |
| Projectless `Use Cursor in a projectless task sandbox…` | Still `projectless_exact_two_file_syntax_required`. |

Remaining genuine gates: choose one Arecibo Core repository when several worktrees are enrolled; standing Developer Autonomy with cognitive discovery files before Cursor planning; explicit subscription grant before paid Cursor execution; no production deploy or Plaid LIVE activation from this path. Rollback checkpoint: `~/.airodrom/activation/airodrom-rollback-b9546357a26c`.

## One-interface, approval-bound completion (candidate V1)

The ordinary `airodrom` Terminal is the primary interface, with Control Center retained for advanced administration and diagnostics. When one eligible signed local WORK template is active, its exact Project/workspace can be selected without asking the owner to manipulate UUIDs or worktrees. An explicitly named Project overrides unrelated disposable-fixture heuristics. Ambiguous, missing, expired, revoked, or dirty scopes still stop safely rather than guessing.

For the **exact `fixture.txt` alpha-to-beta acceptance fixture only**, the owner’s initial authenticated `Approve this task` / Terminal `y` authorizes the **expected final bytes and registered focused verification**. After independent Airodrom host verification passes every exact-file, test, security, and workspace check, the Mission can settle automatically. No separate final Acceptance click is required for that preauthorized scope. The user sees this completion policy **before** approval.

General development WORK remains manual-Acceptance gated. The standing low-risk preference never silently opts registered WORK templates into auto Acceptance. MCP text cannot grant execution, choose acceptance policy, or authorize existing historical Missions. A changed preimage, missing template, extra files, changed verifier, external worker, pending approval, unexpected workspace change, or failing checker must fail closed. Git commit/push/merge, installation, credentials, networking, Production, and broader permissions are **not** authorized by this one-click completion policy.

This is a narrowly scoped pilot. It does not establish arbitrary zero-click autonomous development or retroactive Acceptance for earlier completed tests.


## MCP catalog refresh

Local stdio advertises `tools.listChanged=true` and a `catalog: zero-setup-v1` serverInfo marker.
ChatGPT may still keep a conversation-scoped snapshot of an older tool list.

If `ask_airodrom` is missing after install:

1. Run the read-only [MCP Catalog Integrity gate](MCP-CATALOG-INTEGRITY-V1.md) and confirm the **real npm-linked executable** and fresh `tools/list` match the source.
2. Start a **new** ChatGPT conversation. If tools are still missing, use ChatGPT's explicit Airodrom plugin **Refresh** when available and try another new chat.
3. Investigate a wrong executable, process snapshot, or connector registration only where the specific diagnostic boundary differs. Do not restart the control plane, tunnel, or reset credentials by default.

The gate must report ChatGPT tool visibility as UNVERIFIED unless an independent client catalog receipt is supplied.

## Focused validation

`node scripts/run.cjs --test tests/zero-setup-work.test.js tests/zero-setup-terminal.test.js tests/mcp-schema.test.js`

Fixture success does not grant live Acceptance.
