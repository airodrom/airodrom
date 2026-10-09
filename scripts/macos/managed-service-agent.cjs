#!/usr/bin/env node
'use strict';
// Operator control for the ADR 0031 LaunchAgent: plan | status | install | uninstall.
// install and uninstall are dry runs unless --apply is given. Output is sanitized.
const os = require('node:os');
const agent = require('../../src/managed-service-agent');

const [command = 'plan', ...flags] = process.argv.slice(2);
const apply = flags.includes('--apply'), replace = flags.includes('--replace');
const sanitize = value => JSON.parse(JSON.stringify(value).split(os.homedir()).join('~'));
try {
  if (flags.some(flag => !['--apply', '--replace'].includes(flag))) throw Error('usage');
  let result;
  if (command === 'plan') { const p = agent.plan(); result = { label: p.label, agent: p.agent, checks: agent.checks(p).problems }; }
  else if (command === 'status') result = agent.status();
  else if (command === 'install') result = agent.install({ apply, replace });
  else if (command === 'uninstall') result = agent.uninstall({ apply });
  else throw Error('usage');
  console.log(JSON.stringify(sanitize(result), null, 2));
  if (result.refused?.length) process.exitCode = 2;
} catch (error) {
  console.error(error.message === 'usage' ? 'Use: plan | status | install [--apply] [--replace] | uninstall [--apply]' : 'Managed service agent request failed; no private details shown.');
  process.exitCode = 1;
}
