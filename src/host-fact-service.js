'use strict';
// Host-governed answers for date/time, ports, Airodrom services, and health.
// Never invents measurements. Never grants Mission authority or shell access.

const HOST_SCOPES = Object.freeze(['system_readonly', 'mac_local']);
const MAX_PORT_LIST = 40;
const STALE_MS = 60_000;

function ephemeralTask(id = 'host-facts') {
  return {
    id,
    workspace: null,
    capabilityScopes: [...HOST_SCOPES],
    mission: null,
  };
}

function base(extra = {}) {
  return {
    kind: 'host_fact',
    route: 'HOST_FACT',
    host_verified: true,
    model_invoked: false,
    authority: false,
    execution_authorized: false,
    observed_at: Date.now(),
    ...extra,
  };
}

function deny(message, code, extra = {}) {
  return base({
    kind: 'clarify',
    message,
    code,
    available: false,
    ...extra,
  });
}

async function invokeCapability(server, name, input = {}) {
  const host = server?.bridge?.capabilityHost;
  if (!host || typeof host.prepare !== 'function' || typeof host.perform !== 'function') {
    return { ok: false, code: 'capability_host_unavailable', reason: 'Host capability runtime is unavailable.' };
  }
  if (!host.definitions?.[name] && !host.definitions?.[String(name)]) {
    // Some hosts expose definitions via describe/inventory only.
  }
  const task = ephemeralTask(`host-facts-${name}`);
  let prepared;
  try {
    prepared = await host.prepare(task, name, input);
  } catch (error) {
    return { ok: false, code: 'capability_input_error', reason: String(error.message || error).slice(0, 200) };
  }
  const decision = prepared?.assessment?.decision;
  if (decision === 'deny') {
    return {
      ok: false,
      code: prepared.assessment.kind || 'capability_denied',
      reason: prepared.assessment.reason || `Capability ${name} was denied by policy.`,
      assessment: prepared.assessment,
    };
  }
  if (decision !== 'auto_allow' && decision !== 'allow') {
    return {
      ok: false,
      code: prepared.assessment?.kind || 'capability_not_executable',
      reason: prepared.assessment?.reason || `Capability ${name} is not automatically executable (${decision || 'unknown'}).`,
      assessment: prepared.assessment,
    };
  }
  try {
    const performed = await host.perform(task, prepared);
    return { ok: true, result: performed?.result, duration_ms: performed?.duration_ms, assessment: prepared.assessment };
  } catch (error) {
    return { ok: false, code: 'capability_failed', reason: String(error.message || error).slice(0, 200) };
  }
}

function zoneParts(date = new Date()) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  });
  const parts = Object.fromEntries(dtf.formatToParts(date).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
  const dateOnly = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(date);
  const timeOnly = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
  const tzName = parts.timeZoneName || tz;
  return { tz, dateOnly, timeOnly, tzName, parts, iso: date.toISOString(), epoch_ms: date.getTime() };
}

function addLocalDays(date, days) {
  // Advance by calendar day in the host's local timezone (not UTC day).
  const local = new Date(date.getTime());
  local.setDate(local.getDate() + days);
  return local;
}

function answerDateTime(detail) {
  const now = new Date();
  const current = zoneParts(now);
  if (detail === 'time') {
    return base({
      fact: 'DATE_TIME',
      detail: 'time',
      message: `It's ${current.timeOnly} ${current.tzName}.`,
      clock: { timezone: current.tz, time: current.timeOnly, time_zone_name: current.tzName, epoch_ms: current.epoch_ms },
    });
  }
  if (detail === 'date') {
    return base({
      fact: 'DATE_TIME',
      detail: 'date',
      message: `Today is ${current.dateOnly} (${current.tzName}).`,
      clock: { timezone: current.tz, date: current.dateOnly, time_zone_name: current.tzName, epoch_ms: current.epoch_ms },
    });
  }
  if (detail === 'timezone') {
    return base({
      fact: 'DATE_TIME',
      detail: 'timezone',
      message: `This Mac's local timezone is ${current.tz} (${current.tzName}).`,
      clock: { timezone: current.tz, time_zone_name: current.tzName, epoch_ms: current.epoch_ms },
    });
  }
  if (detail === 'tomorrow') {
    const next = zoneParts(addLocalDays(now, 1));
    return base({
      fact: 'DATE_TIME',
      detail: 'tomorrow',
      message: `Tomorrow is ${next.dateOnly} (${next.tzName}).`,
      clock: { timezone: next.tz, date: next.dateOnly, time_zone_name: next.tzName, epoch_ms: next.epoch_ms, relative: 'tomorrow' },
    });
  }
  // both / default
  return base({
    fact: 'DATE_TIME',
    detail: 'both',
    message: `It's ${current.timeOnly} ${current.tzName} on ${current.dateOnly}.`,
    clock: {
      timezone: current.tz,
      date: current.dateOnly,
      time: current.timeOnly,
      time_zone_name: current.tzName,
      epoch_ms: current.epoch_ms,
    },
  });
}

