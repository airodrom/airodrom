# ADR 0004 — Immutable metadata, erasable content

Status: ACCEPTED. Logical erasure and opaque identity controls are part of the candidate; source is unactivated. Production migrations require separately authorized maintenance.

## Decision

1. Audit/event identity and integrity metadata may be immutable.
2. Personal-content payloads are erasable, never immutable by virtue of their enclosing record.
3. Retain only minimum non-content identity, timestamp/order, actor/runtime class, scope, operation, outcome, provenance relation, erasure/migration generation and safe integrity evidence.
4. After erasure, no immutable application store may preserve personal text, recoverable embeddings, reconstructable context, prompt/memory payloads, alternate encodings or content-derived identifiers that permit dictionary matching. Encrypting content while keeping a recoverable key is insufficient.
5. Erasure/redaction and opaque migration each become protected immutable events in the existing ledgers.
6. Preserve evidence of occurrence and transition rather than erased bytes. Verify the prior chain, remove personal commitments, rechain transformed metadata and attest the transition. The resulting chain proves the transformation; it does not pretend the original content-bearing bytes are unchanged. Do not retain the old content digest for historical proof.
7. Physical platform backups may temporarily retain old bytes. Supported recovery starts in isolation and loads independent current erasure and identity authority before exposure. Raw snapshot promotion is unsupported.
8. Replay, rebuild, import, schema migration and derived-index reconstruction must apply current generations before state becomes readable. Unknown shapes or missing authority deny recovery.
9. Affected retained execution context becomes unavailable for replay. Mission identity/status and minimum Acceptance/Settlement/provenance metadata may survive; personal prompts/evidence/context may not.
10. An exception requires an explicit non-content legal/compliance retention basis and may not preserve recoverable personal payload. This decision makes no legal compliance claim.

LEGACY CONTENT-DERIVED IDENTIFIERS ARE FORBIDDEN FOR NEW RECORDS.

OPAQUE IDENTIFIERS ARE THE ONLY SUPPORTED POST-MIGRATION IDENTITY MODEL.

## Canonical implementation

The existing memory marker ledger, primary lifecycles, synchronous SQLite transactions, Event Ledger and Authority Ledger remain canonical. Content redaction admits host-only updates while protecting identity, scope, ordering and outcome metadata. Propagation states are pending, applied, failed, retrying and complete. Incomplete propagation denies retained reads and dispatch. Errors/reports contain classes and counts, never personal payloads.

Correction-family erasure validates every connected member and source scope before atomically recording all markers; each member is independently retryable. A verified source-event UUID is captured on the marker before clearing the primary link. Unknown historical provenance stays unavailable. Retained replay keys use proven unique non-content discriminators; erasable composite-key labels cannot become permanent evidence.

Cryptographically random UUIDv4 identifies candidates, approved memories, ContextPacks and their content-derived descendants. Erasable payload comparison supports active dedupe. Explicit identity migration allocates stable randomness against independent opaque origin evidence, rewrites every classified SQL/host-file reference, removes legacy aliases and recomputes permitted commitments. Durable lineage contains only origin, current UUID, scope and generation. The literal old-to-new map exists only during the synchronous maintenance call and is cleared afterwards.

## Recovery and maintenance

Supported restore migrates the isolated copy against current independent lineage before constructing services, reconciles all erasure markers and vault dispositions, removes stale content/index/file representations and checks freshness again before returning services. A later change in source generations immediately invalidates a recovered reader. Missing/mismatched origins, unknown schema and unverified historical provenance fail closed. Pre-origin architecture/request archives and unanchored hashed artifact rows are unavailable; denial is not reported as successful migration.

The read-only counts planner and migration APIs are implemented and tested only with synthetic fixtures/copies. Production constructors perform schema preparation, not destructive historical content migration. Authoritative dispositions must survive independently of old backups. Recovery/rollback uses quarantine and current evidence, never a raw old-database substitution or a permanent reconstructive alias table.

## Roles and limits

Remember, correction, forget, expiry and authenticated host/operator erasure have distinct interfaces. Models cannot invoke maintenance ports or gain scopes through remembered text. Active writers/tasks prevent cleanup until safely retryable. Read validation may memoize only a successful non-content database/schema stamp in autocommit; every transaction bypasses it, any data/schema change invalidates it, and current independent authority is checked before each reuse. No payload or retired identity is cached. Covered local stores/files and supported restore have logical guarantees; user workspaces, unmanaged exports, already delivered provider copies, SQLite WAL/free pages, SSD/swap and physical backup bytes have no synchronous forensic-deletion proof. No provider deletion or legal compliance claim is made. Optional runtimes cannot excuse a required canonical-store violation. 
