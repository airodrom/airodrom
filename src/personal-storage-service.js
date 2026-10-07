'use strict';
// Authenticated operator endpoint only; no model or worker registration.
const {object} = require('./control-plane-store');
const storage = require('./personal-storage-intent');
const typeFor = name => 'private_identifier.' + name.toLowerCase().replaceAll(' ', '_');
function current(bridge, name) {
 const memory = bridge.personalMemory;
 require('./memory-erasure').assertCurrent(memory.db);
 require('./memory-identity').assertReadable(memory.db);
 return memory.db.prepare("SELECT memory_id FROM personal_memories WHERE domain='personal' AND type=? AND sensitivity='sensitive' AND status='active'").all(typeFor(name))
  .map(row => memory.get(row.memory_id)).filter(item => item?.status === 'active' && item.source === 'user_explicit' && item.sensitivity === 'sensitive');
}
function operate(bridge, input) {
 object(input, ['action', 'label', 'value', 'id', 'confirmed']);
 const name = storage.label(input.label);
 const rows = current(bridge, name);
 if (input.action === 'lookup') {
  if (input.value !== undefined || input.id !== undefined || input.confirmed !== undefined) throw Error('Lookup accepts a name only.');
  return {items:rows.map(item => ({memoryId:item.memoryId, label:name})), operator_only:true, authority:false};
 }
 if (input.confirmed !== true) throw Error('Fresh operator confirmation required.');
 if (input.action === 'save') {
  if (input.id !== undefined || typeof input.value !== 'string' || !/^\d{1,12}$/.test(input.value)) throw Error('Only a named private number can use this path. Credentials require native secure entry.');
  if (rows.length) throw Error('A private entry with this name already exists. Review or forget it before saving another.');
  const item = bridge.personalMemory.remember({domain:'personal', type:typeFor(name), subject:'sensitive.' + require('node:crypto').randomUUID(), content:input.value, source:'user_explicit', sensitivity:'sensitive'});
  return {memoryId:item.memoryId, stored:true, operator_only:true, authority:false};
 }
 if (input.action === 'reveal') {
  if (input.value !== undefined || rows.length !== 1 || rows[0].memoryId !== input.id || !/^\d{1,12}$/.test(rows[0].content)) throw Error('One current named private entry is required.');
  return {memoryId:rows[0].memoryId, value:rows[0].content, operator_only:true, authority:false};
 }
 throw Error('Choose save, lookup or reveal.');
}
module.exports = {operate};
