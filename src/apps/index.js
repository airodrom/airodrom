'use strict';
// Explicit, host-owned composition. Installing files never enables execution.
const { AppRegistry } = require('../sdk/app-registry');
function capabilityApps() {
  const registry = new AppRegistry();
  const git = require('./capability-git').gitCapabilities();
  const connectors = require('./capability-connectors');
  const entries = {
    git: Object.fromEntries(Object.entries(git).filter(([name]) => !name.startsWith('github_'))),
    github: Object.fromEntries(Object.entries(git).filter(([name]) => name.startsWith('github_'))),
    connectors: { ...connectors.connectorCapabilities(), ...connectors.databaseCapabilities(), ...connectors.agentCapabilities() }
  };
  for (const [id, capabilities] of Object.entries(entries)) registry.register({ manifest: { id, version: '1.0.0', sdk: '^1.0.0' }, capabilities });
  for (const id of ['slack', 'provider-transports', 'memory-adapter', 'execution-agents']) registry.register({ manifest: { id, version: '1.0.0', sdk: '^1.0.0' } });
  return registry;
}
module.exports = { capabilityApps };
