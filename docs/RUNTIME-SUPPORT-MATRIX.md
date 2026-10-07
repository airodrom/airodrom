# Runtime support matrix

**PRE-RELEASE.** Qualification is specific to declared boundaries.

| Runtime or capability | Support | Boundary |
| --- | --- | --- |
| OpenCode | Primary / default | Qualified 2.0.20 on macOS with local Ollama; disposable declared-file execution and host-applied changes |
| Claude Code | Existing optional supported runtime | Explicit immutable external/subscription policy; no fallback from unavailable default OpenCode |
| Work / Codex | Optional; live execution unqualified | Existing governed handoff/result protocol; requires independent verification |
| Cursor | Experimental | Status only; governed execution denied |
| Generic Cloud | Unsupported | No execution adapter |
| Airodrom host primitives | Required control-plane capability | Deterministic typed operations and independent verification; no model or agent runtime |
| Ollama | Local inference provider | Bounded host reasoning and OpenCode inference; no agent adapter or ownership |

Pi is removed. Historical identities are read-only provenance and cannot execute or receive memory. All runtimes remain subordinate to Airodrom authority, lease, privacy and Acceptance controls. See [migration](PI-REMOVAL.md).
