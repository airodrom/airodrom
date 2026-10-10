# Airodrom Product Experience V2

Airodrom is a pre-release local AI operating platform. OpenCode is the primary bounded worker; Airodrom owns authority, Memory V2, Capability Broker, independent verification, Acceptance, Settlement, leases, audit and erasure. The compatible implementation decision is [ADR 0009](adr/0009-product-observability-and-runtime-requalification.md).

## Start locally

Use supported Node 22.23.3 or later in the 22.x line, macOS, Xcode command-line tools, qualified OpenCode 2.0.25 and local Ollama with qwen3-coder:30b. See [installation](INSTALLATION.md) for the exact qualified artifact and platform boundary.

```sh
npm ci --ignore-scripts
npm run install:local
airodrom
```

Startup performs real confined qualification before writing private runtime pins. A supported stale Node pin self-requalifies with the exact OpenCode and Seatbelt artifacts preserved. Active/uncertain work blocks repair. Unsupported changes remain unavailable.

```sh
airodrom help
airodrom doctor
airodrom status
airodrom requalify   # owned service must be stopped
airodrom open
airodrom menu
```

`/help` lists actual interactive commands. `/remember`, `/memory` and `/forget` use explicit Personal Memory V2 operations; `/remember` with corrected content for the same subject supersedes stale context. `/task` admits declared scoped Mission JSON. A plain question admits one local reasoning turn with no tools/files/shell/internet/subagents and at most two minutes. `/accept` records the operator's reviewed Acceptance and local Settlement.

## Live Control Center

Control Center atmosphere/theme mounts recovered on `feat/control-center-ui-recovery-v1` (see [CONTROL-CENTER-UI-RECOVERY-V1.md](CONTROL-CENTER-UI-RECOVERY-V1.md)); not yet shipped on main.

`/open` and the native menu open the private Control Center through discovery kept in memory. The overview shows actual health, retained Mission counts, approvals and recent outcomes. Mission details show canonical lifecycle, attempts, budgets, Memory selection/delivery metadata, termination, independent verification checks, Acceptance and Settlement. Safe timestamped activity has category filters and cursor catch-up. A paused feed differs from a paused Mission.

Memory supports explicit retrieval, remember, selected-record correction and forgetting through current canonical scope guards. Projects show a bounded priority-ordered list and backed archive controls. Approvals show bounded safe state/expiry records and task-bound exact-operation review links.

Only an authoritative declared denominator can produce determinate completion. Current profiles show indeterminate observed activity; paused/blocked work does not animate as advancing. Budget consumption is labeled separately. Memory delivery never claims hidden model use. Unobserved health and unsupported stages say unavailable. Historical verification cannot enable Acceptance.

The authorized task workspace remains available for actual answer and protected-operation review. The cockpit never downloads generic raw envelopes or evidence panels. Its canonical mutations return safe receipts. Technical identity expansion does not relax redaction.

## Personal AI conversation

Ordinary conversation in Control Center uses the host ConversationEngine with a persistent browser session, scoped history, optional ordinary Memory V2 consent and clear local-ollama / Qwen identity. Everyday Personal AI UX V1 places a visible Conversation model control on the Conversation surface (Qwen default local; Claude WAIT), Continue previous / Start new conversation actions, an explicit Memory consent status line, and honest model activity plus reconnect notices. Work Mission model and worker selectors stay on the Missions rail. Mission cards surface active work, assigned worker, verified activity, pending approval, Settlement and Open Observatory without fabricated progress. See [Conversation Engine V1](CONVERSATION-ENGINE-V1.md) and [Everyday Personal AI UX V1](EVERYDAY-PERSONAL-AI-UX-V1.md). ChatGPT MCP Mission tools remain compatible. WhatsApp production outbound and automatic Mission execution stay disabled under the Meta policy HOLD.

## Native menu

The native macOS menu (Premium Menu V3) uses the canonical connected A geometry as an optically padded 18pt Retina template mark. Status color is a compact corner indicator only: system green/blue/orange/red for healthy/working/degraded/disconnected, and a restrained warm-gold accent for ACTION REQUIRED. Pale yellow wash is avoided. Primary status vocabulary is CONNECTED, DEGRADED, DISCONNECTED and ACTION REQUIRED.

Menu hierarchy keeps Everyday UX sections—System Status, Active Mission, Workers, Memory, Model, Connectors, Actions, Diagnostics, Service—with clearer section headers and consistent label spacing. Conversation identity stays separate from Missions. Featured Active Mission is host-backed live execution only (`dispatching` / `running` / `verifying`). Missions in `awaiting_acceptance` or `waiting_for_operator` surface as NEEDS REVIEW / ACTION REQUIRED and never as active work. View Active Mission / Cancel Mission enable only for live featured Missions; Review Missions & Approvals remains the review path.

Deep links still open allowlisted Control Center views through private discovery (Open Conversation, Active Missions, Continue Development Session, Open System Health, Open Control Center). Open CLI uses a fixed private launcher. Start/stop/restart preserve ownership and lock guards. Quit Menu leaves the control plane running.

`airodrom menu` prepares/opens the local helper. `install:local` prepares it without changing login settings. Optional login startup uses `npm run macos:desktop-login:install` (`local.airodrom.desktop-login`), which starts Ollama if needed, the owned Control Plane via `local.start`, then the native menu. It does not enable legacy `local.pi-chatgpt-bridge*` agents or merge startup PR #36. See [INSTALLATION.md](INSTALLATION.md).

## Visual system and sources

The real Airodrom asset suite supplies the connected A, horizontal wordmark, monochrome mark and dimensional hero. The terminal samples the same even-odd geometry into half-block cells, blue/cyan front, indigo extrusion, mint highlight and restrained shadow. It supports truecolor, 256 color, 16 color, no color, non-TTY and compact layouts.

Owner-controlled Somin primitives were ported into independently buildable plain HTML/CSS/JavaScript: ThemeProvider palette/typography/timing roles; GlassCard, HackerButton and input focus; layered HackerLayout atmosphere; PlatformShell/AreciboShell gradient frames, navigation and status chips; AreciboWidgets status/elevation; WeatherAtmosphere reduced-motion/visibility guards; CyberPercentLoader surface/track styling only. Simulated progress, weather canvas, glitch effects, auth, business APIs and deployment dependencies are excluded. Exact source hashes and adaptations are in [the source inventory](V2-SOURCE-INVENTORY.json).

## Verification and limits

The source remains PRE-RELEASE. Local synthetic qualification does not qualify other platforms, versions or artifacts. There is no hidden reasoning viewer, fabricated percentage, production release or deployment. Restoring a pre-correction backup preserves current supersession in both Personal and governed Memory. Copies require matching current identities, scope, protected payload and policy; later source corrections invalidate their freshness witness. Logical memory erasure retains the documented [physical-copy limits](PRIVACY-ERASURE.md). Required checks and independent reviews remain mandatory; repository branch protection is not assumed from documentation. See [CI expectations](CI-BRANCH-PROTECTION.md).