function sanitizeListener(row) {
  const command = typeof row.command === 'string' ? row.command.split(/[\s/]/).pop() : null;
  // Never surface full command lines or paths that may include secrets.
  return {
    port: row.port,
    pid: Number.isFinite(row.pid) ? row.pid : null,
    process: command && command.length <= 64 ? command : null,
    address: typeof row.address === 'string' ? row.address.slice(0, 64) : null,
  };
}

async function answerPorts(server, port) {
  if (port != null) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return deny(`Port ${port} is not a valid TCP port (1–65535).`, 'invalid_port', { fact: 'PORT_DIAGNOSTICS', port });
    }
  }
  const invoked = await invokeCapability(server, 'port_status', port == null ? {} : { port });
  if (!invoked.ok) {
    return deny(
      invoked.code === 'capability_scope_denied' || invoked.code === 'capability_denied'
        ? `I could not check ports: ${invoked.reason}`
        : `Port diagnostics are unavailable (${invoked.reason}). I did not invent a result.`,
      invoked.code,
      { fact: 'PORT_DIAGNOSTICS', port: port ?? null }
    );
  }
  const listeners = (invoked.result?.listeners || []).map(sanitizeListener);
  if (port != null) {
    const hits = listeners.filter((l) => l.port === port);
    if (!hits.length) {
      return base({
        fact: 'PORT_DIAGNOSTICS',
        port,
        in_use: false,
        listeners: [],
        message: `Port ${port} is not currently listening (no TCP LISTEN observed).`,
      });
    }
    const names = [...new Set(hits.map((h) => h.process).filter(Boolean))];
    const detail = names.length ? ` (process: ${names.join(', ')})` : '';
    return base({
      fact: 'PORT_DIAGNOSTICS',
      port,
      in_use: true,
      listeners: hits,
      message: `Yes — port ${port} is in use${detail}.`,
    });
  }
  if (!listeners.length) {
    return base({
      fact: 'PORT_DIAGNOSTICS',
      port: null,
      listeners: [],
      message: 'No TCP listening ports were observed by the authorized port_status capability.',
    });
  }
  const shown = listeners.slice(0, MAX_PORT_LIST);
  const ports = [...new Set(shown.map((l) => l.port))].sort((a, b) => a - b);
  const more = listeners.length > shown.length ? ` Showing ${shown.length} of ${listeners.length} listeners.` : '';
  return base({
    fact: 'PORT_DIAGNOSTICS',
    port: null,
    listeners: shown,
    message: `Listening TCP ports on this Mac: ${ports.join(', ')}.${more} Process names are basename-only; command arguments are omitted.`,
  });
}

function formatServiceRow(row) {
  const name = row.service || row.id || 'unknown';
  const label = row.label && row.label !== name ? `${row.label} (${name})` : name;
  if (row.error) return `${label}: unavailable (${String(row.error).slice(0, 80)})`;
  if (row.running === true) return `${label}: running`;
  if (row.running === false) return `${label}: not running`;
  if (row.verification) return `${label}: ${row.verification}`;
  return `${label}: status observed`;
}

async function answerServices(server) {
  const invoked = await invokeCapability(server, 'service_status', {});
  if (!invoked.ok) {
    return deny(
      `Airodrom service status is unavailable (${invoked.reason}). I did not invent process information.`,
      invoked.code,
      { fact: 'SERVICE_STATUS' }
    );
  }
  const services = Array.isArray(invoked.result?.services) ? invoked.result.services : [];
  if (!services.length) {
    return base({
      fact: 'SERVICE_STATUS',
      scope: 'airodrom_registry',
      services: [],
      message: 'No Airodrom-registered services were returned. This is not a full macOS process inventory.',
    });
  }
  const lines = services.map(formatServiceRow);
  return base({
    fact: 'SERVICE_STATUS',
    scope: 'airodrom_registry',
    services: services.map((s) => ({
      service: s.service,
      label: s.label || null,
      running: s.running === true ? true : s.running === false ? false : null,
      verification: s.verification || null,
      error: s.error ? String(s.error).slice(0, 120) : null,
    })),
    message: `Airodrom-registered services (not all macOS processes):\n${lines.map((l) => `• ${l}`).join('\n')}`,
  });
}

