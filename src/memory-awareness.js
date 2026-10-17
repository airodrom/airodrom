'use strict';
// Host-owned Memory / Vault / connector capability narrative.
// Answers describe systems and live availability only — never memory contents,
// vault values, or invented connector access. No authority is granted.

const SYSTEMS = Object.freeze([
 {
  id: 'personal_memory_v2',
  title: 'Personal Memory V2',
  summary: 'Ordinary facts, names and preferences the host may save and recall when you ask.',
 },
 {
  id: 'sensitive_memory',
  title: 'Sensitive Memory',
  summary: 'Operator-only private records. They are excluded from automatic AI context. Local private storage is used; field-level encryption is not claimed.',
 },
 {
  id: 'secret_vault',
  title: 'Secret Vault',
  summary: 'Keychain-backed credential storage. Labels can be listed; values stay in the Vault and are never ordinary Memory.',
 },
 {
  id: 'project_memory',
  title: 'Project Memory',
  summary: 'Scoped project context and continuity selected by the host for a task — not a free-form model database.',
 },
 {
  id: 'conversation_context',
  title: 'Conversation Context',
  summary: 'The current conversation plus authorized ordinary Memory references the host chooses to include.',
 },
]);

const BOUNDARIES = Object.freeze([
 'The model does not directly read databases or Keychain.',
 'Host services select authorized context for each turn.',
 'Sensitive records are not automatically injected into conversation.',
 'Secrets never become ordinary Memory.',
 'Gmail and web access depend on current connection and authorization evidence.',
]);

function soft(value) {
 return String(value || '')
  .normalize('NFKC')
  .trim()
  .replace(/^(?:hi|hey|hello|good morning|good afternoon|good evening)[\s,:.!–—-]*/i, '')
  .replace(/^(?:airo(?:drom)?|airo)[,:!\s–—-]*/i, '')
  .trim();
}

function focusOf(text) {
  const t = soft(text).toLowerCase();
  if (/\b(?:sensitive\s+memory|sensitive\s+information|\/remember-sensitive|\/sensitive)\b/.test(t)) return 'sensitive_memory';
  if (/\b(?:secret\s+)?vault\b|\bkeychain\b|\bcredentials?\b/.test(t)) return 'secret_vault';
  if (/\bgmail\b|\binbox\b|\bemails?\b/.test(t)) return 'gmail';
  if (/\b(?:browse|browser|web|internet)\b/.test(t)) return 'web';
  if (/\bproject\s+memory\b/.test(t)) return 'project_memory';
  if (/\b(?:personal\s+memory|ordinary\s+memory|memory\s+v2|memory\s+systems?|saved\s+memor(?:y|ies))\b/.test(t)) return 'personal_memory_v2';
  if (/\bassistant\b|\bwhat can you do\b|\bcapabilities?\b/.test(t)) return 'assistant';
  if (/\bmemor(?:y|ies)\b|\bremember\b/.test(t)) return 'memory';
  return 'assistant';
}

// Capability / meta questions only. Does not claim or perform storage.
function detect(message) {
  if (typeof message !== 'string' || !message.trim()) return null;
  const raw = soft(message);
  if (!raw || Buffer.byteLength(raw) > 4000 || raw.includes('\0')) return null;
  // Concrete remember/save with a that-clause stays a storage intent.
  if (/^(?:can you|could you|would you|please)\s+remember\s+that\b/i.test(raw)) return null;
  if (/^(?:remember|save|store)\s+that\b/i.test(raw)) return null;
  // Imperative display/list of actual ordinary records stays on the recall path.
  // Capability/how-to questions below remain host awareness.
  if (/^(?:please\s+)?(?:show|list|view|display)(?:\s+me)?(?:\s+my)?(?:\s+saved)?\s+memor(?:y|ies)\b/i.test(raw)) return null;
  if (/^(?:what do you remember|recall)\b/i.test(raw)) return null;

  const ask =
    /^(?:what|what's|whats|how|do you|does (?:airodrom|airo)|can (?:you|airodrom|airo)|could you|would you|tell me|explain)\b/i.test(raw) ||
    /\?\s*$/.test(message.trim());

  const patterns = [
    /\bwhat kind of memory\b/i,
    /\bwhat(?:\s+kind\s+of)?\s+memory\s+(?:do\s+you|you)\s+have\b/i,
    /\bwhat memory (?:systems?|kinds?)?\s*(?:do you have|are available)?\b/i,
    /\bwhat can you remember\b/i,
    /\bdo you have (?:a )?personal memory\b/i,
    /\b(?:can you|do you) remember (?:my )?(?:company|personal|private|sensitive)?\s*information\b/i,
    /\bwhat is sensitive memory\b/i,
    /\b(?:can you|do you|does airodrom|can airodrom) access(?: my)? (?:sensitive(?:\s+(?:memory|information))?|private(?:\s+information)?)\b/i,
    /\bhow (?:do|can) i (?:see|list|view|show|check)(?: my)? (?:saved\s+)?memor(?:y|ies)\b/i,
    /\b(?:do you have|is there) (?:a )?(?:secret )?vault\b/i,
    // "check/read/show/open my gmail" remains a connector action; access/use are capability questions.
    /\b(?:can you|do you|does airodrom|can airodrom) (?:access|use)(?: my)? (?:gmail|emails?|inbox)\b/i,
    /\b(?:can you|do you|does airodrom|can airodrom) (?:browse|search|use|access)(?: the)? (?:web|internet|browser)\b/i,
    /\bcan you browse the web\b/i,
    /\bwhat can you do(?: as my assistant)?\b/i,
    /\bwhat (?:tools|capabilities|integrations) (?:do you have|are available)\b/i,
    /\bexplain (?:your |airodrom['’]?s )?(?:memory|vault|assistant)(?: systems?| capabilities?)?\b/i,
  ];

  if (!patterns.some((re) => re.test(raw))) return null;
  if (!ask && !/\bwhat kind of memory\b/i.test(raw) && !/\bwhat can you do\b/i.test(raw)) return null;

  return {
    kind: 'memory_awareness',
    route: 'MEMORY',
    focus: focusOf(raw),
    authority: false,
  };
}

function searchSource() {
  try {
    return JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '../config/mission-web-v1.json'), 'utf8')).search_source || null;
  } catch {
    return null;
  }
}

