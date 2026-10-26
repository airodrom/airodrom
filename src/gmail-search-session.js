'use strict';
// Operator-local Gmail search continuation. Opaque IDs only — never expose
// Gmail nextPageToken to models, Missions, or unrelated conversations.
const { randomUUID } = require('node:crypto');

const TTL_MS = 15 * 60 * 1000;
const MAX_PAGES = 20;
const MAX_TOTAL_RESULTS = 200;
const MAX_SESSIONS = 64;
const PAGE_SIZE_MAX = 20;

function bindingKey(operator, conversation_id) {
  if (operator !== 'operator') {
    const err = Error('Gmail search continuation is operator-local only');
    err.code = 'gmail_search_cursor_forbidden';
    throw err;
  }
  // Conversation identity is required for active-search binding (Terminal session).
  if (typeof conversation_id !== 'string' || !conversation_id.trim()) {
    const err = Error('Gmail search continuation requires an authenticated conversation session.');
    err.code = 'gmail_search_session_required';
    throw err;
  }
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(conversation_id)) {
    const err = Error('Gmail search continuation requires a valid conversation session identity.');
    err.code = 'gmail_search_session_invalid';
    throw err;
  }
  return operator + '\0' + conversation_id;
}

class GmailSearchSessions {
  #sessions = new Map();
  // operator+conversation → opaque continuation_id (never a global process pointer)
  #active = new Map();
  // operator+conversation → last verified result page (for write follow-ups)
  #lastResults = new Map();

