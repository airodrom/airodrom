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

`/open` and the native menu open the private Control Center through discovery kept in memory. The overview shows actual health, retained Mission counts, approvals and recent outcomes. Mission details show canonical lifecycle, attempts, budgets, Memory selection/delivery metadata, termination, independent verification checks, Acceptance and Settlement. Safe timestamped activity has category filters and cursor catch-up. A paused feed differs from a paused Mission.

Memory supports explicit retrieval, remember, selected-record correction and forgetting through current canonical scope guards. Projects show a bounded priority-ordered list and backed archive controls. Approvals show bounded safe state/expiry records and task-bound exact-operation review links.

Only an authoritative declared denominator can produce determinate completion. Current profiles show indeterminate observed activity; paused/blocked work does not animate as advancing. Budget consumption is labeled separately. Memory delivery never claims hidden model use. Unobserved health and unsupported stages say unavailable. Historical verification cannot enable Acceptance.

The authorized task workspace remains available for actual answer and protected-operation review. The cockpit never downloads generic raw envelopes or evidence panels. Its canonical mutations return safe receipts. Technical identity expansion does not relax redaction.

## Native menu

The native macOS menu uses the canonical connected A geometry as a Retina-capable vector template image. Its status, OpenCode/Memory rows, approval badge, active Mission phase, System Health, Doctor, safe diagnostic copy, task-bound Open/Cancel Mission controls, service submenu, help and About match the product terminology. Open CLI uses a fixed private launcher, with no request text interpolated into a shell. Start/stop/restart preserve ownership and lock guards. Quit Menu Bar leaves the control plane running; service restart does not require helper restart.

`airodrom menu` prepares/opens the local helper. `install:local` prepares it without changing login settings. Launch at Login remains the existing opt-in [macOS installer](INSTALLATION.md); no speculative toggle or new persistence is added.

## Visual system and sources

The real Airodrom asset suite supplies the connected A, horizontal wordmark, monochrome mark and dimensional hero. The terminal samples the same even-odd geometry into half-block cells, blue/cyan front, indigo extrusion, mint highlight and restrained shadow. It supports truecolor, 256 color, 16 color, no color, non-TTY and compact layouts.

Owner-controlled Somin primitives were ported into independently buildable plain HTML/CSS/JavaScript: ThemeProvider palette/typography/timing roles; GlassCard, HackerButton and input focus; layered HackerLayout atmosphere; PlatformShell/AreciboShell gradient frames, navigation and status chips; AreciboWidgets status/elevation; WeatherAtmosphere reduced-motion/visibility guards; CyberPercentLoader surface/track styling only. Simulated progress, weather canvas, glitch effects, auth, business APIs and deployment dependencies are excluded. Exact source hashes and adaptations are in [the source inventory](V2-SOURCE-INVENTORY.json).

## Verification and limits

The source remains PRE-RELEASE. Local synthetic qualification does not qualify other platforms, versions or artifacts. There is no hidden reasoning viewer, fabricated percentage, production release or deployment. Restoring a pre-correction backup preserves current supersession in both Personal and governed Memory. Copies require matching current identities, scope, protected payload and policy; later source corrections invalidate their freshness witness. Logical memory erasure retains the documented [physical-copy limits](PRIVACY-ERASURE.md). Required checks and independent reviews remain mandatory; repository branch protection is not assumed from documentation. See [CI expectations](CI-BRANCH-PROTECTION.md).
