# Runtime support matrix

**PRE-RELEASE.** Qualification is specific to declared boundaries.

| Runtime or capability | Support | Boundary |
| --- | --- | --- |
| OpenCode | Planning / evaluation | Bounded planning, read-only review and independent evaluation; implementation is assigned to Cursor |
| Claude Code | Adapter retained; implementation excluded | No implementation selection or fallback under ADR 0065 |
| Work / Codex | Engineering / external handoff | No Mission implementation selection or fallback under ADR 0065 |
| Cursor | Exclusive implementation / correction | Governed sandboxed worker requires current runtime qualification, repository/file scope and bound standing or owner authorization. Candidate lifecycle tests are isolated and do not establish installed/live qualification |
| Generic Cloud | Unsupported | No execution adapter |
| Airodrom host primitives | Required control-plane capability | Deterministic typed operations and independent verification; no model or agent runtime |
| Ollama | Local inference provider | Bounded host reasoning and OpenCode inference; no agent adapter or ownership |

Pi is removed. Historical identities are read-only provenance and cannot execute or receive memory. All runtimes remain subordinate to Airodrom authority, lease, privacy and Acceptance controls. See [migration](PI-REMOVAL.md).

See [Multi-Worker V2](MULTI-WORKER-V2.md) for qualification, failure states, host-only browser evidence and exact supported boundaries.

Current Mission worker policy: [ADR 0065](adr/0065-cursor-only-routine-autonomy.md). Runtime availability alone does not grant execution.
