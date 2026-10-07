'use strict';
// Host operator ingress only. Routing receipts contain labels, never values.
const LABELS = ['Mailbox number', 'Locker number', 'Parking space number'];
function label(value) {
 const found = LABELS.find(item => item.toLowerCase() === String(value).trim().toLowerCase());
 if (!found) throw Error('Choose a supported private identifier name.');
 return found;
}
const containsPrivate=value=>require('./private-vault-intent').containsPrivate(value);
function normalize(value, nickname) {
 let request = value.normalize('NFKC').trim();
 const vocative = /^(?:hi|hey|hello)\s+([\p{L}][\p{L}\p{N} .'-]{0,31})[,!:]\s*(?=(?:let['’]s|save|store|remember|please|can you|could you|would you|i['’]d|i would|what['’]s)\b)/iu.exec(request);
 const names = ['Airodrom', 'Airo', ...(vocative ? [vocative[1]] : []), ...(typeof nickname === 'string' && /^[\p{L}\p{N} .'-]{1,32}$/u.test(nickname) ? [nickname] : [])];
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
