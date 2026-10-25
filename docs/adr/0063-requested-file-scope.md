# ADR 0063 — Explicit requested file scope

Status: Accepted for implementation; release and installation remain separately gated.

## Context

A request named `recovery-proof.txt`, while enrollment supplied `AGENTS.md`,
`README.md`, and `docs/ARCHITECTURE.md`. A product name in the requested success
marker made a separate negated source mention appear positive to repository
routing. The planner selected `AGENTS.md` and described it as the requested file.
The host checked consistency with enrollment and the sealed proposal, but did
not compare either with an independent constraint extracted from the request.
Consequently, correct checks on the wrong file could lead to automatic acceptance.

## Decision

The host captures `requested_scope` version 1 inside each new hashed RequestEnvelope.
Its `bindings` are the unique operation/path permission set. Its `stages` are the
ordered execution graph and may repeat the same binding (read → edit → read). These
layers are not equivalent: collapsing stages to unique bindings is a planning
mismatch (`requested_file_stage_mismatch`), not fulfillment. They narrow existing
enrollment and do not create authority.

The host parses literal operation clauses (`read`, `inspect`, `review`, `edit`,
`modify`, `change`, `update`, `rewrite`, `append to`, `write to`, or `create`,
followed by a literal path), plus bounded structured phrases such as
`Make changes only to PATH`, `Use PATH for read and edit`, and
`after editing PATH`. Quote paths with spaces or without a dot or slash, or use
`read file LICENSE` for an extensionless path. An operation without a literal
target normally requires clarification. Comma/and lists retain every literal.
Other bare dotted file references require an explicit operation; no model
extracts authority. Negated operations, descriptive prose (`for read and edit
operations`, `review the result`, `Expected evaluation recommendation: READY`,
`do not edit other files`), and status words (`ONLY`, `READY`, `BLOCKED`) do not
invent file targets. A leading `./` is normalized, while traversal, absolute
paths, backslashes, noncanonical Unicode, and ambiguous path components are
rejected. Case and directory components are preserved. No basename matching,
file aliases, enrollment-default substitution, or report coercion is permitted.

### Planning context versus execution scope

Authorized execution targets must be present as regular files in the prepared
workspace and remain in `permitted_paths` once diagnosis reports `execution_ok`.
Planner-readable context is a separate filter: oversized, sensitive, or otherwise
non-forwardable enrolled documents produce precise codes such as
`requested_file_planning_oversized` or `requested_file_planning_sensitive` and
host planning notes, without inventing a generic `requested_file_missing_or_inadmissible`
denial. Absent disposable clones of enrolled files rematerialize once; genuine
unenrollment, symlinks, directories, path-boundary violations, and creation
requests stay fail-closed with distinct codes.

Literal `reads` and `edits` clauses normalize to the same read/edit operations.
An explicit `AGENTS.md substitution must be rejected` clause excludes that
literal from requested scope; it never enrolls it. A conflicting positive operation
on that same path requires clarification. Other unsupported filename prose still
fails closed.

### Documentation wording and content refinements

The host also recognizes a finite content form: `Update the documentation in
docs/README.md`, `Modify examples within docs/README.md`, or `Rewrite the text of
"docs/README.md"`. The content noun is not a filename alias: the following literal
is normalized, enrolled and sealed exactly as a direct `edit` target. Quoted paths
with spaces and lists use the same literal handling. The host does not ask a model
to infer file authority from prose.

`Edit docs/README.md and update the examples` retains only the explicit edit
binding. A bounded targetless content phrase may refine the immediately preceding
positive edit, joined only by a conjunction/comma in the same clause, and must
finish the instruction (apart from sentence
punctuation); it cannot inherit from a read or create operation,
cross a sentence/semicolon/newline, introduce a target with unsupported prepositions,
or select an enrollment default. Content-form literal lists reject unquoted ambiguous
entries rather than dropping them. Unknown targets such as `edit something` and
unquoted extensionless filenames still require clarification. An explicit content
operation naming another file always retains that operation and file, even when the
file already has a read binding. No existing seal gains new paths or permissions.

