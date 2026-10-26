'use strict';
// Operator- and conversation-bound Calendar selection, pagination, and pending writes.
// Never a process-global active pointer — one conversation cannot continue another.
const { randomUUID } = require('node:crypto');

const TTL_MS = 15 * 60 * 1000;
const MAX_EVENTS = 40;
const MAX_PENDING = 16;
const MAX_ACTIVE = 64;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

function bindingKey(operator, conversation_id) {
  if (operator !== 'operator') {
    const err = Error('Calendar session continuation is operator-local only');
    err.code = 'calendar_session_forbidden';
    throw err;
  }
  if (typeof conversation_id !== 'string' || !conversation_id.trim()) {
    const err = Error('Calendar follow-ups require an authenticated Terminal conversation session.');
    err.code = 'calendar_session_required';
    throw err;
  }
  if (!UUID.test(conversation_id)) {
    const err = Error('Calendar follow-ups require a valid conversation session identity.');
    err.code = 'calendar_session_invalid';
    throw err;
  }
  return operator + '\0' + conversation_id;
}

class CalendarSessions {
  // operator+conversation → active list/selection row
  #active = new Map();
  #pendingWrites = new Map();
  // preview_id → completed create receipt (host-local dedupe only; not Google idempotency)
  #completedCreates = new Map();

