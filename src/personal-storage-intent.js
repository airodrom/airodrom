'use strict';
// Host operator ingress only. Routing receipts contain labels, never values.
const LABELS = ['Mailbox number', 'Locker number', 'Parking space number'];
function label(value) {
 const found = LABELS.find(item => item.toLowerCase() === String(value).trim().toLowerCase());
 if (!found) throw Error('Choose a supported private identifier name.');
 return found;
}
function containsPrivate(value) {
 if (typeof value === 'string') return /\b(?:mailbox|locker|parking\s+space)\s+number\b/i.test(value.normalize('NFKC'));
 if (Array.isArray(value)) return value.some(containsPrivate);
 return !!value && typeof value === 'object' && Object.values(value).some(containsPrivate);
}
function normalize(value, nickname) {
 let request = value.normalize('NFKC').trim();
 const names = ['Airodrom', 'Airo', ...(typeof nickname === 'string' && /^[\p{L}\p{N} .'-]{1,32}$/u.test(nickname) ? [nickname] : [])];
 const address = names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
 for (let i = 0; i < 8; i++) {
  const before = request;
  request = request.replace(new RegExp('^(?:hi|hey|hello|good morning|good afternoon|good evening)\\b[\\s,:.!–—-]*(?:(?:' + address + ')(?=$|[\\s,:.!?–—-])[\\s,:.!?–—-]*)?', 'iu'), '')
   .replace(new RegExp('^(?:' + address + ')[,:!–—-]+\\s*', 'iu'), '')
   .replace(new RegExp('^(?:' + address + ')\\s+(?=(?:please|can you|could you|would you|save|store|remember|let)\\b)', 'iu'), '')
   .replace(/^(?:please|can you|could you|would you|i want you to|i(?: would|['’]d) like you to|i want to|i need to|i(?: would|['’]d) like to|help me|let['’]s|let us)[\s,:]+/i, '').trim();
  if (request === before) break;
 }
 return request.replace(/[.!?]+$/, '').trim();
}
function parse(request, {capture = false} = {}) {
 if (/[\r\n]/.test(request) && containsPrivate(request)) return {route:'MEMORY', kind:'clarify', message:'Submit one private storage request at a time.'};
 const names = LABELS.join('|');
 const save = new RegExp('^(?:save|store|remember)\\s+(?:that\\s+)?(?:(?:secret of|the secret of)\\s+)?(?:my\\s+)?(' + names + ')\\s*(?:(?:is|:|=|-)\\s*)?(\\d{1,12})$', 'i').exec(request);
 if (save) return {route:'MEMORY', kind:'private_storage', action:'save', label:label(save[1]), ...(capture ? {value:save[2]} : {value_present:true})};
 const recall = new RegExp("^(?:what(?:['’]s| is)|show|reveal|recall|tell me|give me)\\s+(?:my\\s+)?(" + names + ")$", 'i').exec(request);
 if (recall) return {route:'MEMORY', kind:'private_storage', action:'reveal', label:label(recall[1])};
 if (containsPrivate(request)) return {route:'MEMORY', kind:'clarify', message:'Airodrom handles private identifiers locally. To save one, give its name and number; to retrieve it, ask by name. Quoted, negated or ambiguous text does not authorize storage.'};
 return null;
}
module.exports = {LABELS, label, normalize, parse, containsPrivate};
