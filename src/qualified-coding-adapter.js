'use strict';
// Host-owned bounded executor. Proposals are data; typed capabilities retain authority.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { object, fingerprint } = require('./control-plane-store');
const { canonical } = require('./mission-manifest-paths');
const { allowsPath } = require('./mission-manifest');
const DESCRIPTOR = Object.freeze({
  id: 'pi.typed-coding', version: '1.0.0', protocol: 'coding-plan-v1',
  capabilities: Object.freeze(['exact_file_edit', 'registered_tests', 'registered_lint', 'registered_typecheck']),
  authority: 'intersected_manifest_and_typed_capability_policy',
  termination: 'in_process_awaited_capabilities', provider: null,
  commit: false, merge: false, deploy: false
});
function digest(file) {
  if (!fs.existsSync(file)) return null;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 12000) throw Error('Coding preimage is not a bounded regular file');
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function normalizePlan(input, { workspace, allowedFiles, manifest }) {
  object(input, ['version', 'operations']);
  if (input.version !== 1 || !Array.isArray(input.operations) || !input.operations.length || input.operations.length > 10) throw Error('Invalid coding plan bound');
  const seen = new Set();
  for (const op of input.operations) {
    object(op, ['name', 'path', 'content', 'preimage_sha256']);
    if (op.name !== 'file_write' || !allowedFiles.includes(op.path) || seen.has(op.path)) throw Error('Coding plan requires unique exact owned files');
    seen.add(op.path);
    const target = path.resolve(workspace, op.path);
    if (!manifest || canonical(target) !== target || !allowsPath(manifest, target, 'write')) throw Error('Coding plan manifest boundary exceeded');
    if (op.preimage_sha256 !== null && !/^[a-f0-9]{64}$/.test(op.preimage_sha256)) throw Error('Explicit coding preimage required');
    if (digest(target) !== op.preimage_sha256) throw Error('Coding preimage mismatch');
    // Reuse secret, size and path checks of the native dispatch contract.
    require('./agent-dispatch').dispatchPolicy({ native_actions: [{ name: op.name, path: op.path, content: op.content }] });
  }
  return { version: 1, adapter: { ...DESCRIPTOR, descriptor_hash: fingerprint(DESCRIPTOR) }, operations: structuredClone(input.operations) };
}
class QualifiedCodingAdapter {
  constructor(service) { this.service = service; }
  identity() { return structuredClone(DESCRIPTOR); }
  assert(mission, operation) {
    const plan = mission.envelope.coding_plan;
    if (!plan || plan.adapter.descriptor_hash !== fingerprint(DESCRIPTOR) || fingerprint(plan.adapter) !== fingerprint({ ...DESCRIPTOR, descriptor_hash: fingerprint(DESCRIPTOR) })) throw Error('Coding adapter qualification mismatch');
    const binding=this.service.db.prepare('SELECT envelope_hash FROM cp_execution_qualification WHERE mission_id=?').get(mission.id);
    if(!binding || binding.envelope_hash!==fingerprint(mission.envelope))throw Error('Immutable coding contract changed');
    this.service.program.assert(mission);
    const actions = plan.operations.map(({ name, path: file, content }) => ({ name, path: file, content }));
    if (fingerprint(actions) !== fingerprint(mission.envelope.dispatch_policy.native_actions)) throw Error('Coding plan binding mismatch');
    if (operation) {
      const op = plan.operations.find(o => o.path === operation.path);
      const target = path.resolve(mission.envelope.workspace, operation.path);
      if (!op || fingerprint({name:op.name,path:op.path,content:op.content}) !== fingerprint(operation) || canonical(target) !== target || !allowsPath(mission.envelope.manifest, target, 'write') || digest(target) !== op.preimage_sha256) throw Error('Coding operation or preimage changed');
    }
  }
}
module.exports = { QualifiedCodingAdapter, normalizePlan, DESCRIPTOR, digest };
