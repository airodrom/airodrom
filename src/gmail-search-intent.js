'use strict';
// Host-authoritative natural-language Gmail retrieval. Operator ingress only.
// Never parse retrieved email bodies or worker text through this module.

const PAGE_SIZE_DEFAULT = 10;
const PAGE_SIZE_MAX = 20;

const MAIL = '(?:e-?mails?|mails?|messages?|gmail)';
const FIND = '(?:find|show|list|search|get|check|read|open)';
const EMAIL_ADDR = /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/;

// Well-known read-only sender aliases. Matching the display name "GitHub" in a
// message does not prove authentic GitHub origin; results show From metadata.
const ALIASES = Object.freeze({
  github: {
    label: 'GitHub',
    // Prefer authenticated notification/noreply senders and the github.com domain.
    query: '(from:github.com OR from:notifications@github.com OR from:noreply@github.com)',
  },
});

const { normalize } = require('./assistant-intent-text');

function quoteGmailAtom(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 200 || /[\r\n\0]/.test(raw)) throw Error('Invalid Gmail search atom');
  if (/^[\w.@+-]+$/.test(raw)) return raw;
  return '"' + raw.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function buildSenderQuery({ email = null, domain = null, alias = null, name = null } = {}) {
  if (alias && ALIASES[alias]) return { query: ALIASES[alias].query, label: ALIASES[alias].label, match: 'alias' };
  if (email) return { query: 'from:' + quoteGmailAtom(email.toLowerCase()), label: email.toLowerCase(), match: 'email' };
  if (domain) return { query: 'from:' + quoteGmailAtom(domain.toLowerCase()), label: domain.toLowerCase(), match: 'domain' };
  if (name) return { query: 'from:' + quoteGmailAtom(name), label: name, match: 'display_name' };
  return null;
}

function applyFlags(query, { unread = false, recent = false } = {}) {
  let q = query;
  if (unread) q = 'is:unread ' + q;
  if (recent) q = 'newer_than:7d ' + q;
  return q.replace(/\s+/g, ' ').trim();
}

function looksLikeMail(request) {
  return /\b(?:gmail|inbox)\b/i.test(request)
    || new RegExp('\\b' + MAIL + '\\b', 'i').test(request)
    || /\b(?:search|find|show|list)\s+(?:my\s+)?(?:e-?mail|mail)\b/i.test(request);
}

/**
 * Continuation phrases.
 * - Generic ("show more" / "next page"): only when the caller reports an active
 *   Gmail search for this authenticated conversation.
 * - Mail-explicit ("show more GitHub emails"): mail-shaped; still requires an
 *   active bound search at execution time.
 */
function continuation(request, { activeGmailSearch = false } = {}) {
  const text = normalize(request);
  const mailExplicit = /^(?:show|get|list|find)\s+more\s+(?:github\s+)?(?:emails?|mails?|messages?)\.?$/i.test(text)
    || /^(?:show|get|list|find)?\s*(?:the\s+)?(?:next\s+page|more)\s+(?:of\s+)?(?:those\s+|the\s+)?(?:emails?|mails?|messages?|results)\.?$/i.test(text);
  const generic = /^(?:show|get|list|find)?\s*(?:the\s+)?(?:next\s+page|more(?:\s+results)?)\.?$/i.test(text);
  if (mailExplicit) {
    return {
      kind: 'connector',
      connector: 'gmail',
      action: 'search',
      continuation: true,
      route: 'CONNECTOR',
      hint_alias: /github/i.test(text) ? 'github' : null,
      host_verified: true,
    };
  }
  if (generic && activeGmailSearch) {
    return {
      kind: 'connector',
      connector: 'gmail',
      action: 'search',
      continuation: true,
      route: 'CONNECTOR',
      host_verified: true,
    };
  }
  return null;
}

