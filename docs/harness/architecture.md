# Canonical architecture

Memory supplies reference context and never changes agent/provider policy, scopes or Acceptance.

Pi Worker also has an existing provider-backed RPC path (`pi-adapter.js`), distinct from provider-independent native execution.

DeepSeek stays disabled/auth_required.

Anthropic reasoning requires explicit privacy and cost admission; source fixtures do not qualify a live provider.

This repair does not import ChatGPT conversation history into Pi memory or enable automatic promotion.

See [architecture](../ARCHITECTURE.md) and the [runtime matrix](../RUNTIME-SUPPORT-MATRIX.md).
