'use strict';
// Test-only child. The parent copies this and the pure policy modules into a
// disposable sandbox. Never imported, packaged or routed by the live service.
if (process.env.AIRODROM_POLICY_SIMULATION_FIXTURE !== 'isolated-v1') throw Error('isolated synthetic fixture required');
const fs = require('node:fs');
const path = require('node:path');
const { CapabilityPolicy, loadCapabilityPolicy } = require('./src/capability-policy');
const root = __dirname;
if (process.cwd() !== root) throw Error('fixture cwd required');
const input = JSON.parse(fs.readFileSync(path.join(root, 'fixture.json'), 'utf8'));
const scenarios = new Set(['overrestrictive-read', 'missing-scope', 'always-deny', 'protected-class']);
if (!scenarios.has(input.scenario) || Object.keys(input).length !== 1) throw Error('fixed synthetic scenario required');
const document = JSON.parse(fs.readFileSync(path.join(root, 'config/capability-policy-v2.json'), 'utf8'));
const current = structuredClone(document), proposed = structuredClone(document);
let capability = 'file_read', scopes = ['repo'], changedRule = 'capabilities.file_read.decision';
if (input.scenario === 'overrestrictive-read') current.capabilities.file_read.decision = 'deny';
if (input.scenario === 'missing-scope') { scopes = []; changedRule = 'capabilities.file_read.taskScopes'; }
if (input.scenario === 'always-deny') { capability = 'secret_read_value'; proposed.capabilities[capability].decision = 'auto_allow'; changedRule = 'capabilities.secret_read_value.alwaysDeny'; }
if (input.scenario === 'protected-class') { capability = 'financial_transaction'; proposed.capabilities[capability].decision = 'auto_allow'; changedRule = 'neverAutomaticClasses'; }
function evaluate(policy, name) {
  const file = path.join(root, name + '.json'); fs.writeFileSync(file, JSON.stringify(policy));
  try {
    const evaluator = new CapabilityPolicy({ document: loadCapabilityPolicy(file) });
    const result = evaluator.decide(capability, { taskScopes: scopes });
    return { valid: true, decision: result.decision, kind: result.kind || null };
  } catch { return { valid: false, decision: 'deny', kind: 'policy_validation_failed' }; }
}
let outsideReadDenied = false, childDenied = false;
try { fs.readFileSync('/etc/passwd'); } catch (e) { outsideReadDenied = e.code === 'ERR_ACCESS_DENIED' || e.code === 'EPERM'; }
try { require('node:child_process').spawnSync('/usr/bin/true'); } catch (e) { childDenied = e.code === 'ERR_ACCESS_DENIED'; }
const net = require('node:net'); const server = net.createServer();
server.once('error', () => finish(true)); server.listen(0, '127.0.0.1', () => server.close(() => finish(false)));
function finish(networkDenied) {
  console.log(JSON.stringify({ schema_version: 1, synthetic_only: true, current: evaluate(current, 'current'),
    proposed: evaluate(proposed, 'proposed'), difference_rule: changedRule,
    containment: { outside_read_denied: outsideReadDenied, child_process_denied: childDenied, network_denied: networkDenied },
    authority: false, accepted: false, execution_permitted: false }));
}
