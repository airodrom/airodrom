# ADR 0050 — Terminal intent routing and controlled self-repair fixture

Status: Proposed (source implementation). Does not authorize Production mutation or automatic Acceptance.

## Decision

Natural-language WORK classification recognizes requested file/repository actions after harmless contextual preambles. Ordinary discussion or how-to questions about files remain CONVERSATION. Classification never grants execution; ZeroSetupWork preparation and authenticated Terminal `y/N` (or Control Center) remain required.

For disposable self-repair acceptance, an owner-placed marker `.airodrom/controlled-verify-fail-once.json` may instruct the host to introduce exactly one exact-file mismatch immediately before independent verification of the original Mission. The marker is consumed atomically. Corrective Missions (`repair_of`) never re-apply it. OpenCode (or the authorized worker) repairs within the original scope; Acceptance and Settlement stay owner-only.

## Compatibility

Extends ADR 0011 intent routing, ADR 0048 autonomous repair, and zero-setup Terminal consent. Historical Missions are unchanged.