function gmailObservation(server) {
  const state = require('./personal-ops').gmailState(server);
  let item = null;
  try {
    item = require('./assistant-service').connectors(server.bridge).status().items.find((i) => i.id === 'gmail') || null;
  } catch { /* connectors unset in some fixtures */ }

  const authenticated = item ? item.connected === true : state.auth === 'connected_live' || state.auth === 'connected_unverified';
  const live = item ? item.live_qualified === true : state.live_qualified === true;
  const stateLive = state.live_qualified === true;
  const stateAuthenticated = state.auth === 'connected_live' || state.auth === 'connected_unverified';

  // Fail closed on disagreeing connector status vs personal-ops projection, or live without auth.
  const inconsistent =
    (item != null && (live !== stateLive || authenticated !== stateAuthenticated)) ||
    (live && !authenticated) ||
    (state.auth === 'connected_live' && !live) ||
    (state.auth === 'connected_unverified' && live);

  // Connected requires BOTH authenticated connection and current live qualification.
  const connected = !inconsistent && authenticated && live && state.auth === 'connected_live';

  return {
    id: 'gmail',
    live_qualified: connected ? true : false,
    auth: inconsistent ? 'inconsistent_or_stale' : state.auth,
    connected,
    availability: connected ? 'AVAILABLE' : state.availability,
    note: inconsistent
      ? 'Gmail status evidence is inconsistent or stale; treating as not connected.'
      : state.note,
    next: inconsistent ? '/gmail status' : state.next,
  };
}

function webObservation() {
  const source = searchSource();
  return {
    id: 'web',
    search_source: source,
    public_web: source
      ? 'Governed public web Missions are available after the existing Terminal permission review.'
      : 'Public web search is blocked: no approved search provider is enabled. A public source URL can still use the existing governed Mission web review.',
    browser_research: 'Dedicated governed browser research (navigation, account sessions, screenshots) is not qualified in this version.',
  };
}

function explain(server, parsed = {}) {
  const focus = parsed.focus || 'assistant';
  const gmail = gmailObservation(server);
  const web = webObservation();
  const systems = SYSTEMS.map((s) => ({ id: s.id, title: s.title, summary: s.summary }));

  const lines = [];
  const lead = (id) => systems.find((s) => s.id === id);

  if (focus === 'sensitive_memory') {
    const s = lead('sensitive_memory');
    lines.push(`${s.title}: ${s.summary}`);
    lines.push('Use /remember-sensitive to save and /sensitive to list or reveal by exact ID. Ordinary recall and chat context never include these records automatically.');
  } else if (focus === 'secret_vault') {
    const s = lead('secret_vault');
    lines.push(`${s.title}: ${s.summary}`);
    lines.push('Use /vault or /secret in the operator terminal. Credentials typed in chat are refused. This answer never discloses Vault values.');
  } else if (focus === 'gmail') {
    lines.push(
      gmail.connected
        ? `Gmail: live read access is available right now (${gmail.note}).`
        : `Gmail: not live-connected right now. ${gmail.note} Next: ${gmail.next}.`
    );
    lines.push('Reads are host-routed. Send, archive and label stay unavailable without separate authorization.');
  } else if (focus === 'web') {
    lines.push(web.public_web);
    lines.push(web.browser_research);
  } else if (focus === 'personal_memory_v2' || focus === 'memory' || focus === 'project_memory') {
    lines.push('Airodrom keeps several distinct memory systems (host-owned — the model does not browse them freely):');
    for (const s of systems) lines.push(`- ${s.title}: ${s.summary}`);
    if (focus === 'personal_memory_v2' || focus === 'memory') {
      lines.push('Ordinary company facts can be saved with /remember or an explicit Personal Memory choice; private company details belong in Sensitive Memory; credentials belong in the Vault.');
      lines.push('To review ordinary saved memories, use /memory in the operator terminal or Control Center Memory. Sensitive entries use /sensitive (operator-only). Vault labels use /vault or /secret — values are never listed into chat.');
    }
  } else {
    lines.push('As your local assistant, I talk through host-owned workflows — I do not invent live connector access or memory contents.');
    lines.push('Memory systems:');
    for (const s of systems) lines.push(`- ${s.title}: ${s.summary}`);
    lines.push(
      gmail.connected
        ? `Gmail: live read access is available (${gmail.note}).`
        : `Gmail: not live-connected (${gmail.auth}). ${gmail.note}`
    );
    lines.push(web.public_web);
    lines.push(web.browser_research);
    lines.push('Work in a repository still goes through governed Work Missions when you ask for changes.');
  }

  lines.push('Access boundaries:');
  for (const b of BOUNDARIES) lines.push(`- ${b}`);
  lines.push('I am not listing or inventing any stored personal records in this answer.');

  return {
    kind: 'memory_awareness',
    route: 'MEMORY',
    focus,
    systems,
    boundaries: [...BOUNDARIES],
    connectors: { gmail, web },
    authority: false,
    message: lines.join('\n'),
  };
}

module.exports = { SYSTEMS, BOUNDARIES, detect, explain, focusOf, gmailObservation, webObservation };