  #sweep(now = Date.now()) {
    for (const [key, row] of this.#active) {
      if (row.expires_at <= now) this.#active.delete(key);
    }
    for (const [id, row] of this.#pendingWrites) {
      if (row.expires_at <= now) this.#pendingWrites.delete(id);
    }
    for (const [id, row] of this.#completedCreates) {
      if (row.expires_at <= now) this.#completedCreates.delete(id);
    }
    while (this.#active.size > MAX_ACTIVE) {
      const oldest = this.#active.keys().next().value;
      this.#active.delete(oldest);
    }
  }

  requireConversation(conversation_id, operator = 'operator') {
    return bindingKey(operator, conversation_id);
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
    const row = this.#active.get(key);
    if (!row || row.expires_at <= Date.now()) {
      this.#active.delete(key);
      return null;
    }
    if (row.conversation_id !== conversation_id || row.operator !== operator) {
      this.#active.delete(key);
      const err = Error('Calendar session belongs to a different conversation.');
      err.code = 'calendar_session_forbidden';
      throw err;
    }
    return row;
  }

  rememberList({
    items = [],
    action = 'events',
    query = null,
    day = null,
    calendar_id = 'primary',
    next_page_token = null,
    conversation_id = null,
    operator = 'operator',
  } = {}) {
    this.#sweep();
    const key = bindingKey(operator, conversation_id);
    const events = (items || []).slice(0, MAX_EVENTS).map((e) => ({
      id: e.id,
      summary: e.summary,
      start: e.start,
      end: e.end,
      // Preserve the queried calendar id — never substitute organizer email.
      calendar_id: calendar_id || e.calendar_id || 'primary',
      recurring_event_id: e.recurring_event_id || null,
    }));
    const row = {
      action,
      query,
      day,
      calendar_id: calendar_id || 'primary',
      events,
      next_page_token: typeof next_page_token === 'string' && next_page_token ? next_page_token : null,
      conversation_id,
      operator,
      expires_at: Date.now() + TTL_MS,
      selected_index: events.length === 1 ? 0 : null,
    };
    this.#active.set(key, row);
    return row;
  }

  clearActive({ conversation_id = null, operator = 'operator' } = {}) {
    try {
      this.#active.delete(bindingKey(operator, conversation_id));
    } catch {
      /* invalid identity — nothing to clear */
    }
  }

  selectByHint(hint, { conversation_id = null, operator = 'operator' } = {}) {
    this.#sweep();
    let active;
    try {
      active = this.getActive({ conversation_id, operator });
    } catch (error) {
      return { error: error.message, code: error.code };
    }
    if (!active?.events?.length) {
      return { error: 'No verified calendar results to refer to in this conversation. Ask what’s on your calendar first.' };
    }
    const text = String(hint || '').toLowerCase();
    const timeMatch = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text);
    const candidates = active.events.filter((e) => {
      if (text && e.summary && e.summary.toLowerCase().includes(text.replace(/move|the|meeting|to|\d.*/gi, '').trim()) && text.length > 3) return true;
      if (!timeMatch || !e.start) return false;
      const hour = Number(timeMatch[1]);
      const minute = timeMatch[2] ? Number(timeMatch[2]) : 0;
      let h = hour;
      const ap = (timeMatch[3] || '').toLowerCase();
      if (ap === 'pm' && hour < 12) h += 12;
      if (ap === 'am' && hour === 12) h = 0;
      // All-day events use YYYY-MM-DD — time hints do not match them.
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(e.start))) return false;
      const start = new Date(e.start);
      if (Number.isNaN(start.getTime())) return String(e.start).includes(String(hour));
      const hourMatch = start.getHours() === h || start.getUTCHours() === h;
      if (!hourMatch) return false;
      if (!timeMatch[2]) return true;
      return start.getMinutes() === minute || start.getUTCMinutes() === minute;
    });
    if (candidates.length === 1) {
      active.selected_index = active.events.indexOf(candidates[0]);
      active.expires_at = Date.now() + TTL_MS;
      return { event: candidates[0] };
    }
    if (candidates.length > 1) {
      return {
        error: 'Multiple matching events. Specify which one by exact time or title.',
        choices: candidates.slice(0, 5),
      };
    }
    if (active.events.length === 1) {
      active.selected_index = 0;
      active.expires_at = Date.now() + TTL_MS;
      return { event: active.events[0] };
    }
    return { error: 'Could not resolve which event you mean. Name the time or title from the verified list.' };
  }

  selected({ conversation_id = null, operator = 'operator' } = {}) {
    this.#sweep();
    const active = this.getActive({ conversation_id, operator });
    if (!active || active.selected_index == null) return null;
    return active.events[active.selected_index] || null;
  }

  stageWrite(proposal, { conversation_id = null, operator = 'operator' } = {}) {
    this.#sweep();
    const key = bindingKey(operator, conversation_id);
    while (this.#pendingWrites.size >= MAX_PENDING) {
      const oldest = this.#pendingWrites.keys().next().value;
      this.#pendingWrites.delete(oldest);
    }
    const id = randomUUID();
    const approval_id = proposal.destructive ? randomUUID() : null;
    const row = {
      ...proposal,
      id,
      approval_id,
      // Independent approval for destructive ops — --destructive alone never sets this.
      approval_status: proposal.destructive ? 'pending' : 'not_required',
      conversation_id,
      operator,
      binding_key: key,
      expires_at: Date.now() + TTL_MS,
    };
    this.#pendingWrites.set(id, row);
    return { preview_id: id, approval_id };
  }

  approveWrite(approval_id, { conversation_id = null, operator = 'operator' } = {}) {
    this.#sweep();
    bindingKey(operator, conversation_id);
    if (typeof approval_id !== 'string' || !UUID.test(approval_id)) {
      const err = Error('Calendar destructive approval id is invalid or expired.');
      err.code = 'calendar_approval_invalid';
      throw err;
    }
    for (const row of this.#pendingWrites.values()) {
      if (row.approval_id !== approval_id) continue;
      if (row.conversation_id !== conversation_id || row.operator !== operator) {
        const err = Error('Calendar destructive approval belongs to a different conversation.');
        err.code = 'calendar_approval_forbidden';
        throw err;
      }
      if (!row.destructive) {
        const err = Error('This calendar preview does not require destructive approval.');
        err.code = 'calendar_approval_not_required';
        throw err;
      }
      row.approval_status = 'approved';
      row.expires_at = Date.now() + TTL_MS;
      return { preview_id: row.id, approval_id: row.approval_id, approval_status: 'approved' };
    }
    const err = Error('Calendar destructive approval expired or was not found. Request the cancel again.');
    err.code = 'calendar_approval_expired';
    throw err;
  }

  peekWrite(id, { conversation_id = null, operator = 'operator' } = {}) {
    this.#sweep();
    bindingKey(operator, conversation_id);
    if (typeof id !== 'string' || !UUID.test(id)) {
      const err = Error('Calendar write preview expired or invalid.');
      err.code = 'calendar_write_preview_invalid';
      throw err;
    }
    const row = this.#pendingWrites.get(id);
    if (!row) {
      const err = Error('Calendar write preview expired. Request the change again.');
      err.code = 'calendar_write_preview_expired';
      throw err;
    }
    if (row.conversation_id !== conversation_id || row.operator !== operator) {
      const err = Error('Calendar write preview belongs to a different conversation.');
      err.code = 'calendar_write_preview_forbidden';
      throw err;
    }
    return row;
  }

  /**
   * Consume a pending write only after the caller is ready to mutate Google.
   * Uncertain failures should leave the preview in place (use peekWrite, not commit).
   */
  commitWrite(id, { conversation_id = null, operator = 'operator' } = {}) {
    const row = this.peekWrite(id, { conversation_id, operator });
    this.#pendingWrites.delete(id);
    return row;
  }

  /** @deprecated use peekWrite/commitWrite — kept for call-site clarity during transition */
  takeWrite(id, { confirm = false, conversation_id = null, operator = 'operator' } = {}) {
    if (!confirm) return this.peekWrite(id, { conversation_id, operator });
    return this.commitWrite(id, { conversation_id, operator });
  }

  getCompletedCreate(preview_id, { conversation_id = null, operator = 'operator' } = {}) {
    this.#sweep();
    const row = this.#completedCreates.get(preview_id);
    if (!row || row.expires_at <= Date.now()) {
      this.#completedCreates.delete(preview_id);
      return null;
    }
    if (conversation_id != null) {
      bindingKey(operator, conversation_id);
      if (row.conversation_id !== conversation_id || row.operator !== operator) return null;
    }
    return row.receipt;
  }

  markCreateCompleted(preview_id, receipt, { conversation_id = null, operator = 'operator' } = {}) {
    bindingKey(operator, conversation_id);
    this.#completedCreates.set(preview_id, {
      receipt: {
        ...receipt,
        host_dedupe: true,
        google_idempotent: false,
        message: (receipt.message || '') + ' (host-local replay of a completed preview; Google does not provide create idempotency).',
      },
      conversation_id,
      operator,
      expires_at: Date.now() + TTL_MS,
    });
  }
}

module.exports = { CalendarSessions, TTL_MS, bindingKey, UUID };
