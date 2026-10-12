# CLI Client Reliability V1

Hardening for Terminal client attach, service lifecycle separation, install
alignment detection, and shared health contracts. Extends the emergency recovery
work on PR #70. Does **not** authorize tip cutover or global CLI replacement.

## Problem

The PATH `airodrom` command pointed at an older package (`airodrom-menu-v3`) while
the managed service ran from `airodrom-menu-status-525458c`. Client entry called
`local.start()`, which refused a healthy foreign source revision with:

> A live or unverified service owns the data directory.

Everyday chat therefore failed even though Control Plane, Memory, and Qwen were Ready.

## Contract

| Surface | Behavior |
| --- | --- |
| `airodrom` / `airodrom chat` | **Client attach only** via discovery + authenticated local API. Never spawns a second supervisor. |
| `airodrom status` / `doctor` | Client read of live health; doctor also reports PATH install alignment. |
| `airodrom service start\|stop\|restart` | Explicit lifecycle. `start` attaches if healthy; starts only when stopped. |
| `start\|stop\|restart` | Legacy aliases for `service …`. |
| Menu `product-control` | Same discovery home; MCP readiness probed (not hard-coded false). |
| Locks | Never deleted. Unresponsive owners refuse replacement. |

Attach uses `allowOlderSource` so a Terminal package may talk to a healthy managed
tip from another install. Same-source pin repair and owning lifecycle remain gated.

## Install alignment

`src/cli-command-inspect.js` compares `which -a airodrom` to this package’s
`scripts/airodrom.cjs`. Stale/unrelated PATH commands are reported by
`airodrom doctor` and never auto-replaced.

### Authorization required to update PATH `airodrom`

Observed: Terminal `airodrom` → `…/airodrom-menu-v3-…/scripts/airodrom.cjs` (stale).

Verified replacement (already tested against the live tip without mutation):

```sh
cd /path/to/authorized/package   # tip or this PR worktree after review
npm unlink -g airodrom           # only if operator authorizes replacing the command
npm run install:local
hash -r
airodrom doctor
airodrom status
airodrom chat
```

Until that authorization is given, use:

```sh
node /path/to/package/scripts/airodrom.cjs status
node /path/to/package/scripts/airodrom.cjs chat
```

## Tests

- `tests/cli-client-reliability.test.js` — attach across source mismatch, no
  launch.lock, unresponsive no-replacement, concurrent attach, stopped guidance,
  main wiring
- `tests/cli-install-smoke.test.js` — package bin help/status smoke + PATH inspect
- `tests/menu-control-alignment.test.js` — menu `AirodromControl` drift
- Existing interactive / conversation CLI suites (attach mocks)

Known flake (pre-existing teardown): `signed near-expiry conversation…` can fail
hook shutdown with unverified termination; not required for client-attach acceptance.

## Live evidence (2026-10-11)

Against managed tip `525458c` on dynamic port discovery, worktree CLI:

- `status` / `doctor` Ready; single `local-service`; doctor reports stale PATH install
- Interactive remember → memory search → Qwen `PONG` → forget succeeded
- No tokens in terminal output; no second supervisor
