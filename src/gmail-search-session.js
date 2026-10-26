'use strict';
// Operator-local Gmail search continuation. Opaque IDs only — never expose
// Gmail nextPageToken to models, Missions, or unrelated conversations.
const { randomUUID } = require('node:crypto');

const TTL_MS = 15 * 60 * 1000;
const MAX_PAGES = 20;
const MAX_TOTAL_RESULTS = 200;
const MAX_SESSIONS = 64;
const PAGE_SIZE_MAX = 20;

class GmailSearchSessions {
  #sessions = new Map();

  #sweep(now = Date.now()) {
    for (const [id, row] of this.#sessions) {
      if (row.expires_at <= now) this.#sessions.delete(id);
    }
    while (this.#sessions.size > MAX_SESSIONS) {
      const oldest = this.#sessions.keys().next().value;
      this.#sessions.delete(oldest);
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
    return id;
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
      const err = Error('Gmail search continuation expired. Run the search again.');
      err.code = 'gmail_search_cursor_expired';
      throw err;
    }
    if (row.operator !== operator) {
      const err = Error('Gmail search continuation belongs to a different operator session.');
      err.code = 'gmail_search_cursor_forbidden';
      throw err;
    }
    if (row.conversation_id && conversation_id && row.conversation_id !== conversation_id) {
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
    const row = this.require(id);
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
    return {
      items: unique,
      continuation_id: limit_reached || row.exhausted ? null : id,
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
      next_page_token: row.next_page_token, // internal only — callers must not project this
    };
  }

  peekToken(id, opts) {
    const row = this.require(id, opts);
    return row.next_page_token;
  }

  clear(id) {
    if (id) this.#sessions.delete(id);
  }
}

module.exports = {
  GmailSearchSessions,
  TTL_MS,
  MAX_PAGES,
  MAX_TOTAL_RESULTS,
  PAGE_SIZE_MAX,
};
