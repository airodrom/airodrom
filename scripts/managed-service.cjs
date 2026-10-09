#!/usr/bin/env node
'use strict';
// ADR 0031 launchd entry. One supervisor per Airodrom home; it owns the local
// service process, not Mission authority. Nothing is written to stdout or argv.
const local = require('../src/local-bootstrap');
const { Supervisor } = require('../src/managed-supervisor');
const runtime = require('../src/managed-service-runtime');

async function main() {
  process.umask(0o077);
  const controller = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => controller.abort());
  const home = local.localHome();
  const release = await runtime.acquireSupervisorLock(home, controller.signal);
  if (!release) return;
  try { await new Supervisor(runtime.adapters(home)).run(controller.signal); }
  finally { release(); }
}

// A non-zero exit lets launchd's KeepAlive relaunch the supervisor after its throttle.
if (require.main === module) main().catch(() => { process.exitCode = 1; });
module.exports = { main };
