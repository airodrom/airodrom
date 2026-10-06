# ADR 0005 — OpenCode execution boundary

Status: ACCEPTED for the adapter contract. Qualification evidence is separate.

Airodrom admits OpenCode as an execution agent beside Pi. Pi's local control and verification services remain required. Installing or discovering a CLI does not activate it or change the default route.

The first adapter supports OpenCode CLI 2.0.20 on macOS with an explicitly configured local Ollama coding model. It starts a private standalone runtime, transfers an exact set of bounded existing regular files into a disposable workspace, and passes instructions through standard input. Ordered OpenCode permissions deny every tool except declared file reads and edits. An inherited operating system sandbox confines data and writes to the disposable workspace and session state, permits only the pinned executable, and denies internet traffic. Localhost inference and private runtime transport are declared dependencies.

OpenCode owns no Mission, policy, memory, verification, Acceptance or Settlement authority. It never receives the original checkout, canonical database, credentials, registered test definitions or repository write credentials. Airodrom verifies preimages and applies returned changes through its existing capability broker. The Result Inbox and independent repository verifier remain authoritative for evidence. Acceptance and Settlement keep their existing order.

Memory V2 stays canonical. The host reconstructs minimum context from a current authorized ContextPack, ignoring runtime-supplied or caller-supplied cached records. Correction and erasure invalidate prior packs. Each execution uses isolated fresh session state; native session reuse is denied. Explicit rework can use a fresh Mission dispatch with freshly retrieved context. No runtime session becomes a memory source.

Timeout and cancellation kill the owned process group. Uncertain termination or uncertain application keeps the workspace lease quarantined. Restart does not replay an uncertain dispatch. Provider copies, physical storage and external backups retain the limits of ADR 0004; this decision adds no forensic deletion claim.
