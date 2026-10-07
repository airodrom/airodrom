'use strict';
// Detached native operator terminal; values never enter inference or receipts.
const {hidden} = require('./vault-cli');
const storage = require('./personal-storage-intent');
async function guide({input, output, home, plan, message, signal, vault, request} = {}) {
 if (!input?.isTTY || !output?.isTTY || typeof input.setRawMode !== 'function') throw Error('Private storage requires an interactive operator terminal.');
 if (input.listenerCount('data') || input.listenerCount('readable')) throw Error('Close ordinary terminal input before private storage.');
 const name = storage.label(plan?.label);
 if (!['save', 'reveal'].includes(plan?.action)) throw Error('Choose a private storage operation.');
 request ||= body => require('./local-bootstrap').request(home, '/api/assistant/private-memory', body);
 if (!vault) {
  const local = require('./local-bootstrap'), path = require('node:path');
  vault = new (require('./secret-vault').SecretVault)(local.privateDirectory(path.join(home, 'data'), true));
 }
 const choose = prompt => hidden(input, output, {prompt, maximum:16, signal});
 const cancelled = () => {output.write('Private storage cancelled.\n'); return {state:'cancelled'};};
 let value = '';
 try {
  if (plan.action === 'save') {
   if (typeof message !== 'string' || require('./assistant-intent').secret(message) || /[\r\n\0]/.test(message)) throw Error('Private number unavailable.');
   value = /\b(\d{1,12})[.!?]*\s*$/.exec(message)?.[1] || '';
   if (!value) throw Error('Private number unavailable.');
   output.write(`I can save ${name.toLowerCase()} locally. Its value stays hidden.\n1. Sensitive Memory (private local SQLite; operator-only)\n2. Named Vault entry (macOS Keychain)\n3. Cancel\n`);
   const target = await choose('Choose 1–3 (hidden): ');
   if (!['1', '2'].includes(target) || signal?.aborted) return cancelled();
   if (target === '2' && !vault.status().configured) {output.write('Keychain is unavailable. Prepare secure entry with airodrom secret prepare.\n'); return {state:'unavailable'};}
   const backend = target === '1' ? 'Sensitive Memory' : 'Vault';
   output.write(`Save ${name.toLowerCase()} in ${backend}?\n`);
   if ((await choose('Type yes to confirm (hidden): ')).toLowerCase() !== 'yes' || signal?.aborted) return cancelled();
   const receipt = target === '1' ? await request({action:'save', label:name, value, confirmed:true}) : vault.put(value, 'operator', {kind:'private_identifier', label:name});
   output.write(`${name} saved in ${backend}.\n`);
   return {state:'saved', backend, ...(target === '1' ? {memoryId:receipt.memoryId} : {reference:receipt.reference})};
  }
  const memory = await request({action:'lookup', label:name});
  const choices = [...memory.items.map(item => ({backend:'Sensitive Memory', id:item.memoryId})), ...vault.privateEntries(name).map(item => ({backend:'Vault', id:item.reference}))];
  if (!choices.length) {output.write(`No current ${name.toLowerCase()} entry found.\n`); return {state:'empty'};}
  let selected = choices[0];
  if (choices.length > 1) {
   choices.forEach((item, i) => output.write(`${i + 1}. ${name} · ${item.backend}\n`));
   const index = await choose('Choose an entry number, or 0 to cancel (hidden): ');
   selected = /^[1-9]\d*$/.test(index) ? choices[Number(index) - 1] : null;
   if (!selected || signal?.aborted) return cancelled();
  }
  output.write(`Reveal ${name.toLowerCase()} from ${selected.backend} in this terminal?\n`);
  if ((await choose('Type yes to reveal (hidden): ')).toLowerCase() !== 'yes' || signal?.aborted) return cancelled();
  value = selected.backend === 'Vault' ? vault.revealPrivate(selected.id, {confirmed:true}) : (await request({action:'reveal', label:name, id:selected.id, confirmed:true})).value;
  if (signal?.aborted) return cancelled();
  if (typeof value !== 'string' || !/^\d{1,12}$/.test(value)) throw Error('Private number unavailable.');
  output.write(`Your ${name.toLowerCase()} is ${value}.\n`);
  return {state:'revealed', operator_only:true};
 } catch (error) {
  if (signal?.aborted || error.message === 'Secure entry cancelled') return cancelled();
  output.write('Private storage unavailable. Review the current named entry; values stay hidden.\n');
  return {state:'unavailable'};
 } finally {value = '';}
}
module.exports = {guide};
