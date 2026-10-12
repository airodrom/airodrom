# Erasure and retention

The logical guarantee covers classified application stores and host-managed retained files. Personal payloads and reconstructive commitments are erasable even when operation metadata is immutable. After migration/erasure, retained identities cannot be computable from or dictionary-matched against erased personal content. Random UUIDs and independent opaque origins replace legacy content identities; no durable old-to-new content alias survives.

## Erasure layers (host API: `memory-erasure.classifyAction` / `layerStatus`)

| Layer | Claimed | Meaning |
| --- | --- | --- |
| `retrieval_suppression` | yes | Markers hide records from get/search before purge finishes |
| `cache_invalidation` | yes | Context packs / FTS indexes reject erased identities |
| `retention` | yes | Immutable non-content envelopes may remain after operator erasure |
| `logical_purge` | yes | Content columns nullified / subject erased under host transaction |
| `physical_deletion` | **no** | WAL/SSD/swap/backup/provider copies — unclaimed |

`forget` / `expiry` apply suppression + cache invalidation + logical purge. `operator_erasure` additionally redacts retained content columns while preserving classified non-content metadata. `physicalErasure` remains `false` on all product APIs.

Erasure records immutable non-content transitions. Propagation is retryable; pending, failed or unknown stores block retained reads and dispatch. Scope, generation and independent origin evidence govern transformation. Active tasks/writers prevent unsafe cleanup. Unknown schemas or missing origins remain quarantined rather than receiving a false COMPLETE result.

Supported recovery loads current independent erasure and identity authority into an isolated restored copy before any service is returned. It migrates/redacts classified rows, references, files and derived indexes, and checks authority freshness again. Later erasure invalidates recovered readers. Missing markers, rolled-back authority, raw snapshot promotion, unclassified extensions and downgrade are unsupported.

Local storage is not universally encrypted. Restricted-vault deletion depends on disposal of relevant key copies; keeping a decryptable copy is not erasure. SQLite WAL/free pages, SSD, swap, old physical backup bytes, unmanaged exports, user workspaces and already delivered provider copies have no synchronous forensic-deletion proof. No live provider deletion, regulatory compliance or universal physical-erasure claim is made.

Operators keep current dispositions independently of old backups, inspect safe counts, use quarantined maintenance and verify scope/generations before recovery. Public reports use synthetic data and safe summaries. The detailed local store/evidence inventory stays private.
