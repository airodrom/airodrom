'use strict';
// Operator-local Calendar continuation and verified event referents.
const { randomUUID } = require('node:crypto');

const TTL_MS = 15 * 60 * 1000;
const MAX_EVENTS = 40;
const MAX_PENDING = 16;

class CalendarSessions {
  #active = null;
  #pendingWrites = new Map();

  #sweep(now = Date.now()) {
    if (this.#active && this.#active.expires_at <= now) this.#active = null;
    for (const [id, row] of this.#pendingWrites) {
      if (row.expires_at <= now) this.#pendingWrites.delete(id);
    }
  }

  rememberList({ items = [], action = 'events', query = null, day = null, calendar_id = 'primary', next_page_token = null, conversation_id = null } = {}) {
    this.#sweep();
    const events = (items || []).slice(0, MAX_EVENTS).map((e) => ({
      id: e.id,
      summary: e.summary,
      start: e.start,
      end: e.end,
      calendar_id: e.calendar_id || calendar_id,
    }));
    this.#active = {
      action,
      query,
      day,
      calendar_id,
      events,
      next_page_token: typeof next_page_token === 'string' && next_page_token ? next_page_token : null,
      conversation_id: conversation_id || null,
      expires_at: Date.now() + TTL_MS,
      selected_index: events.length === 1 ? 0 : null,
    };
    return this.#active;
  }

  active({ conversation_id = null } = {}) {
    this.#sweep();
    if (!this.#active) return null;
    if (this.#active.conversation_id && this.#active.conversation_id !== (conversation_id || null)) return null;
    return this.#active;
  }

  selectByHint(hint) {
    this.#sweep();
    if (!this.#active?.events?.length) return { error: 'No verified calendar results to refer to. Ask what’s on your calendar first.' };
    const text = String(hint || '').toLowerCase();
    const timeMatch = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text);
    const candidates = this.#active.events.filter((e) => {
      if (text && e.summary && e.summary.toLowerCase().includes(text.replace(/move|the|meeting|to|\d.*/gi, '').trim()) && text.length > 3) return true;
      if (!timeMatch || !e.start) return false;
      const hour = Number(timeMatch[1]);
      const minute = timeMatch[2] ? Number(timeMatch[2]) : 0;
      let h = hour;
      const ap = (timeMatch[3] || '').toLowerCase();
      if (ap === 'pm' && hour < 12) h += 12;
      if (ap === 'am' && hour === 12) h = 0;
      const start = new Date(e.start);
      if (Number.isNaN(start.getTime())) return String(e.start).includes(String(hour));
      return start.getHours() === h && (timeMatch[2] ? start.getMinutes() === minute : true);
    });
    if (candidates.length === 1) {
      this.#active.selected_index = this.#active.events.indexOf(candidates[0]);
      return { event: candidates[0] };
    }
    if (candidates.length > 1) {
      return {
        error: 'Multiple matching events. Specify which one by exact time or title.',
        choices: candidates.slice(0, 5),
      };
    }
    if (this.#active.events.length === 1) {
      this.#active.selected_index = 0;
      return { event: this.#active.events[0] };
    }
    return { error: 'Could not resolve which event you mean. Name the time or title from the verified list.' };
  }

  selected() {
    this.#sweep();
    if (!this.#active || this.#active.selected_index == null) return null;
    return this.#active.events[this.#active.selected_index] || null;
  }

  stageWrite(proposal) {
    this.#sweep();
    while (this.#pendingWrites.size >= MAX_PENDING) {
      const oldest = this.#pendingWrites.keys().next().value;
      this.#pendingWrites.delete(oldest);
    }
    const id = randomUUID();
    this.#pendingWrites.set(id, { ...proposal, id, expires_at: Date.now() + TTL_MS });
    return id;
  }

  takeWrite(id, { confirm = false } = {}) {
    this.#sweep();
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) {
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
    if (confirm !== true) return row;
    this.#pendingWrites.delete(id);
    return row;
  }
}

module.exports = { CalendarSessions, TTL_MS };