  #sweep(now = Date.now()) {
    for (const [id, row] of this.#sessions) {
      if (row.expires_at <= now) {
        this.#sessions.delete(id);
        this.#clearActiveId(id);
      }
    }
    for (const [key, row] of this.#lastResults) {
      if (row.expires_at <= now) this.#lastResults.delete(key);
    }
    while (this.#sessions.size > MAX_SESSIONS) {
      const oldest = this.#sessions.keys().next().value;
      this.#sessions.delete(oldest);
      this.#clearActiveId(oldest);
    }
  }

  #clearActiveId(id) {
    for (const [key, activeId] of this.#active) {
      if (activeId === id) this.#active.delete(key);
    }
  }

  begin({
    query,
    label = null,
    match = null,
    conversation_id = null,
    operator = 'operator',
    page_size = 10,
  }) {
    if (typeof query !== 'string' || !query.trim() || query.length > 1000) throw Error('Bounded Gmail search query required');
    if (operator !== 'operator') throw Error('Gmail search continuation is operator-local only');
    const size = Number.isInteger(page_size) ? Math.min(Math.max(page_size, 1), PAGE_SIZE_MAX) : 10;
    this.#sweep();
    const id = randomUUID();
    const row = {
      id,
      query: query.trim(),
      label,
      match,
      conversation_id: conversation_id || null,
      operator,
      page_size: size,
      page: 0,
      pages_fetched: 0,
      total_returned: 0,
      seen_ids: new Set(),
      next_page_token: null,
      exhausted: false,
      expires_at: Date.now() + TTL_MS,
    };
    this.#sessions.set(id, row);
    // Active pointer only when conversation identity is present — never a global process slot.
    if (conversation_id) this.#active.set(bindingKey(operator, conversation_id), id);
    return id;
  }

  hasActive({ conversation_id = null, operator = 'operator' } = {}) {
    try {
      return !!this.getActive({ conversation_id, operator });
    } catch {
      return false;
    }
  }

  getActive({ conversation_id = null, operator = 'operator' } = {}) {
    this.#sweep();
    const key = bindingKey(operator, conversation_id);
    const id = this.#active.get(key);
    if (!id) return null;
    const row = this.#sessions.get(id);
    if (!row || row.expires_at <= Date.now()) {
      this.#sessions.delete(id);
      this.#active.delete(key);
      return null;
    }
    if (row.conversation_id !== conversation_id || row.operator !== operator) {
      this.#active.delete(key);
      const err = Error('Gmail search continuation belongs to a different conversation.');
      err.code = 'gmail_search_cursor_forbidden';
      throw err;
    }
    if (!row.next_page_token && row.exhausted) return null;
    return { continuation_id: id, query: row.query, label: row.label, conversation_id: row.conversation_id };
  }

  setActive(id, { conversation_id = null, operator = 'operator' } = {}) {
    this.#sweep();
    const key = bindingKey(operator, conversation_id);
    if (!id) {
      this.#active.delete(key);
      return;
    }
    const row = this.require(id, { conversation_id, operator });
    this.#active.set(key, row.id);
  }

  clearActive({ conversation_id = null, operator = 'operator' } = {}) {
    try {
      this.#active.delete(bindingKey(operator, conversation_id));
    } catch {
      /* invalid identity — nothing to clear */
    }
  }

  require(id, { conversation_id = null, operator = 'operator', expected_query = null } = {}) {
    this.#sweep();
    if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)) {
      const err = Error('Gmail search continuation is unavailable or expired. Run the search again.');
      err.code = 'gmail_search_cursor_invalid';
      throw err;
    }
    const row = this.#sessions.get(id);
    if (!row || row.expires_at <= Date.now()) {
      this.#sessions.delete(id);
      this.#clearActiveId(id);
      const err = Error('Gmail search continuation expired. Run the search again.');
      err.code = 'gmail_search_cursor_expired';
      throw err;
    }
    if (row.operator !== operator) {
      const err = Error('Gmail search continuation belongs to a different operator session.');
      err.code = 'gmail_search_cursor_forbidden';
      throw err;
    }
    // Bound sessions require the same conversation; omitting conversation_id is not a free pass.
    if (row.conversation_id && row.conversation_id !== (conversation_id || null)) {
      const err = Error('Gmail search continuation belongs to a different conversation.');
      err.code = 'gmail_search_cursor_forbidden';
      throw err;
    }
    if (!row.conversation_id && conversation_id) {
      const err = Error('Gmail search continuation belongs to a different conversation.');
      err.code = 'gmail_search_cursor_forbidden';
      throw err;
    }
    if (expected_query && expected_query !== row.query) {
      const err = Error('Gmail search query changed; start a new search instead of continuing.');
      err.code = 'gmail_search_query_mismatch';
      throw err;
    }
    row.expires_at = Date.now() + TTL_MS;
    return row;
  }

  recordPage(id, { messages = [], next_page_token = null } = {}) {
    // Host page recording is bound to the session row itself (not a client-supplied conversation).
    const existing = this.#sessions.get(id);
    const row = this.require(id, {
      conversation_id: existing?.conversation_id || null,
      operator: existing?.operator || 'operator',
    });
    if (row.pages_fetched >= MAX_PAGES || row.total_returned >= MAX_TOTAL_RESULTS) {
      row.exhausted = true;
      row.next_page_token = null;
      const err = Error('Gmail search reached the host safety limit. Narrow the query or stop here; results so far are partial.');
      err.code = 'gmail_search_limit';
      err.partial = true;
      throw err;
    }
    const unique = [];
    for (const message of messages) {
      const mid = message && message.id;
      if (typeof mid !== 'string' || !mid) continue;
      if (row.seen_ids.has(mid)) continue;
      row.seen_ids.add(mid);
      unique.push(message);
    }
    row.page += 1;
    row.pages_fetched += 1;
    row.total_returned += unique.length;
    row.next_page_token = typeof next_page_token === 'string' && next_page_token ? next_page_token : null;
    const limit_reached = row.pages_fetched >= MAX_PAGES || row.total_returned >= MAX_TOTAL_RESULTS;
    const provider_has_more = !!row.next_page_token;
    // Cap stops continuation; do not claim provider exhaustion when the host limit cut off more pages.
    if (limit_reached) row.next_page_token = null;
    row.exhausted = !provider_has_more;
    const continuation_id = limit_reached || row.exhausted ? null : id;
    if (continuation_id) {
      try {
        this.setActive(continuation_id, { conversation_id: row.conversation_id, operator: row.operator });
      } catch {
        /* row without conversation cannot be active-bound */
      }
    } else {
      this.#clearActiveId(id);
    }
    if (row.conversation_id) {
      try {
        this.rememberResults({
          items: unique,
          conversation_id: row.conversation_id,
          operator: row.operator,
        });
      } catch { /* selection memory is best-effort */ }
    }
    return {
      items: unique,
      continuation_id,
      has_more: !limit_reached && !row.exhausted && provider_has_more,
      page: row.page,
      pages_fetched: row.pages_fetched,
      total_returned: row.total_returned,
      exhausted: row.exhausted && !limit_reached,
      limit_reached,
      partial: limit_reached && provider_has_more,
      query: row.query,
      label: row.label,
      match: row.match,
      page_size: row.page_size,
      conversation_id: row.conversation_id,
      next_page_token: row.next_page_token, // internal only — callers must not project this
    };
  }

  peekToken(id, opts) {
    const row = this.require(id, opts);
    return row.next_page_token;
  }

  clear(id) {
    if (id) {
      this.#sessions.delete(id);
      this.#clearActiveId(id);
    }
  }

  rememberResults({ items = [], conversation_id = null, operator = 'operator' } = {}) {
    this.#sweep();
    const key = bindingKey(operator, conversation_id);
    const list = (items || [])
      .filter((m) => m && typeof m.id === 'string' && m.id)
      .slice(0, PAGE_SIZE_MAX)
      .map((m) => ({ id: m.id, subject: m.subject || null, from: m.from || null }));
    this.#lastResults.set(key, {
      items: list,
      selected_id: list.length === 1 ? list[0].id : null,
      conversation_id,
      operator,
      expires_at: Date.now() + TTL_MS,
    });
    return this.#lastResults.get(key);
  }

  lastResults({ conversation_id = null, operator = 'operator' } = {}) {
    this.#sweep();
    const key = bindingKey(operator, conversation_id);
    const row = this.#lastResults.get(key);
    if (!row || row.expires_at <= Date.now()) {
      this.#lastResults.delete(key);
      return null;
    }
    if (row.conversation_id !== conversation_id || row.operator !== operator) {
      this.#lastResults.delete(key);
      return null;
    }
    return row;
  }
}

module.exports = {
  GmailSearchSessions,
  bindingKey,
  TTL_MS,
  MAX_PAGES,
  MAX_TOTAL_RESULTS,
  PAGE_SIZE_MAX,
};