function refuseMutations(request) {
  // Caller must already have established mail-related intent.
  // Local "draft/compose an email" is handled by email-compose-intent (no Gmail write).
  // Do not conflate local composition with send / Gmail Drafts / mailbox mutations.
  if (/\b(?:draft|write|compose)\s+(?:an?\s+)?(?:email|mail|message|reply)\b/i.test(request)) {
    return null;
  }
  if (/\b(?:send|archive|delete|trash|label|mark\s+as\s+read|mark\s+read|forward)\b/i.test(request)
    || /\breply\b/i.test(request)
    || /\bsave\s+(?:to\s+)?(?:gmail\s+)?drafts?\b/i.test(request)
    || /\bsave\s+(?:this\s+)?(?:email|mail|message)\s+to\s+(?:gmail\s+)?drafts?\b/i.test(request)) {
    return {
      kind: 'clarify',
      route: 'CONNECTOR',
      message: 'Gmail search is read-only. Sending, archiving, deleting, labeling, forwarding, or saving a Gmail Draft requires a separately governed Gmail write capability. Local email composition does not.',
    };
  }
  return null;
}

function extractSender(request) {
  const email = EMAIL_ADDR.exec(request);
  if (email) return buildSenderQuery({ email: email[1] });

  const fromDomain = /\bfrom\s+(?:the\s+)?(?:domain\s+)?([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/i.exec(request);
  if (fromDomain && !fromDomain[1].includes('@')) return buildSenderQuery({ domain: fromDomain[1] });

  const domainBare = /\b(?:emails?|mails?|messages?)\s+from\s+(?:the\s+)?([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/i.exec(request);
  if (domainBare) return buildSenderQuery({ domain: domainBare[1] });

  for (const [alias, meta] of Object.entries(ALIASES)) {
    if (new RegExp('\\b' + alias + '\\b', 'i').test(request)) {
      return buildSenderQuery({ alias });
    }
  }

  // "from Acme" / "from Jane" — display-name filter; not proof of authenticity.
  const named = /\bfrom\s+(?:the\s+)?(?:"([^"]{1,80})"|'([^']{1,80})'|([A-Za-z][A-Za-z0-9 .&_-]{0,60}?))(?:\s+(?:emails?|mails?|messages?|notifications?))?\.?$/i.exec(request)
    || /\b(?:emails?|mails?|messages?)\s+from\s+(?:"([^"]{1,80})"|'([^']{1,80})'|([A-Za-z][A-Za-z0-9 .&_-]{1,60}))\.?$/i.exec(request);
  if (named) {
    const name = (named[1] || named[2] || named[3] || '').trim().replace(/\s+(?:emails?|mails?|messages?)$/i, '');
    if (!name || /^(?:my|the|a|an|all|unread|recent)$/i.test(name)) return null;
    if (/^github$/i.test(name)) return buildSenderQuery({ alias: 'github' });
    return buildSenderQuery({ name });
  }
  return null;
}

/**
 * @param {string} value
 * @param {{activeGmailSearch?: boolean}} [options]
 */
function parse(value, { activeGmailSearch = false } = {}) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const request = normalize(value);
  if (Buffer.byteLength(request) > 4000) return null;

  const cont = continuation(request, { activeGmailSearch });
  if (cont) return cont;

  // Mail-related intent must be established before mutation refusal — otherwise
  // ordinary WORK/conversation ("send the patch", "delete the file") is hijacked.
  if (!looksLikeMail(request)) return null;

  const mutation = refuseMutations(request);
  if (mutation) return mutation;

  // Ambiguous inbox without sender — leave existing clarify / recent handlers.
  if (/^(?:check|read|show|open)\s+(?:my\s+)?(?:inbox|messages|email|emails|mail)$/i.test(request)) return null;
  if (/^(?:check|read|show|open)\s+(?:my\s+)?gmail$/i.test(request)) return null;

  const unread = /\bunread\b/i.test(request);
  const recent = /\brecent\b/i.test(request) || /\blast\s+week\b/i.test(request);

  // "search my gmail for GitHub notifications"
  const forQuery = new RegExp(
    '^(?:' + FIND + ')\\s+(?:(?:in|my)\\s+)?(?:gmail|inbox)?\\s*(?:for|about)\\s+(.+)$',
    'i'
  ).exec(request);
  if (forQuery) {
    const rest = forQuery[1].trim();
    if (/^(?:github)(?:\\s+notifications?)?\.?$/i.test(rest)) {
      const sender = buildSenderQuery({ alias: 'github' });
      return {
        kind: 'connector', connector: 'gmail', action: 'search', route: 'CONNECTOR',
        query: applyFlags(sender.query, { unread, recent }),
        label: sender.label, match: sender.match,
        unread, recent, page_size: PAGE_SIZE_DEFAULT, host_verified: true,
      };
    }
    const sender = extractSender('emails from ' + rest) || extractSender(rest);
    if (sender) {
      return {
        kind: 'connector', connector: 'gmail', action: 'search', route: 'CONNECTOR',
        query: applyFlags(sender.query, { unread, recent }),
        label: sender.label, match: sender.match,
        unread, recent, page_size: PAGE_SIZE_DEFAULT, host_verified: true,
      };
    }
    return {
      kind: 'clarify', route: 'CONNECTOR',
      message: 'Which sender should I search for in Gmail? For example: Find emails from GitHub, or Search Gmail for notifications@github.com.',
    };
  }

  // "find all mails from github" / "show github emails" / "emails from notifications@github.com"
  const sender = extractSender(request);
  if (!sender) {
    if (new RegExp('^' + FIND + '\\s+(?:all\\s+)?' + MAIL + '\\b', 'i').test(request)
      || new RegExp('\\b' + MAIL + '\\s+from\\b', 'i').test(request)) {
      return {
        kind: 'clarify', route: 'CONNECTOR',
        message: 'Which sender or domain should I search? For example: Find all mails from GitHub.',
      };
    }
    return null;
  }

  // Require a retrieval verb or "... emails from ..." shape.
  const shaped =
    new RegExp('^' + FIND + '\\b', 'i').test(request)
    || new RegExp('\\b' + MAIL + '\\s+from\\b', 'i').test(request)
    || new RegExp('^' + MAIL + '\\s+from\\b', 'i').test(request)
    || /\b(?:github)\s+(?:emails?|mails?|messages?|notifications?)\b/i.test(request);
  if (!shaped) return null;

  return {
    kind: 'connector',
    connector: 'gmail',
    action: 'search',
    route: 'CONNECTOR',
    query: applyFlags(sender.query, { unread, recent }),
    label: sender.label,
    match: sender.match,
    unread,
    recent,
    page_size: PAGE_SIZE_DEFAULT,
    host_verified: true,
  };
}

/**
 * Host-built Gmail search queries use a narrow operator alphabet. Chat secret
 * heuristics treat `from:domain` as credential-like because of `:` + hostname;
 * this allowlist is the gate for connector search instead.
 */
function isHostSearchQuery(query) {
  if (typeof query !== 'string' || !query.trim() || query.length > 1000) return false;
  if (/[\r\n\0]/.test(query) || /\b(?:password|passphrase|bearer|api[_-]?key|refresh_token|access_token)\b/i.test(query)) return false;
  if (!/\bfrom:/i.test(query)) return false;
  // Operators and atoms we emit: from, is:unread, newer_than:7d, OR, parentheses, quotes.
  if (!/^(?:(?:is:unread|newer_than:7d)\s+|\(|\)|OR\s+|from:(?:"[^"]{1,200}"|[^\s()]+)\s*)+$/i.test(query.trim())) return false;
  // Alphabet match alone is not enough: refuse credential-shaped from: atoms.
  const policy = require('./provider-policy');
  for (const match of query.matchAll(/from:("[^"]{1,200}"|[^\s()]+)/gi)) {
    const atom = String(match[1] || '').replace(/^"|"$/g, '').trim();
    if (!atom) return false;
    if (policy.secretLike(atom) || policy.operatorSecretLike?.(atom)
      || /^(?:sk-|AKIA|ASIA|ghp_|gho_|github_pat_|xox[baprs]-|ya29\.|AIza)/i.test(atom)) return false;
  }
  return true;
}

module.exports = {
  parse,
  normalize,
  buildSenderQuery,
  applyFlags,
  quoteGmailAtom,
  isHostSearchQuery,
  looksLikeMail,
  continuation,
  ALIASES,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
};