This is deterministic supported grammar, not unrestricted natural-language parsing.
For unsupported wording, state the exact operation/path separately and describe the
required result without another ambiguous file operation. `requested_file_operation_required`
means the host needs an unambiguous operation/target; it is distinct from
`requested_file_not_enrolled` and `requested_file_creation_not_authorized`. Parsing
success alone is not authorization or proof of execution. The old ambiguous phrases
were rejected before Mission creation; retry them as a new corrected request only
after inspecting any prior request outcome. Ordinary direct forms retain their version-1 representation. Correct handling of
punctuation after a quoted filename can differ from the old parser, which could
include the closing quote in the path. `assertOriginal` rejects such an old seal as
`requested_file_constraint_changed`; it never rewrites the stored binding or hash.
No migration or historical-row rewrite is performed. Downgrade may reject newly supported wording and must not resume its
Missions under the older parser.

An explicit path must be enrolled and available as a regular admissible file before
planning. Cognitive enrollment currently supports existing files; a creation request
is rejected and requires an independently authorized creation workflow. There is no
fallback to another existing file when a requested file is missing or inadmissible.

Planning must retain every explicit operation/path binding. Read context is confined
to the explicitly requested set; edits require an explicit edit binding. An explicit
read before an edit remains a dependency. Coercion cannot remove offending task paths,
change these constraints, or convert an invalid worker into an allowed worker.

Binding and dispatch compare the constraints with the original instruction hash and
sealed tasks. Specialist assignment hashes and recovery lineage retain them. The
independent verifier adds `requested_file_scope` evidence using host repository
snapshots; read assignments must produce no changes, and each requested edit must
be present relative to the original baseline. Changes outside the requested edit
set fail even when the evaluator returns READY or worker prose claims success.
Acceptance independently repeats the comparison against the current snapshot.

Evidence exposes requested bindings, proposed assignments, authorized paths,
observed changes, and the host check. Read evidence consists of sealed assignment
and runtime receipts; it is not a claim that filesystem access tracing observed
all reads. Exact final bytes still require the enrolled exact-file verifier.

Repository matching now negates each matched target phrase independently. A marker
containing a product name cannot make another negated source phrase positive.
Expired enrollments are excluded from cognitive selection. An exact enrolled alias
outranks shared words in other aliases or project names; multiple exact aliases
remain ambiguous and cannot authorize execution.

Without an exact alias, exact enrolled project names and repository paths outrank
incidental shared words. Multiple exact matches or multiple policies for the named
project remain ambiguous. `No source edits` is a negation, not a request for a
project containing the word `source`; negation stops at a sentence boundary.

Generated disposable workspace UUIDs are typed host identities. Before screening
a workspace path, the host may neutralize only its canonical UUID basename, and
only when the workspace registry, exact path, directory inode chain, containment,
ownership, and repository identity all agree. Parent paths and unregistered paths
retain secret screening. This avoids random card-checksum false positives without
changing general secret detection, filesystem paths, or execution authority.

## Compatibility, recovery, and rollback

The optional versioned envelope extension is covered by the existing envelope hash
and sealed contract hash. Historical records and hashes are never rewritten. Old
stored evidence keeps its original shape. Attempts to resume or accept an old
explicitly mismatched proposal fail the comparison with its original request.
Ordinary requests without explicit file constraints retain the enrolled planning
contract. A clarification or corrected request does not expand an existing seal.

Bounded planning retries may return a corrected exact-scope proposal. Neither
specialist retries nor evaluator recovery can widen scope; budget, isolation,
termination, and acceptance gates remain mandatory. Rollback requires draining
active work and owner approval; an old runtime cannot interpret new envelopes and
must not resume their execution. No production restart or installation is implied
by this source change.