function normalizeComponentState(value) {
  if (value == null) return 'not_checked';
  const s = String(value);
  if (/^ready$/i.test(s)) return 'ready';
  if (/^degraded$/i.test(s)) return 'degraded';
  if (/^(unavailable|stopped|closed)$/i.test(s)) return 'unavailable';
  if (/not[_ ]?checked|deferred|unknown/i.test(s)) return 'not_checked';
  return s.slice(0, 40).toLowerCase();
}

async function answerHealth(server, { maxAgeMs = STALE_MS } = {}) {
  const bridge = server?.bridge;
  if (!bridge) {
    return deny('Control plane bridge is unavailable; health was not checked.', 'bridge_unavailable', { fact: 'AIRODROM_HEALTH' });
  }
  let status;
  const started = Date.now();
  try {
    status = await require('./product-observability').nativeStatus(bridge);
  } catch (error) {
    return deny(
      `Authoritative health could not be read (${String(error.message || error).slice(0, 120)}).`,
      'health_read_failed',
      { fact: 'AIRODROM_HEALTH' }
    );
  }
  const observed_at = Date.now();
  const age_ms = observed_at - started;
  // nativeStatus is live; reject only if caller injects a stale snapshot.
  if (status && typeof status.observed_at === 'number' && observed_at - status.observed_at > maxAgeMs) {
    return deny(
      `The last health observation is stale (${observed_at - status.observed_at} ms old) and was not presented as live.`,
      'stale_status',
      { fact: 'AIRODROM_HEALTH', observed_at: status.observed_at }
    );
  }

  const components = {
    overall: normalizeComponentState(status.status),
    control: normalizeComponentState(status.control),
    opencode: normalizeComponentState(status.runtime),
    memory_v2: normalizeComponentState(status.memory),
    provider_ollama: normalizeComponentState(status.provider),
    missions: {
      active: status.active_missions ?? null,
      review: status.review_missions ?? null,
      failed: status.failed_missions ?? null,
    },
    connectors: typeof status.connectors === 'string' ? status.connectors : 'not_checked',
    mcp: status.runtimeReason && /mcp/i.test(String(status.runtimeReason))
      ? normalizeComponentState(status.runtime)
      : 'not_checked',
    cursor_agent: status.cursor?.agent_availability || 'not_checked',
  };

  const summary = [
    `Overall: ${components.overall}`,
    `Control: ${components.control}`,
    `OpenCode: ${components.opencode}`,
    `Memory V2: ${components.memory_v2}`,
    `Provider (Ollama): ${components.provider_ollama}`,
    `Missions: ${components.missions.active ?? '?'} active, ${components.missions.review ?? '?'} need attention`,
    `Connectors: ${components.connectors}`,
  ].join('\n');

  const healthy = components.overall === 'ready';
  const lead = healthy
    ? 'Airodrom looks healthy from the live control-plane observation.'
    : components.overall === 'degraded'
      ? 'Airodrom is degraded — some components are not fully ready.'
      : `Airodrom status is ${components.overall}.`;

  return base({
    fact: 'AIRODROM_HEALTH',
    observed_at,
    age_ms,
    stale: false,
    components,
    message: `${lead}\n${summary}`,
  });
}

async function run(server, parsed) {
  if (!parsed || parsed.kind !== 'host_fact') {
    return deny('Not a host-fact request.', 'not_host_fact');
  }
  switch (parsed.fact) {
    case 'DATE_TIME':
      return answerDateTime(parsed.detail || 'both');
    case 'PORT_DIAGNOSTICS':
      return answerPorts(server, parsed.port === undefined ? null : parsed.port);
    case 'SERVICE_STATUS':
      return answerServices(server);
    case 'AIRODROM_HEALTH':
      return answerHealth(server);
    default:
      return deny(`Unsupported host fact: ${parsed.fact}`, 'unsupported_fact', { fact: parsed.fact });
  }
}

module.exports = {
  run,
  answerDateTime,
  answerPorts,
  answerServices,
  answerHealth,
  invokeCapability,
  ephemeralTask,
  HOST_SCOPES,
  STALE_MS,
  zoneParts,
};
