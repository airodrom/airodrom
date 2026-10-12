# Local WORK Template Registration V1

Control Center → WORK Templates lets the authenticated local operator register,
inspect and revoke a local-only WORK template. It uses existing operator bearer
authentication and same-origin checks. MCP credentials cannot access registration,
inspection or revocation. No credential or signing-key initialization is performed.

Register an existing Project and Goal, its exact canonical repository root, one to
eight existing regular files, an exact `git diff --check` task and one to four
focused process test tasks from `.vscode/tasks.json`. Aliases use lowercase letters,
digits, underscores and hyphens. Review the form's exact scope before confirming.
A template lasts 1–1440 minutes. Registration is reusable during that interval;
expiry is absolute and is never renewed by submission. To change or renew a
registration, use a new alias and new operator consent. Duplicate aliases,
including revoked ones, cannot be overwritten.

The signed record binds the project/goal, workspace device and inode, file scope,
verifier-definition hash, local routing, permissions, budget and expiry. Symlinks,
hardlinks, globs, hidden files, test files, package manifests and dirty scoped files
are rejected. Project/workspace mismatch, changed verification definitions,
invalid seals, expiry and revocation fail closed. Restore invalidates registrations.

The existing Mission Manifest enforces exact file writes and permits only the
registered verifier task labels. The outer filesystem ceiling includes the
repository for existing host verifier tasks; this is not permission for arbitrary
worker writes. Host tests are trusted operator-selected programs, use the existing
Capability Broker and protected approvals, and must leave the workspace stable.
They are not a newly introduced OS sandbox. Read-only scoped canonical Memory is
bounded to 20 injections and cannot grant authority. No memory mutations, external
inference, secrets, commits, branch changes, push, merge or deployment are allowed.

Mission V2 `submit_mission` uses `privacy: "local_only"`, `data_class: "public"`,
`mission_class: "WORK"`, and the registered `project` and `workspace` aliases.
The request may choose `worker: "auto"` or `"opencode"`; it cannot widen the
registered ceiling. OpenCode remains primary and no external fallback is allowed.
The separate approved-external qualified worker path is unchanged. Legacy
host-option templates remain compatible only where no durable local registration
exists; a revoked or expired durable record never falls back to a legacy entry.

Revocation denies further submission, dispatch, capability application and
Acceptance under that registration. Already-running inference may finish, but its
output cannot be applied after revocation. Prior writes are not rolled back.
Session-bound idempotent replays return the original Mission receipt; they do not
execute again. Independent verification ends at awaiting Acceptance. Neither the
registration API nor the handoff automatically accepts or settles a Mission.

Focused validation: `node scripts/run.cjs --test tests/work-templates.test.js`.
This includes synthetic OpenCode execution with canonical routing, host verification,
expiry, integrity, revocation, path boundaries, durable reload and the real browser
registration flow against a disposable local server. Fixture success does not
qualify a live worker or register a live template. Loading new server code and
owner registration remain separate from source validation.
