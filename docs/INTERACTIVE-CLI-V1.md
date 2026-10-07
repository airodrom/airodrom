# Interactive CLI V1 (pre-release)

From a local source checkout on the qualified macOS arm64 host:

```sh
npm ci --ignore-scripts
npm run install:local
airodrom
```

The reversible local install uses the existing user-owned npm prefix, refuses to
replace another command and never edits shell startup files. Remove the command
with `npm unlink -g airodrom`; private service data remains available.

`airodrom` shows the compact brand and runtime status, starts or attaches to the
private local control plane and opens a terminal conversation. The browser is
optional. Bootstrap requires installed qualified OpenCode 2.0.20 and local Ollama
with `qwen3-coder:30b`. It generates actual host pins and runs a disposable
synthetic sandbox probe. No provider credentials are copied or printed. First
startup can take longer while the local model warms. Failed prerequisites give an
actionable error rather than enable another provider.

The startup logo defaults to colored terminal text with the canonical geometry,
subdued gradient and fine 3D depth. Its geometry is bundled in application code:
default startup does not open a logo asset or emit an image/file-transfer request.
This avoids terminal-owned inline-image approval dialogs during ordinary startup.

Set `AIRODROM_INTRO_GRAPHICS=image` to opt into the sharper transparent PNG in
Kitty, iTerm2 or WezTerm. The terminal's image permission policy still applies.
Unknown terminals, tmux/screen, redirected output, `TERM=dumb` and `NO_COLOR`
retain text or monochrome output. Startup does not download images, invoke an
image converter or query the terminal through conversation input.

Private persistent state is under `~/.airodrom`, with directories mode 0700 and
configuration/discovery files mode 0600. `AIRODROM_HOME` selects a dedicated
private home for synthetic testing. A live or unverifiable writer lock prevents
a second service. Attach validates credentials, PID ownership, loopback origin,
protocol and source identity. Stop uses the authenticated owning service endpoint
rather than signaling a discovered PID. Restart accepts the owning older source
but never rewrites another installation's configuration.

| Command | Behavior |
| --- | --- |
| `airodrom status` | Read aggregate local runtime status |
| `airodrom start` | Start or attach; no duplicate writer |
| `airodrom stop` | Stop the owned service; preserve memory |
| `airodrom restart` | Stop then start the owned service |
| `airodrom open` | Open optional Control Center without token copying |
| `airodrom memory [query]` | List/search current Personal Memory V2 |
| `airodrom task mission.json` | Register and dispatch an explicit scoped Mission |

Interactive commands are `/remember <text>`, `/memory [query]`, `/forget <id or
unambiguous query>`, `/vault`, `/mission new [objective]`, `/mission list`,
`/mission status [id]`, `/mission cancel [id]`, `/status`, `/details`,
`/runtime [opencode]`, `/open`, `/task <mission.json>`, `/accept [review evidence]`,
`/help` and `/quit`. Repeating “My
test codename is …” uses its subject to correct the current fact. Arbitrary
corrections can use the existing explicit memory-ID update API. Secret-like
content is rejected by the canonical memory service. No remembered instruction
can grant authority.

Ordinary questions use persistent direct local conversation with relevant
ordinary Memory V2 references. They create no Work Mission, Task or execution
lease and do not require `/accept`. The host routes Memory, secure Vault,
authorized connectors, work and explicit Missions before inference. Work needs a
host-registered bounded template; missing scope or qualification creates a
non-executable Mission draft with a clarification. `/task` and Control Hub retain
declared scope, registered verification, Acceptance and Settlement for executable
work. OpenCode remains the default bounded execution runtime; typed deterministic
plans use Airodrom host capabilities. Pi is removed and unavailable or
unqualified execution fails closed. Historical removed-runtime tasks cannot
receive context or resume. See [Conversation Engine V1](CONVERSATION-ENGINE-V1.md)
for routing, persistence, secure entry and connector boundaries.

The legacy foreground `npm start` and macOS login-service commands remain
available for existing installations. Their private instances are not adopted
or removed by this CLI. An old browser tab must use its owning updated service
before it can run the new admission path. Legacy task/shared scratch memories
are not automatically imported into Personal Memory V2.

See proposed [ADR 0011](adr/0011-conversation-engine-and-intent-routing.md) for the
ordinary chat distinction, [ADR 0007](adr/0007-local-interactive-missions.md) for
the retained governed Mission contract, and [the existing runtime
boundary](OPENCODE-RUNTIME-V1.md) for execution limits.
