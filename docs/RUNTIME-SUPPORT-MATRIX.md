# Runtime support matrix

Support is product scope, not execution authority or current availability. Candidate validation uses synthetic stores, transport stubs and optional installed-runtime fixture simulations. No live provider or production operation is qualified by this pass.

| Component | Tier | Dispatch and qualification boundary |
| --- | --- | --- |
| Pi local control and typed capabilities | REQUIRED | Immutable Mission scope, protected approvals, lease and independent verification gates |
| Pi agentic RPC | Local optional path | Installed worker closure, provider admission and sandbox qualification required |
| Claude Code | SUPPORTED, optional | Host authentication and qualified runtime required; no new live proof in this pass |
| Work/Codex | OPTIONAL | Tested port/attempt envelope; no configured live-qualified private transport |
| Cursor | EXPERIMENTAL | Observation only; governed workspace writes, continuation and result publication denied |
| Generic Cloud | UNSUPPORTED | No concrete runtime; receives no dispatch/context |
| Reasoning providers | Separate from agents | Privacy/cost admission; inference grants no execution authority; DeepSeek disabled/auth_required |

| Platform/toolchain | Candidate status |
| --- | --- |
| macOS arm64, Node 22.23.3, npm 10.9.9 | Fresh local candidate validation |
| Node 22.x newer versions | Intended compatible range; rerun checks on the actual runtime |
| Linux, Windows, other architectures, Node 24+ | Unqualified; do not infer support from schemas or adapters |

Optional external availability does not lower required local security/privacy gates. A CLI wrapper is not an OS sandbox. Cancellation requests and timeouts do not prove termination. Physical retention and provider copies have separate limits described in [privacy and erasure](PRIVACY-ERASURE.md).
